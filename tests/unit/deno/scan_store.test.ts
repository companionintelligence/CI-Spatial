/**
 * How an uploaded scan reaches the scans directory (server/world/scan_store.ts): a reader that lists the directory,
 * as every read of a world does, must never find a scan half made.
 *
 * These run the real file operations in a temporary directory. The `observe` hook lets a test look at the directory
 * between two steps, with the same rule the server lists scans by (a `.glb` that is not an optimizer artifact), so
 * "no reader can see it" is checked at every moment there is and not only at the end.
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from 'jsr:@std/assert@^1.0.0'
import { PART_SUFFIX, storeUploadedScan, writeAll, type StoreStep } from '../../../server/world/scan_store.ts'

/** listStoredScans (server/main.ts): `.glb` files, minus the `.opt` and `.lodN` artifacts of the optimizer. */
const listed = async (dir: string): Promise<string[]> => {
  const names: string[] = []
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith('.glb') && !/\.(opt|lod\d+)\.glb$/.test(entry.name)) names.push(entry.name)
  }
  return names.sort()
}

const everything = async (dir: string): Promise<string[]> => {
  const names: string[] = []
  for await (const entry of Deno.readDir(dir)) names.push(entry.name)
  return names.sort()
}

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'scan-store-' })
  try {
    await body(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

const bytesOf = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill)

Deno.test('nothing can be listed until the scan is whole and its sidecar is in place', async () => {
  await withDir(async (dir) => {
    const bytes = bytesOf(200_000, 9)
    const sidecar = JSON.stringify({ projectTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 3, 1] })
    const seen: Array<{ step: StoreStep; listed: string[]; names: string[] }> = []
    const filename = await storeUploadedScan({
      dir,
      ts: 1700000000000,
      safeName: 'room.glb',
      bytes,
      sidecar,
      observe: async (step) => {
        seen.push({ step, listed: await listed(dir), names: await everything(dir) })
      },
    })
    assertEquals(filename, '1700000000000_room.glb')
    assertEquals(seen.map((entry) => entry.step), ['claimed', 'bytes-written', 'sidecar-written', 'published'])

    // Until the last step the directory lists no scan, though bytes and sidecar are already on disk.
    for (const entry of seen.slice(0, 3)) assertEquals(entry.listed, [], `nothing is listed after ${entry.step}`)
    assertEquals(seen[0]!.names, [`${filename}${PART_SUFFIX}`], 'the claim is a file that is not a .glb')
    assert(seen[2]!.names.includes('1700000000000_room.json'), 'the sidecar is there before the scan can be')
    assert(seen[2]!.names.includes(`${filename}${PART_SUFFIX}`))

    // When the .glb appears it is whole, and the sidecar was there first.
    assertEquals(seen[3]!.listed, [filename])
    assertEquals(seen[3]!.names, ['1700000000000_room.glb', '1700000000000_room.json'], 'no part, no temporary file left behind')
    assertEquals(await Deno.readFile(`${dir}/${filename}`), bytes)
    assertEquals(await Deno.readTextFile(`${dir}/1700000000000_room.json`), sidecar)
  })
})

Deno.test('a scan with no sidecar is stored with none, and still appears whole', async () => {
  await withDir(async (dir) => {
    const seenListed: string[][] = []
    const filename = await storeUploadedScan({
      dir,
      ts: 5,
      safeName: 'plain',
      bytes: bytesOf(1000, 1),
      sidecar: null,
      observe: async () => {
        seenListed.push(await listed(dir))
      },
    })
    assertEquals(filename, '5_plain.glb', 'the name is made, and without .glb gets none of its own')
    assertEquals(seenListed.slice(0, 3), [[], [], []])
    assertEquals(await everything(dir), ['5_plain.glb'])
  })
})

Deno.test('two uploads that take the same name in the same millisecond each get their own file', async () => {
  await withDir(async (dir) => {
    const names = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      storeUploadedScan({ dir, ts: 42, safeName: 'same.glb', bytes: bytesOf(5000, i + 1), sidecar: JSON.stringify({ n: i }) })))
    assertEquals(new Set(names).size, 8, 'eight distinct names')
    assertEquals(names.filter((name) => name === '42_same.glb').length, 1, 'one of them has the plain name')
    // Each file holds its own upload, and each sidecar its own.
    const fills = new Set<number>()
    for (const name of names) {
      const bytes = await Deno.readFile(`${dir}/${name}`)
      const n = (JSON.parse(await Deno.readTextFile(`${dir}/${name.replace(/\.glb$/, '.json')}`)) as { n: number }).n
      assertEquals(bytes.length, 5000)
      assert(bytes.every((byte) => byte === n + 1), `${name} holds upload ${n}`)
      fills.add(n)
    }
    assertEquals(fills.size, 8)
    assertEquals((await everything(dir)).length, 16, 'eight scans and eight sidecars, nothing else')
  })
})

Deno.test('a name that a finished upload already has is not taken from it, and one still being written is not either', async () => {
  await withDir(async (dir) => {
    await Deno.writeFile(`${dir}/7_taken.glb`, bytesOf(10, 3))
    const first = await storeUploadedScan({ dir, ts: 7, safeName: 'taken.glb', bytes: bytesOf(20, 4), sidecar: null })
    assertNotEquals(first, '7_taken.glb')
    assertEquals(await Deno.readFile(`${dir}/7_taken.glb`), bytesOf(10, 3), 'the earlier scan is untouched')

    await Deno.writeFile(`${dir}/8_busy.glb${PART_SUFFIX}`, bytesOf(10, 5))
    const second = await storeUploadedScan({ dir, ts: 8, safeName: 'busy.glb', bytes: bytesOf(20, 6), sidecar: null })
    assertNotEquals(second, '8_busy.glb')
    assertEquals(await Deno.readFile(`${dir}/8_busy.glb${PART_SUFFIX}`), bytesOf(10, 5), 'the one in flight is untouched')
    assertEquals(await listed(dir), [first, '7_taken.glb', second].sort())
  })
})

Deno.test('every byte is written, however large the scan', async () => {
  await withDir(async (dir) => {
    const bytes = new Uint8Array(12_000_000)
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i / 4096) % 251
    const filename = await storeUploadedScan({ dir, ts: 1, safeName: 'big.glb', bytes, sidecar: null })
    const stored = await Deno.readFile(`${dir}/${filename}`)
    assertEquals(stored.length, bytes.length)
    assert(stored.every((byte, i) => byte === bytes[i]))
  })
})

Deno.test('a write that takes only some of the bytes it is given is asked again for the rest', async () => {
  const written: number[] = []
  const slow = {
    write(chunk: Uint8Array): Promise<number> {
      const taken = Math.min(3, chunk.byteLength)
      written.push(...chunk.subarray(0, taken))
      return Promise.resolve(taken)
    },
  }
  await writeAll(slow, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))
  assertEquals(written, [1, 2, 3, 4, 5, 6, 7, 8])
  written.length = 0
  await writeAll(slow, new Uint8Array(0))
  assertEquals(written, [], 'nothing to write is not a write')
})

Deno.test('a write that fails leaves nothing for a reader to find, wherever it fails', async () => {
  for (const failAt of ['claimed', 'bytes-written', 'sidecar-written'] as const) {
    await withDir(async (dir) => {
      await assertRejects(
        () =>
          storeUploadedScan({
            dir,
            ts: 9,
            safeName: 'fails.glb',
            bytes: bytesOf(3000, 2),
            sidecar: '{"a":1}',
            observe: (step) => {
              if (step === failAt) throw new Error(`stopped after ${step}`)
            },
          }),
        Error,
        `stopped after ${failAt}`,
      )
      assertEquals(await everything(dir), [], `after a failure at ${failAt} the directory is empty again`)
    })
  }
})

Deno.test('an upload that arrived keeps what it has, even if something after the last step fails', async () => {
  await withDir(async (dir) => {
    await assertRejects(
      () =>
        storeUploadedScan({
          dir,
          ts: 11,
          safeName: 'done.glb',
          bytes: bytesOf(3000, 2),
          sidecar: '{"a":1}',
          observe: (step) => {
            if (step === 'published') throw new Error('late')
          },
        }),
      Error,
      'late',
    )
    assertEquals(await everything(dir), ['11_done.glb', '11_done.json'])
  })
})
