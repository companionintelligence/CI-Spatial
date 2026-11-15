/**
 * The shell's session token goes to the Scan server the person saved, and follows it
 * when it changes (src/shared/shell-sign-in.ts installShellSession, reading
 * src/shared/api-base.ts). In a file of its own because the wrapper installs once per
 * page, and shell_session.test.ts installs it with a fixed server.
 *
 * Run: npm run test:shell-session
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SHELL_SESSION_KEY, saveServerAddress } from '../../../src/shared/api-base.ts'
import { installShellSession } from '../../../src/shared/shell-sign-in.ts'
import { SCAN_SERVER_KEY } from '../../../src/shared/storage-keys.ts'

test('the token goes to the saved server only, and a new server gets none of the old one', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  const storage = new Map<string, string>()
  const sent: Array<{ url: string; auth: string | null }> = []
  const originalFetch = globalThis.fetch
  g['__TAURI_INTERNALS__'] = {}
  g['localStorage'] = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization') })
    return new Response('{}')
  }) as typeof fetch
  try {
    installShellSession()
    await globalThis.fetch('https://a.example.ts.net/projects')
    assert.equal(sent.at(-1)?.auth, null, 'no server saved, no token')

    storage.set(SCAN_SERVER_KEY, 'https://a.example.ts.net')
    storage.set(SHELL_SESSION_KEY, 'token-for-a')
    await globalThis.fetch('https://a.example.ts.net/projects')
    assert.equal(sent.at(-1)?.auth, 'Bearer token-for-a')
    await globalThis.fetch('https://a.example.ts.net.evil.example/projects')
    assert.equal(sent.at(-1)?.auth, null, 'a longer host is another origin')

    saveServerAddress('https://b.example.ts.net')
    await globalThis.fetch('https://b.example.ts.net/projects')
    assert.equal(sent.at(-1)?.auth, null, "b gets no token, least of all a's")
    await globalThis.fetch('https://a.example.ts.net/projects')
    assert.equal(sent.at(-1)?.auth, null, 'and a is no longer the server')
  } finally {
    globalThis.fetch = originalFetch
    delete g['__TAURI_INTERNALS__']
    delete g['localStorage']
  }
})
