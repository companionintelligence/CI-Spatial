/**
 * Frame generations (ADR 0009), the halves the browser and an older phone meet: the shared rules module that
 * both the server and the capture client import, how the phone's existing frame code reads the server's new
 * answers, and the New Place form's default type (D7).
 *
 * The server's own tests are tests/unit/deno/frame_generations.test.ts (the rules and the compare-and-swap write),
 * scan_carry.test.ts and frame_generations_route.test.ts (the real server over HTTP). What only Node can say is here:
 *
 *  - `src/world/frame-generations.ts` is a file the browser imports, so it holds no Deno reference and imports no
 *    server module (ADR 0002), and the ids the capture client mints with it are frame ids in both shapes;
 *  - a phone built before ids, whose frame code is the code in this tree (src/project/frame-sync.ts), meets the
 *    server's replace rule through the real write function: its override of a Place that has no frame id still
 *    saves, and its override of a Place that has one is a lost race it adopts the server's frame from, with the
 *    sentence the server wrote in the body and nothing it cannot read;
 *  - the New Place form starts on Building, offers the four types once each, and takes its options from the module
 *    a test can read.
 *
 * Run: npm run test:wave (the `wp-` prefix is what that script globs), or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-08s-frame-generations.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adoptFrameOutcome,
  sendSpatialFrame,
  type FrameSyncEnv,
} from '../../../src/project/frame-sync.ts'
import {
  classifyFrameWrite,
  FRAME_HISTORY_LIMIT,
  FRAME_REPLACE_REASONS,
  frameIdOf,
  isInPlaceFrame,
  newFrameId,
  parseFrameReplaces,
} from '../../../src/world/frame-generations.ts'
import { isFrameId } from '../../../src/world/spatial-frame.ts'
import {
  NEW_PLACE_DEFAULT_TYPE,
  NEW_PLACE_TYPE_OPTIONS,
  newPlaceTypeOptionsHtml,
  PLACE_TYPE_LABELS,
} from '../../../src/project/new-place-type.ts'
import { applySpatialFrameWrite } from '../../../server/wp-a-projects.ts'
import type { Project, ProjectSpatialFrame } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sourceOf = (path: string) => readFileSync(join(ROOT, path), 'utf8')

function frame(createdAt: string, separationM: number, frameId?: string): ProjectSpatialFrame {
  return {
    version: 1,
    createdAt,
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: separationM },
    separationM,
    toleranceM: 0.15,
    anchorBearingDeg: null,
    ...(frameId ? { frameId } : {}),
  }
}

// ── The shared module ────────────────────────────────────────────────────────────────────────────

test('the rules module is a file the browser imports: no Deno reference, no server module', () => {
  // The code, not the comments that explain why it has none.
  const source = sourceOf('src/world/frame-generations.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(source, /\bDeno\b/, 'ADR 0002: a Deno reference in a file the browser imports')
  assert.doesNotMatch(source, /from\s+['"][^'"]*\bserver\b[^'"]*['"]/, 'it imports no server module')
  assert.doesNotMatch(source, /from\s+['"]node:/, 'and no Node module')
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(imports.sort(), ['../shared/ar-run-id.ts', './spatial-frame.ts', './types.ts'])
})

test('the ids the capture client mints are frame ids, in both shapes, and each is new', () => {
  const uuid = newFrameId()
  assert.ok(isFrameId(uuid) && uuid.length === 36, uuid)
  // An old webview has no randomUUID: the time and random bytes.
  const fallback = newFrameId({ getRandomValues: (buffer) => globalThis.crypto.getRandomValues(buffer as Uint8Array) as never })
  assert.ok(isFrameId(fallback) && fallback.length < 30 && !fallback.includes('.'), fallback)
  const many = new Set(Array.from({ length: 500 }, () => newFrameId({ getRandomValues: (buffer) => globalThis.crypto.getRandomValues(buffer as Uint8Array) as never })))
  assert.equal(many.size, 500, 'no two are the same')
})

test('the rules run in the browser\'s runtime: a client reads what a write is, and builds a `replaces` the server accepts', () => {
  const held = frame('2026-11-16T08:00:00.000Z', 2, 'gen-a')
  const next = frame('2026-11-16T09:00:00.000Z', 3, newFrameId())
  assert.equal(classifyFrameWrite(null, next), 'first')
  assert.equal(classifyFrameWrite(held, next), 'new-generation', 'the client sends `replaces` for this one')
  const replaces = { frameId: frameIdOf(held), reason: FRAME_REPLACE_REASONS[0] }
  assert.deepEqual(parseFrameReplaces(replaces), { ok: true, replaces })
  const projects: Project[] = [{ projectId: 'proj-1', name: 'Home', createdAt: 1, updatedAt: 1, floors: [], spatialFrame: held, spatialFrameRevision: 1 }]
  const written = applySpatialFrameWrite(projects, 'proj-1', { frame: next, expectedRevision: 1, replaces }, Date.parse('2026-11-17T12:00:00.000Z'))
  assert.equal(written.result.status, 200)
  assert.equal(projects[0]!.frameHistory?.[0]?.frameId, 'gen-a')
  assert.equal(FRAME_HISTORY_LIMIT, 20)
  assert.equal(isInPlaceFrame({ calibrationMethod: 'two-point-ground', calibrationStatus: 'verified' }), true)
  assert.equal(isInPlaceFrame({ calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional' }), false)
})

// ── A phone built before ids, against the server's rule ──────────────────────────────────────────

/** The server's write function behind `fetch`, as the route calls it: this tree's client code against this tree's rule. */
function link(projects: Project[]): { env: FrameSyncEnv; bodies: unknown[] } {
  const bodies: unknown[] = []
  const env: FrameSyncEnv = {
    fetchFn: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as unknown
      bodies.push(body)
      const reply = applySpatialFrameWrite(projects, 'proj-1', body, Date.parse('2026-11-17T12:00:00.000Z')).result
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
    },
    url: (path) => path,
    now: () => 0,
    online: () => true,
  }
  return { env, bodies }
}

const place = (extra: Partial<Project>): Project => ({ projectId: 'proj-1', name: 'Home', createdAt: 1, updatedAt: 1, floors: [], ...extra })

test('a phone built before ids still overrides a Place whose frame has no id, and the server records nothing it cannot name', async () => {
  const projects = [place({ spatialFrame: frame('2026-11-16T08:00:00.000Z', 2), spatialFrameRevision: 1 })]
  const { env, bodies } = link(projects)
  const outcome = await sendSpatialFrame(env, 'proj-1', frame('2026-11-16T09:00:00.000Z', 3), 1)
  assert.equal(outcome.status, 'saved')
  assert.deepEqual(Object.keys(bodies[0] as object).sort(), ['expectedRevision', 'frame'], 'its body is the one it always sent')
  assert.equal(projects[0]!.spatialFrameRevision, 2)
  assert.equal(projects[0]!.frameHistory, undefined)
})

test('a phone built before ids that overrides a Place whose frame has an id is told it lost, and adopts the frame the Place holds', async () => {
  const held = frame('2026-11-16T08:00:00.000Z', 2, 'gen-a')
  const projects = [place({ spatialFrame: held, spatialFrameRevision: 1 })]
  const { env } = link(projects)
  const outcome = await sendSpatialFrame(env, 'proj-1', frame('2026-11-16T09:00:00.000Z', 3), 1)
  // The same outcome as a lost race, so its existing code shows "This Place already has a different alignment" and
  // stops stamping the scans that follow with the frame the server refused.
  assert.equal(outcome.status, 'conflict')
  assert.deepEqual(outcome.status === 'conflict' && outcome.current, { frame: held, revision: 1 })
  const copy = place({})
  adoptFrameOutcome(copy, outcome)
  assert.deepEqual([copy.spatialFrame, copy.spatialFrameRevision], [held, 1])
  assert.equal(projects[0]!.spatialFrame, held, 'the Place keeps its generation')
  assert.equal(projects[0]!.frameHistory, undefined)
})

test('the refusal carries a sentence a person can read, which a client that predates it does not need', () => {
  const projects = [place({ spatialFrame: frame('2026-11-16T08:00:00.000Z', 2, 'gen-a'), spatialFrameRevision: 1 })]
  const refused = applySpatialFrameWrite(projects, 'proj-1', { frame: frame('2026-11-16T09:00:00.000Z', 3), expectedRevision: 1 }, 1).result
  assert.equal(refused.status, 409)
  const body = refused.body as { error: string; code: string }
  assert.equal(body.code, 'replaces-required')
  assert.ok(body.error.length > 20 && body.error.length < 140 && /^[A-Z]/.test(body.error) && body.error.endsWith('.'), body.error)
})

// ── D7: the New Place form ───────────────────────────────────────────────────────────────────────

test('the New Place form starts on Building, so a house is one Place with its rooms as Areas and not a chain of Places', () => {
  assert.equal(NEW_PLACE_DEFAULT_TYPE, 'building')
  assert.notEqual(NEW_PLACE_DEFAULT_TYPE, 'room', 'the default it replaced')
  const html = newPlaceTypeOptionsHtml()
  assert.deepEqual(NEW_PLACE_TYPE_OPTIONS.map((option) => option.value), ['building', 'floor', 'room', 'other'], 'all four are still offered, in the order they were')
  for (const { value, label } of NEW_PLACE_TYPE_OPTIONS) {
    assert.equal([...html.matchAll(new RegExp(`<option value="${value}"[^>]*>${label}</option>`, 'g'))].length, 1, value)
  }
  assert.equal([...html.matchAll(/ selected/g)].length, 1, 'exactly one is selected')
  assert.match(html, /<option value="building" selected>Building<\/option>/)
  assert.match(newPlaceTypeOptionsHtml('room'), /<option value="room" selected>Room<\/option>/, 'and a caller may choose another')
  assert.doesNotMatch(newPlaceTypeOptionsHtml('room'), /value="building" selected/)
})

test('source shape: the scanner\'s New Place form takes its type list from the module, and no option carries its own `selected`', () => {
  const main = sourceOf('src/main.ts')
  const form = main.slice(main.indexOf('<select id="place-new-type"'), main.indexOf('</select>', main.indexOf('<select id="place-new-type"')))
  assert.ok(form.includes('${newPlaceTypeOptionsHtml()}'), 'the options come from the module')
  assert.doesNotMatch(form, /<option/, 'no option is written into the template')
  assert.match(main, /import \{ newPlaceTypeOptionsHtml \} from '\.\/project\/new-place-type\.ts'/)
})

test('the New Place name field suggests a building, as the type beside it does, and not a room', () => {
  const main = sourceOf('src/main.ts')
  const field = /<input id="place-new-name"[^>]*>/.exec(main)?.[0] ?? ''
  assert.match(field, /placeholder="e\.g\. Our house"/)
  // The Area form, which is where a room is named, keeps its own example.
  assert.match(main, /<input id="place-area-name"[^>]*placeholder="e\.g\. Living room"/)
})

test('the words for the four Place types are in one table: the form lists them and the Place picker names a level by them', () => {
  assert.deepEqual(PLACE_TYPE_LABELS, { building: 'Building', floor: 'Floor', room: 'Room', other: 'Other' })
  for (const { value, label } of NEW_PLACE_TYPE_OPTIONS) assert.equal(PLACE_TYPE_LABELS[value], label, value)
  const viewer = sourceOf('src/viewer/viewer.ts')
  assert.match(viewer, /import \{ PLACE_TYPE_LABELS \} from '\.\.\/project\/new-place-type'/, 'the picker takes the table from the form\'s module')
  assert.doesNotMatch(viewer, /const PLACE_TYPE_LABELS/, 'and keeps no copy of its own')
})
