/**
 * F99 (src/shared/shell-sign-in.ts): a token that was not kept is a failed sign-in, and a refusal
 * clears only the token it checked. Storage, Capacitor and fetch are stand-ins, so this runs in Node.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-e-shell-sign-in.test.ts
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  SHELL_RETURN_PREFIX,
  beginShellSignIn,
  finishShellSignIn,
  shellSignedIn,
} from '../../../src/shared/shell-sign-in.ts'

/** A one-time code has the shape of a PKCE value: 43 base64url characters. */
const CODE = 'A'.repeat(43)
const TOKEN_KEY = 'companion-scan-shell-session'

function stubGlobal(t: TestContext, name: string, value: unknown): void {
  const had = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  t.after(() => {
    if (had) Object.defineProperty(globalThis, name, had)
    else delete (globalThis as Record<string, unknown>)[name]
  })
}

/**
 * A shell with in-memory storage and a fetch that answers with `respond`. A write to a key that
 * `refuse` names throws, as blocked or full storage does. `asked` records each request's address.
 */
function installShell(
  t: TestContext,
  respond: (url: string) => Response,
  refuse: (key: string) => boolean = () => false,
) {
  const storage = new Map<string, string>()
  const asked: string[] = []
  stubGlobal(t, 'localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (refuse(key)) throw new Error('storage is full')
      storage.set(key, value)
    },
    removeItem: (key: string) => { storage.delete(key) },
  })
  stubGlobal(t, 'Capacitor', {
    isNativePlatform: () => true,
    Plugins: { Browser: { open: async () => {}, close: async () => {} } },
  })
  stubGlobal(t, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    asked.push(url)
    return respond(url)
  })
  return { storage, asked }
}

test('a token the shell cannot keep is a failed sign-in, not a success', async (t) => {
  const { storage, asked } = installShell(
    t,
    (url) => (url.endsWith('/authenticate/shell/exchange') ? Response.json({ token: 'session-token' }) : new Response('{}', { status: 404 })),
    (key) => key === TOKEN_KEY,
  )
  await beginShellSignIn()
  assert.equal(
    await finishShellSignIn(`${SHELL_RETURN_PREFIX}?code=${CODE}`),
    false,
    'the token was not stored, so the sign-in did not finish',
  )
  assert.equal(storage.has(TOKEN_KEY), false)
  assert.equal(asked.length, 1, 'the code was exchanged, and the save is what failed')
})

test('a token that is kept finishes the sign-in', async (t) => {
  const { storage } = installShell(t, () => Response.json({ token: 'session-token' }))
  await beginShellSignIn()
  assert.equal(await finishShellSignIn(`${SHELL_RETURN_PREFIX}?code=${CODE}`), true)
  assert.equal(storage.get(TOKEN_KEY), 'session-token')
})

test('a refusal of an older token does not erase a newer one stored while the check was in flight', async (t) => {
  const { storage } = installShell(t, () => new Response('{}', { status: 200 }))
  storage.set(TOKEN_KEY, 'old-token')
  const check = (async () => {
    // A sign-in finishes while this check is on the wire, and stores a new token.
    storage.set(TOKEN_KEY, 'new-token')
    return new Response('{}', { status: 401 })
  }) as typeof fetch
  assert.equal(await shellSignedIn(check), false)
  assert.equal(storage.get(TOKEN_KEY), 'new-token')
})

test('a 401 for the token that is still stored clears it', async (t) => {
  const { storage } = installShell(t, () => new Response('{}', { status: 401 }))
  storage.set(TOKEN_KEY, 'old-token')
  assert.equal(await shellSignedIn(), false)
  assert.equal(storage.has(TOKEN_KEY), false)
})

test('an accepted token is kept, and the check says so', async (t) => {
  const { storage, asked } = installShell(t, () => Response.json({ email: 'a@example.com' }))
  storage.set(TOKEN_KEY, 'session-token')
  assert.equal(await shellSignedIn(), true)
  assert.equal(storage.get(TOKEN_KEY), 'session-token')
  assert.equal(asked.length, 1)
})
