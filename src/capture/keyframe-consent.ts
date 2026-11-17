/**
 * Whether this device has agreed to send camera frames to its Scan server, and the words it agreed to.
 *
 * A keyframe is a photograph, taken while someone walks through a room, with the phone's pose. The scanner
 * streams them (src/capture/keyframes.ts) so that reconstruction jobs can build a 3D model, and decision D15
 * makes that stream default-on for a scan in a Place, which is the prerequisite for server registration. A
 * photograph of the inside of a home is personal data, and Apple (5.1.1) and Google Play ask for the person's
 * consent before it is collected, an easy way to withdraw it, and no feature held back for saying no.
 *
 * ## The rules this module holds
 *
 *   - Sending frames needs this device's yes. The only thing that waits on it is sending frames. The scan, the
 *     export, the calibration, the editor and every other feature work the same with consent `unset` or
 *     `withdrawn`. Nothing in the app reads this to unlock or lock anything else (docs/operations/PRIVACY.md).
 *   - Default-on is conditional. A scan in a Place streams on its own only when consent is `granted`.
 *     Otherwise nothing starts. A person can still tap Stream, and that tap asks first.
 *   - Stopping never needs consent. The tap that stops a stream, and withdrawal, always work.
 *   - Consent is per device and per browser profile (localStorage, `KEYFRAME_CONSENT_KEY`), and is for the words
 *     it was given for and the Scan server it was given for: the dialog names the server, so a yes to one is not a yes to
 *     another. When the words change in a way that changes what is sent or why (`KEYFRAME_CONSENT_COPY_VERSION`), or the
 *     app is pointed at a different Scan server, an older yes no longer counts and the person is asked again. A
 *     withdrawal stands whatever the version or the server: it is never turned back into a yes by a change.
 *   - A device whose storage is blocked keeps the person's answer for this page only, and asks again on the next.
 *
 * ## Withdrawal, and what happens to the frames already sent
 *
 * Turning it off stops sending at once: nothing waiting in the streamer or in the service worker's offline queue
 * is sent, and the upload in flight is cancelled (KeyframeStreamer.abandon, dropQueuedKeyframeUploads). The
 * frames already on the server are not taken back by that, and the copy says so. They stay until the scan is
 * deleted (DELETE /scans/:filename removes its sessions), until the server's retention setting removes them, or
 * until the person taps "Delete frames this phone sent", which names each session this device remembers streaming to
 * this server (`KeyframeSessionLedger`) to DELETE /sessions/:id. The list is the phone's own and is not complete: it keeps
 * the newest sessions, it was not kept by earlier builds, and it is empty on a phone whose storage was cleared. What it
 * cannot name goes with its scan. Deleting is a separate tap, never a side effect of turning the switch off: frames a
 * scan was built from are that scan's data, and a person who only wants sending to stop should not lose the
 * reconstruction of a room they still want.
 *
 * Pure of the DOM, so the state machine and the copy are tested without a browser. The words are here, in one
 * place, so the dialog, the panel row and docs/operations/PRIVACY.md cannot drift apart.
 */
import { KEYFRAME_CONSENT_KEY, KEYFRAME_SESSIONS_KEY } from '../shared/storage-keys.ts'
import { SESSION_ID_RE } from '../shared/session-id.ts'
import { apiBase, apiUrl } from '../shared/api-base.ts'

/**
 * The version of the consent words. Raise it when the words change in a way that changes what is sent, where it
 * goes or what it is used for, so that a device that agreed to the old words is asked again. Version 1 covers:
 * camera photos with the phone's pose, to the Scan server, to build 3D models. When server registration (WP-15b
 * slice 2) starts to use the frames to line scans up, that is a new use and this becomes 2.
 */
export const KEYFRAME_CONSENT_COPY_VERSION = 1

export type KeyframeConsentState = 'unset' | 'granted' | 'withdrawn'

/** What is stored: the answer, when it was given, the version of the words it was given for, and the Scan server it named. */
export interface KeyframeConsentRecord {
  state: 'granted' | 'withdrawn'
  at: string
  copyVersion: number
  /** The origin of the Scan server the dialog named when the person said yes. Absent in a record made before servers were kept: that yes counts for none. */
  server?: string
}

/** The words. Short and plain, and only what the code does. */
export const KEYFRAME_CONSENT_COPY = {
  title: 'Send camera frames?',
  /** The line under the switch, always on screen: what is sent, where it goes, what for, and that it can stop. */
  line: 'While you scan, sends camera photos and where the phone was to your Scan server, to build 3D models. Turn it off any time.',
  /** The rest of what the dialog says. */
  details: [
    'Photos can show people, screens and papers in the room.',
    'They go only to your Scan server. Turning this off stops sending at once.',
    'Frames already sent stay on your server until deleted.',
  ],
  allow: 'Allow',
  decline: 'Not now',
  /** Said once sending has stopped because of a withdrawal. */
  stopped: 'Stopped. Frames already sent stay on your server until deleted.',
  /** The switch's own label. */
  switchLabel: 'Send camera frames',
} as const

/**
 * What the confirm before deleting says. It says which frames: the sessions this phone remembers sending, because the list
 * is the phone's own. A stream that is running is stopped first, and the words say so.
 */
export function confirmDeleteText(input: { sessions: number; streaming: boolean }): string {
  const sessions = input.sessions === 1 ? '1 scan session' : `${input.sessions} scan sessions`
  return `Delete the camera frames from the ${sessions} this phone remembers sending to your server? This cannot be undone. Scans made from them keep what they have, but cannot be rebuilt.${input.streaming ? ' Sending stops now.' : ''}`
}

/** "Server: scan.example.ts.net": where the frames go, in the dialog, so the person can check it. */
export function serverLine(host: string): string {
  return `Server: ${host}`
}

/**
 * The origin of the Scan server the frames would go to: the address saved on this device in a native app, the build's, or
 * the page's own. Empty only where there is no page (a test). A consent and a list of sessions are for one of these.
 */
export function scanServerOrigin(): string {
  try {
    return apiBase() || globalThis.location?.origin || ''
  } catch {
    return ''
  }
}

/** The host of `origin`, as the person would recognise it. Falls back to the page's own host. */
export function serverHost(origin: string = scanServerOrigin()): string {
  try {
    return new URL(origin).host
  } catch {
    return globalThis.location?.host ?? ''
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────

/** The part of localStorage this module uses, so a test can pass a stand-in. */
export interface ConsentStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The page's localStorage, or null when the browser refuses it (a private window, blocked site data). */
export function deviceStorage(): ConsentStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function parseRecord(raw: string | null): KeyframeConsentRecord | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<KeyframeConsentRecord> | null
    if (!parsed || (parsed.state !== 'granted' && parsed.state !== 'withdrawn')) return null
    if (typeof parsed.at !== 'string' || typeof parsed.copyVersion !== 'number') return null
    return {
      state: parsed.state,
      at: parsed.at,
      copyVersion: parsed.copyVersion,
      ...(typeof parsed.server === 'string' ? { server: parsed.server } : {}),
    }
  } catch {
    return null
  }
}

export interface KeyframeConsentOptions {
  storage?: ConsentStorage | null
  now?: () => Date
  /** The version of the words in force. Tests pass another to see an old yes stop counting. */
  copyVersion?: number
  /** The Scan server the frames would go to now. Defaults to the page's. A yes counts for the server it was given to only. */
  server?: () => string
}

type Listener = (state: KeyframeConsentState) => void

/** This device's answer. Read once, kept in step with other tabs through `refresh()`, and written on every change. */
export class KeyframeConsent {
  private readonly storage: ConsentStorage | null
  private readonly now: () => Date
  private readonly copyVersion: number
  private readonly server: () => string
  private record: KeyframeConsentRecord | null
  /** The state listeners were last told, so that a change of server, which changes no record, is still announced once. */
  private told: KeyframeConsentState
  private readonly listeners = new Set<Listener>()

  constructor(opts: KeyframeConsentOptions = {}) {
    this.storage = opts.storage === undefined ? deviceStorage() : opts.storage
    this.now = opts.now ?? (() => new Date())
    this.copyVersion = opts.copyVersion ?? KEYFRAME_CONSENT_COPY_VERSION
    this.server = opts.server ?? scanServerOrigin
    this.record = this.read()
    this.told = this.state
  }

  private read(): KeyframeConsentRecord | null {
    try {
      return parseRecord(this.storage?.getItem(KEYFRAME_CONSENT_KEY) ?? null)
    } catch {
      return null
    }
  }

  /**
   * `granted` only for a yes given to the words in force, for the Scan server in use. An older yes, or a yes given for
   * another server, reads as unset, so the person is asked again.
   */
  get state(): KeyframeConsentState {
    if (!this.record) return 'unset'
    if (this.record.state === 'withdrawn') return 'withdrawn'
    return this.record.copyVersion === this.copyVersion && this.record.server === this.server() ? 'granted' : 'unset'
  }

  get granted(): boolean {
    return this.state === 'granted'
  }

  /** What is stored, for a test or the privacy note's "when did I agree": null when nothing is. */
  get stored(): KeyframeConsentRecord | null {
    return this.record
  }

  private set(state: 'granted' | 'withdrawn'): boolean {
    this.record = { state, at: this.now().toISOString(), copyVersion: this.copyVersion, server: this.server() }
    let saved = true
    try {
      if (!this.storage) saved = false
      else this.storage.setItem(KEYFRAME_CONSENT_KEY, JSON.stringify(this.record))
    } catch {
      saved = false
    }
    this.announce()
    return saved
  }

  /**
   * Records a yes to the words in force, for the Scan server in use. Resolves false when this device would not keep it:
   * the yes then holds for this page only, and the person is asked again next time.
   */
  grant(): boolean {
    return this.set('granted')
  }

  /** Records a no. A device that cannot store it still stops: the answer holds for this page. */
  withdraw(): void {
    this.set('withdrawn')
  }

  /**
   * Reads the stored answer again and looks at the Scan server again, for a change made in another tab (the `storage`
   * event) or a different server saved on this device. Notifies when the state moved.
   */
  refresh(): void {
    this.record = this.read()
    this.announce()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Tells listeners the state if it is not the one they were last told. */
  private announce(): void {
    const now = this.state
    if (now === this.told) return
    this.told = now
    for (const listener of [...this.listeners]) {
      try {
        listener(now)
      } catch (error) {
        console.warn('[keyframe-consent] listener threw:', error)
      }
    }
  }
}

// ── What a tap or a scan start does ─────────────────────────────────────────

export type StreamTapAction = 'ask-consent' | 'start' | 'stop' | 'ignore'

/**
 * What a tap on Stream does. A stream in progress is stopped, always: stopping needs no consent. A tap while the
 * streamer is opening or closing a session is ignored. Otherwise a tap starts it when this device has agreed, and
 * asks first when it has not.
 */
export function streamTapAction(input: { consent: KeyframeConsentState; streaming: boolean; transitioning: boolean }): StreamTapAction {
  if (input.transitioning) return 'ignore'
  if (input.streaming) return 'stop'
  return input.consent === 'granted' ? 'start' : 'ask-consent'
}

/**
 * Whether a scan starts streaming without a tap (D15): only on a device that has agreed, only for a scan in a Place,
 * never on a read-only page (another tab is the scanner), and never over a session that is already opening or open.
 * Anything else starts nothing. Nothing else in the scanner reads this.
 */
export function shouldAutoStartStreaming(input: {
  consent: KeyframeConsentState
  placeSelected: boolean
  readOnly: boolean
  streaming: boolean
  transitioning: boolean
}): boolean {
  return input.consent === 'granted' && input.placeSelected && !input.readOnly && !input.streaming && !input.transitioning
}

// ── The sessions this device streamed to ────────────────────────────────────

/**
 * The newest sessions kept. A phone that streams twenty sessions a room and scans every day fills this in a month.
 * Adopted, not measured (ADR 0005 rule 5): it bounds a localStorage value, and a session beyond it can still be
 * deleted with its scan. How many were let go is counted, so the person is told that the list is not the whole story.
 */
export const KEYFRAME_LEDGER_LIMIT = 500

interface LedgerEntry {
  id: string
  /** The origin of the Scan server the session was opened on, or '' for one noted before servers were kept. */
  server: string
}

interface LedgerRecord {
  entries: LedgerEntry[]
  /** How many older sessions the limit has let go of, which this phone can no longer name. */
  forgotten: number
}

/**
 * The capture sessions this device streamed frames to, and which Scan server each was on, so that "Delete frames this phone
 * sent" can name them to the server that holds them. Device-local, like the consent: nothing about which phone sent
 * which session is kept on the server. A session is deleted from the server it was sent to only: asking another server
 * to delete it would hear "not found" and say it was done. A phone whose storage was cleared cannot name what it sent,
 * and neither can one that streamed before this list was kept; those go with their scans, with the retention setting
 * or through the server's own tools.
 */
export class KeyframeSessionLedger {
  private readonly storage: ConsentStorage | null
  private readonly limit: number
  private readonly server: () => string

  constructor(opts: { storage?: ConsentStorage | null; limit?: number; server?: () => string } = {}) {
    this.storage = opts.storage === undefined ? deviceStorage() : opts.storage
    this.limit = opts.limit ?? KEYFRAME_LEDGER_LIMIT
    this.server = opts.server ?? scanServerOrigin
  }

  /** What is stored. Anything that is not a session id is dropped; the first build wrote `{ v: 1, ids }`, with no server. */
  private read(): LedgerRecord {
    try {
      const parsed = JSON.parse(this.storage?.getItem(KEYFRAME_SESSIONS_KEY) ?? 'null') as {
        ids?: unknown
        entries?: unknown
        forgotten?: unknown
      } | null
      const raw: unknown[] = Array.isArray(parsed?.entries) ? parsed.entries : Array.isArray(parsed?.ids) ? parsed.ids.map((id) => ({ id, server: '' })) : []
      const byId = new Map<string, LedgerEntry>()
      for (const item of raw) {
        const entry = item as Partial<LedgerEntry> | null
        if (!entry || typeof entry.id !== 'string' || !SESSION_ID_RE.test(entry.id)) continue
        byId.delete(entry.id)
        byId.set(entry.id, { id: entry.id, server: typeof entry.server === 'string' ? entry.server : '' })
      }
      const forgotten = typeof parsed?.forgotten === 'number' && Number.isFinite(parsed.forgotten) && parsed.forgotten > 0 ? Math.floor(parsed.forgotten) : 0
      return { entries: [...byId.values()], forgotten }
    } catch {
      return { entries: [], forgotten: 0 }
    }
  }

  private write(record: LedgerRecord): void {
    try {
      if (record.entries.length === 0 && record.forgotten === 0) this.storage?.removeItem(KEYFRAME_SESSIONS_KEY)
      else this.storage?.setItem(KEYFRAME_SESSIONS_KEY, JSON.stringify({ v: 2, entries: record.entries, forgotten: record.forgotten }))
    } catch { /* a blocked store keeps nothing: the frames can still be deleted with their scan */ }
  }

  /** Whether a session noted on `entryServer` is one this server holds. One noted before servers were kept is taken to be. */
  private isHere(entry: LedgerEntry): boolean {
    return entry.server === '' || entry.server === this.server()
  }

  /** The ids of the sessions on the Scan server in use, oldest first. */
  ids(): string[] {
    return this.read().entries.filter((entry) => this.isHere(entry)).map((entry) => entry.id)
  }

  /** How many remembered sessions were sent to another Scan server, which this phone cannot delete from here. */
  get elsewhere(): number {
    return this.read().entries.filter((entry) => !this.isHere(entry)).length
  }

  /** How many older sessions the limit let go of: sent from this phone, but no longer named by it. */
  get forgotten(): number {
    return this.read().forgotten
  }

  /** Notes a session this device has opened on the Scan server in use. Not a session id: ignored. Beyond the limit the oldest are let go and counted. */
  add(sessionId: string): void {
    if (!SESSION_ID_RE.test(sessionId)) return
    const record = this.read()
    const entries = record.entries.filter((entry) => entry.id !== sessionId)
    entries.push({ id: sessionId, server: this.server() })
    const letGo = Math.max(0, entries.length - this.limit)
    this.write({ entries: entries.slice(letGo), forgotten: record.forgotten + letGo })
  }

  remove(sessionIds: readonly string[]): void {
    const gone = new Set(sessionIds)
    const record = this.read()
    this.write({ entries: record.entries.filter((entry) => !gone.has(entry.id)), forgotten: record.forgotten })
  }

  /** How many sessions on the Scan server in use this phone remembers. */
  get count(): number {
    return this.ids().length
  }
}

/**
 * Longest one DELETE of a session may take before it counts as unreachable, in ms. Adopted, not measured (ADR 0005
 * rule 5): removing a session of a few hundred JPEGs is a directory removal on the server, and a link that does not
 * answer in this long is not going to.
 */
const DELETE_TIMEOUT_MS = 15_000

export interface DeleteSentFramesResult {
  /** Sessions the server removed. */
  deleted: number
  /** Sessions the server no longer had, which is as good as deleted. */
  alreadyGone: number
  /** Sessions the server refused or could not remove, or whose answer never came. */
  failed: number
  /** True when the server could not be reached: nothing past the first miss was tried. */
  offline: boolean
  /** Sessions this phone sent to another Scan server: not asked about here, and kept on the list. */
  elsewhere: number
  /** Older sessions this phone no longer names. */
  forgotten: number
}

/**
 * Asks the server in use to delete each session this phone sent to it. A session that is gone (404) is done. One the
 * server will not delete because it is a scan's own source (409) is dropped from the ledger and counted as failed: it is
 * not this phone's streamed frames and is deleted with its scan. A network failure stops the run, so an offline phone does
 * not wait out a timeout per session. What the server removed or no longer had leaves the ledger; the rest stays for a retry.
 * Sessions sent to another Scan server are not asked about, and stay.
 */
export async function deleteSentFrames(
  ledger: KeyframeSessionLedger,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<DeleteSentFramesResult> {
  const result: DeleteSentFramesResult = { deleted: 0, alreadyGone: 0, failed: 0, offline: false, elsewhere: ledger.elsewhere, forgotten: ledger.forgotten }
  const done: string[] = []
  for (const sessionId of ledger.ids()) {
    let response: Response
    try {
      response = await fetchFn(apiUrl(`/sessions/${encodeURIComponent(sessionId)}`), {
        method: 'DELETE',
        signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
      })
    } catch {
      result.offline = true
      break
    }
    if (response.ok) {
      result.deleted += 1
      done.push(sessionId)
    } else if (response.status === 404) {
      result.alreadyGone += 1
      done.push(sessionId)
    } else if (response.status === 409) {
      result.failed += 1
      done.push(sessionId)
    } else {
      result.failed += 1
    }
  }
  ledger.remove(done)
  return result
}

/**
 * What is left out of "Delete frames this phone sent", in words, or '' when nothing is. Always on screen beside the button, and
 * the last words of what it reports: the list is this phone's own, so it is said what it does not hold.
 */
export function ledgerNote(input: { elsewhere: number; forgotten: number }): string {
  const parts: string[] = []
  if (input.elsewhere > 0) parts.push(`${input.elsewhere} sent to another Scan server (delete them there)`)
  if (input.forgotten > 0) parts.push(`${input.forgotten} older than this phone keeps a list of`)
  return parts.length === 0 ? '' : `Not on this list: ${parts.join(', ')}. Frames not on the list go when their scan is deleted.`
}

/** What the person is told after "Delete frames this phone sent". `hadAny` is whether this phone remembered any sessions on this server. */
export function deleteResultText(result: DeleteSentFramesResult, hadAny: boolean): string {
  const note = ledgerNote(result)
  const tail = note ? ` ${note}` : ''
  if (!hadAny) {
    return `This phone does not remember sending frames to this server. Frames sent by another phone, or before this phone kept a list, go when their scan is deleted.${result.elsewhere > 0 ? ` ${ledgerNote({ elsewhere: result.elsewhere, forgotten: 0 })}` : ''}`
  }
  if (result.offline) return `Could not reach your server. Nothing more was deleted.${tail}`
  const removed = result.deleted + result.alreadyGone
  if (result.failed > 0) return `Deleted ${removed}. ${result.failed} could not be deleted. Try again.${tail}`
  return (removed === 1 ? 'Deleted the frames from 1 scan session on your server.' : `Deleted the frames from ${removed} scan sessions on your server.`) + tail
}

// ── The service worker's offline queue ──────────────────────────────────────

/** The message public/sw.js answers by removing every queued keyframe upload. Mirrors the literal there. */
export const DROP_QUEUED_KEYFRAMES_MESSAGE = 'dropQueuedKeyframes'

/**
 * How long a withdrawal waits for the worker to say how many it removed, in ms. Adopted, not measured (ADR 0005 rule 5):
 * the worker's work is a few small reads from its own database, and an older worker that does not know the message never
 * answers, so this is what a withdrawal costs there.
 */
const DROP_QUEUED_TIMEOUT_MS = 1500

/**
 * Tells the service worker to delete the keyframe uploads it is holding for when the phone is back online, and
 * resolves with how many it removed. Resolves null when no worker answers in time (no worker controls this page,
 * which also means nothing was queued; or an older worker that does not know the message).
 *
 * A frame is queued there only while the server cannot be reached, so this is what stops "sending" after a
 * withdrawal made while offline: without it the frames would go as soon as the phone reconnected.
 */
export async function dropQueuedKeyframeUploads(
  container: Pick<ServiceWorkerContainer, 'controller'> | undefined = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker,
  timeoutMs = DROP_QUEUED_TIMEOUT_MS,
): Promise<number | null> {
  const worker = container?.controller
  if (!worker || typeof MessageChannel === 'undefined') return null
  return await new Promise<number | null>((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => {
      channel.port1.close()
      resolve(null)
    }, timeoutMs)
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer)
      channel.port1.close()
      const count = (event.data as { count?: unknown } | null)?.count
      resolve(typeof count === 'number' ? count : null)
    }
    worker.postMessage({ type: DROP_QUEUED_KEYFRAMES_MESSAGE }, [channel.port2])
  })
}

// ── What the panel row says ─────────────────────────────────────────────────

/** The counters a streamer reports. */
export interface StreamCounts {
  sent: number
  skipped: number
  failed: number
}

/**
 * The line under the switch that says what is happening now. "Skipped" is a frame the phone did not send because
 * uploads were behind: coverage thins when it is not zero, and the person is told. "Failed" is a frame the server
 * did not take.
 */
export function keyframeStatusText(input: { state: KeyframeConsentState; streaming: boolean; counts: StreamCounts; offline: boolean }): string {
  if (input.state !== 'granted') return 'Off. Nothing is sent.'
  if (!input.streaming) return 'On. Not sending right now.'
  const { sent, skipped, failed } = input.counts
  const parts = [`${sent} sent`]
  if (skipped > 0) parts.push(`${skipped} skipped`)
  if (failed > 0) parts.push(`${failed} failed`)
  return `Sending frames${input.offline ? ' (server not answering)' : ''}. ${parts.join(', ')}.`
}
