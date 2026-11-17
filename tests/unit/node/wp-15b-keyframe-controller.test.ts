/**
 * WP-15b: what the scanner does about consent to send camera frames (src/capture/keyframe-consent-controller.ts),
 * and how main.ts wires it, against a fake streamer.
 *
 * What these hold: a tap that would start sending asks first when the device has not agreed and starts when it has;
 * a no changes nothing; the panel switch records the answer and starts or stops to match; a scan in a Place starts by
 * itself only with a yes; a withdrawal, from this page, another tab or a different Scan server, abandons the stream and
 * empties the worker's queue, whatever else goes wrong while it does, and stops a stream started since an earlier stop
 * began; deleting what was sent is its own tap, after a confirm, never part of withdrawal, and stops a stream that is
 * running first; and no part of the app but sending frames reads the answer ("no feature may depend on consent").
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-15b-keyframe-controller.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ConsentStorage,
  KeyframeConsent,
  KeyframeSessionLedger,
} from '../../../src/capture/keyframe-consent.ts'
import {
  type ControllerDeps,
  type FinalizePayload,
  KeyframeConsentController,
  type StreamerPort,
} from '../../../src/capture/keyframe-consent-controller.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const S1 = 'sess-11111111-1111-4111-8111-111111111111'
const S2 = 'sess-22222222-2222-4222-8222-222222222222'

function memoryStorage(): ConsentStorage {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

interface Harness {
  controller: KeyframeConsentController
  consent: KeyframeConsent
  ledger: KeyframeSessionLedger
  streamer: StreamerPort & { starts: number; abandons: FinalizePayload[]; active: boolean; isTransitioning: boolean }
  asked: () => number
  confirms: () => number
  /** What each confirm before deleting was told: whether a stream was running, and how many sessions. */
  confirmCalls: Array<{ streaming: boolean; sessions: number }>
  /** What happened, in order: 'abandon', 'drop' (the worker's queue) and 'delete' (the server). */
  events: string[]
  dropped: () => number
  deleted: () => number
  setAnswer(answer: boolean): void
  setConfirm(answer: boolean): void
  storage: ConsentStorage
}

function harness(opts: { readOnly?: boolean; canStreamNow?: boolean; abandonDelayMs?: number; seed?: 'granted' | 'withdrawn'; finalizePayload?: () => FinalizePayload } = {}): Harness {
  const storage = memoryStorage()
  const consent = new KeyframeConsent({ storage })
  if (opts.seed === 'granted') consent.grant()
  if (opts.seed === 'withdrawn') consent.withdraw()
  const ledger = new KeyframeSessionLedger({ storage })
  const events: string[] = []
  const streamer = {
    starts: 0,
    abandons: [] as FinalizePayload[],
    active: false,
    isTransitioning: false,
    async start() {
      this.starts += 1
      this.active = true
    },
    async abandon(finalize?: FinalizePayload) {
      events.push('abandon')
      this.abandons.push(finalize)
      if (opts.abandonDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.abandonDelayMs))
      this.active = false
    },
  }
  let answer = true
  let confirmAnswer = true
  let asked = 0
  let confirms = 0
  const confirmCalls: Array<{ streaming: boolean; sessions: number }> = []
  let dropped = 0
  let deleted = 0
  const deps: ControllerDeps = {
    consent,
    ledger,
    streamer,
    finalizePayload: opts.finalizePayload ?? (() => ({ glbFilename: 'a.glb', pointCount: 10 })),
    ask: async () => {
      asked += 1
      return answer
    },
    confirmDelete: (streaming, sessions) => {
      confirms += 1
      confirmCalls.push({ streaming, sessions })
      return confirmAnswer
    },
    readOnly: opts.readOnly ?? false,
    canStreamNow: () => opts.canStreamNow ?? true,
    dropQueued: async () => {
      events.push('drop')
      dropped += 1
      return 2
    },
    deleteSent: async () => {
      events.push('delete')
      deleted += 1
      ledger.remove(ledger.ids())
      return { deleted: 2, alreadyGone: 0, failed: 0, offline: false, elsewhere: 0, forgotten: 0 }
    },
  }
  return {
    controller: new KeyframeConsentController(deps),
    consent,
    ledger,
    streamer,
    asked: () => asked,
    confirms: () => confirms,
    confirmCalls,
    events,
    dropped: () => dropped,
    deleted: () => deleted,
    setAnswer: (value) => {
      answer = value
    },
    setConfirm: (value) => {
      confirmAnswer = value
    },
    storage,
  }
}

// ── A tap on Stream ──────────────────────────────────────────────────────────────────────────────

test('a tap that would start sending, on a device that has agreed, starts and asks nothing', async () => {
  const h = harness({ seed: 'granted' })
  assert.equal(await h.controller.requestStart(() => h.streamer.start()), true)
  assert.equal(h.asked(), 0)
  assert.equal(h.streamer.starts, 1)
})

test('a tap on a device that has not been asked asks first, and a yes is recorded before the stream starts', async () => {
  const h = harness()
  let consentWhenStarted = ''
  assert.equal(await h.controller.requestStart(async () => {
    consentWhenStarted = h.consent.state
    await h.streamer.start()
  }), true)
  assert.equal(h.asked(), 1)
  assert.equal(consentWhenStarted, 'granted', 'the yes is on record when the first frame could leave')
  assert.equal(h.consent.state, 'granted')
})

test('a no starts nothing and records nothing, so the next tap asks again', async () => {
  const h = harness()
  h.setAnswer(false)
  assert.equal(await h.controller.requestStart(() => h.streamer.start()), false)
  assert.equal(h.streamer.starts, 0)
  assert.equal(h.consent.state, 'unset', 'declining is not a withdrawal: the person is just not asked to decide yet')
  h.setAnswer(true)
  assert.equal(await h.controller.requestStart(() => h.streamer.start()), true)
  assert.equal(h.asked(), 2)
})

test('a device that withdrew is asked again by a tap, and one that is then allowed is a yes', async () => {
  const h = harness({ seed: 'withdrawn' })
  assert.equal(await h.controller.requestStart(() => h.streamer.start()), true)
  assert.equal(h.asked(), 1)
  assert.equal(h.consent.state, 'granted')
})

test('a stream that fails to start after a yes leaves the yes on record: the person did agree', async () => {
  const h = harness()
  await assert.rejects(h.controller.requestStart(async () => {
    throw new Error('server down')
  }), /server down/)
  assert.equal(h.consent.state, 'granted')
})

// ── The switch in the panel ──────────────────────────────────────────────────────────────────────

test('turning the switch on asks, records the yes, and starts sending when the scanner is running', async () => {
  const h = harness()
  assert.equal(await h.controller.setSwitch(true), 'on')
  assert.equal(h.asked(), 1)
  assert.equal(h.consent.state, 'granted')
  assert.equal(h.streamer.starts, 1)
})

test('turning the switch on records the yes but starts nothing before the scanner runs, on a read-only page, or when already sending', async () => {
  const before = harness({ canStreamNow: false })
  assert.equal(await before.controller.setSwitch(true), 'on')
  assert.equal(before.consent.state, 'granted')
  assert.equal(before.streamer.starts, 0, 'a session opened before AR starts would sit open with no frames')

  const readOnly = harness({ readOnly: true })
  assert.equal(await readOnly.controller.setSwitch(true), 'on')
  assert.equal(readOnly.streamer.starts, 0, 'another tab is the scanner')

  const sending = harness({ seed: 'granted' })
  sending.streamer.active = true
  await sending.controller.setSwitch(true)
  assert.equal(sending.streamer.starts, 0, 'a second session is not opened over the first')
})

test('declining the dialog from the switch leaves it off and starts nothing', async () => {
  const h = harness()
  h.setAnswer(false)
  assert.equal(await h.controller.setSwitch(true), 'off')
  assert.equal(h.consent.state, 'unset')
  assert.equal(h.streamer.starts, 0)
})

test('turning the switch off withdraws and stops at once: the stream is abandoned with its finalize payload, and the worker\'s queue is emptied', async () => {
  const h = harness({ seed: 'granted' })
  h.streamer.active = true
  assert.equal(await h.controller.setSwitch(false), 'off')
  assert.equal(h.consent.state, 'withdrawn')
  assert.deepEqual(h.streamer.abandons, [{ glbFilename: 'a.glb', pointCount: 10 }], 'abandoned once, not drained: the withdrawal waits for the stop its own announcement started')
  assert.equal(h.dropped(), 1, 'frames waiting for the phone to be online are dropped')
  assert.equal(h.streamer.active, false)
})

test('turning the switch off when the answer is already no, and a stream is somehow still running, stops it', async () => {
  // The withdrawal changes nothing, so nothing is announced and the consent's own subscription does not stop the stream.
  // The switch must not rely on it: a person who says no is not left sending.
  const h = harness({ seed: 'withdrawn' })
  h.streamer.active = true
  assert.equal(await h.controller.setSwitch(false), 'off')
  assert.equal(h.consent.state, 'withdrawn')
  assert.equal(h.streamer.abandons.length, 1, 'stopped by the switch itself')
  assert.equal(h.streamer.active, false)
  assert.equal(h.dropped(), 1)
})

test('turning the switch off on a device that was never asked still stops what is running, once', async () => {
  const h = harness()
  h.streamer.active = true
  assert.equal(await h.controller.setSwitch(false), 'off')
  assert.equal(h.consent.state, 'withdrawn')
  assert.equal(h.streamer.abandons.length, 1, 'the state went from unset to withdrawn, which announces a change that is not a loss of a yes: the switch stops it itself')
  assert.equal(h.streamer.active, false)
  assert.equal(h.dropped(), 1)
})

test('withdrawing never deletes what was already sent: that is a separate tap', async () => {
  const h = harness({ seed: 'granted' })
  h.ledger.add(S1)
  await h.controller.setSwitch(false)
  assert.equal(h.deleted(), 0)
  assert.equal(h.confirms(), 0)
  assert.deepEqual(h.ledger.ids(), [S1], 'the frames are still named, so the person can delete them when they choose')
})

test('a withdrawal made in another tab stops this page\'s stream too', async () => {
  const h = harness({ seed: 'granted', abandonDelayMs: 20 })
  h.streamer.active = true
  const other = new KeyframeConsent({ storage: h.storage })
  other.withdraw()
  assert.equal(h.consent.state, 'granted', 'this page has not heard yet')
  h.consent.refresh()
  assert.equal(h.consent.state, 'withdrawn')
  // The change is heard through the consent's own subscription: the stream is abandoned, and the worker's queue is dropped.
  assert.equal(h.streamer.abandons.length, 1, 'the stop began as soon as the change was heard')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(h.streamer.active, false)
  assert.equal(h.dropped(), 1)
  // A later halt is a new stop, and a harmless one: nothing is left to stop.
  await h.controller.halt()
  assert.equal(h.streamer.abandons.length, 2)
  assert.equal(h.streamer.active, false)
})

test('a halt is not joined to a stop that is already running: a stream started since is stopped too', async () => {
  const h = harness({ seed: 'granted', abandonDelayMs: 30 })
  h.streamer.active = true
  const first = h.controller.halt()
  // While that stop is still running the person says yes again, and a new stream starts; then they say no again.
  h.streamer.active = true
  const second = h.controller.halt()
  await Promise.all([first, second])
  assert.equal(h.streamer.abandons.length, 2, 'the second no issued its own stop; it did not wait on the first and walk away')
  assert.equal(h.streamer.active, false, 'so the stream that started in between is not left running')
  assert.equal(h.dropped(), 2)
})

test('a withdrawal stops the stream even when the payload it would finalize with cannot be read', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const h = harness({
    seed: 'granted',
    finalizePayload: () => {
      throw new Error('the quality summary could not be read')
    },
  })
  h.streamer.active = true
  assert.equal(await h.controller.setSwitch(false), 'off')
  assert.equal(h.streamer.abandons.length, 1, 'the stream was abandoned, with no payload')
  assert.equal(h.streamer.abandons[0], undefined)
  assert.equal(h.streamer.active, false, 'nothing is left sending after the person said no')
  assert.equal(h.dropped(), 1, 'and the worker\'s queue was emptied too')
  assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('stopping without it')), 'the failure is logged, not swallowed')
})

test('a stop that throws where it is called is logged, and the worker\'s queue is still emptied', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const h = harness({ seed: 'granted' })
  h.streamer.abandon = (() => {
    throw new Error('thrown, not rejected')
  }) as unknown as typeof h.streamer.abandon
  await h.controller.halt()
  assert.equal(h.dropped(), 1)
})

test('a failure while stopping is logged and does not leave the queue undropped', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const h = harness({ seed: 'granted' })
  h.streamer.abandon = async () => {
    throw new Error('close failed')
  }
  await h.controller.halt()
  assert.equal(h.dropped(), 1, 'the worker is still told')
})

// ── A scan in a Place ────────────────────────────────────────────────────────────────────────────

test('a scan in a Place streams by itself on a device that has agreed, and on no other', async () => {
  const agreed = harness({ seed: 'granted' })
  assert.equal(agreed.controller.autoStart(true), true)
  await Promise.resolve()
  assert.equal(agreed.streamer.starts, 1)

  for (const seed of [undefined, 'withdrawn'] as const) {
    const h = harness({ seed })
    assert.equal(h.controller.autoStart(true), false, `a device that is ${seed ?? 'unset'} starts nothing`)
    assert.equal(h.streamer.starts, 0)
    assert.equal(h.asked(), 0, 'and is not asked: asking is the person\'s tap')
  }
})

test('default-on is for a scan in a Place, on the writer tab, and never over a stream that is already open', () => {
  const noPlace = harness({ seed: 'granted' })
  assert.equal(noPlace.controller.autoStart(false), false)
  const readOnly = harness({ seed: 'granted', readOnly: true })
  assert.equal(readOnly.controller.autoStart(true), false)
  const open = harness({ seed: 'granted' })
  open.streamer.active = true
  assert.equal(open.controller.autoStart(true), false)
  const opening = harness({ seed: 'granted' })
  opening.streamer.isTransitioning = true
  assert.equal(opening.controller.autoStart(true), false)
  for (const h of [noPlace, readOnly, open, opening]) assert.equal(h.streamer.starts, 0)
})

test('an automatic start that fails is logged and is not a crash', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const h = harness({ seed: 'granted' })
  h.streamer.start = async () => {
    throw new Error('offline')
  }
  assert.equal(h.controller.autoStart(true), true)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(warn.mock.calls.length, 1)
})

// ── Deleting what was sent ───────────────────────────────────────────────────────────────────────

test('deleting asks first, names the phone\'s sessions, and says what happened', async () => {
  const h = harness({ seed: 'withdrawn' })
  h.ledger.add(S1)
  h.ledger.add(S2)
  assert.equal(await h.controller.deleteSent(), 'Deleted the frames from 2 scan sessions on your server.')
  assert.equal(h.confirms(), 1)
  assert.equal(h.deleted(), 1)
})

test('declining the confirm deletes nothing and says nothing', async () => {
  const h = harness()
  h.ledger.add(S1)
  h.setConfirm(false)
  assert.equal(await h.controller.deleteSent(), '')
  assert.equal(h.deleted(), 0)
  assert.deepEqual(h.ledger.ids(), [S1])
})

test('a phone that remembers sending nothing to this server says so, without a confirm or a request', async () => {
  const h = harness()
  assert.equal(
    await h.controller.deleteSent(),
    'This phone does not remember sending frames to this server. Frames sent by another phone, or before this phone kept a list, go when their scan is deleted.',
  )
  assert.equal(h.confirms(), 0)
  assert.equal(h.deleted(), 0)
})

test('deleting while a stream is running stops it first, because the session being sent is one of those deleted', async () => {
  const h = harness({ seed: 'granted' })
  h.ledger.add(S1)
  h.ledger.add(S2)
  h.streamer.active = true // S2 is the session open now
  const text = await h.controller.deleteSent()
  assert.deepEqual(h.confirmCalls, [{ streaming: true, sessions: 2 }], 'the confirm is told that sending will stop')
  assert.deepEqual(h.events, ['abandon', 'drop', 'delete'], 'the stream was stopped, and the worker\'s queue dropped, before any session was deleted')
  assert.equal(h.streamer.active, false, 'nothing is left sending into a session that no longer exists')
  assert.equal(text, 'Deleted the frames from 2 scan sessions on your server.')
  assert.equal(h.consent.state, 'granted', 'deleting is not withdrawing: the switch stays on, and a tap on Stream starts a new session')
})

test('deleting while nothing is running stops nothing, and a declined confirm leaves a running stream alone', async () => {
  const idle = harness({ seed: 'granted' })
  idle.ledger.add(S1)
  await idle.controller.deleteSent()
  assert.deepEqual(idle.confirmCalls, [{ streaming: false, sessions: 1 }])
  assert.deepEqual(idle.events, ['delete'], 'no stop, no worker message')

  const declined = harness({ seed: 'granted' })
  declined.ledger.add(S1)
  declined.streamer.active = true
  declined.setConfirm(false)
  assert.equal(await declined.controller.deleteSent(), '')
  assert.equal(declined.streamer.active, true, 'a no to the confirm changes nothing')
  assert.deepEqual(declined.events, [])
})

test('a session the streamer opens is noted for the ledger', () => {
  const h = harness()
  h.controller.noteSession(S1)
  h.controller.noteSession('local-not-a-session')
  assert.deepEqual(h.ledger.ids(), [S1])
})

// ── Nothing but sending frames depends on the answer ─────────────────────────────────────────────

/** Source with its comments taken out, so a rule about code is not tripped by a sentence that names it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every .ts file under `dir`, as a path from the repo root. */
function tsFiles(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = `${dir}/${name}`
    if (statSync(join(ROOT, path)).isDirectory()) found.push(...tsFiles(path))
    else if (name.endsWith('.ts')) found.push(path)
  }
  return found
}

test('source shape: no part of the app but the consent modules and the panel row reads the answer', () => {
  const allowed = new Set([
    'src/capture/keyframe-consent.ts',
    'src/capture/keyframe-consent-controller.ts',
    'src/ui/keyframe-consent-ui.ts',
  ])
  const importers = tsFiles('src')
    .filter((file) => /from '[^']*keyframe-consent(-controller|-ui)?(\.ts)?'/.test(readFileSync(join(ROOT, file), 'utf8')))
    .map((file) => relative(ROOT, join(ROOT, file)))
    .sort()
  // main.ts imports the one mount, and nothing that holds the answer.
  assert.deepEqual(importers.filter((file) => !allowed.has(file)), ['src/main.ts'])
  const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8')
  assert.match(main, /import \{ mountKeyframeFrames \} from '\.\/ui\/keyframe-consent-ui'/)
  assert.doesNotMatch(main, /keyframe-consent['"]|KeyframeConsent\b|KEYFRAME_CONSENT/, 'main.ts reads no consent state itself')
  // ...and what it calls on the mount is the four calls, none of which reads the answer back into the scan.
  const used = new Set([...main.matchAll(/\bcameraFrames\.([A-Za-z]+)/g)].map((m) => m[1]))
  assert.deepEqual([...used].sort(), ['autoStart', 'noteSession', 'onStatus', 'requestStart'])
  assert.doesNotMatch(main, /cameraFrames\.consent/, 'no scanner feature reads whether this device agreed')
  // The storage key is read in one place.
  const readers = tsFiles('src').filter((file) => readFileSync(join(ROOT, file), 'utf8').includes('KEYFRAME_CONSENT_KEY'))
  assert.deepEqual(readers.sort(), ['src/capture/keyframe-consent.ts', 'src/shared/storage-keys.ts', 'src/ui/keyframe-consent-ui.ts'])
})

test('source shape: the stream tap asks before it starts, and a tap that stops needs no consent', () => {
  const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8')
  const start = main.indexOf("document.getElementById('stream-btn')?.addEventListener('click'")
  const handler = main.slice(start, main.indexOf('\n  })\n', start))
  const stop = handler.indexOf('void kfStreamer.stop({')
  const begin = handler.indexOf('cameraFrames.requestStart(() => kfStreamer.start())')
  assert.ok(stop > 0 && begin > stop, 'stopping is the first branch and starts nothing')
  assert.ok(!handler.slice(stop, begin).includes('requestStart'), 'the stop branch never asks')
  assert.doesNotMatch(handler, /kfStreamer\.start\(\)\s*\n\s*\.then/, 'the only start is the one behind the ask')
  const calls = [...code(main).matchAll(/kfStreamer\.start\(\)/g)].length
  assert.equal(calls, 1, 'one place in the scanner starts the stream directly, and it is behind requestStart')
})

test('source shape: the automatic start comes after calibration, on the Place the scan is in, and is the only default-on', () => {
  const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8')
  const calibrate = main.indexOf('await runProjectCalibration({')
  const auto = main.indexOf('cameraFrames.autoStart(selectedProject !== null)')
  assert.ok(calibrate > 0 && auto > calibrate, 'after the calibration, so a Place scan is one the person chose')
  assert.equal([...main.matchAll(/cameraFrames\.autoStart\(/g)].length, 1)
  // The streamer itself is built with no automatic start of its own, and no rule about consent: whoever starts it has asked.
  const streamer = code(readFileSync(join(ROOT, 'src/capture/keyframes.ts'), 'utf8'))
  assert.doesNotMatch(streamer, /consent/i)
})

test('source shape: a pagehide, a reset and a rotation do not reopen a stream the person turned off', () => {
  const streamer = readFileSync(join(ROOT, 'src/capture/keyframes.ts'), 'utf8')
  const rotate = streamer.slice(streamer.indexOf('rotate(finalize: FinalizeSessionPayload)'), streamer.indexOf('Runs one transition after the one before it'))
  assert.match(rotate, /await this\._closeSession\(finalize\)\n\s+if \(this\._halted\) return\n\s+await this\._openSession\(\)/)
  assert.match(streamer, /start\(\): Promise<void> \{\n\s+\/\/ [^\n]+\n\s+this\._halted = false/)
})
