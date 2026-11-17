/**
 * PRE8-5 and PRE8-6: the claims the budget and the copy checks make about the
 * start screen are pinned against the markup and the source they describe.
 *
 *   - The `.start-path-status` line is not counted. renderCaptureChoice() never
 *     writes it; setStartButtonState() does; CSS shows it only while the start
 *     button is disabled. So it is absent from the static chrome the budget reads.
 *   - The insecure page returns before the boot probe, so the insecure line is
 *     never written at boot. It is still checked, because probeVerdict() can
 *     return it.
 *
 * Source-level checks, in the same style as showArHelpLinesMissingFrom(): they
 * read the files the claims are about, and fail when those files stop saying what
 * the comments say.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-pre8-budget-claims.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readStaticCopy } from '../../support/startup-budget.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const mainSource = readFileSync(REPO_ROOT + 'src/main.ts', 'utf8')
const indexSource = readFileSync(REPO_ROOT + 'index.html', 'utf8')

/** The body of a top-level function in main.ts: from its opening brace to the closing brace at column 0. */
function functionBody(source: string, header: RegExp): string {
  const m = header.exec(source)
  assert.ok(m, 'main.ts no longer has ' + header.source + ': update this check')
  const start = (m.index ?? 0) + m[0].length
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, 'the function body for ' + header.source + ' has no closing brace at column 0')
  return source.slice(start, end)
}

test('the status line is not in the static copy the budget counts', () => {
  // The AR card is a skipped subtree (METHOD_CONTROLS), and "Preparing…" is its default.
  const copy = readStaticCopy(indexSource)
  assert.doesNotMatch(copy.chromeText, /Preparing/)
  assert.match(indexSource, /<span class="start-path-status" aria-live="polite">Preparing…<\/span>/)
})

test('renderCaptureChoice() never writes the start-path-status line', () => {
  const body = functionBody(mainSource, /function renderCaptureChoice\(\): void \{/)
  assert.doesNotMatch(body, /start-path-status/)
  // What it does write is the title and the action-and-result sub-label of each card.
  assert.match(body, /\.start-path-title/)
  assert.match(body, /\.start-path-sub/)
})

test('setStartButtonState() is the writer of the start-path-status line', () => {
  const body = functionBody(mainSource, /function setStartButtonState\([^)]*\): void \{/)
  assert.match(body, /start-path-status/)
})

test('the status line is shown only while the start button is disabled', () => {
  assert.match(indexSource, /#start-ar-btn \.start-path-status \{\s*display: none;/)
  assert.match(indexSource, /#start-ar-btn:disabled \.start-path-status \{\s*display: block;/)
})

test('the insecure branch returns before the boot probe, so its line is never written at boot', () => {
  const at = mainSource.indexOf('if (!window.isSecureContext) {')
  const probeAt = mainSource.indexOf('const probe = probeVerdict(probeEnv)')
  assert.ok(at >= 0, 'main.ts has no insecure-context branch: update this check')
  assert.ok(probeAt > at, 'the boot probe must come after the insecure branch')
  const end = mainSource.indexOf('\n  }\n', at)
  assert.ok(end > at && end < probeAt, 'the insecure branch must close before the boot probe')
  assert.match(mainSource.slice(at, end), /\n {4}return\s*$/, 'the insecure branch must end in a bare return')
})
