/**
 * Where the Scan server is, as seen from the page (src/shared/api-base.ts): the URL
 * helpers, and the server address a native shell keeps on the device. Storage, the
 * shell globals and `location` are stand-ins, so this runs in Node.
 *
 * Run: npm run test:api-base
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SCAN_SERVER_CHANGE_EVENT,
  SHELL_SESSION_KEY,
  SHELL_SIGN_IN_PENDING_KEY,
  apiBase,
  apiCredentials,
  apiUrl,
  editorPath,
  isDesktopShell,
  isNativeShell,
  parseServerAddress,
  resolveApiCredentials,
  resolveApiUrl,
  resolveWsUrl,
  saveServerAddress,
  savedServerAddress,
  wsUrl,
} from '../../../src/shared/api-base.ts'
import { SCAN_SERVER_KEY } from '../../../src/shared/storage-keys.ts'

const PAGE = { protocol: 'https:', host: 'scan.ci.computer' }

test('no base: server paths and sockets are the page-relative ones the hosted app already uses', () => {
  assert.equal(resolveApiUrl('', '/projects'), '/projects')
  assert.equal(resolveWsUrl('', '/events', PAGE), 'wss://scan.ci.computer/events')
  assert.equal(
    resolveWsUrl('', '/events', { protocol: 'http:', host: 'localhost:8000' }),
    'ws://localhost:8000/events',
  )
})

test('base: server paths get the server origin, and sockets switch to ws(s)', () => {
  const base = 'https://scan.example.ts.net'
  assert.equal(resolveApiUrl(base, '/projects'), 'https://scan.example.ts.net/projects')
  assert.equal(
    resolveApiUrl(base, '/scans/a%20b.glb?token=t'),
    'https://scan.example.ts.net/scans/a%20b.glb?token=t',
  )
  assert.equal(
    resolveWsUrl(base, '/rtc-signal?role=viewer&room=r1', PAGE),
    'wss://scan.example.ts.net/rtc-signal?role=viewer&room=r1',
  )
  assert.equal(
    resolveWsUrl('http://10.0.0.2:8000', '/events', { protocol: 'capacitor:', host: 'localhost' }),
    'ws://10.0.0.2:8000/events',
  )
})

test('absolute and protocol-relative URLs pass through unchanged', () => {
  const base = 'https://scan.example.ts.net'
  assert.equal(resolveApiUrl(base, 'https://other.example/x'), 'https://other.example/x')
  assert.equal(resolveApiUrl(base, '//cdn.example/x.js'), '//cdn.example/x.js')
})

test('credentials: cookies stay first-party without a base, and cross to a configured server', () => {
  assert.equal(resolveApiCredentials(''), 'same-origin')
  assert.equal(resolveApiCredentials('https://scan.example.ts.net'), 'include')
})

// ── The Scan server address a native shell keeps on the device ─────────────────────────────

type Shell = 'browser' | 'capacitor' | 'tauri'

/** Runs `body` as a page in `shell`, with an in-memory localStorage. Puts every global back afterwards. */
function asPage(shell: Shell, body: (storage: Map<string, string>, events: string[]) => void): void {
  const g = globalThis as unknown as Record<string, unknown>
  const storage = new Map<string, string>()
  const events: string[] = []
  const names = ['localStorage', 'Capacitor', '__TAURI_INTERNALS__', 'dispatchEvent', 'location']
  const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  const put = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  put('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  })
  put('dispatchEvent', (event: Event) => { events.push(event.type); return true })
  put('location', { protocol: 'https:', host: 'localhost', origin: 'https://localhost' })
  if (shell === 'capacitor') put('Capacitor', { isNativePlatform: () => true })
  else delete g['Capacitor']
  if (shell === 'tauri') put('__TAURI_INTERNALS__', {})
  else delete g['__TAURI_INTERNALS__']
  try {
    body(storage, events)
  } finally {
    names.forEach((name, i) => {
      const had = saved[i]
      if (had) Object.defineProperty(globalThis, name, had)
      else delete g[name]
    })
  }
}

test('parseServerAddress: a bare host or host:port reads as https, and the result is an origin', () => {
  assert.deepEqual(parseServerAddress('scan.example.ts.net'), { ok: true, origin: 'https://scan.example.ts.net' })
  assert.deepEqual(parseServerAddress('  scan.example.ts.net:8443 '), { ok: true, origin: 'https://scan.example.ts.net:8443' })
  assert.deepEqual(parseServerAddress('HTTPS://Scan.Example.ts.net/'), { ok: true, origin: 'https://scan.example.ts.net' })
  assert.deepEqual(parseServerAddress('https://scan.example.ts.net:443'), { ok: true, origin: 'https://scan.example.ts.net' })
  assert.deepEqual(parseServerAddress('198.51.100.20:8443'), { ok: true, origin: 'https://198.51.100.20:8443' })
})

test('parseServerAddress: only https, and only an origin, is accepted', () => {
  const problem = (input: string, own?: string) => {
    const parsed = parseServerAddress(input, own)
    return parsed.ok ? 'ok' : parsed.problem
  }
  assert.equal(problem(''), 'empty')
  assert.equal(problem('   '), 'empty')
  assert.equal(problem('http://scan.example.ts.net'), 'not-https', 'plain http is refused, not upgraded')
  assert.equal(problem('ws://scan.example.ts.net'), 'not-https')
  assert.equal(problem('ftp://scan.example.ts.net'), 'not-https')
  assert.equal(problem('https://scan.example.ts.net/editor'), 'has-path', 'a page address is refused, not cut down')
  assert.equal(problem('https://scan.example.ts.net/?token=abc'), 'has-path')
  assert.equal(problem('https://scan.example.ts.net/#x'), 'has-path')
  assert.equal(problem('https://me:secret@scan.example.ts.net'), 'has-credentials')
  assert.equal(problem('https://'), 'not-a-url')
  assert.equal(problem('scan example'), 'not-a-url')
  assert.equal(problem('https://localhost', 'https://localhost'), 'own-origin', "the Android shell's own origin is not a server")
  assert.equal(problem('https://localhost:8443', 'https://localhost'), 'ok', 'another port on this device is')
})

test('a browser never reads a saved address: the public site keeps its page-relative URLs', () => {
  asPage('browser', (storage) => {
    storage.set(SCAN_SERVER_KEY, 'https://scan.example.ts.net')
    assert.equal(isNativeShell(), false)
    assert.equal(apiBase(), '')
    assert.equal(apiUrl('/projects'), '/projects')
    assert.equal(apiCredentials(), 'same-origin')
    assert.equal(wsUrl('/events'), 'wss://localhost/events')
    assert.equal(editorPath('?project=p1'), '/editor?project=p1', 'the server and Pages rewrite /editor')
  })
})

for (const shell of ['capacitor', 'tauri'] as const) {
  test(`${shell}: server paths go to the saved address, and the editor is the bundled file`, () => {
    asPage(shell, (storage) => {
      assert.equal(isNativeShell(), true)
      assert.equal(isDesktopShell(), shell === 'tauri')
      assert.equal(apiBase(), '', 'nothing saved and no build default: no server yet')
      storage.set(SCAN_SERVER_KEY, 'https://scan.example.ts.net')
      assert.equal(savedServerAddress(), 'https://scan.example.ts.net')
      assert.equal(apiUrl('/projects'), 'https://scan.example.ts.net/projects')
      assert.equal(apiCredentials(), 'include')
      storage.set(SHELL_SESSION_KEY, 'tok')
      assert.equal(wsUrl('/events'), 'wss://scan.example.ts.net/events?token=tok')
      assert.equal(editorPath('?project=p1'), '/viewer.html?project=p1', 'a shell has no /editor rewrite')
    })
  })
}

test('a saved value that no longer parses counts as no server', () => {
  asPage('capacitor', (storage) => {
    storage.set(SCAN_SERVER_KEY, 'http://scan.example.ts.net')
    assert.equal(savedServerAddress(), null)
    assert.equal(apiUrl('/projects'), '/projects')
  })
})

test('saving a different server drops the old session and any sign-in in progress, and says so', () => {
  asPage('tauri', (storage, events) => {
    assert.equal(saveServerAddress('https://a.example.ts.net'), true)
    storage.set(SHELL_SESSION_KEY, 'token-for-a')
    storage.set(SHELL_SIGN_IN_PENDING_KEY, '{"verifier":"v"}')

    assert.equal(saveServerAddress('https://a.example.ts.net'), true)
    assert.equal(storage.get(SHELL_SESSION_KEY), 'token-for-a', 'the same server keeps its session')

    assert.equal(saveServerAddress('https://b.example.ts.net'), true)
    assert.equal(storage.get(SCAN_SERVER_KEY), 'https://b.example.ts.net')
    assert.equal(storage.has(SHELL_SESSION_KEY), false, "server a's token must never reach server b")
    assert.equal(storage.has(SHELL_SIGN_IN_PENDING_KEY), false)
    assert.deepEqual(events, [SCAN_SERVER_CHANGE_EVENT, SCAN_SERVER_CHANGE_EVENT, SCAN_SERVER_CHANGE_EVENT])
  })
})

test('saving into blocked storage reports false and changes nothing', () => {
  asPage('capacitor', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: () => null,
        setItem: () => { throw new Error('blocked') },
        removeItem: () => undefined,
      },
    })
    assert.equal(saveServerAddress('https://scan.example.ts.net'), false)
    assert.equal(apiBase(), '')
  })
})
