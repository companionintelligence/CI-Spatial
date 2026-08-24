/**
 * Deno unit tests for the capture-session id vocabulary
 * (`src/shared/session-id.ts`) and its server-side path resolution
 * (`session_id.ts`) — ticket
 * docs/factory/07-scan-identity/0002-one-session-identity.md.
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'

import { resolveSessionDir, sessionDirPath } from '../../../session_id.ts'
import {
  isServerSessionId,
  newLocalSessionId,
  newServerSessionId,
  SESSION_ID_RE,
} from '../../../src/shared/session-id.ts'

// ── The vocabulary ─────────────────────────────────────────────────────────

Deno.test('SESSION_ID_RE: accepts a server-minted id, rejects the retired client shape', () => {
  assert(SESSION_ID_RE.test(newServerSessionId()))
  assert(SESSION_ID_RE.test('sess-1787174216556-ab12cd'), 'the pre-UUID server shape must still validate')

  // The whole cutover in one assertion: this named a directory that only the
  // server ever created, and the server never used this prefix.
  assert(!SESSION_ID_RE.test('session-1787174216556'))
  assert(!SESSION_ID_RE.test('session-abc'))
})

Deno.test('SESSION_ID_RE: rejects a local store id, so it can never pose as a server session', () => {
  const local = newLocalSessionId()
  assert(local.startsWith('local-'))
  assert(!SESSION_ID_RE.test(local))
  assert(!isServerSessionId(local))
})

Deno.test('isServerSessionId: narrows away null and undefined', () => {
  assert(!isServerSessionId(null))
  assert(!isServerSessionId(undefined))
  assert(!isServerSessionId(''))
  assert(isServerSessionId(newServerSessionId()))
})

Deno.test('newServerSessionId / newLocalSessionId: unique, and use the id house style', () => {
  const ids = new Set(Array.from({ length: 64 }, () => newServerSessionId()))
  assertEquals(ids.size, 64, 'server ids must not collide')

  const locals = new Set(Array.from({ length: 64 }, () => newLocalSessionId()))
  assertEquals(locals.size, 64, 'local ids must not collide')

  // The retired server id used Math.random(); every other id in the repo uses
  // crypto.randomUUID(), and so does this one now.
  assert(/^sess-[0-9a-f-]{36}$/.test(newServerSessionId()))
})

Deno.test('SESSION_ID_RE: path traversal and separators stay rejected', () => {
  // The id becomes a directory name under SESSIONS_DIR, so this regex is also
  // the path-safety guard.
  for (
    const bad of [
      'sess-../../etc/passwd',
      'sess-..',
      'sess-a/b',
      'sess-a\\b',
      'sess-A-UPPER',
      'sess-a b',
      'sess-',
      'sess',
      '../sess-a',
      'sess-a.b',
      'sess-a\0b',
    ]
  ) {
    assert(!SESSION_ID_RE.test(bad), `${JSON.stringify(bad)} must not validate`)
  }
})

// ── Server-side path resolution ────────────────────────────────────────────

Deno.test('sessionDirPath: shape only — builds a path without proving it exists', () => {
  const id = newServerSessionId()
  assertEquals(sessionDirPath('/data/sessions', id), `/data/sessions/${id}`)
  assertEquals(sessionDirPath('/data/sessions', 'session-1787174216556'), null)
  assertEquals(sessionDirPath('/data/sessions', null), null)
  assertEquals(sessionDirPath('/data/sessions', undefined), null)
})

Deno.test('resolveSessionDir: null for a well-formed id with no directory behind it', async () => {
  const root = await Deno.makeTempDir({ prefix: 'session-id-' })
  try {
    const real = newServerSessionId()
    const phantom = newServerSessionId()
    await Deno.mkdir(`${root}/${real}`)

    // The defect this ticket exists for: `phantom` is perfectly well-formed.
    // Only existence separates it from `real`.
    assertEquals(await resolveSessionDir(root, real), `${root}/${real}`)
    assertEquals(await resolveSessionDir(root, phantom), null)
    assertEquals(await resolveSessionDir(root, 'session-1787174216556'), null)
    assertEquals(await resolveSessionDir(root, null), null)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('resolveSessionDir: a plain file with a session id name is not a session', async () => {
  const root = await Deno.makeTempDir({ prefix: 'session-id-file-' })
  try {
    const id = newServerSessionId()
    await Deno.writeTextFile(`${root}/${id}`, 'not a directory')
    assertEquals(await resolveSessionDir(root, id), null)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('resolveSessionDir: a missing sessions root resolves to null, not a throw', async () => {
  const root = await Deno.makeTempDir({ prefix: 'session-id-gone-' })
  await Deno.remove(root, { recursive: true })
  assertEquals(await resolveSessionDir(root, newServerSessionId()), null)
})
