/**
 * Deno unit tests for the take id vocabulary.
 *
 * A take id is echoed into a signalling room name and into `session.json`, so
 * the regex is a path-safety guard as much as a format check — these assert the
 * rejections that matter, not just the happy path.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@^1.0.0'
import { isClientId, isTakeId, newClientId, newTakeId, TAKE_ID_RE } from '../../../server/take_id.ts'

Deno.test('newTakeId mints an id its own guard accepts', () => {
  const id = newTakeId()
  assert(id.startsWith('take-'))
  assert(isTakeId(id), `${id} should be a valid take id`)
  assert(TAKE_ID_RE.test(id))
})

Deno.test('newTakeId is unique per call', () => {
  const ids = new Set(Array.from({ length: 64 }, () => newTakeId()))
  assertEquals(ids.size, 64)
})

Deno.test('isTakeId rejects path separators and traversal', () => {
  for (const bad of ['take-../etc', 'take-a/b', 'take-a\\b', '../take-a', 'take-.hidden']) {
    assertFalse(isTakeId(bad), `${bad} must be rejected`)
  }
})

Deno.test('isTakeId rejects a missing or wrong prefix', () => {
  for (const bad of ['abc123', 'sess-abc', 'takes-abc', 'take', 'take-']) {
    assertFalse(isTakeId(bad), `${bad} must be rejected`)
  }
})

Deno.test('isTakeId rejects over-length input', () => {
  assert(isTakeId('take-' + 'a'.repeat(64)))
  assertFalse(isTakeId('take-' + 'a'.repeat(65)))
})

Deno.test('isTakeId narrows unknown — it is applied to parsed JSON', () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assertFalse(isTakeId(bad))
  }
})

Deno.test('client ids are a separate namespace from take ids', () => {
  const client = newClientId()
  assert(isClientId(client))
  assertFalse(isTakeId(client), 'a client id must never validate as a take id')
  assertFalse(isClientId(newTakeId()), 'a take id must never validate as a client id')
})
