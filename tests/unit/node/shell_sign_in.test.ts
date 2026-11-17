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
  DESKTOP_RETURN_PREFIX,
  SHELL_RETURN_PREFIX,
  beginShellSignIn,
  createShellPkce,
  finishShellSignIn,
  initShellSignIn,
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

/** How a stand-in server answers a request: its URL and, for a POST, its JSON body. */
type Respond = (url: string, body?: Record<string, unknown>) => Response

/** A shell: an in-memory localStorage, a Browser plugin that records what it opens, and a fetch that answers with `respond`. */
function installShell(respond: Respond) {
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
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      requests.push({ url, body, headers: (init.headers ?? {}) as Record<string, string> })
      return respond(url, body)
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

test("a link to the app without a code of the server's shape is ignored, and the sign-in in progress still finishes", async () => {
  const shell = installShell(() => Response.json({ token: 'session-token' }))
  try {
    await beginShellSignIn()
    const pending = shell.storage.get(PENDING_KEY)
    for (const url of [`${SHELL_RETURN_PREFIX}?code=short`, `${SHELL_RETURN_PREFIX}?error=access_denied`, `${SHELL_RETURN_PREFIX}?code=${'A'.repeat(42)}!`]) {
      assert.equal(await finishShellSignIn(url), null, url)
    }
    assert.equal(shell.requests.length, 0, 'nothing is sent to the server')
    assert.equal(shell.storage.get(PENDING_KEY), pending, 'any web page can open such a link; it does not cancel the sign-in')
    assert.equal(await finishShellSignIn(`${SHELL_RETURN_PREFIX}?code=${CODE}`), true, "the server's return still finishes it")
  } finally {
    shell.restore()
  }
})

/** The server's exchange: each code works once, as in server/portal_auth.ts. */
function singleUseExchange(): Respond {
  const used = new Set<string>()
  return (url, body) => {
    if (!url.endsWith('/authenticate/shell/exchange')) throw new Error(`unexpected request to ${url}`)
    const code = String(body?.['code'])
    if (used.has(code)) return Response.json({ error: 'Sign-in expired. Start again.' }, { status: 400 })
    used.add(code)
    return Response.json({ token: `token-for-${code.slice(0, 1)}`, email: 'a@example.com', name: 'A' })
  }
}

test("a return handed over again, even after newer ones, never takes a later sign-in's verifier", async () => {
  const shell = installShell(singleUseExchange())
  const ret = (letter: string) => `${SHELL_RETURN_PREFIX}?code=${letter.repeat(43)}`
  try {
    // Three sign-ins that finished; the first one's return is the URL that launched the app.
    for (const letter of ['A', 'B', 'C']) {
      await beginShellSignIn()
      assert.equal(await finishShellSignIn(ret(letter)), true, letter)
    }
    // A fourth is out in the browser when a page load hands over the launch URL again.
    await beginShellSignIn()
    const pending = shell.storage.get(PENDING_KEY)
    assert.equal(await finishShellSignIn(ret('A')), null, 'the launch URL is a return the app had already')
    assert.equal(shell.requests.length, 3, 'and it is not sent again')
    assert.equal(shell.storage.get(PENDING_KEY), pending, 'the sign-in in progress keeps its verifier')
    assert.equal(await finishShellSignIn(ret('D')), true, 'its own return finishes it')
  } finally {
    shell.restore()
  }
})

test('the app remembers the latest ten codes, and a launch URL handed over on every page load stays among them', async () => {
  const shell = installShell(singleUseExchange())
  const ret = (n: number) => `${SHELL_RETURN_PREFIX}?code=${String(n).padStart(43, 'x')}`
  try {
    for (let n = 0; n < 12; n++) {
      if (n > 0) assert.equal(await finishShellSignIn(ret(0)), null, 'a page load hands over the launch URL again')
      await finishShellSignIn(ret(n))
    }
    const kept = JSON.parse(shell.storage.get('companion-scan-shell-sign-in-codes') ?? '[]') as string[]
    assert.equal(kept.length, 10)
    assert.ok(kept.includes(String(0).padStart(43, 'x')), 'the launch URL is still known')
    await beginShellSignIn()
    assert.equal(await finishShellSignIn(ret(0)), null)
    assert.ok(shell.storage.has(PENDING_KEY))
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

// ── The desktop app (Tauri): the default browser out, the deep-link plugin back ─────────────

/**
 * A desktop shell: Tauri's globals with the opener and deep-link plugins, storage, and fetch.
 * `launchedWith` is what the deep-link plugin's getCurrent() gives. Pass the `storage` of an
 * earlier install to load another page in the same app.
 */
function installDesktop(respond: Respond, launchedWith: string[] | null = null, storage = new Map<string, string>()) {
  const opened: string[] = []
  const requests: Recorded[] = []
  let deliver: ((urls: string[]) => void) | null = null
  const restores = [
    stubGlobal('Capacitor', undefined),
    stubGlobal('__TAURI_INTERNALS__', {}),
    stubGlobal('__TAURI__', {
      opener: { openUrl: async (url: string) => { opened.push(url) } },
      deepLink: {
        getCurrent: async () => launchedWith,
        onOpenUrl: async (handler: (urls: string[]) => void) => { deliver = handler },
      },
    }),
    stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    }),
    stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      requests.push({ url, body, headers: (init.headers ?? {}) as Record<string, string> })
      return respond(url, body)
    }),
  ]
  return {
    storage,
    opened,
    requests,
    deliver: (urls: string[]) => deliver?.(urls),
    restore: () => restores.forEach((put) => put()),
  }
}

const exchangeOk = (url: string) => {
  if (url.endsWith('/authenticate/shell/exchange')) return Response.json({ token: 'desktop-token', email: 'a@example.com', name: 'A' })
  throw new Error(`unexpected request to ${url}`)
}

test('the desktop return is the scheme the server redirects to and the one the desktop app registers', () => {
  const server = readFileSync(new URL('../../../server/portal_auth.ts', import.meta.url), 'utf8')
  assert.ok(
    server.includes(`export const DESKTOP_RETURN_URL = '${DESKTOP_RETURN_PREFIX}'`),
    'server/portal_auth.ts and src/shared/shell-sign-in.ts must name the same desktop return URL',
  )
  const tauri = JSON.parse(readFileSync(new URL('../../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as {
    plugins?: { 'deep-link'?: { desktop?: { schemes?: string[] } } }
  }
  const scheme = new URL(DESKTOP_RETURN_PREFIX).protocol.slice(0, -1)
  assert.deepEqual(tauri.plugins?.['deep-link']?.desktop?.schemes, [scheme], 'the installers register the scheme the server returns to')
  assert.notEqual(DESKTOP_RETURN_PREFIX, SHELL_RETURN_PREFIX, 'the desktop app has its own scheme')
})

test('desktop: the sign-in path asks the server to return to the desktop app', () => {
  assert.equal(shellSignInPath('B'.repeat(43), 'desktop'), `/authenticate/oidc?shell=desktop&challenge=${'B'.repeat(43)}`)
})

test('desktop: a sign-in opens the default browser, and its return trades the code for a token', async () => {
  const shell = installDesktop(exchangeOk)
  try {
    shell.storage.set('companion-scan-server', 'https://scan.example.ts.net')
    await beginShellSignIn()
    assert.equal(shell.opened.length, 1)
    const opened = new URL(shell.opened[0]!)
    assert.equal(opened.origin, 'https://scan.example.ts.net', 'the saved server, in the system browser')
    assert.equal(opened.searchParams.get('shell'), 'desktop')
    const challenge = opened.searchParams.get('challenge')!

    assert.equal(await finishShellSignIn(`${SHELL_RETURN_PREFIX}?code=${CODE}`), null, "the phone app's return is not this app's")
    assert.equal(await finishShellSignIn(`${DESKTOP_RETURN_PREFIX}?code=${CODE}`), true)
    const exchange = shell.requests[0]!
    assert.equal(exchange.url, 'https://scan.example.ts.net/authenticate/shell/exchange')
    assert.equal(await s256(exchange.body?.['verifier'] as string), challenge)
    assert.equal(shell.storage.get(TOKEN_KEY), 'desktop-token')
  } finally {
    shell.restore()
  }
})

test('desktop: a return delivered while the app runs is finished, and so is one that launched it', async () => {
  const running = installDesktop(exchangeOk)
  try {
    const results: boolean[] = []
    await beginShellSignIn()
    await initShellSignIn((signedIn) => { results.push(signedIn) })
    running.deliver([`${DESKTOP_RETURN_PREFIX}?code=${CODE}`])
    await new Promise((settle) => setTimeout(settle, 20))
    assert.deepEqual(results, [true])
    running.deliver([`${DESKTOP_RETURN_PREFIX}?code=${CODE}`])
    await new Promise((settle) => setTimeout(settle, 20))
    assert.deepEqual(results, [true], 'the same link again is ignored')
  } finally {
    running.restore()
  }

  const cold = installDesktop(exchangeOk, [`${DESKTOP_RETURN_PREFIX}?code=${CODE}`])
  try {
    cold.storage.set(PENDING_KEY, JSON.stringify({ verifier: 'v'.repeat(43), startedAt: Date.now() }))
    const results: boolean[] = []
    await initShellSignIn((signedIn) => { results.push(signedIn) })
    await new Promise((settle) => setTimeout(settle, 20))
    assert.deepEqual(results, [true], 'the link that started the app finishes the sign-in')
  } finally {
    cold.restore()
  }
})

test("desktop: the plugin's last link, handed to a page loaded during the next sign-in, does not end that sign-in", async () => {
  const storage = new Map<string, string>()
  const settle = () => new Promise((done) => setTimeout(done, 20))
  const first = `${DESKTOP_RETURN_PREFIX}?code=${CODE}`
  const exchange = singleUseExchange()
  const page = installDesktop(exchange, null, storage)
  try {
    const results: boolean[] = []
    await beginShellSignIn()
    await initShellSignIn((signedIn) => { results.push(signedIn) })
    page.deliver([first])
    await settle()
    assert.deepEqual(results, [true], 'the first sign-in finishes')
  } finally {
    page.restore()
  }

  // The person signs in again, and opens Scan a Place and comes back while the browser is out. The
  // deep-link plugin keeps the last link for the life of the process, so the new page gets the first again.
  const later = installDesktop(exchange, [first], storage)
  try {
    const results: boolean[] = []
    await beginShellSignIn()
    const challenge = new URL(later.opened[0]!, 'https://unused.invalid').searchParams.get('challenge')!
    const pending = storage.get(PENDING_KEY)
    await initShellSignIn((signedIn) => { results.push(signedIn) })
    await settle()
    assert.deepEqual(results, [], 'the first return is not finished again')
    assert.equal(later.requests.length, 0, 'and nothing is sent')
    assert.equal(storage.get(PENDING_KEY), pending, 'the sign-in in progress keeps its verifier')

    later.deliver([`${DESKTOP_RETURN_PREFIX}?code=${'B'.repeat(43)}`])
    await settle()
    assert.deepEqual(results, [true], 'its own return finishes it')
    assert.equal(await s256(later.requests[0]!.body?.['verifier'] as string), challenge)
  } finally {
    later.restore()
  }
})

test('desktop: without the opener plugin the sign-in says so instead of pretending to start', async () => {
  const shell = installDesktop(exchangeOk)
  const restore = stubGlobal('__TAURI__', {})
  try {
    await assert.rejects(beginShellSignIn(), /cannot open the system browser/)
    assert.equal(shell.storage.has(PENDING_KEY), false, 'no sign-in is left pending')
  } finally {
    restore()
    shell.restore()
  }
})
