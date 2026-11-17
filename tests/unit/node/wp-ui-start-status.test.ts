/**
 * The start button's 10 s fallback never overwrites a boot failure (publish-readiness fix wave 4, UI-1).
 *
 * index.html starts a timer. It used to write "Still loading. Reload to try again."
 * whenever the Start button was disabled, but showArHelp() and setStartButtonState()
 * disable that button too and write their own reason to the same line. A failure
 * inside those 10 s was therefore replaced by a false "Still loading" label. The
 * timer now writes only while the line still holds the initial "Preparing…" text.
 *
 * The inline script is run here against a small stand-in for the two DOM calls it
 * makes, so the test checks what the script does and not how it is spelled.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-ui-start-status.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const html = readFileSync(join(ROOT, 'index.html'), 'utf8')

const STILL_LOADING = 'Still loading. Reload to try again.'

/** The one inline script that owns the start-button fallback, without its tags. */
function fallbackScript(): string {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '')
  const owners = scripts.filter((body) => body.includes('start-ar-btn'))
  assert.equal(owners.length, 1, 'exactly one inline script owns the start-button fallback')
  return owners[0] ?? ''
}

interface StatusLine { textContent: string }
interface StartButton {
  disabled: boolean
  querySelector(selector: string): StatusLine | null
}

function startButton(disabled: boolean, text: string): { button: StartButton, line: StatusLine } {
  const line: StatusLine = { textContent: text }
  const button: StartButton = {
    disabled,
    querySelector: (selector) => (selector === '.start-path-status' ? line : null),
  }
  return { button, line }
}

/**
 * Runs the fallback as the page would, with `button` as the start button, and fires
 * the timer it set. Returns the delay it asked for.
 */
function runFallback(button: StartButton | null): number {
  const timers: Array<{ run: () => void, ms: number }> = []
  const stubTimeout = (run: () => void, ms: number): number => {
    timers.push({ run, ms })
    return 0
  }
  const doc = { getElementById: (id: string) => (id === 'start-ar-btn' ? button : null) }
  new Function('document', 'setTimeout', fallbackScript())(doc, stubTimeout)
  assert.equal(timers.length, 1, 'the fallback sets exactly one timer')
  const timer = timers[0]
  assert.ok(timer, 'the timer exists')
  timer.run()
  return timer.ms
}

test('the fallback still waits 10 s before it says anything', () => {
  const { button } = startButton(true, 'Preparing…')
  assert.equal(runFallback(button), 10000)
})

test('a button still booting says Still loading once the 10 s pass', () => {
  const { button, line } = startButton(true, 'Preparing…')
  runFallback(button)
  assert.equal(line.textContent, STILL_LOADING)
})

test('a boot failure that wrote its reason inside the 10 s keeps that reason', () => {
  // setStartButtonState('unavailable', headline) leaves the button disabled and puts the headline on the line.
  const { button, line } = startButton(true, 'Not available on this device')
  runFallback(button)
  assert.equal(line.textContent, 'Not available on this device')
})

test('a failed boot that says so is not relabelled either', () => {
  const { button, line } = startButton(true, 'Start failed — reload the page')
  runFallback(button)
  assert.equal(line.textContent, 'Start failed — reload the page')
})

test('a button that is already pressable is left alone', () => {
  // main.ts enables the button in section 0 and leaves the initial line in place.
  const { button, line } = startButton(false, 'Preparing…')
  runFallback(button)
  assert.equal(line.textContent, 'Preparing…')
})

test('a page without the start button writes nothing and does not throw', () => {
  assert.doesNotThrow(() => runFallback(null))
})

test('the guard compares against the exact text the markup ships with', () => {
  // The markup's initial status line is the single source of truth for the copy the guard looks for.
  const initial = html.match(/<span class="start-path-status" aria-live="polite">([^<]*)<\/span>/)
  assert.ok(initial, 'the start button ships a status line')
  assert.equal(initial[1], 'Preparing…')
  assert.ok(
    fallbackScript().includes("=== '" + (initial[1] ?? '') + "'"),
    'the fallback compares against the same text the markup ships with',
  )
})
