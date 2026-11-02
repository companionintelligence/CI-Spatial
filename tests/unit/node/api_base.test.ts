import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveApiUrl, resolveWsUrl } from '../../../src/shared/api-base.ts'

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
