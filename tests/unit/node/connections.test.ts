import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accountRow,
  memoryRow,
  modelRow,
  toMemory,
  toModel,
  type ConnectionRow,
} from '../../../src/shared/connections.ts'

const SIGN_IN = 'https://scan.example.ts.net/authenticate/oidc?redirect=%2Feditor'

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

test('account: signed in shows who, with nothing to click', () => {
  const row = accountRow({ kind: 'signed-in', name: 'Ada' }, { native: false, signInHref: SIGN_IN })
  assert.equal(row.label, 'Companion Account')
  assert.equal(row.state, 'ok')
  assert.equal(row.text, 'Signed in as Ada')
  assert.equal(row.action, undefined)
})

test('account: signed out in a browser links to the server sign-in', () => {
  const row = accountRow({ kind: 'signed-out' }, { native: false, signInHref: SIGN_IN })
  assert.equal(row.state, 'off')
  assert.equal(row.text, 'Not signed in')
  assert.deepEqual(row.action, { label: 'Sign in', href: SIGN_IN })
})

test('account: signed out in a native shell says to sign in on the web, with no link', () => {
  const row = accountRow({ kind: 'signed-out' }, { native: true, signInHref: SIGN_IN })
  assert.equal(row.text, 'Sign in on the web')
  assert.equal(row.action, undefined)
})

test('account: sign-in off on the server says so, with no link', () => {
  const row = accountRow({ kind: 'off' }, { native: false, signInHref: SIGN_IN })
  assert.equal(row.state, 'off')
  assert.equal(row.text, 'Sign-in is off here')
  assert.equal(row.action, undefined)
})

test('account: a check that could not be made says so', () => {
  const row = accountRow(null, { native: false, signInHref: SIGN_IN })
  assert.equal(row.state, 'unknown')
  assert.equal(row.text, "Can't check")
})

test('memory: connected, unreachable, not connected, and not checked', () => {
  assert.deepEqual(
    memoryRow({ enabled: true, reachable: true }),
    { id: 'memory', label: 'Companion Memory', state: 'ok', text: 'Connected' },
  )
  assert.equal(memoryRow({ enabled: true, reachable: null }).state, 'ok')
  assert.equal(memoryRow({ enabled: true, reachable: false }).state, 'warn')
  const off = memoryRow({ enabled: false, reachable: null })
  assert.equal(off.state, 'off')
  assert.equal(off.text, 'Not connected')
  assert.equal(off.hint, 'Connect it in your Companion Hub')
  assert.equal(memoryRow(null).state, 'unknown')
})

test('model: ready names the model, loading says so, anything else is unavailable', () => {
  assert.equal(modelRow({ model: 'qwen3-vl:4b', ready: true, loading: false }).text, 'qwen3-vl:4b ready')
  assert.equal(modelRow({ model: 'qwen3-vl:4b', ready: false, loading: true }).text, 'Loading qwen3-vl:4b')
  const down = modelRow({ model: 'qwen3-vl:4b', ready: false, loading: false })
  assert.equal(down.state, 'warn')
  assert.equal(down.text, 'Unavailable')
  assert.equal(modelRow({ model: null, ready: true, loading: false }).text, 'Ready')
  assert.equal(modelRow(null).state, 'unknown')
})

test('replies: /health names the model without its engine prefix; a non-JSON or failed reply is not checked', () => {
  const health = { status: 200, body: { model: 'Ollama/llava:7b', modelReady: true, engineLoadState: 'ready' } }
  assert.deepEqual(toModel(health), { model: 'llava:7b', ready: true, loading: false })
  assert.equal(toModel({ status: 503, body: undefined }), null)
  assert.equal(toModel({ status: 200, body: undefined }), null)
  assert.deepEqual(
    toMemory({ status: 200, body: { enabled: true, reachable: false } }),
    { enabled: true, reachable: false },
  )
  assert.equal(toMemory(null), null)
})

test('every row the overlay can draw stays within the copy budget', () => {
  const answers: Array<[ConnectionRow, string]> = []
  for (const kind of ['signed-in', 'signed-out', 'off'] as const) {
    for (const native of [false, true]) {
      // A two-word name is the longest the copy is budgeted for. The name is data, not copy.
      const answer = kind === 'signed-in' ? { kind, name: 'Ada Lovelace' } : { kind }
      answers.push([accountRow(answer, { native, signInHref: SIGN_IN }), 'account'])
    }
  }
  for (const enabled of [true, false]) {
    for (const reachable of [true, false, null]) {
      answers.push([memoryRow({ enabled, reachable }), 'memory'])
    }
  }
  for (const ready of [true, false]) {
    for (const loading of [true, false]) {
      answers.push([modelRow({ model: 'qwen3-vl:4b', ready, loading }), 'model'])
    }
  }
  for (const [row] of answers) {
    assert.ok(words(row.label) <= 2, `${row.id} label: "${row.label}"`)
    assert.ok(words(row.text) <= 5, `${row.id} text: "${row.text}"`)
    if (row.hint) assert.ok(words(row.hint) <= 6, `${row.id} hint: "${row.hint}"`)
    if (row.action) assert.ok(words(row.action.label) <= 2, `${row.id} action: "${row.action.label}"`)
  }
})
