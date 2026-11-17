/**
 * The line a printed sheet's QR code carries: which tag family it belongs to, which tag, which
 * Place and room, and how big the black square was printed.
 *
 * Why a QR code at all, when the tag already carries its id: the id alone says nothing about where
 * the sheet hangs. The Place, the room and the printed size are what turn "tag 7" into "the kitchen
 * doorway, 200 mm", and the printed size is what makes the pose metric (`tag-pose.ts`). The QR code
 * lets any phone camera app read them off the sheet, and a later step can cross-check them against
 * the tag the detector decoded.
 *
 * Compact JSON with a fixed key order, so a sheet generated twice is byte-identical and the QR code
 * does not change when nothing else did. `parseTagPayload` is strict about what it needs and ignores
 * what it does not know; it never trusts a string it did not validate, because the text arrives from
 * the world.
 *
 * Browser-safe (ADR 0002).
 */
import type { TagPayload } from './types.ts'

/** Longest id string accepted for a Place or room. Adopted, not measured: ids in the repo are UUIDs and slugs, well under this. */
const MAX_ID_LENGTH = 200
/** Largest printed size accepted, millimetres. A sheet bigger than a poster is a typo. Adopted, not measured. */
const MAX_PRINTED_SIZE_MM = 5000

export function serializeTagPayload(payload: TagPayload): string {
  return JSON.stringify({
    v: payload.v,
    family: payload.family,
    tagId: payload.tagId,
    placeId: payload.placeId,
    roomId: payload.roomId,
    printedSizeMm: payload.printedSizeMm,
  })
}

function idText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : null
}

/** The payload a QR code carried, or null when the text is not one this version wrote. */
export function parseTagPayload(text: string): TagPayload | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o['v'] !== 1) return null
  const family = idText(o['family'])
  const placeId = idText(o['placeId'])
  if (family === null || placeId === null) return null
  const tagId = o['tagId']
  if (typeof tagId !== 'number' || !Number.isInteger(tagId) || tagId < 0) return null
  const printedSizeMm = o['printedSizeMm']
  if (typeof printedSizeMm !== 'number' || !Number.isFinite(printedSizeMm) || printedSizeMm <= 0 || printedSizeMm > MAX_PRINTED_SIZE_MM) return null
  const roomRaw = o['roomId']
  const roomId = roomRaw === null || roomRaw === undefined ? null : idText(roomRaw)
  if (roomRaw !== null && roomRaw !== undefined && roomId === null) return null
  return { v: 1, family, tagId, placeId, roomId, printedSizeMm }
}
