/**
 * A read-only scanner tab writes nothing at boot (publish-readiness wave 10, package MAIN10, items
 * MAIN10-1, MAIN10-2 and MAIN10-5).
 *
 * main.ts and the two scanner components are DOM modules, so these checks read their source the way
 * the other scanner tests do. Those names start "source shape:". The pure lock decision and its bound
 * are in wp-main9-scanner-lock.test.ts and wp-main10-lock-timeout.test.ts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-main10-read-only-boot.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/** The text from `header` up to the first `next` marker after it. */
function between(source: string, header: string, next: string): string {
  const start = source.indexOf(header)
  assert.ok(start >= 0, header + ' is in the source')
  const end = source.indexOf(next, start + header.length)
  assert.ok(end > start, next + ' comes after it')
  return source.slice(start, end)
}

/** The lines of a block that are code, not comments. */
function codeLines(block: string): string[] {
  return block.split('\n').filter((line) => {
    const text = line.trim()
    return text.length > 0 && !text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*')
  })
}

const uploadSource = () => between(
  read('src/main.ts'),
  'function wireContentUpload(readOnly: boolean): void {',
  '\n/** The three start-screen controls',
)

const tripodSource = () => between(
  read('src/main.ts'),
  'function mountTripodCapture(readOnly: boolean): void {',
  '\nfunction setCaptureBusy(',
)

// ── MAIN10-1: the write paths are wired with the role the page was given ─────────

test('source shape: MAIN10-1: main passes the role into both write paths, and calls neither without it', () => {
  const main = read('src/main.ts')
  assert.match(main, /^  wireContentUpload\(readOnlyScanner\)$/m)
  assert.match(main, /^  mountTripodCapture\(readOnlyScanner\)$/m)
  assert.doesNotMatch(main, /^  wireContentUpload\(\)$/m, 'no call without the role')
  assert.doesNotMatch(main, /^  mountTripodCapture\(\)$/m, 'no call without the role')
})

test('source shape: MAIN10-1: a read-only upload card opens no picker, even before requestPlaceSelection is set', () => {
  const wire = uploadSource()
  const picker = wire.indexOf("requestPlaceSelection(() => input.click(), 'upload')")
  const guard = wire.indexOf('if (readOnly) return')
  const fallback = wire.indexOf('if (progress) progress.textContent = uploadExpectationLine(scanCapability)')
  assert.ok(picker > 0, 'the picker path is still there for a writer')
  assert.ok(guard > picker, 'the role is checked after the picker path')
  assert.ok(fallback > guard, 'and before the fallback that would open the picker directly')
})

test('source shape: MAIN10-1: a read-only page attaches no change handler to the upload input, so a file handed to it is not sent', () => {
  const wire = uploadSource()
  assert.match(
    wire,
    /\/\/ A read-only page sends nothing, so the input gets no change handler \(MAIN10-1\)\.\n  if \(readOnly\) return\n  input\.addEventListener\('change', \(\) => \{/,
    'the check is the last thing before the change handler is attached',
  )
  assert.equal(wire.split("addEventListener('change'").length - 1, 1, 'one change handler, behind the check')
})

test('source shape: MAIN10-1: a read-only tripod card opens no sweep, not even before the picker is wired', () => {
  const tripod = tripodSource()
  assert.match(tripod, /if \(requestPlaceSelection\) requestPlaceSelection\(open, 'tripod'\)\n    else if \(!readOnly\) open\(\)/)
})

// ── MAIN10-2: a read-only page reads the tripod capture and writes none of it ────

test('source shape: MAIN10-2: every tripod clear and spot delete is gated on the role', () => {
  const writes = codeLines(tripodSource()).filter((line) => /\b(clearTripodCapture|deleteTripodSpot)\(/.test(line))
  assert.equal(writes.length, 5, 'the five places a capture is cleared or a spot is deleted')
  for (const line of writes) assert.match(line, /readOnly/, 'gated: ' + line.trim())
})

test('source shape: MAIN10-2: the tripod save sits behind the role check in persist, and is the only save', () => {
  const tripod = tripodSource()
  const at = tripod.indexOf('const persist = (spot?')
  const save = tripod.indexOf('saveTripodCapture(meta, spot)')
  assert.ok(at > 0 && save > at, 'persist saves the capture')
  assert.match(tripod.slice(at, save), /if \(readOnly\) return\n/, 'a read-only page returns before it saves')
  assert.equal(tripod.split('saveTripodCapture(').length - 1, 1, 'the only save is in persist')
})

test('source shape: MAIN10-2: restore reads and renders on a read-only page, and clears nothing for an unusable record', () => {
  const tripod = tripodSource()
  const restore = tripod.slice(tripod.indexOf('const restore = async () => {'), tripod.indexOf('void restore()'))
  assert.match(restore, /const stored = await loadTripodCapture\(\)/, 'restore reads the stored capture')
  assert.match(
    restore,
    /if \(!back\) \{[\s\S]*?if \(!readOnly\) void clearTripodCapture\(\)\n\s+return\n\s+\}/,
    'the clear for a record with no usable photos is gated',
  )
  assert.doesNotMatch(restore, /saveTripodCapture|deleteTripodSpot/, 'restore writes no record and no spot')
})

// ── MAIN10-5: the erase controls are disabled on a read-only page ────────────────

test('source shape: MAIN10-5: a read-only panel disables Clear, with a title that says the scan is open in another tab', () => {
  const panel = read('src/ui/panel.ts')
  assert.match(panel, /const READ_ONLY_CLEAR_TITLE = 'The scan is open in another tab\. Erase it there\.'/)
  const setter = between(panel, '  setReadOnly(): void {', '\n  }\n')
  assert.match(setter, /this\.readOnly = true/)
  assert.match(setter, /clearBtn\.disabled = true/)
  assert.match(setter, /clearBtn\.title = READ_ONLY_CLEAR_TITLE/)
})

test('source shape: MAIN10-5: the Clear handler returns before the confirm, the erase and the scan reset on a read-only page', () => {
  const panel = read('src/ui/panel.ts')
  const handler = panel.slice(panel.indexOf("clearBtn.addEventListener('click', async () => {"))
  const guard = handler.indexOf('if (this.readOnly) return')
  assert.ok(guard > 0, 'the handler checks the role first')
  assert.ok(guard < handler.indexOf('confirm('), 'before the confirm')
  assert.ok(guard < handler.indexOf('this.store.clear()'), 'before the erase')
  assert.ok(guard < handler.indexOf('this.onScanReset?.(erased)'), 'before the scan reset')
})

test('source shape: MAIN10-5: a read-only history drawer disables each delete, with a title that says the scan is open in another tab', () => {
  const history = read('src/ui/history.ts')
  assert.match(history, /const READ_ONLY_DELETE_TITLE = 'The scan is open in another tab, so sessions can be deleted only from there\.'/)
  const build = between(history, 'const delBtn = document.createElement(', 'actions.append(loadBtn, delBtn)')
  assert.match(build, /if \(this\.readOnly\) \{\n\s+delBtn\.disabled = true\n\s+delBtn\.title = READ_ONLY_DELETE_TITLE\n\s+\}/)
  const handler = build.slice(build.indexOf("delBtn.addEventListener('click', async (e) => {"))
  const guard = handler.indexOf('if (this.readOnly) return')
  assert.ok(guard > 0, 'the delete handler checks the role first')
  assert.ok(guard < handler.indexOf('this.store.deleteSession'), 'before the delete')
  assert.ok(guard < handler.indexOf('this.onScanReset(leavingCount)'), 'before the scan reset')
})

test('source shape: MAIN10-5: main sets the erase controls read-only only on a read-only page, after each component is built', () => {
  const main = read('src/main.ts')
  const history = read('src/ui/history.ts')
  assert.match(history, /setReadOnly\(\): void \{\n\s+this\.readOnly = true\n\s+\}/)
  assert.ok(main.indexOf('panel.mount()') < main.indexOf('if (readOnlyScanner) panel.setReadOnly()'), 'after the panel is mounted, which builds Clear')
  assert.match(main, /const history = new SessionHistory\(store, resetScanner\)\n  if \(readOnlyScanner\) history\.setReadOnly\(\)\n  history\.mount\(\)/)
})
