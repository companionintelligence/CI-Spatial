/**
 * WP-15b: the consent dialog and the "Camera frames" row (src/ui/keyframe-consent-ui.ts), drawn into a small
 * stand-in for the document, and the one mount main.ts calls.
 *
 * What these hold: the dialog says the words in keyframe-consent.ts and the server it will send to, and only Allow is a yes
 * (Not now, the close button and Escape are all a no, and the first answer is the only one); the row shows the answer as
 * a switch, says what is happening, shows the delete button only when this phone remembers sending something to this
 * server, says beside it what that list leaves out, asks a confirm that says how many sessions and whether a stream will
 * stop, and tells the person when a switch they turned off has stopped sending; and the mount ties them to one consent,
 * one ledger and the streamer, and hears a change made in another tab and a different Scan server.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-15b-consent-ui.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  confirmDeleteText,
  KEYFRAME_CONSENT_COPY,
  KeyframeConsent,
  KeyframeSessionLedger,
  ledgerNote,
  serverLine,
  type ConsentStorage,
} from '../../../src/capture/keyframe-consent.ts'
import { KeyframeConsentController, type StreamerPort } from '../../../src/capture/keyframe-consent-controller.ts'
import { askKeyframeConsent, consentDialogParagraphs, mountConsentRow, mountKeyframeFrames } from '../../../src/ui/keyframe-consent-ui.ts'
import { SCAN_SERVER_CHANGE_EVENT } from '../../../src/shared/api-base.ts'
import { KEYFRAME_CONSENT_KEY } from '../../../src/shared/storage-keys.ts'

const ORIGIN = 'https://scan.example.ts.net'
const OTHER_ORIGIN = 'https://someone-elses-server.example'

const S1 = 'sess-11111111-1111-4111-8111-111111111111'

/** What the dialog and the row use of an element. */
class FakeElement {
  tag: string
  children: FakeElement[] = []
  attributes = new Map<string, string>()
  handlers = new Map<string, Array<() => void>>()
  classes = new Set<string>()
  style = { cssText: '' }
  className = ''
  id = ''
  type = ''
  textContent = ''
  hidden = false
  disabled = false
  closed = false
  constructor(tag: string) {
    this.tag = tag
  }
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }
  appendChild(node: FakeElement): FakeElement {
    this.children.push(node)
    return node
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  get classList() {
    return { toggle: (name: string, on?: boolean) => void (on ? this.classes.add(name) : this.classes.delete(name)) }
  }
  addEventListener(type: string, handler: () => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler])
  }
  emit(type: string): void {
    for (const handler of this.handlers.get(type) ?? []) handler()
  }
  showModal(): void {}
  close(): void {
    this.closed = true
    this.emit('close')
  }
  remove(): void {}
  all(): FakeElement[] {
    return [this, ...this.children.flatMap((child) => child.all())]
  }
  byId(id: string): FakeElement {
    const found = this.all().find((el) => el.id === id)
    assert.ok(found, `no element with id ${id}`)
    return found
  }
}

interface Page {
  document: { createElement(tag: string): FakeElement; getElementById(id: string): FakeElement | null; head: FakeElement; body: FakeElement }
  body: FakeElement
  /** The last dialog the page opened. */
  dialog(): FakeElement
  confirms: string[]
  confirmAnswer: boolean
  storageListeners: Array<(event: { key: string | null }) => void>
  /** The listeners for a change of the saved Scan server, which the mount registers. */
  serverListeners: Array<() => void>
  /** The page's location: a test moves `origin` to point the app at another Scan server. */
  location: { host: string; origin: string }
  storage: ConsentStorage & { data: Map<string, string> }
}

/** Installs the globals a scanner page has, runs `body`, and puts every global back. */
async function onPage(body: (page: Page) => Promise<void> | void): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>
  const names = ['document', 'confirm', 'localStorage', 'addEventListener', 'location']
  const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  const put = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  const data = new Map<string, string>()
  const storage = {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
  const documentBody = new FakeElement('body')
  const page: Page = {
    document: {
      createElement: (tag) => new FakeElement(tag),
      getElementById: () => null,
      head: new FakeElement('head'),
      body: documentBody,
    },
    body: documentBody,
    dialog: () => documentBody.children.filter((el) => el.tag === 'dialog').at(-1)!,
    confirms: [],
    confirmAnswer: true,
    storageListeners: [],
    serverListeners: [],
    location: { host: 'scan.example.ts.net', origin: ORIGIN },
    storage,
  }
  put('document', page.document)
  put('localStorage', storage)
  put('location', page.location)
  put('confirm', (text: string) => {
    page.confirms.push(text)
    return page.confirmAnswer
  })
  put('addEventListener', (type: string, listener: (event: { key: string | null }) => void) => {
    if (type === 'storage') page.storageListeners.push(listener)
    if (type === SCAN_SERVER_CHANGE_EVENT) page.serverListeners.push(listener as unknown as () => void)
  })
  try {
    await body(page)
  } finally {
    names.forEach((name, i) => {
      const had = saved[i]
      if (had) Object.defineProperty(globalThis, name, had)
      else delete g[name]
    })
  }
}

const text = (el: FakeElement): string[] => el.all().filter((child) => child.tag === 'p').map((child) => child.textContent)
const buttons = (el: FakeElement): FakeElement[] => el.all().filter((child) => child.tag === 'button')

// ── The dialog ───────────────────────────────────────────────────────────────────────────────────

test('the dialog says what is sent, where it goes and that it stops at once, and names the server it will send to', async () => {
  await onPage(async ({ dialog }) => {
    const asking = askKeyframeConsent('scan.example.ts.net')
    const shown = dialog()
    assert.equal(shown.all().find((el) => el.tag === 'h2')?.textContent, KEYFRAME_CONSENT_COPY.title)
    assert.deepEqual(text(shown), [KEYFRAME_CONSENT_COPY.line, ...KEYFRAME_CONSENT_COPY.details, serverLine('scan.example.ts.net')])
    const labels = buttons(shown).filter((b) => b.id.startsWith('keyframe-consent-')).map((b) => b.textContent)
    assert.deepEqual(labels, ['Allow', 'Not now'])
    shown.byId('keyframe-consent-decline').emit('click')
    assert.equal(await asking, false)
  })
  assert.deepEqual(consentDialogParagraphs('h'), [KEYFRAME_CONSENT_COPY.line, ...KEYFRAME_CONSENT_COPY.details, 'Server: h'])
})

test('only Allow is a yes: Not now, the close button and Escape are each a no', async () => {
  await onPage(async ({ dialog }) => {
    const yes = askKeyframeConsent('h')
    dialog().byId('keyframe-consent-allow').emit('click')
    assert.equal(await yes, true)
    assert.equal(dialog().closed, true, 'the dialog closes itself')

    const no = askKeyframeConsent('h')
    dialog().byId('keyframe-consent-decline').emit('click')
    assert.equal(await no, false)

    const escaped = askKeyframeConsent('h')
    dialog().emit('close')
    assert.equal(await escaped, false, 'Escape and the close button end a native dialog without a click on either button')
  })
})

test('the first answer is the only one: an Allow followed by the dialog closing is still a yes', async () => {
  await onPage(async ({ dialog }) => {
    const asking = askKeyframeConsent('h')
    dialog().byId('keyframe-consent-allow').emit('click')
    dialog().emit('close')
    assert.equal(await asking, true)
  })
})

test('the dialog puts text in with textContent, so nothing it shows is read as markup', async () => {
  await onPage(async ({ dialog }) => {
    const asking = askKeyframeConsent('<img src=x onerror=alert(1)>')
    const shown = dialog()
    const server = text(shown).at(-1)!
    assert.equal(server, 'Server: <img src=x onerror=alert(1)>')
    assert.equal(shown.all().some((el) => el.tag === 'img'), false)
    shown.byId('keyframe-consent-decline').emit('click')
    await asking
  })
})

// ── The row ──────────────────────────────────────────────────────────────────────────────────────

interface RowKit {
  row: ReturnType<typeof mountConsentRow>
  container: FakeElement
  consent: KeyframeConsent
  ledger: KeyframeSessionLedger
  streamer: StreamerPort & { active: boolean; starts: number; abandons: number }
  deleteCalls: () => number
  asked: () => number
}

function mountRow(page: Page, opts: { answer?: boolean } = {}): RowKit {
  const consent = new KeyframeConsent({ storage: page.storage })
  const ledger = new KeyframeSessionLedger({ storage: page.storage })
  const streamer = {
    active: false,
    isTransitioning: false,
    starts: 0,
    abandons: 0,
    async start() {
      this.starts += 1
      this.active = true
    },
    async abandon() {
      this.abandons += 1
      this.active = false
    },
  }
  let asked = 0
  let deleted = 0
  const controller = new KeyframeConsentController({
    consent,
    ledger,
    streamer,
    finalizePayload: () => ({}),
    ask: async () => {
      asked += 1
      return opts.answer ?? true
    },
    confirmDelete: () => true,
    readOnly: false,
    canStreamNow: () => true,
    dropQueued: async () => 0,
    deleteSent: async () => {
      deleted += 1
      ledger.remove(ledger.ids())
      return { deleted: 1, alreadyGone: 0, failed: 0, offline: false, elsewhere: 0, forgotten: 0 }
    },
  })
  const container = new FakeElement('div')
  const row = mountConsentRow({ container, consent, ledger, controller, streaming: () => streamer.active }, page.document as unknown as Document)
  return { row, container, consent, ledger, streamer, deleteCalls: () => deleted, asked: () => asked }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

test('the row starts off: the switch says off, the line says what is sent, and nothing is offered to delete', async () => {
  await onPage((page) => {
    const { container } = mountRow(page)
    const wrap = container.byId('keyframe-consent-row')
    assert.equal(container.children.includes(wrap), true)
    const toggle = container.byId('keyframe-consent-switch')
    assert.equal(toggle.getAttribute('role'), 'switch', 'a screen reader says on or off')
    assert.equal(toggle.getAttribute('aria-label'), 'Send camera frames', 'its name is the setting; the state is aria-checked')
    assert.equal(toggle.getAttribute('aria-checked'), 'false')
    assert.equal(toggle.textContent, 'Send camera frames: Off')
    assert.equal(container.byId('keyframe-consent-line').textContent, KEYFRAME_CONSENT_COPY.line)
    assert.equal(container.byId('keyframe-consent-status').textContent, 'Off. Nothing is sent.')
    assert.equal(container.byId('keyframe-consent-delete').hidden, true, 'a phone that has sent nothing has nothing to delete')
  })
})

test('the switch follows the answer, and the status line follows the streamer', async () => {
  await onPage((page) => {
    const kit = mountRow(page)
    kit.consent.grant()
    const toggle = kit.container.byId('keyframe-consent-switch')
    assert.equal(toggle.getAttribute('aria-checked'), 'true')
    assert.equal(toggle.textContent, 'Send camera frames: On')
    assert.equal(toggle.classes.has('active'), true)
    assert.equal(kit.container.byId('keyframe-consent-status').textContent, 'On. Not sending right now.')
    kit.streamer.active = true
    kit.row.update({ active: true, sent: 5, skipped: 1, failed: 0, offline: false })
    assert.equal(kit.container.byId('keyframe-consent-status').textContent, 'Sending frames. 5 sent, 1 skipped.')
    kit.consent.withdraw()
    assert.equal(toggle.getAttribute('aria-checked'), 'false')
    assert.equal(kit.container.byId('keyframe-consent-status').textContent, 'Off. Nothing is sent.')
  })
})

test('tapping the switch on asks, then agrees and starts; a no leaves it off and says nothing was stopped', async () => {
  await onPage(async (page) => {
    const kit = mountRow(page, { answer: false })
    const toggle = kit.container.byId('keyframe-consent-switch')
    toggle.emit('click')
    await settle()
    assert.equal(kit.asked(), 1)
    assert.equal(kit.consent.state, 'unset')
    assert.equal(toggle.getAttribute('aria-checked'), 'false')
    assert.equal(kit.container.byId('keyframe-consent-result').textContent, '', 'declining stopped nothing, so it says nothing')

    const yes = mountRow(page, { answer: true })
    yes.container.byId('keyframe-consent-switch').emit('click')
    await settle()
    assert.equal(yes.consent.state, 'granted')
    assert.equal(yes.streamer.starts, 1)
    assert.equal(yes.container.byId('keyframe-consent-switch').getAttribute('aria-checked'), 'true')
  })
})

test('tapping the switch off withdraws at once and says that it stopped and what became of what was sent', async () => {
  await onPage(async (page) => {
    const kit = mountRow(page)
    kit.consent.grant()
    kit.streamer.active = true
    kit.container.byId('keyframe-consent-switch').emit('click')
    await settle()
    assert.equal(kit.consent.state, 'withdrawn')
    assert.equal(kit.streamer.abandons >= 1, true)
    assert.equal(kit.container.byId('keyframe-consent-result').textContent, KEYFRAME_CONSENT_COPY.stopped)
    assert.match(KEYFRAME_CONSENT_COPY.stopped, /already sent stay on your server until deleted/)
    assert.equal(kit.container.byId('keyframe-consent-switch').disabled, false, 'the switch is usable again')
  })
})

test('the delete button appears once this phone has sent frames, counts them, and tells the person what happened', async () => {
  await onPage(async (page) => {
    const kit = mountRow(page)
    const remove = kit.container.byId('keyframe-consent-delete')
    assert.equal(remove.hidden, true)
    kit.ledger.add(S1)
    kit.row.refresh()
    assert.equal(remove.hidden, false)
    assert.equal(remove.textContent, 'Delete frames this phone sent (1)')
    remove.emit('click')
    await settle()
    assert.equal(kit.deleteCalls(), 1)
    assert.equal(kit.container.byId('keyframe-consent-result').textContent, 'Deleted the frames from 1 scan session on your server.')
    assert.equal(remove.hidden, true, 'nothing is left to delete')
    assert.equal(kit.consent.state, 'unset', 'deleting changes no answer')
  })
})

// ── The mount ────────────────────────────────────────────────────────────────────────────────────

function mountForScanner(page: Page, footer: FakeElement | null) {
  const streamer: StreamerPort & { starts: number; abandons: number; active: boolean } = {
    active: false,
    isTransitioning: false,
    starts: 0,
    abandons: 0,
    async start() {
      this.starts += 1
      this.active = true
    },
    async abandon() {
      this.abandons += 1
      this.active = false
    },
  }
  const frames = mountKeyframeFrames({
    streamer,
    footer: footer as unknown as HTMLElement | null,
    readOnly: false,
    finalizePayload: () => ({ glbFilename: 'a.glb' }),
    canStreamNow: () => true,
  })
  void page
  return { frames, streamer }
}

test('the mount draws the row into the panel footer and reads the answer this device already gave', async () => {
  await onPage((page) => {
    page.storage.setItem(KEYFRAME_CONSENT_KEY, JSON.stringify({ state: 'granted', at: '2026-11-16T09:00:00.000Z', copyVersion: 1, server: ORIGIN }))
    const footer = new FakeElement('div')
    const { frames } = mountForScanner(page, footer)
    assert.equal(frames.consent.state, 'granted')
    assert.equal(footer.byId('keyframe-consent-switch').getAttribute('aria-checked'), 'true')
  })
})

test('a page with no footer has no row, and the rules still work', async () => {
  await onPage(async (page) => {
    const { frames, streamer } = mountForScanner(page, null)
    assert.equal(frames.autoStart(true), false, 'no yes yet, so no stream')
    frames.consent.grant()
    assert.equal(frames.autoStart(true), true)
    await settle()
    assert.equal(streamer.starts, 1)
    frames.onStatus({ active: true, sessionId: null, sent: 1, queued: 0, skipped: 0, failed: 0, offline: false })
    frames.noteSession(S1)
  })
})

test('a session the streamer opens is noted, and the delete button for it appears', async () => {
  await onPage((page) => {
    const footer = new FakeElement('div')
    const { frames } = mountForScanner(page, footer)
    assert.equal(footer.byId('keyframe-consent-delete').hidden, true)
    frames.noteSession(S1)
    assert.equal(footer.byId('keyframe-consent-delete').hidden, false)
    assert.equal(footer.byId('keyframe-consent-delete').textContent, 'Delete frames this phone sent (1)')
  })
})

test('an answer given in another tab is heard here through the storage event, and a withdrawal stops the stream', async () => {
  await onPage(async (page) => {
    const footer = new FakeElement('div')
    const { frames, streamer } = mountForScanner(page, footer)
    assert.equal(page.storageListeners.length, 1)
    const hear = (key: string | null) => page.storageListeners[0]!({ key })

    page.storage.setItem(KEYFRAME_CONSENT_KEY, JSON.stringify({ state: 'granted', at: 'x', copyVersion: 1, server: ORIGIN }))
    hear('something-else')
    assert.equal(frames.consent.state, 'unset', 'a change to another key is not read')
    hear(KEYFRAME_CONSENT_KEY)
    assert.equal(frames.consent.state, 'granted')
    assert.equal(footer.byId('keyframe-consent-switch').getAttribute('aria-checked'), 'true')

    streamer.active = true
    page.storage.setItem(KEYFRAME_CONSENT_KEY, JSON.stringify({ state: 'withdrawn', at: 'y', copyVersion: 1, server: ORIGIN }))
    hear(null)
    await settle()
    assert.equal(frames.consent.state, 'withdrawn')
    assert.equal(streamer.abandons, 1, 'turning it off on another tab stopped this one')
  })
})

test('a tap on Stream through the mount asks when the device has not agreed, and starts only after a yes', async () => {
  await onPage(async (page) => {
    const footer = new FakeElement('div')
    const { frames, streamer } = mountForScanner(page, footer)
    const started = frames.requestStart(() => streamer.start())
    // The dialog is open; the stream has not started.
    assert.equal(streamer.starts, 0)
    page.dialog().byId('keyframe-consent-allow').emit('click')
    assert.equal(await started, true)
    assert.equal(streamer.starts, 1)
    assert.equal(JSON.parse(page.storage.getItem(KEYFRAME_CONSENT_KEY)!).state, 'granted', 'and the yes is on this device')
  })
})

// ── What the list leaves out, the confirm, and a different Scan server ─────────────────────────────

test('the note beside the delete button says what the list leaves out, even when there is nothing on it to delete', async () => {
  await onPage((page) => {
    const kit = mountRow(page)
    const note = kit.container.byId('keyframe-consent-list-note')
    assert.equal(note.textContent, '')
    assert.equal(note.hidden, true, 'nothing left out, nothing to say')
    // A phone that streamed 30 sessions and keeps 3 has forgotten 27.
    const small = new KeyframeSessionLedger({ storage: page.storage, limit: 3 })
    for (let n = 1; n <= 30; n++) small.add(`sess-${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`)
    kit.row.refresh()
    assert.equal(note.hidden, false)
    assert.equal(note.textContent, ledgerNote({ elsewhere: 0, forgotten: 27 }))
    assert.match(note.textContent, /27 older than this phone keeps a list of/)
  })
})

test('the confirm says how many sessions this phone remembers, and that sending stops when a stream is running', async () => {
  await onPage(async (page) => {
    const footer = new FakeElement('div')
    const { frames, streamer } = mountForScanner(page, footer)
    frames.noteSession(S1)
    const remove = footer.byId('keyframe-consent-delete')
    remove.emit('click')
    await settle()
    assert.deepEqual(page.confirms, [confirmDeleteText({ sessions: 1, streaming: false })])

    // With a stream running, the same tap says that it stops, and does stop it before the sessions are deleted.
    frames.consent.grant()
    frames.noteSession('sess-22222222-2222-4222-8222-222222222222')
    streamer.active = true
    page.confirms.length = 0
    page.confirmAnswer = false
    remove.emit('click')
    await settle()
    assert.deepEqual(page.confirms, [confirmDeleteText({ sessions: 2, streaming: true })])
    assert.match(page.confirms[0]!, /Sending stops now\.$/)
    assert.equal(streamer.active, true, 'a no to the confirm stopped nothing')
    assert.equal(streamer.abandons, 0)
  })
})

test('when the device is pointed at another Scan server the yes stops counting: sending stops and the row says off', async () => {
  await onPage(async (page) => {
    const footer = new FakeElement('div')
    const { frames, streamer } = mountForScanner(page, footer)
    frames.consent.grant()
    streamer.active = true
    const toggle = footer.byId('keyframe-consent-switch')
    assert.equal(toggle.getAttribute('aria-checked'), 'true')
    assert.equal(page.serverListeners.length, 1, 'the mount listens for a change of the saved Scan server')

    page.location.origin = OTHER_ORIGIN
    page.serverListeners[0]!()
    await settle()
    assert.equal(frames.consent.state, 'unset', 'the yes was for the first server')
    assert.equal(streamer.abandons, 1, 'and what was being sent there stopped')
    assert.equal(toggle.getAttribute('aria-checked'), 'false')
    assert.equal(footer.byId('keyframe-consent-status').textContent, 'Off. Nothing is sent.')

    // Pointed back at it, the yes counts again, but nothing starts by itself: the next scan, or a tap, does.
    page.location.origin = ORIGIN
    page.serverListeners[0]!()
    assert.equal(frames.consent.state, 'granted')
    assert.equal(streamer.active, false)
  })
})

test('the sessions listed are the ones on the server in use, and the note says how many went to another', async () => {
  await onPage((page) => {
    const footer = new FakeElement('div')
    const { frames } = mountForScanner(page, footer)
    frames.noteSession(S1)
    assert.equal(footer.byId('keyframe-consent-delete').textContent, 'Delete frames this phone sent (1)')
    page.location.origin = OTHER_ORIGIN
    page.serverListeners[0]!()
    assert.equal(footer.byId('keyframe-consent-delete').hidden, true, 'this server has none of this phone\'s sessions')
    assert.equal(footer.byId('keyframe-consent-list-note').textContent, ledgerNote({ elsewhere: 1, forgotten: 0 }))
  })
})
