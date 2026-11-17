/**
 * MAIN10-3: a read-only scanner tab must not flush the offline upload queue.
 *
 * src/pwa.ts cannot be imported under node (it reads import.meta.env), so these
 * checks read the source, the same way the other wp-main tests do.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pwa = readFileSync(new URL('../../../src/pwa.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('../../../src/main.ts', import.meta.url), 'utf8')

test('source shape: MAIN10-3 registerPWA takes an option that defaults to flushing', () => {
  assert.match(pwa, /export function registerPWA\(options: \{ flushQueue\?: boolean \} = \{\}\): void/)
  assert.match(pwa, /const flushQueue = options\.flushQueue !== false/)
})

test('source shape: MAIN10-3 the online listener and the first flush sit behind the option', () => {
  assert.match(pwa, /if \(flushQueue\) \{\s*window\.addEventListener\('online', flush\)\s*flush\(\)\s*\}/)
})

test('source shape: MAIN10-3 the scanner passes flushQueue false only when its tab is read-only', () => {
  assert.match(main, /registerPWA\(\{ flushQueue: !readOnlyScanner \}\)/)
})
