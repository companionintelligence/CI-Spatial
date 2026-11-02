/**
 * The shell sign-in client (src/shared/shell-sign-in.ts): the PKCE pair it makes,
 * the URL it opens, the return it finishes, and the token it keeps. Storage, the
 * Capacitor plugins and fetch are stand-ins, so this runs in Node.
 *
 * Run: npm run test:shell-sign-in
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SHELL_RETURN_PREFIX,
  beginShellSignIn,
  createShellPkce,
  finishShellSignIn,
  shellSignInPath,
  shellSignedIn,
} from '../../../src/shared/shell-sign-in.ts'

/** A one-time code has the shape of a PKCE value: 43 base64url characters. */
const CODE = 'A'.repeat(43)
const PENDING_KEY = 'companion-scan-shell-sign-in'
const TOKEN_KEY = 'companion-scan-shell-session'

/** Replaces one global for the duration of a test. Returns the function that puts the original back. */
function stubGlobal(name: string, value: unknown): () => void {
  const had = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  return () => {
    if (had) Object.defineProperty(globalThis, name, had)
    else delete (globalThis as Record<string, unknown>)[name]
  }
}

interface Recorded { url: string; body: Record<string, unknown> | undefined; headers: Record<string, string> }

/** A shell: an in-memory localStorage, a Browser plugin that records what it opens, and a fetch that answers with `respond`. */
function installShell(respond: (url: string) => Response) {
  const storage = new Map<string, string>()
  const opened: string[] = []
  const requests: Recorded[] = []
  let closed = 0
  const restores = [
    stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    }),
    stubGlobal('Capacitor', {
      isNativePlatform: () => true,
      Plugins: {
        Browser: {
          open: async ({ url }: { url: string }) => { opened.push(url) },
          close: async () => { closed++ },
        },
      },
    }),
    stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      requests.push({
        url,
        body: typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined,
        headers: (init.headers ?? {}) as Record<string, string>,
      })
      return respond(url)
    }),
  ]
  return {
    storage,
    opened,
    requests,
    closed: () => closed,
    restore: () => restores.forEach((put) => put()),
  }
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return Buffer.from(digest).toString('base64url')
}

test('the return prefix is the scheme the server redirects to', () => {
  const server = readFileSync(new URL('../../../server/portal_auth.ts', import.meta.url), 'utf8')
  assert.ok(
    server.includes(`export const SHELL_RETURN_URL = '${SHELL_RETURN_PREFIX}'`),
    'server/portal_auth.ts and src/shared/shell-sign-in.ts must name the same return URL',
  )
})

test('the PKCE pair is S256: challenge = base64url(sha256(verifier)), 43 characters each', async () => {
  const { verifier, challenge } = await createShellPkce()
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(challenge, await s256(verifier))
})

test('the sign-in path asks the server for a shell sign-in carrying the challenge', () => {
  const challenge = 'B'.repeat(43)
  assert.equal(shellSignInPath(challenge), `/authenticate/oidc?shell=1&challenge=${challenge}`)
})

test('a URL that is not a return for a sign-in this app started is ignored and sends nothing', async () => {
  const shell = installShell(() => new Response('{}', { status: 200 }))
  try {
    assert.equal(await finishShellSignIn('https://scan.example/?code=x'), null)
    assert.equal(await finishShellSignIn(`${SHELL_RETURN_PREFIX}?code=${CODE}`), null, 'no sign-in was started here')
    assert.equal(shell.requests.length, 0)
  } finally {
    shell.restore()
  }
})

test('a sign-in opens the server in the browser, and its return trades the code for a token the shell keeps', async () => {
  const shell = installShell((url) => {
    if (url.endsWith('/authenticate/shell/exchange')) {
      return Response.json({ token: 'session-token', email: 'a@example.com', name: 'A' })
    }
    if (url.endsWith('/authenticate/whoami')) return Response.json({ email: 'a@example.com' })
    throw new Error(`unexpected request to ${url}`)
  })
  try {
    await beginShellSignIn()
    assert.equal(shell.opened.length, 1)
    const opened = new URL(shell.opened[0]!, 'https://unused.invalid')
    assert.equal(opened.pathname, '/authenticate/oidc')
    assert.equal(opened.searchParams.get('shell'), '1')
    const challenge = opened.searchParams.get('challenge')!

    assert.equal(await finishShellSignIn(`${SHELL_RETURN_PREFIX}?code=${CODE}`), true)
    const exchange = shell.requests[0]!
    assert.equal(exchange.url.endsWith('/authenticate/shell/exchange'), true)
    assert.equal(exchange.body?.['code'], CODE)
    assert.equal(await s256(exchange.body?.['verifier'] as string), challenge, 'only the holder of the verifier can exchange the code')

    assert.equal(await shellSignedIn(), true)
    assert.equal(shell.requests[1]!.headers['Authorization'], 'Bearer session-token')
    assert.equal(shell.storage.get(TOKEN_KEY), 'session-token')

    assert.equal(await finishShellSignIn(`${SHELL_RETURN_PREFIX}?code=${CODE}`), null, 'the same return again is ignored')
    assert.equal(shell.closed(), 1, 'the browser sheet is closed when the app comes back')
  } finally {
    shell.restore()
  }
})

test('an exchange the server refuses is a failed sign-in, and the pending sign-in is dropped', async () => {
  const shell = installShell(() => Response.json({ error: 'Sign-in expired. Start again.' }, { status: 400 }))
  try {
    await beginShellSignIn()
    assert.equal(await finishShellSignIn(`${SHELL_RETURN_PREFIX}?code=${CODE}`), false)
    assert.equal(await finishShellSignIn(`${SHELL_RETURN_PREFIX}?code=${CODE}`), null, 'nothing is pending any more')
    assert.equal(shell.storage.has(TOKEN_KEY), false)
  } finally {
    shell.restore()
  }
})

test('a return with a malformed code fails without contacting the server', async () => {
  const shell = installShell(() => new Response('{}', { status: 200 }))
  try {
    await beginShellSignIn()
    assert.equal(await finishShellSignIn(`${SHELL_RETURN_PREFIX}?code=short`), false)
    assert.equal(shell.requests.length, 0)
  } finally {
    shell.restore()
  }
})

test('a sign-in left pending for more than ten minutes is not finished', async () => {
  const shell = installShell(() => new Response('{}', { status: 200 }))
  try {
    shell.storage.set(PENDING_KEY, JSON.stringify({ verifier: 'v'.repeat(43), startedAt: Date.now() - 11 * 60_000 }))
    assert.equal(await finishShellSignIn(`${SHELL_RETURN_PREFIX}?code=${CODE}`), null)
    assert.equal(shell.requests.length, 0)
  } finally {
    shell.restore()
  }
})

test('a token the server refuses is cleared, so the status row offers sign-in again', async () => {
  const shell = installShell(() => new Response('{}', { status: 403 }))
  try {
    shell.storage.set(TOKEN_KEY, 'stale-token')
    assert.equal(await shellSignedIn(), false)
    assert.equal(shell.storage.has(TOKEN_KEY), false)
  } finally {
    shell.restore()
  }
})

test('outside a shell there is no token to check, and nothing is sent', async () => {
  const shell = installShell(() => new Response('{}', { status: 200 }))
  const restore = stubGlobal('Capacitor', undefined)
  try {
    shell.storage.set(TOKEN_KEY, 'token-in-a-browser')
    assert.equal(await shellSignedIn(), false)
    assert.equal(shell.requests.length, 0)
  } finally {
    restore()
    shell.restore()
  }
})
