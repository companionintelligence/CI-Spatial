/**
 * Unit tests for src/shared/debug-flags.ts.
 *
 * The load-bearing case is backward compatibility: `?debug=remote` armed
 * console mirroring (src/debug/remote-log.ts) via an exact string-equality
 * check before this module existed, and every QR code, doc and habit still
 * uses that URL. Widening the param to a token list must not have changed
 * what it arms — if it did, remote logging breaks silently, which is exactly
 * the failure mode that is hardest to notice while debugging something else.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { hasDebugFlag, parseDebugFlags } from './src/shared/debug-flags.ts'

Deno.test('hasDebugFlag: the legacy ?debug=remote URL still arms remote', () => {
  assertEquals(hasDebugFlag('remote', '?debug=remote'), true)
})

Deno.test('hasDebugFlag: a single flag does not arm the others', () => {
  assertEquals(hasDebugFlag('pose', '?debug=remote'), false)
  assertEquals(hasDebugFlag('remote', '?debug=pose'), false)
})

Deno.test('hasDebugFlag: a list arms every flag it names', () => {
  for (const search of ['?debug=pose,remote', '?debug=remote,pose']) {
    assertEquals(hasDebugFlag('pose', search), true, search)
    assertEquals(hasDebugFlag('remote', search), true, search)
  }
})

Deno.test('hasDebugFlag: tolerates whitespace and casing', () => {
  assertEquals(hasDebugFlag('pose', '?debug= POSE , Remote '), true)
  assertEquals(hasDebugFlag('remote', '?debug= POSE , Remote '), true)
})

Deno.test('hasDebugFlag: absent, empty and unrelated params arm nothing', () => {
  for (const search of ['', '?', '?debug=', '?debug=,', '?debug=,,', '?world=default&mock=1']) {
    assertEquals(hasDebugFlag('pose', search), false, JSON.stringify(search))
    assertEquals(hasDebugFlag('remote', search), false, JSON.stringify(search))
  }
})

Deno.test('hasDebugFlag: an unknown token does not arm a known flag', () => {
  // Guards against a substring/prefix match creeping in — 'remotely' is not 'remote'.
  assertEquals(hasDebugFlag('remote', '?debug=remotely'), false)
  assertEquals(hasDebugFlag('pose', '?debug=poseidon'), false)
})

Deno.test('parseDebugFlags: normalises to lower-case non-empty tokens', () => {
  assertEquals(parseDebugFlags('?debug=Pose,,  REMOTE ,'), ['pose', 'remote'])
  assertEquals(parseDebugFlags('?debug='), [])
  assertEquals(parseDebugFlags(''), [])
})

Deno.test('parseDebugFlags: preserves other params without confusing them for flags', () => {
  assertEquals(parseDebugFlags('?world=default&debug=pose&ar=webxr'), ['pose'])
})
