/**
 * The consent dialog and the "Camera frames" row in the scanner's side panel (src/capture/keyframe-consent.ts).
 *
 * The row is always there: a switch, the one line that says what is sent and where, what is happening now, and, once
 * this phone has sent frames to this server, a button to delete them, with what that list does not hold. The dialog is
 * what a tap on Stream shows to a device that has not agreed. Both say the same words, which live in keyframe-consent.ts
 * so the privacy note can quote them.
 *
 * Text goes in with textContent, so nothing a server answers is ever read as markup. The dialog is the shell dialog
 * (./shell-dialog.ts), a native `<dialog>`: modal, closes on Escape, and Escape or the close button is "Not now".
 */
import { SCAN_SERVER_CHANGE_EVENT } from '../shared/api-base.ts'
import { KEYFRAME_CONSENT_KEY } from '../shared/storage-keys.ts'
import {
  confirmDeleteText,
  KEYFRAME_CONSENT_COPY,
  KeyframeConsent,
  KeyframeSessionLedger,
  keyframeStatusText,
  ledgerNote,
  serverHost,
  serverLine,
  type StreamCounts,
} from '../capture/keyframe-consent.ts'
import {
  type FinalizePayload,
  KeyframeConsentController,
  type StreamerPort,
} from '../capture/keyframe-consent-controller.ts'
import type { StreamerStatus } from '../capture/keyframes.ts'
import { openShellDialog } from './shell-dialog.ts'

/** The host the frames go to, as the person would recognise it: the Scan server's, or the page's own. */
export { serverHost }

/** The dialog's paragraphs, in order. Pure, so the words are tested without a document. */
export function consentDialogParagraphs(host: string): string[] {
  return [KEYFRAME_CONSENT_COPY.line, ...KEYFRAME_CONSENT_COPY.details, serverLine(host)]
}

/** Shows the consent words. Resolves true for Allow, and false for Not now, Escape or the close button. */
export function askKeyframeConsent(host: string = serverHost(), doc: Document = document): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let answered = false
    const answer = (value: boolean): void => {
      if (answered) return
      answered = true
      resolve(value)
    }
    const paragraphs = consentDialogParagraphs(host).map((text) => {
      const p = doc.createElement('p')
      p.textContent = text
      return p
    })
    const allow = doc.createElement('button')
    allow.type = 'button'
    allow.className = 'cs-btn cs-btn-primary'
    allow.id = 'keyframe-consent-allow'
    allow.textContent = KEYFRAME_CONSENT_COPY.allow
    const decline = doc.createElement('button')
    decline.type = 'button'
    decline.className = 'cs-btn cs-btn-quiet'
    decline.id = 'keyframe-consent-decline'
    decline.textContent = KEYFRAME_CONSENT_COPY.decline
    const actions = doc.createElement('div')
    actions.className = 'cs-actions'
    actions.append(allow, decline)
    const dialog = openShellDialog(KEYFRAME_CONSENT_COPY.title, [...paragraphs, actions], doc)
    allow.addEventListener('click', () => {
      answer(true)
      dialog.close()
    })
    decline.addEventListener('click', () => {
      answer(false)
      dialog.close()
    })
    // Escape and the close button end the dialog without an answer: that is a no.
    dialog.addEventListener('close', () => answer(false))
  })
}

export interface ConsentRowOptions {
  container: HTMLElement
  consent: KeyframeConsent
  ledger: KeyframeSessionLedger
  controller: KeyframeConsentController
  /** Whether the streamer is sending now. */
  streaming: () => boolean
}

export interface ConsentRow {
  /** Redraws the status line from the streamer's counters. Call it from the streamer's onStatus. */
  update(status: StreamCounts & { active: boolean; offline: boolean }): void
  /** Redraws everything from the consent and the ledger, for a change that is not a status. */
  refresh(): void
}

const LABEL_STYLE = 'color:rgba(255,255,255,0.6);font-size:10px;text-transform:uppercase;letter-spacing:0.08em;padding:4px 0 2px;'
const NOTE_STYLE = 'font-size:10px;line-height:1.5;color:rgba(255,255,255,0.6);padding:2px 0;'

/**
 * Draws the row into `container` and keeps it in step with the consent, the streamer and the ledger. The switch is
 * `role="switch"`, so a screen reader says it is on or off.
 */
export function mountConsentRow(opts: ConsentRowOptions, doc: Document = document): ConsentRow {
  const { container, consent, ledger, controller } = opts
  const wrap = doc.createElement('div')
  wrap.id = 'keyframe-consent-row'
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.06);'

  const label = doc.createElement('div')
  label.style.cssText = LABEL_STYLE
  label.textContent = 'Camera frames'

  const toggle = doc.createElement('button')
  toggle.type = 'button'
  toggle.id = 'keyframe-consent-switch'
  toggle.className = 'ci-toolbar-pill'
  toggle.setAttribute('role', 'switch')
  // The visible text carries On or Off for the eye; the switch role and aria-checked carry it for a screen reader.
  toggle.setAttribute('aria-label', KEYFRAME_CONSENT_COPY.switchLabel)

  const line = doc.createElement('div')
  line.id = 'keyframe-consent-line'
  line.style.cssText = NOTE_STYLE
  line.textContent = KEYFRAME_CONSENT_COPY.line

  const status = doc.createElement('div')
  status.id = 'keyframe-consent-status'
  status.setAttribute('aria-live', 'polite')
  status.style.cssText = NOTE_STYLE

  const remove = doc.createElement('button')
  remove.type = 'button'
  remove.id = 'keyframe-consent-delete'
  remove.className = 'panel-btn-ghost panel-btn-danger'

  // What the list behind the button does not hold: said beside it, because the button says it deletes what this phone sent.
  const listNote = doc.createElement('div')
  listNote.id = 'keyframe-consent-list-note'
  listNote.style.cssText = NOTE_STYLE

  const result = doc.createElement('div')
  result.id = 'keyframe-consent-result'
  result.setAttribute('role', 'status')
  result.style.cssText = NOTE_STYLE

  wrap.append(label, toggle, line, status, remove, listNote, result)
  container.appendChild(wrap)

  let counts: StreamCounts = { sent: 0, skipped: 0, failed: 0 }
  let offline = false

  const draw = (): void => {
    const on = consent.granted
    toggle.setAttribute('aria-checked', String(on))
    toggle.textContent = `${KEYFRAME_CONSENT_COPY.switchLabel}: ${on ? 'On' : 'Off'}`
    toggle.classList.toggle('active', on)
    status.textContent = keyframeStatusText({ state: consent.state, streaming: opts.streaming(), counts, offline })
    const sent = ledger.count
    remove.hidden = sent === 0
    remove.textContent = `Delete frames this phone sent (${sent})`
    // Shown whenever the list leaves something out, even with nothing on it to delete: that is when it matters most.
    const note = ledgerNote({ elsewhere: ledger.elsewhere, forgotten: ledger.forgotten })
    listNote.textContent = note
    listNote.hidden = note === ''
  }

  toggle.addEventListener('click', () => {
    result.textContent = ''
    toggle.disabled = true
    // Said only for a switch that was on and is now off: a no to the dialog changes nothing and stopped nothing.
    const wasOn = consent.granted
    void controller.setSwitch(!wasOn).then((state) => {
      if (wasOn && state === 'off') result.textContent = KEYFRAME_CONSENT_COPY.stopped
    }).finally(() => {
      toggle.disabled = false
      draw()
    })
  })
  remove.addEventListener('click', () => {
    remove.disabled = true
    void controller.deleteSent().then((text) => {
      if (text) result.textContent = text
    }).finally(() => {
      remove.disabled = false
      draw()
    })
  })
  consent.subscribe(draw)
  draw()

  return {
    update(next) {
      counts = { sent: next.sent, skipped: next.skipped, failed: next.failed }
      offline = next.offline
      draw()
    },
    refresh: draw,
  }
}

// ── What the scanner mounts ─────────────────────────────────────────────────

export interface KeyframeFramesOptions {
  streamer: StreamerPort
  /** The side panel's footer. Without it there is no row, and the dialog and the rules still work. */
  footer: HTMLElement | null
  /** True when another tab is the scanner: this page starts nothing. */
  readOnly: boolean
  /** The payload the finalize POST carries when a stream is abandoned. */
  finalizePayload: () => FinalizePayload
  /** Whether the scanner is running. */
  canStreamNow: () => boolean
}

/** What main.ts holds on to: the answer, and the four calls it makes into the rules. */
export interface KeyframeFrames {
  consent: KeyframeConsent
  /** A tap on Stream that would start sending: asks first when this device has not agreed. */
  requestStart(start: () => Promise<void>): Promise<boolean>
  /** The streamer's status, for the row. */
  onStatus(status: StreamerStatus): void
  /** A session the streamer opened, for the ledger that "Delete frames this phone sent" reads. */
  noteSession(sessionId: string): void
  /** A scan in a Place has begun: streams by default, but only on a device that has agreed (D15). */
  autoStart(placeSelected: boolean): boolean
}

/**
 * Builds this device's consent, its ledger, the rules that tie them to the streamer, and the row in the panel, and
 * keeps the consent in step with other tabs. One call from the scanner.
 */
export function mountKeyframeFrames(opts: KeyframeFramesOptions): KeyframeFrames {
  const consent = new KeyframeConsent()
  const ledger = new KeyframeSessionLedger()
  const controller = new KeyframeConsentController({
    consent,
    ledger,
    streamer: opts.streamer,
    finalizePayload: opts.finalizePayload,
    ask: () => askKeyframeConsent(),
    confirmDelete: (streaming, sessions) => confirm(confirmDeleteText({ sessions, streaming })),
    readOnly: opts.readOnly,
    canStreamNow: opts.canStreamNow,
  })
  // An answer given in another tab reaches this one through the storage event, and a withdrawal there stops sending here.
  globalThis.addEventListener?.('storage', (event) => {
    if (event.key === KEYFRAME_CONSENT_KEY || event.key === null) consent.refresh()
  })
  const row = opts.footer
    ? mountConsentRow({ container: opts.footer, consent, ledger, controller, streaming: () => opts.streamer.active })
    : null
  // A yes was given for a Scan server. When the device is pointed at another one the yes no longer counts: sending stops, and
  // the row asks again. The list of sessions is redrawn for the server now in use.
  globalThis.addEventListener?.(SCAN_SERVER_CHANGE_EVENT, () => {
    consent.refresh()
    row?.refresh()
  })
  return {
    consent,
    requestStart: (start) => controller.requestStart(start),
    onStatus: (status) => row?.update(status),
    noteSession: (sessionId) => {
      controller.noteSession(sessionId)
      row?.refresh()
    },
    autoStart: (placeSelected) => controller.autoStart(placeSelected),
  }
}
