/**
 * The place-register matcher runs under Node as well as Deno.
 *
 * server/register/scan_match.ts is pure computation: points in, a proposal out. It
 * is kept free of Deno APIs on purpose, so the same code can be exercised wherever
 * a test or a script wants it, and so a future worker thread or CLI can reuse it
 * without a runtime port. The full behavioural suite is tests/unit/deno/scan_match.test.ts;
 * this file is the proof that the module loads and answers correctly under Node, and
 * the guard that keeps it that way.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-15a-*.test.ts
 * `npm run verify` reaches it through `npm run test:wave`, which runs every wp-*.test.ts here: the name is what wires it in.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { matchScans } from '../../../server/register/scan_match.ts'
import { concatClouds, corners, makeRoom, misplace, recoveryError } from '../../fixtures/place-register/synthetic-room.ts'
import { multiplyMat4 } from '../../../src/world/register-proposal.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const ROOM = { width: 6, depth: 4, centre: { x: 3, z: 2 } } as const
const room = (seed: number, extra: object = {}) => makeRoom({ ...ROOM, noiseM: 0.02, seed, ...extra })

test('under Node: an injected placement error is recovered to under 5 cm and 1 degree', () => {
  const error = { yawDeg: 3, dx: 0.3, dz: -0.2 }
  const result = matchScans({ positions: room(1) }, { positions: misplace(room(2), error) })
  assert.equal(result.status, 'proposed')
  assert.ok(result.transform)
  const recovered = recoveryError(result.transform, error, corners(ROOM))
  assert.ok(recovered.positionM < 0.05, `${recovered.positionM} m`)
  assert.ok(Math.abs(recovered.yawDeg) < 1, `${recovered.yawDeg} deg`)
})

test('under Node: two different rooms return a low score and no transform', () => {
  const elsewhere = makeRoom({ width: 5, depth: 3, centre: { x: 9, z: 7 }, noiseM: 0.02, seed: 5 })
  const result = matchScans({ positions: room(1) }, { positions: elsewhere })
  assert.equal(result.status, 'refused')
  assert.equal(result.transform, null)
  assert.ok(result.score < 0.5)
})

test('under Node: a walk through two rooms against a scan of one of them is proposed whichever scan is new, and the moves undo each other', () => {
  const error = { yawDeg: 3, dx: 0.35, dz: -0.25 }
  const earlier = room(9)
  const walk = misplace(concatClouds(room(2), makeRoom({ width: 5, depth: 5, centre: { x: 15, z: 3 }, noiseM: 0.02, seed: 102 })), error)
  const asNew = matchScans({ positions: earlier }, { positions: walk })
  const asEarlier = matchScans({ positions: walk }, { positions: earlier })
  assert.equal(asNew.status, 'proposed', String(asNew.reason))
  assert.equal(asEarlier.status, 'proposed', String(asEarlier.reason))
  const recovered = recoveryError(asNew.transform!, error, corners(ROOM))
  assert.ok(recovered.positionM < 0.05 && Math.abs(recovered.yawDeg) < 1, `${recovered.positionM} m, ${recovered.yawDeg} deg`)
  const undone = recoveryError(multiplyMat4(asEarlier.transform!, asNew.transform!), { yawDeg: 0, dx: 0, dz: 0 }, corners(ROOM))
  assert.ok(undone.positionM < 0.05 && Math.abs(undone.yawDeg) < 1, `${undone.positionM} m, ${undone.yawDeg} deg`)
})

test('under Node: a corridor is ambiguous, and the answer is the same twice', () => {
  const corridor = { width: 2, depth: 18, centre: { x: 1, z: 9 }, noiseM: 0.02 }
  const reference = makeRoom({ ...corridor, seed: 11, unscanned: ['north', 'south'] })
  const moving = misplace(makeRoom({ ...corridor, seed: 12, unscanned: ['north', 'south'] }), { yawDeg: 1, dx: 0.1, dz: 0.5 })
  const first = matchScans({ positions: reference }, { positions: moving })
  assert.equal(first.reason, 'ambiguous')
  assert.equal(first.transform, null)
  assert.deepEqual(matchScans({ positions: reference }, { positions: moving }), first)
})

test('the matcher source names no Deno API and imports nothing but the shared proposal types', () => {
  const source = readFileSync(join(ROOT, 'server/register/scan_match.ts'), 'utf8')
  // Comments may talk about Deno; code may not touch it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\bDeno\b/)
  assert.doesNotMatch(code, /\bprocess\./)
  assert.doesNotMatch(code, /from 'node:/)
  const imports = [...code.matchAll(/^import\b[^;]*?from\s+'([^']+)'/gm)].map((match) => match[1])
  assert.deepEqual(imports, ['../../src/world/register-proposal.ts'])
})
