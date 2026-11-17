/**
 * The count and per-photo caps on POST /ingest-photos (photoUploadRefusal in server/wp-a-body.ts).
 *
 * The total byte cap does not bound the number of parts, so a flood of tiny photos would write one
 * file each. These checks run before anything is written.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { photoUploadRefusal } from '../../../server/wp-a-body.ts'

const LIMITS = { maxCount: 1000, maxPartBytes: 12_000_000 }

function photos(count: number, size: number): { size: number }[] {
  return Array.from({ length: count }, () => ({ size: size }))
}

Deno.test('a tripod capture at its largest (8 spots of 64 photos) is admitted', () => {
  assertEquals(photoUploadRefusal(photos(512, 900_000), LIMITS), null)
})

Deno.test('the count cap admits exactly the cap and refuses one more', () => {
  assertEquals(photoUploadRefusal(photos(1000, 1), LIMITS), null, 'at the cap')
  assertEquals(
    photoUploadRefusal(photos(1001, 1), LIMITS),
    'too many photos: 1001 sent, at most 1000 per upload',
    'one over the cap',
  )
})

Deno.test('a flood of tiny parts is refused by count, whatever their size', () => {
  const reason = photoUploadRefusal(photos(50_000, 1), LIMITS)
  assertEquals(reason?.startsWith('too many photos'), true)
})

Deno.test('a photo over the per-photo cap is refused, even when the count is fine', () => {
  const parts = [{ size: 1 }, { size: 12_000_001 }, { size: 2 }]
  assertEquals(
    photoUploadRefusal(parts, LIMITS),
    'a photo is 12000001 bytes; the limit is 12000000 bytes per photo',
  )
})

Deno.test('a photo exactly at the per-photo cap is admitted', () => {
  assertEquals(photoUploadRefusal([{ size: 12_000_000 }], LIMITS), null)
})

Deno.test('an empty upload has nothing to refuse', () => {
  assertEquals(photoUploadRefusal([], LIMITS), null)
})
