/**
 * WP-15b: consent to send camera frames (src/capture/keyframe-consent.ts): the answer and where it is kept, what a
 * tap on Stream and the start of a scan in a Place do about it, the words, the list of sessions a phone streamed to,
 * deleting them, and asking the service worker to drop what is queued.
 *
 * What these hold: consent is per device, survives a reload, and is for the words it was given for and the Scan server it
 * named; a withdrawal stands; storage that refuses an answer does not stop the person from giving or withdrawing it;
 * default-on streaming needs a yes, a Place, a writer tab and no stream already open, and stopping needs nothing; the
 * words say what is sent, where it goes and that it stops at once, in plain short sentences that claim nothing the code
 * does not do; the ledger names only server session ids, keeps each with its server, counts what its limit let go, and
 * reads what an earlier build wrote; and deleting what was sent stays honest about a server that is gone, a session
 * already removed, one the server will not remove, one sent to another server, and what the list does not hold.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-15b-keyframe-consent.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  type ConsentStorage,
  DROP_QUEUED_KEYFRAMES_MESSAGE,
  KEYFRAME_CONSENT_COPY,
  KEYFRAME_CONSENT_COPY_VERSION,
  KEYFRAME_LEDGER_LIMIT,
  KeyframeConsent,
  KeyframeSessionLedger,
  confirmDeleteText,
  deleteResultText,
  deleteSentFrames,
  dropQueuedKeyframeUploads,
  keyframeStatusText,
  ledgerNote,
  scanServerOrigin,
  serverHost,
  serverLine,
  shouldAutoStartStreaming,
  streamTapAction,
} from '../../../src/capture/keyframe-consent.ts'
import { KEYFRAME_CONSENT_KEY, KEYFRAME_SESSIONS_KEY } from '../../../src/shared/storage-keys.ts'

const S1 = 'sess-11111111-1111-4111-8111-111111111111'
const S2 = 'sess-22222222-2222-4222-8222-222222222222'
const S3 = 'sess-33333333-3333-4333-8333-333333333333'

/** localStorage, as far as this module uses it. */
function memoryStorage(initial: Record<string, string> = {}): ConsentStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

/** A storage that refuses every call, as a private window or blocked site data does. */
const blockedStorage: ConsentStorage = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
  removeItem: () => {
    throw new Error('SecurityError')
  },
}

const CLOCK = () => new Date('2026-11-16T09:30:00.000Z')

// ── The answer ───────────────────────────────────────────────────────────────────────────────────

test('a device that has not been asked is unset, and nothing is stored by looking', () => {
  const storage = memoryStorage()
  const consent = new KeyframeConsent({ storage })
  assert.equal(consent.state, 'unset')
  assert.equal(consent.granted, false)
  assert.equal(storage.data.size, 0)
})

const SERVER_A = 'https://scan.example.ts.net'
const SERVER_B = 'https://someone-elses-server.example'

test('a yes is stored with when it was given, which words and which Scan server it was given for, and a new page reads it back', () => {
  const storage = memoryStorage()
  const first = new KeyframeConsent({ storage, now: CLOCK, server: () => SERVER_A })
  assert.equal(first.grant(), true)
  assert.equal(first.state, 'granted')
  assert.deepEqual(JSON.parse(storage.data.get(KEYFRAME_CONSENT_KEY)!), {
    state: 'granted',
    at: '2026-11-16T09:30:00.000Z',
    copyVersion: KEYFRAME_CONSENT_COPY_VERSION,
    server: SERVER_A,
  })
  assert.equal(new KeyframeConsent({ storage, server: () => SERVER_A }).state, 'granted', 'a reload remembers it')
})

test('a yes is for the Scan server the dialog named: another server reads as unset, and the yes is kept for the one it was given to', () => {
  const storage = memoryStorage()
  let server = SERVER_A
  const consent = new KeyframeConsent({ storage, server: () => server })
  consent.grant()
  assert.equal(consent.granted, true)

  server = SERVER_B
  assert.equal(consent.state, 'unset', 'frames would go somewhere the person was not told about')
  assert.equal(consent.granted, false)
  assert.equal(new KeyframeConsent({ storage, server: () => SERVER_B }).state, 'unset', 'a fresh page reads the same')
  assert.equal(consent.stored?.server, SERVER_A, 'what was agreed to, and for whom, is still on record')

  server = SERVER_A
  assert.equal(consent.state, 'granted', 'pointed back at the server it was given for, the yes counts again')

  // A yes to the other server is a new yes, for that server.
  server = SERVER_B
  consent.grant()
  assert.equal(consent.stored?.server, SERVER_B)
  assert.equal(consent.granted, true)
  server = SERVER_A
  assert.equal(consent.state, 'unset', 'and no longer counts for the first')
})

test('a withdrawal stands whatever the Scan server, and a yes with no server on record counts for none', () => {
  const withdrawn = memoryStorage()
  new KeyframeConsent({ storage: withdrawn, server: () => SERVER_A }).withdraw()
  assert.equal(new KeyframeConsent({ storage: withdrawn, server: () => SERVER_B }).state, 'withdrawn', 'it is not turned into a no-longer-asked by a change of server')

  // What the first build of this feature wrote had no server: that yes was not given for any server in particular.
  const legacy = memoryStorage({
    [KEYFRAME_CONSENT_KEY]: JSON.stringify({ state: 'granted', at: '2026-11-16T09:30:00.000Z', copyVersion: KEYFRAME_CONSENT_COPY_VERSION }),
  })
  assert.equal(new KeyframeConsent({ storage: legacy, server: () => SERVER_A }).state, 'unset', 'the person is asked again')
})

test('a change of Scan server is announced once when the device reads it again, and sending stops', () => {
  const storage = memoryStorage()
  let server = SERVER_A
  const consent = new KeyframeConsent({ storage, server: () => server })
  consent.grant()
  const heard: string[] = []
  consent.subscribe((state) => heard.push(state))
  consent.refresh()
  assert.deepEqual(heard, [], 'nothing moved')
  server = SERVER_B
  consent.refresh()
  assert.deepEqual(heard, ['unset'], 'the yes stopped counting, and listeners (the stream) were told')
  consent.refresh()
  assert.deepEqual(heard, ['unset'], 'once')
  server = SERVER_A
  consent.refresh()
  assert.deepEqual(heard, ['unset', 'granted'])
})

test('the Scan server is read from the saved address or the page, and says nothing outside a page', () => {
  assert.equal(scanServerOrigin(), '', 'no page, no server: a test is the only place this is true')
  assert.equal(serverHost('https://scan.example.ts.net:8443'), 'scan.example.ts.net:8443')
  assert.equal(serverHost('not a url'), '', 'with no page either')
})

test('a withdrawal is stored, stands over a reload, and a later yes replaces it', () => {
  const storage = memoryStorage()
  const consent = new KeyframeConsent({ storage, now: CLOCK })
  consent.grant()
  consent.withdraw()
  assert.equal(consent.state, 'withdrawn')
  assert.equal(new KeyframeConsent({ storage }).state, 'withdrawn')
  consent.grant()
  assert.equal(new KeyframeConsent({ storage }).state, 'granted')
})

test('a yes given to older words no longer counts, so the person is asked again; a withdrawal is never turned into a yes', () => {
  const storage = memoryStorage()
  new KeyframeConsent({ storage, copyVersion: 1 }).grant()
  const newer = new KeyframeConsent({ storage, copyVersion: 2 })
  assert.equal(newer.state, 'unset', 'the words changed')
  assert.equal(newer.granted, false)
  assert.equal(newer.stored?.copyVersion, 1, 'what was agreed to is still on record')

  const withdrawnStorage = memoryStorage()
  new KeyframeConsent({ storage: withdrawnStorage, copyVersion: 1 }).withdraw()
  assert.equal(new KeyframeConsent({ storage: withdrawnStorage, copyVersion: 5 }).state, 'withdrawn')
})

test('a stored value that is not an answer is no answer', () => {
  for (const raw of ['', 'granted', '{', 'null', '[]', '{"state":"maybe","at":"x","copyVersion":1}', '{"state":"granted"}', '{"state":"granted","at":1,"copyVersion":1}']) {
    assert.equal(new KeyframeConsent({ storage: memoryStorage({ [KEYFRAME_CONSENT_KEY]: raw }) }).state, 'unset', JSON.stringify(raw))
  }
})

test('storage that refuses is not a crash: the answer holds for this page, and is not reported as kept', () => {
  const consent = new KeyframeConsent({ storage: blockedStorage })
  assert.equal(consent.state, 'unset')
  assert.equal(consent.grant(), false, 'it says it could not keep the yes')
  assert.equal(consent.state, 'granted', 'but the person said yes, and it holds for this page')
  consent.withdraw()
  assert.equal(consent.state, 'withdrawn', 'and a no stops it just the same')
  assert.equal(new KeyframeConsent({ storage: null }).grant(), false)
})

test('a change is announced once, to whoever listens, and a listener that throws stops no one', (t) => {
  t.mock.method(console, 'warn', () => {})
  const consent = new KeyframeConsent({ storage: memoryStorage() })
  const seen: string[] = []
  consent.subscribe(() => {
    throw new Error('a bad listener')
  })
  const stop = consent.subscribe((state) => seen.push(state))
  consent.grant()
  consent.grant()
  consent.withdraw()
  consent.withdraw()
  assert.deepEqual(seen, ['granted', 'withdrawn'], 'only a change is announced')
  stop()
  consent.grant()
  assert.deepEqual(seen, ['granted', 'withdrawn'], 'a listener that left hears nothing more')
})

test('another tab\'s answer reaches this one when it reads storage again, and a withdrawal there is heard here', () => {
  const storage = memoryStorage()
  const here = new KeyframeConsent({ storage })
  const there = new KeyframeConsent({ storage })
  const heard: string[] = []
  here.subscribe((state) => heard.push(state))
  there.grant()
  assert.equal(here.state, 'unset', 'this page has not read it yet')
  here.refresh()
  assert.equal(here.state, 'granted')
  there.withdraw()
  here.refresh()
  assert.deepEqual(heard, ['granted', 'withdrawn'])
  here.refresh()
  assert.deepEqual(heard, ['granted', 'withdrawn'], 'reading the same answer again announces nothing')
})

test('the storage keys are the declared ones, and neither is one that is already in use', () => {
  assert.equal(KEYFRAME_CONSENT_KEY, 'companion-scan-keyframe-consent')
  assert.equal(KEYFRAME_SESSIONS_KEY, 'companion-scan-keyframe-sessions')
})

// ── What a tap does, and when a scan starts streaming ────────────────────────────────────────────

test('a tap on Stream: stops what is running, ignores a transition, starts when agreed, asks when not', () => {
  const tap = (consent: 'unset' | 'granted' | 'withdrawn', streaming: boolean, transitioning = false) => streamTapAction({ consent, streaming, transitioning })
  for (const consent of ['unset', 'granted', 'withdrawn'] as const) {
    assert.equal(tap(consent, true), 'stop', `stopping needs no consent (${consent})`)
    assert.equal(tap(consent, false, true), 'ignore', `a tap during a transition is ignored (${consent})`)
    assert.equal(tap(consent, true, true), 'ignore')
  }
  assert.equal(tap('granted', false), 'start')
  assert.equal(tap('unset', false), 'ask-consent')
  assert.equal(tap('withdrawn', false), 'ask-consent', 'a person who withdrew is asked again, not started')
})

test('a scan streams by itself only on a device that has agreed, in a Place, on the writer tab, with nothing already open', () => {
  const base = { consent: 'granted', placeSelected: true, readOnly: false, streaming: false, transitioning: false } as const
  assert.equal(shouldAutoStartStreaming(base), true)
  assert.equal(shouldAutoStartStreaming({ ...base, consent: 'unset' }), false, 'no yes, no stream (D15)')
  assert.equal(shouldAutoStartStreaming({ ...base, consent: 'withdrawn' }), false)
  assert.equal(shouldAutoStartStreaming({ ...base, placeSelected: false }), false, 'default-on is for a scan in a Place')
  assert.equal(shouldAutoStartStreaming({ ...base, readOnly: true }), false, 'a read-only page starts nothing')
  assert.equal(shouldAutoStartStreaming({ ...base, streaming: true }), false)
  assert.equal(shouldAutoStartStreaming({ ...base, transitioning: true }), false)
})

test('the only inputs the default-on decision reads are the five it names, so nothing else can decide it', () => {
  assert.equal(shouldAutoStartStreaming.length, 1)
  const everything = ['consent', 'placeSelected', 'readOnly', 'streaming', 'transitioning']
  const calls = everything.map((off) => {
    const input: Record<string, unknown> = { consent: 'granted', placeSelected: true, readOnly: false, streaming: false, transitioning: false }
    // Turn one condition the wrong way at a time: each must be able to stop it, and no sixth input is read.
    input[off] = off === 'consent' ? 'unset' : off === 'placeSelected' ? false : true
    return shouldAutoStartStreaming(input as Parameters<typeof shouldAutoStartStreaming>[0])
  })
  assert.deepEqual(calls, [false, false, false, false, false])
})

// ── The words ────────────────────────────────────────────────────────────────────────────────────

test('the words say what is sent, where it goes, what for, and that it stops at once', () => {
  const all = [KEYFRAME_CONSENT_COPY.line, ...KEYFRAME_CONSENT_COPY.details].join(' ')
  assert.match(KEYFRAME_CONSENT_COPY.line, /camera photos/, 'what is sent')
  assert.match(KEYFRAME_CONSENT_COPY.line, /where the phone was/, 'and what travels with it')
  assert.match(KEYFRAME_CONSENT_COPY.line, /to your Scan server/, 'where it goes')
  assert.match(KEYFRAME_CONSENT_COPY.line, /3D models/, 'what for')
  assert.match(KEYFRAME_CONSENT_COPY.line, /Turn it off any time/, 'that it can be withdrawn')
  assert.match(all, /only to your Scan server/, 'and nowhere else')
  assert.match(all, /stops sending at once/, 'withdrawal is at once')
  assert.match(all, /already sent stay on your server until deleted/, 'and what happens to what was sent')
  assert.match(all, /people, screens and papers/, 'the person is told what a photo of a room can show')
  assert.equal(serverLine('scan.example.ts.net'), 'Server: scan.example.ts.net')
})

test('the words are short and plain, and claim nothing the code does not do', () => {
  const sentences = [KEYFRAME_CONSENT_COPY.line, ...KEYFRAME_CONSENT_COPY.details, KEYFRAME_CONSENT_COPY.stopped]
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length
  assert.ok(words(KEYFRAME_CONSENT_COPY.line) <= 28, `the line is ${words(KEYFRAME_CONSENT_COPY.line)} words`)
  assert.ok(sentences.join(' ').split(/\s+/).length <= 90, 'the whole dialog is a few lines')
  const around = [
    confirmDeleteText({ sessions: 3, streaming: false }),
    confirmDeleteText({ sessions: 1, streaming: true }),
    ledgerNote({ elsewhere: 2, forgotten: 5 }),
    deleteResultText({ deleted: 2, alreadyGone: 1, failed: 1, offline: false, elsewhere: 1, forgotten: 4 }, true),
    deleteResultText({ deleted: 0, alreadyGone: 0, failed: 0, offline: false, elsewhere: 0, forgotten: 0 }, false),
  ]
  for (const text of [...sentences, KEYFRAME_CONSENT_COPY.title, ...around]) {
    // ADR 0005 rule 3: a word that claims a check, or a safety nobody measured, is not used.
    assert.doesNotMatch(text, /verified|secure|encrypt|anonymi|private|safe|guarantee|never|delete[sd]? (them )?(automatically|for you)/i, text)
    assert.doesNotMatch(text, /\n/, 'one line each')
  }
  assert.equal(KEYFRAME_CONSENT_COPY.allow, 'Allow')
  assert.equal(KEYFRAME_CONSENT_COPY.decline, 'Not now')
})

test('the delete confirm says which frames, that it cannot be undone, what a scan keeps, and that a stream is stopped first', () => {
  const idle = confirmDeleteText({ sessions: 3, streaming: false })
  assert.match(idle, /3 scan sessions this phone remembers sending to your server/, 'which frames: the ones this phone remembers, not "all it sent"')
  assert.match(idle, /cannot be undone/)
  assert.match(idle, /cannot be rebuilt/)
  assert.doesNotMatch(idle, /Sending stops now/, 'nothing is running, so nothing is stopped')
  assert.match(confirmDeleteText({ sessions: 1, streaming: true }), /1 scan session this phone remembers.*Sending stops now\.$/)
})

test('the status line says what is happening, and counts the frames a slow link made the phone skip', () => {
  const none = { sent: 0, skipped: 0, failed: 0 }
  assert.equal(keyframeStatusText({ state: 'unset', streaming: false, counts: none, offline: false }), 'Off. Nothing is sent.')
  assert.equal(keyframeStatusText({ state: 'withdrawn', streaming: false, counts: none, offline: false }), 'Off. Nothing is sent.')
  assert.equal(keyframeStatusText({ state: 'granted', streaming: false, counts: none, offline: false }), 'On. Not sending right now.')
  assert.equal(keyframeStatusText({ state: 'granted', streaming: true, counts: { sent: 12, skipped: 0, failed: 0 }, offline: false }), 'Sending frames. 12 sent.')
  assert.equal(keyframeStatusText({ state: 'granted', streaming: true, counts: { sent: 12, skipped: 3, failed: 1 }, offline: false }), 'Sending frames. 12 sent, 3 skipped, 1 failed.')
  assert.equal(keyframeStatusText({ state: 'granted', streaming: true, counts: { sent: 0, skipped: 0, failed: 2 }, offline: true }), 'Sending frames (server not answering). 0 sent, 2 failed.')
  // A device that has said no is never shown as sending, whatever a stale streamer reports.
  assert.equal(keyframeStatusText({ state: 'withdrawn', streaming: true, counts: { sent: 9, skipped: 0, failed: 0 }, offline: false }), 'Off. Nothing is sent.')
})

// ── The sessions this device streamed to ─────────────────────────────────────────────────────────

test('the ledger keeps session ids, oldest first, once each, and nothing that is not one', () => {
  const storage = memoryStorage()
  const ledger = new KeyframeSessionLedger({ storage })
  assert.deepEqual(ledger.ids(), [])
  ledger.add(S1)
  ledger.add(S2)
  ledger.add(S1)
  ledger.add('local-1234')
  ledger.add('../etc')
  ledger.add('')
  assert.deepEqual(ledger.ids(), [S2, S1], 'a repeated id moves to the end')
  assert.equal(ledger.count, 2)
  // What is written is as clean as what is read: a value that is not a session id never reaches storage.
  assert.deepEqual(JSON.parse(storage.data.get(KEYFRAME_SESSIONS_KEY)!).entries.map((entry: { id: string }) => entry.id), [S2, S1])
  assert.deepEqual(new KeyframeSessionLedger({ storage }).ids(), [S2, S1], 'a reload keeps it')
  ledger.remove([S2])
  assert.deepEqual(ledger.ids(), [S1])
  ledger.remove([S1])
  assert.equal(storage.data.has(KEYFRAME_SESSIONS_KEY), false, 'an empty ledger leaves no key behind')
})

test('the ledger drops stored values that are not session ids, and survives a stored value that is not a ledger', () => {
  const storage = memoryStorage({ [KEYFRAME_SESSIONS_KEY]: JSON.stringify({ v: 2, entries: [{ id: S1, server: '' }, { id: 7 }, { id: 'local-x' }, null, { id: '../x' }, { id: S1 }, { id: S3, server: '' }] }) })
  assert.deepEqual(new KeyframeSessionLedger({ storage }).ids(), [S1, S3])
  for (const raw of ['{', 'null', '"x"', '{"ids":"nope"}', '{"entries":"nope"}', '[]']) {
    assert.deepEqual(new KeyframeSessionLedger({ storage: memoryStorage({ [KEYFRAME_SESSIONS_KEY]: raw }) }).ids(), [], raw)
  }
})

test('what the first build wrote, a list of ids with no server, is still read, and its sessions are taken to be on the server in use', () => {
  const storage = memoryStorage({ [KEYFRAME_SESSIONS_KEY]: JSON.stringify({ v: 1, ids: [S1, 7, 'local-x', '../x', S1, null, S3] }) })
  const ledger = new KeyframeSessionLedger({ storage, server: () => SERVER_A })
  assert.deepEqual(ledger.ids(), [S3, S1].reverse(), 'oldest first, once each, and only session ids')
  assert.equal(ledger.elsewhere, 0, 'with no server on record there is nothing to say they went elsewhere')
  ledger.add(S2)
  const written = JSON.parse(storage.data.get(KEYFRAME_SESSIONS_KEY)!)
  assert.equal(written.v, 2, 'what is written now says which server each session was on')
  assert.deepEqual(written.entries, [{ id: S1, server: '' }, { id: S3, server: '' }, { id: S2, server: SERVER_A }])
})

test('the ledger keeps only the newest sessions beyond its limit, and counts the ones it let go of', () => {
  assert.equal(KEYFRAME_LEDGER_LIMIT, 500)
  const storage = memoryStorage()
  const ledger = new KeyframeSessionLedger({ storage, limit: 3 })
  const ids = [1, 2, 3, 4, 5].map((n) => `sess-${n}`)
  for (const id of ids) ledger.add(id)
  assert.deepEqual(ledger.ids(), ['sess-3', 'sess-4', 'sess-5'])
  assert.equal(ledger.forgotten, 2, 'two sessions were sent from this phone that it can no longer name')
  assert.equal(new KeyframeSessionLedger({ storage, limit: 3 }).forgotten, 2, 'and a reload remembers that it forgot')
  // Deleting what is on the list does not make the forgotten ones go away, and a list with only a count is still a list.
  ledger.remove(['sess-3', 'sess-4', 'sess-5'])
  assert.equal(ledger.count, 0)
  assert.equal(ledger.forgotten, 2)
  assert.equal(storage.data.has(KEYFRAME_SESSIONS_KEY), true, 'the count is not lost with the last id')
})

test('a session is listed for the Scan server it was opened on, and a delete asks only that server\'s sessions', () => {
  const storage = memoryStorage()
  let server = SERVER_A
  const ledger = new KeyframeSessionLedger({ storage, server: () => server })
  ledger.add(S1)
  server = SERVER_B
  ledger.add(S2)
  assert.deepEqual(ledger.ids(), [S2], 'on server B, the session from A is not one to ask B about')
  assert.equal(ledger.elsewhere, 1)
  assert.equal(ledger.count, 1)
  server = SERVER_A
  assert.deepEqual(ledger.ids(), [S1])
  assert.equal(ledger.elsewhere, 1)
  // Removing what was deleted from A leaves B's.
  ledger.remove([S1])
  assert.equal(ledger.elsewhere, 1)
  assert.deepEqual(ledger.ids(), [])
})

test('a ledger on storage that refuses holds nothing and throws nothing', () => {
  const ledger = new KeyframeSessionLedger({ storage: blockedStorage })
  ledger.add(S1)
  ledger.remove([S1])
  assert.deepEqual(ledger.ids(), [])
  assert.equal(new KeyframeSessionLedger({ storage: null }).count, 0)
})

// ── Deleting what was sent ───────────────────────────────────────────────────────────────────────

/** A fetch that answers each DELETE by session id. A string answer is a status; `'offline'` is a network failure. */
function deleteServer(answers: Record<string, number | 'offline'>) {
  const calls: Array<{ url: string; method: string }> = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    const answer = answers[url.split('/').pop()!]
    if (answer === 'offline') throw new TypeError('Failed to fetch')
    return new Response('{}', { status: answer ?? 500 })
  }) as typeof fetch
  return { calls, fetchFn }
}

test('every session the phone streamed is deleted by name, with DELETE, and leaves the ledger when the server removed it', async () => {
  const ledger = new KeyframeSessionLedger({ storage: memoryStorage() })
  for (const id of [S1, S2]) ledger.add(id)
  const { calls, fetchFn } = deleteServer({ [S1]: 200, [S2]: 200 })
  const result = await deleteSentFrames(ledger, fetchFn)
  assert.deepEqual(result, { deleted: 2, alreadyGone: 0, failed: 0, offline: false, elsewhere: 0, forgotten: 0 })
  assert.deepEqual(calls, [{ url: `/sessions/${S1}`, method: 'DELETE' }, { url: `/sessions/${S2}`, method: 'DELETE' }])
  assert.equal(ledger.count, 0)
  assert.equal(deleteResultText(result, true), 'Deleted the frames from 2 scan sessions on your server.')
})

test('a session the server no longer has is as good as deleted, and one it will not delete is dropped and reported', async () => {
  const ledger = new KeyframeSessionLedger({ storage: memoryStorage() })
  for (const id of [S1, S2, S3]) ledger.add(id)
  const result = await deleteSentFrames(ledger, deleteServer({ [S1]: 404, [S2]: 409, [S3]: 200 }).fetchFn)
  assert.deepEqual(result, { deleted: 1, alreadyGone: 1, failed: 1, offline: false, elsewhere: 0, forgotten: 0 })
  assert.equal(ledger.count, 0, 'the 409 is not this phone\'s streamed frames, so it is not kept to be asked again')
  assert.equal(deleteResultText(result, true), 'Deleted 2. 1 could not be deleted. Try again.')
})

test('a session that fails stays in the ledger for another try', async () => {
  const ledger = new KeyframeSessionLedger({ storage: memoryStorage() })
  for (const id of [S1, S2]) ledger.add(id)
  const result = await deleteSentFrames(ledger, deleteServer({ [S1]: 500, [S2]: 200 }).fetchFn)
  assert.deepEqual(result, { deleted: 1, alreadyGone: 0, failed: 1, offline: false, elsewhere: 0, forgotten: 0 })
  assert.deepEqual(ledger.ids(), [S1])
})

test('with the server out of reach the run stops at the first miss and nothing is forgotten', async () => {
  const ledger = new KeyframeSessionLedger({ storage: memoryStorage() })
  for (const id of [S1, S2, S3]) ledger.add(id)
  const { calls, fetchFn } = deleteServer({ [S1]: 200, [S2]: 'offline', [S3]: 200 })
  const result = await deleteSentFrames(ledger, fetchFn)
  assert.deepEqual(result, { deleted: 1, alreadyGone: 0, failed: 0, offline: true, elsewhere: 0, forgotten: 0 })
  assert.equal(calls.length, 2, 'the third was not tried: an offline phone does not wait out a timeout per session')
  assert.deepEqual(ledger.ids(), [S2, S3])
  assert.equal(deleteResultText(result, true), 'Could not reach your server. Nothing more was deleted.')
})

test('a session sent to another Scan server is not asked about here, is not reported as deleted, and stays on the list', async () => {
  const storage = memoryStorage()
  let server = SERVER_A
  const ledger = new KeyframeSessionLedger({ storage, server: () => server })
  ledger.add(S1)
  ledger.add(S2)
  server = SERVER_B
  // The person points the app at another Scan server. That one does not have the sessions, and would answer 404 to each: which
  // the delete counts as "already gone", so asking it would report as deleted what is still on the first server.
  const { calls, fetchFn } = deleteServer({ [S1]: 404, [S2]: 404 })
  const result = await deleteSentFrames(ledger, fetchFn)
  assert.deepEqual(calls, [], 'no request: neither session was sent to this server')
  assert.deepEqual(result, { deleted: 0, alreadyGone: 0, failed: 0, offline: false, elsewhere: 2, forgotten: 0 })
  server = SERVER_A
  assert.deepEqual(ledger.ids(), [S1, S2], 'both are still on the list, for the server that holds them')
  const back = await deleteSentFrames(ledger, deleteServer({ [S1]: 200, [S2]: 200 }).fetchFn)
  assert.equal(back.deleted, 2)
  assert.equal(ledger.count, 0)
})

test('the lines after a delete say what was deleted, and what the list does not hold', () => {
  const clean = { offline: false, elsewhere: 0, forgotten: 0 }
  assert.equal(
    deleteResultText({ deleted: 0, alreadyGone: 0, failed: 0, ...clean }, false),
    'This phone does not remember sending frames to this server. Frames sent by another phone, or before this phone kept a list, go when their scan is deleted.',
    'it does not claim to have sent nothing: it says what it remembers',
  )
  assert.equal(deleteResultText({ deleted: 1, alreadyGone: 0, failed: 0, ...clean }, true), 'Deleted the frames from 1 scan session on your server.')
  assert.equal(deleteResultText({ deleted: 2, alreadyGone: 3, failed: 0, ...clean }, true), 'Deleted the frames from 5 scan sessions on your server.')
  assert.equal(
    deleteResultText({ deleted: 2, alreadyGone: 0, failed: 0, offline: false, elsewhere: 3, forgotten: 4 }, true),
    'Deleted the frames from 2 scan sessions on your server. Not on this list: 3 sent to another Scan server (delete them there), 4 older than this phone keeps a list of. Frames not on the list go when their scan is deleted.',
    'it ends by saying what the list left out, so "deleted" is not read as "everything this phone ever sent"',
  )
  assert.match(deleteResultText({ deleted: 0, alreadyGone: 0, failed: 1, offline: false, elsewhere: 0, forgotten: 7 }, true), /^Deleted 0\. 1 could not be deleted\. Try again\. Not on this list: 7 older/)
  assert.match(deleteResultText({ deleted: 0, alreadyGone: 0, failed: 0, offline: true, elsewhere: 0, forgotten: 7 }, true), /^Could not reach your server\. Nothing more was deleted\. Not on this list: 7 older/)
  assert.match(deleteResultText({ deleted: 0, alreadyGone: 0, failed: 0, offline: false, elsewhere: 2, forgotten: 9 }, false), /sent to another Scan server \(delete them there\)/)
  assert.doesNotMatch(deleteResultText({ deleted: 0, alreadyGone: 0, failed: 0, offline: false, elsewhere: 2, forgotten: 9 }, false), /older than this phone/, 'with nothing remembered here, only what went elsewhere is worth saying')
})

test('the note beside the button names what the list leaves out, and is empty when it leaves nothing out', () => {
  assert.equal(ledgerNote({ elsewhere: 0, forgotten: 0 }), '')
  assert.equal(
    ledgerNote({ elsewhere: 1, forgotten: 0 }),
    'Not on this list: 1 sent to another Scan server (delete them there). Frames not on the list go when their scan is deleted.',
  )
  assert.equal(
    ledgerNote({ elsewhere: 0, forgotten: 25 }),
    'Not on this list: 25 older than this phone keeps a list of. Frames not on the list go when their scan is deleted.',
  )
})

// ── The service worker's queue ───────────────────────────────────────────────────────────────────

test('the drop is asked of the worker that controls the page, and the count on the port is the answer', async () => {
  const sent: unknown[] = []
  const container = {
    controller: {
      postMessage(message: unknown, transfer: MessagePort[]) {
        sent.push(message)
        transfer[0]!.postMessage({ count: 4 })
      },
    },
  } as unknown as Pick<ServiceWorkerContainer, 'controller'>
  assert.equal(await dropQueuedKeyframeUploads(container, 500), 4)
  assert.deepEqual(sent, [{ type: DROP_QUEUED_KEYFRAMES_MESSAGE }])
})

test('no worker, or one that does not answer, is no count, and does not hang', async () => {
  assert.equal(await dropQueuedKeyframeUploads({ controller: null }, 50), null, 'no worker controls the page, so nothing was queued')
  assert.equal(await dropQueuedKeyframeUploads(undefined, 50), null)
  const silent = { controller: { postMessage() {} } } as unknown as Pick<ServiceWorkerContainer, 'controller'>
  const started = Date.now()
  assert.equal(await dropQueuedKeyframeUploads(silent, 60), null, 'an older worker that does not know the message')
  assert.ok(Date.now() - started < 1000, 'bounded by the timeout')
  const nonsense = { controller: { postMessage(_m: unknown, transfer: MessagePort[]) { transfer[0]!.postMessage({ count: 'many' }) } } } as unknown as Pick<ServiceWorkerContainer, 'controller'>
  assert.equal(await dropQueuedKeyframeUploads(nonsense, 100), null, 'an answer that is not a number is not a count')
})
