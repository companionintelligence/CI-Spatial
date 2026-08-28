/**
 * Priority on the HUD status line.
 *
 * The line reports events; the HUD around it reports state. State is written
 * on a 750 ms scanner tick and events are written once, so with no priority
 * state always won — tapping Capture on a real device produced no visible
 * feedback at all, because the accurate error was painted over before it could
 * be read.
 *
 * The primary fix is structural (per-tick writers moved off `#status-text`
 * entirely — see tests/mock-status-line.spec.ts). These pin the belt to that
 * pair of braces: a sticky write owns the line for a bounded window, and an
 * ordinary write inside it is dropped rather than queued, because a stale tick
 * has nothing worth saying later.
 *
 * Lives in the node suite rather than the Deno one only because the module
 * sits under src/ with the browser code it ships alongside; `StatusNode` is
 * narrow enough that a plain object stands in for the DOM element.
 *
 * Run: npm run test:status-line
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STATUS_HOLD_MS, statusIsHeld, writeStatus, type StatusNode } from '../../../src/ui/status-line.ts'

/** A stand-in for `#status-text` — the only member writeStatus touches. */
const node = (): StatusNode => ({ textContent: null })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('an ordinary write lands when nothing holds the line', () => {
  const el = node()
  writeStatus(el, 'Tracking')
  assert.equal(el.textContent, 'Tracking')
  assert.equal(statusIsHeld(el), false)
})

test('a sticky write survives the 750 ms tick that used to erase it', () => {
  const el = node()
  writeStatus(el, 'On-device model not downloaded yet — open the panel to download it, or switch to Server.', 'sticky')
  // Two scanner ticks' worth of ordinary writes, all inside the hold.
  writeStatus(el, 'Tracking')
  writeStatus(el, '⚠ Moving too fast — slow down')
  assert.equal(
    el.textContent,
    'On-device model not downloaded yet — open the panel to download it, or switch to Server.',
  )
  assert.equal(statusIsHeld(el), true)
})

test('a later sticky write supersedes an earlier one', () => {
  const el = node()
  writeStatus(el, 'Analysing…', 'sticky')
  writeStatus(el, '3 objects detected', 'sticky')
  assert.equal(el.textContent, '3 objects detected')
})

test('the hold expires, so the line is never wedged', async () => {
  const el = node()
  writeStatus(el, 'Capture failed — try again', 'sticky', 40)
  writeStatus(el, 'Tracking')
  assert.equal(el.textContent, 'Capture failed — try again')

  await sleep(60)
  assert.equal(statusIsHeld(el), false)
  writeStatus(el, 'Tracking')
  assert.equal(el.textContent, 'Tracking')
})

test('the hold is per node, so one message cannot mute another line', () => {
  const a = node(), b = node()
  writeStatus(a, 'Capture failed — try again', 'sticky')
  writeStatus(b, 'Tracking')
  assert.equal(b.textContent, 'Tracking')
})

test('a null node is tolerated — the scanner runs on pages without one', () => {
  assert.doesNotThrow(() => writeStatus(null, 'Tracking', 'sticky'))
  assert.equal(statusIsHeld(null), false)
})

test('the default hold outlasts several scanner ticks', () => {
  // DEFAULT_INTERVAL_MS is 750 in src/ar/scanner.ts. A hold shorter than a few
  // of those would put us straight back where we started.
  assert.ok(STATUS_HOLD_MS >= 3 * 750, `STATUS_HOLD_MS=${STATUS_HOLD_MS} is under three scanner ticks`)
})
