/**
 * Byte caps on request bodies (server/wp-a-body.ts). The cap has to hold for a declared
 * Content-Length and for a chunked body that declares none.
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0'
import { declaredLengthExceeds, readFormDataCapped, readTextCapped } from '../../../server/wp-a-body.ts'

/**
 * A body that yields `chunks` one at a time, counting how many were pulled. The high-water mark
 * is zero, so nothing is pulled until something reads: the count shows what the code consumed.
 */
function chunkedBody(chunks: Uint8Array[]): { body: ReadableStream<Uint8Array>; pulled: () => number } {
  let next = 0
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next < chunks.length) controller.enqueue(chunks[next++])
        else controller.close()
      },
    }, { highWaterMark: 0 }),
    pulled: () => next,
  }
}

function postWith(body: ReadableStream<Uint8Array> | null, headers: Record<string, string>): Request {
  return new Request('http://scan.test/upload', { method: 'POST', headers, body, duplex: 'half' } as RequestInit)
}

/** A real multipart body, as a browser would send it, with its Content-Type. */
async function multipartImage(bytes: Uint8Array<ArrayBuffer>): Promise<{ body: Uint8Array; contentType: string }> {
  const form = new FormData()
  form.set('image', new Blob([bytes], { type: 'image/jpeg' }), 'frame.jpg')
  form.set('meta', '{"index":0}')
  const built = new Response(form)
  return { body: new Uint8Array(await built.arrayBuffer()), contentType: built.headers.get('content-type')! }
}

function split(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size))
  return out
}

Deno.test('a declared Content-Length over the cap is refused', () => {
  assertEquals(declaredLengthExceeds(new Headers({ 'content-length': '2000' }), 1000), true)
  assertEquals(declaredLengthExceeds(new Headers({ 'content-length': '1000' }), 1000), false, 'at the cap')
  assertEquals(declaredLengthExceeds(new Headers(), 1000), false, 'no header declares nothing')
  assertEquals(declaredLengthExceeds(new Headers({ 'content-length': '' }), 1000), false, 'empty header')
  assertEquals(declaredLengthExceeds(new Headers({ 'content-length': 'many' }), 1000), false, 'not a number')
})

Deno.test('a declared length over the cap is refused before a single byte is read', async () => {
  const { body, pulled } = chunkedBody([new Uint8Array(10)])
  const text = await readTextCapped(postWith(body, { 'content-length': '5000' }), 1000)
  assertEquals(text, null)
  assertEquals(pulled(), 0, 'the body was not read')
})

Deno.test('a chunked text body over the cap is cut off as it arrives', async () => {
  // 200 chunks of 100 bytes against a 1000-byte cap: the read must stop long before the end.
  const { body, pulled } = chunkedBody(Array.from({ length: 200 }, () => new Uint8Array(100)))
  const text = await readTextCapped(postWith(body, {}), 1000)
  assertEquals(text, null)
  assert(pulled() < 50, `read ${pulled()} of 200 chunks`)
})

Deno.test('a chunked text body under the cap is returned whole', async () => {
  const bytes = new TextEncoder().encode('{"entries":[]}')
  const { body } = chunkedBody(split(bytes, 4))
  assertEquals(await readTextCapped(postWith(body, {}), 1000), '{"entries":[]}')
})

Deno.test('a chunked multipart body over the cap is refused with no Content-Length', async () => {
  const image = new Uint8Array(50_000).fill(7)
  const { body: multipart, contentType } = await multipartImage(image)
  const { body } = chunkedBody(split(multipart, 1024))
  const form = await readFormDataCapped(postWith(body, { 'content-type': contentType }), 10_000)
  assertEquals(form, null)
})

Deno.test('a chunked multipart body under the cap parses into its file', async () => {
  const image = new Uint8Array(3_000).map((_, i) => i % 251)
  const { body: multipart, contentType } = await multipartImage(image)
  const { body } = chunkedBody(split(multipart, 512))
  const form = await readFormDataCapped(postWith(body, { 'content-type': contentType }), 100_000)
  assert(form !== null)
  const file = form.get('image')
  assert(file instanceof File)
  assertEquals(new Uint8Array(await file.arrayBuffer()), image)
  assertEquals(form.get('meta'), '{"index":0}')
})

Deno.test('a form body with a declared length over the cap is refused before it is read', async () => {
  const { body, pulled } = chunkedBody([new Uint8Array(10)])
  const form = await readFormDataCapped(postWith(body, { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '999999' }), 1000)
  assertEquals(form, null)
  assertEquals(pulled(), 0)
})

Deno.test('a body that is not form data still throws, as formData() does', async () => {
  const { body } = chunkedBody([new TextEncoder().encode('hello')])
  await assertRejects(() => readFormDataCapped(postWith(body, { 'content-type': 'text/plain' }), 1000))
})
