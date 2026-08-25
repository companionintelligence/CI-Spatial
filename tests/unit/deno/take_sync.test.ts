/**
 * Deno unit tests for take clock-sync aggregation.
 *
 * The load-bearing assertion here is the *absence* of a residual on the solo
 * path. A zero would read as a perfect measurement of a quantity that does not
 * exist for one client, which is the exact defect ADR 0005 rule 3 is about.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@^1.0.0'
import { buildTakeSync, exchangeFailed, residualOf, withinTolerance } from '../../../server/world/take_sync.ts'
import { DEFAULT_SYNC_TOLERANCE_MS } from '../../../src/world/types.ts'

const AT = '2026-08-24T12:00:00.000Z'

Deno.test('residual is the half-width of the member spread', () => {
  assertEquals(residualOf([100, 180]), 40)
  assertEquals(residualOf([-20, 0, 20]), 20)
  assertEquals(residualOf([5, 5, 5]), 0)
})

Deno.test('a single member has no inter-member residual to compute', () => {
  assertEquals(residualOf([42]), 0)
  assertEquals(residualOf([]), 0)
})

Deno.test('a solo take is unsynced and carries no residual field at all', () => {
  const out = buildTakeSync([{ clientId: 'client-a', offsetMs: 12, sampleCount: 11 }], AT, { expectedMembers: 1 })
  const sync = out.get('client-a')!
  assertEquals(sync.method, 'unsynced')
  if (sync.method === 'unsynced') assertEquals(sync.reason, 'solo-take')
  // The union makes this unstateable at the type level; assert it at runtime too,
  // because the record is persisted and read back as untyped JSON.
  assertFalse('residualMs' in sync, 'a solo take must not carry a residual')
  assertFalse('offsetMs' in sync, 'a solo take must not carry an offset')
})

Deno.test('a take that expected peers and got none says so distinctly', () => {
  const out = buildTakeSync([{ clientId: 'client-a', offsetMs: 12, sampleCount: 11 }], AT, { expectedMembers: 3 })
  const sync = out.get('client-a')!
  if (sync.method === 'unsynced') assertEquals(sync.reason, 'insufficient-peers')
  else throw new Error('expected unsynced')
})

Deno.test('two members produce a measured record for each, sharing one residual', () => {
  const out = buildTakeSync([
    { clientId: 'client-a', offsetMs: 100, sampleCount: 11 },
    { clientId: 'client-b', offsetMs: 140, sampleCount: 9 },
  ], AT)
  const a = out.get('client-a')!
  const b = out.get('client-b')!
  assertEquals(a.method, 'measured')
  assertEquals(b.method, 'measured')
  if (a.method !== 'measured' || b.method !== 'measured') throw new Error('expected measured')
  // Offsets are per device...
  assertEquals(a.offsetMs, 100)
  assertEquals(b.offsetMs, 140)
  // ...the residual is shared, because it describes the take, not a member.
  assertEquals(a.residualMs, 20)
  assertEquals(b.residualMs, 20)
  assertEquals(a.sampleCount, 11)
  assertEquals(b.sampleCount, 9)
  assertEquals(a.toleranceMs, DEFAULT_SYNC_TOLERANCE_MS)
})

Deno.test('three members residual is driven by the extremes, not the mean', () => {
  const out = buildTakeSync([
    { clientId: 'client-a', offsetMs: 0, sampleCount: 11 },
    { clientId: 'client-b', offsetMs: 5, sampleCount: 11 },
    { clientId: 'client-c', offsetMs: 200, sampleCount: 11 },
  ], AT)
  const a = out.get('client-a')!
  if (a.method !== 'measured') throw new Error('expected measured')
  assertEquals(a.residualMs, 100)
  assertFalse(withinTolerance(a), 'a 100ms residual must not pass a 50ms tolerance')
})

Deno.test('withinTolerance is false for every unsynced record, including solo', () => {
  const solo = buildTakeSync([{ clientId: 'client-a', offsetMs: 1, sampleCount: 3 }], AT, { expectedMembers: 1 })
  assertFalse(withinTolerance(solo.get('client-a')))
  assertFalse(withinTolerance(exchangeFailed(AT)))
  assertFalse(withinTolerance(null))
  assertFalse(withinTolerance(undefined))
})

Deno.test('a good take passes tolerance', () => {
  const out = buildTakeSync([
    { clientId: 'client-a', offsetMs: 10, sampleCount: 11 },
    { clientId: 'client-b', offsetMs: 30, sampleCount: 11 },
  ], AT)
  assert(withinTolerance(out.get('client-a')))
})

Deno.test('exchangeFailed is unsynced with its own reason', () => {
  const sync = exchangeFailed(AT)
  assertEquals(sync.method, 'unsynced')
  if (sync.method === 'unsynced') assertEquals(sync.reason, 'exchange-failed')
  assertFalse('residualMs' in sync)
})
