import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SHELL_SESSION_KEY, shellSessionToken, withSessionToken } from '../../../src/shared/api-base.ts'
import { installShellSession } from '../../../src/shared/shell-sign-in.ts'

test('withSessionToken: no token leaves the URL as it is', () => {
  assert.equal(withSessionToken('wss://scan.example/events', null), 'wss://scan.example/events')
})

test('withSessionToken: adds the token as a query parameter', () => {
  assert.equal(withSessionToken('wss://scan.example/events', 'abc'), 'wss://scan.example/events?token=abc')
})

test('withSessionToken: keeps an existing query and encodes the token', () => {
  assert.equal(
    withSessionToken('/rtc-signal?role=phone&room=r1', 'a+b/c'),
    '/rtc-signal?role=phone&room=r1&token=a%2Bb%2Fc',
  )
})

test('shellSessionToken: no token outside a native shell, even when storage holds one', () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.localStorage = { getItem: (key: string) => (key === SHELL_SESSION_KEY ? 'stored-token' : null) }
  try {
    assert.equal(shellSessionToken(), null)
  } finally {
    delete g.localStorage
  }
})

test('shellSessionToken: returns the stored token inside a native shell', () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.Capacitor = { isNativePlatform: () => true }
  g.localStorage = { getItem: (key: string) => (key === SHELL_SESSION_KEY ? 'stored-token' : null) }
  try {
    assert.equal(shellSessionToken(), 'stored-token')
  } finally {
    delete g.Capacitor
    delete g.localStorage
  }
})

test('shellSessionToken: blocked storage reads as no token', () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.Capacitor = { isNativePlatform: () => true }
  g.localStorage = { getItem: () => { throw new Error('blocked') } }
  try {
    assert.equal(shellSessionToken(), null)
  } finally {
    delete g.Capacitor
    delete g.localStorage
  }
})

test('installShellSession: the Bearer token reaches fetch and XHR requests to the server, and no other origin', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  const originalFetch = globalThis.fetch
  const sent: Array<{ url: string; auth: string | null }> = []
  class FakeXHR {
    headers: Record<string, string> = {}
    open(_method: string, _url: string) {}
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value
    }
  }
  g.Capacitor = { isNativePlatform: () => true }
  g.localStorage = { getItem: (key: string) => (key === SHELL_SESSION_KEY ? 'stored-token' : null) }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization') })
    return new Response('{}')
  }) as typeof fetch
  g.XMLHttpRequest = FakeXHR
  try {
    installShellSession('https://scan.example')
    await globalThis.fetch('https://scan.example/projects')
    await globalThis.fetch('https://other.example/projects')
    const toServer = new FakeXHR()
    toServer.open('POST', 'https://scan.example/ingest-photos')
    const toOther = new FakeXHR()
    toOther.open('POST', 'https://other.example/ingest-photos')
    assert.equal(sent[0]?.auth, 'Bearer stored-token')
    assert.equal(sent[1]?.auth, null)
    assert.equal(toServer.headers.Authorization, 'Bearer stored-token')
    assert.equal(toOther.headers.Authorization, undefined)
  } finally {
    globalThis.fetch = originalFetch
    delete g.XMLHttpRequest
    delete g.Capacitor
    delete g.localStorage
  }
})
