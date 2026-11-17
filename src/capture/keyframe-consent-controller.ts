/**
 * What the scanner does when a person says yes to sending camera frames, says no, or scans in a Place.
 *
 * The state, the words and the decisions are in ./keyframe-consent.ts. This ties them to the streamer
 * (./keyframes.ts), without touching the page: the dialog and the panel row (src/ui/keyframe-consent-ui.ts) call
 * it, and main.ts hands it the streamer and a few closures, so every rule here runs in a test with a fake streamer.
 *
 *   - A tap on Stream asks first when this device has not agreed (`requestStart`), and starts when it has.
 *   - The switch in the panel is the same answer, kept: on asks and starts; off withdraws and stops (`setSwitch`).
 *   - A scan in a Place starts streaming by itself only when this device has agreed (`autoStart`, decision D15).
 *   - Withdrawal stops at once, from wherever it comes, including another tab (the consent's own subscription) and a
 *     different Scan server saved on the device: the stream is abandoned without a drain, and the service worker's queued
 *     frames are dropped (`halt`). It stops whatever else goes wrong while it does: a payload that cannot be read, a close
 *     that fails.
 *   - "Delete frames this phone sent" is its own tap, after a confirm, and never a side effect of withdrawal. It stops a
 *     stream that is running first, because the session being sent is one of the sessions it deletes.
 *
 * Nothing here reads or sets anything but camera-frame streaming. A device that said no, or was never asked, scans,
 * calibrates, exports and uses the editor exactly as one that said yes.
 */
import type { KeyframeStreamer } from './keyframes.ts'
import {
  type DeleteSentFramesResult,
  deleteResultText,
  deleteSentFrames,
  dropQueuedKeyframeUploads,
  type KeyframeConsent,
  type KeyframeSessionLedger,
  shouldAutoStartStreaming,
} from './keyframe-consent.ts'

/** What the finalize POST that closes a session carries: counts and a filename, never a picture. */
export type FinalizePayload = Parameters<KeyframeStreamer['stop']>[0]

/** The part of the streamer this uses, so a test passes a fake. `KeyframeStreamer` satisfies it. */
export interface StreamerPort {
  readonly active: boolean
  readonly isTransitioning: boolean
  start(): Promise<void>
  abandon(finalize?: FinalizePayload): Promise<void>
}

export interface ControllerDeps {
  consent: KeyframeConsent
  ledger: KeyframeSessionLedger
  streamer: StreamerPort
  /** The payload the finalize POST carries, read when a stream is abandoned. */
  finalizePayload: () => FinalizePayload
  /** Shows the consent words. Resolves true for Allow, false for anything else. */
  ask: () => Promise<boolean>
  /** Asks before frames are deleted: how many sessions, and whether a stream that is running will be stopped first. */
  confirmDelete: (streaming: boolean, sessions: number) => boolean
  /** True when another tab is the scanner: this page starts nothing. */
  readOnly: boolean
  /** Whether the scanner is running, so a switch turned on mid-scan has something to stream. */
  canStreamNow: () => boolean
  /** Drops the service worker's queued frames. Defaults to the real worker. */
  dropQueued?: () => Promise<number | null>
  /** Deletes the sessions in the ledger. Defaults to the real server. */
  deleteSent?: () => Promise<DeleteSentFramesResult>
}

export class KeyframeConsentController {
  private readonly deps: ControllerDeps
  /** The stop the consent's own subscription started most recently, so a withdrawal that caused it can wait for it. */
  private subscribedHalt: Promise<void> | null = null

  constructor(deps: ControllerDeps) {
    this.deps = deps
    // Consent that stops being a yes stops the stream, wherever the change came from: this page's switch, another
    // tab's (the storage event calls consent.refresh()), or a different Scan server saved on the device.
    deps.consent.subscribe((state) => {
      if (state !== 'granted') this.subscribedHalt = this.halt()
    })
  }

  /**
   * A tap on Stream that would start sending. Asks first when this device has not agreed, and records the yes. Resolves
   * true when `start` ran, false when the person said no. A tap that stops a stream never comes here: stopping needs
   * no consent.
   */
  async requestStart(start: () => Promise<void>): Promise<boolean> {
    if (!this.deps.consent.granted) {
      if (!(await this.deps.ask())) return false
      this.deps.consent.grant()
    }
    await start()
    return true
  }

  /**
   * The switch in the panel. On records a yes (asking first) and, when the scanner is running and not already sending,
   * starts sending. Off records a no and stops at once. Resolves the state the switch ends in.
   */
  async setSwitch(on: boolean): Promise<'on' | 'off'> {
    if (!on) {
      // The withdrawal announces itself, and the subscription above stops the stream in that same call when the state
      // changed; when it did not (a device that was never asked), nothing has been stopped yet and this does it.
      this.subscribedHalt = null
      this.deps.consent.withdraw()
      await (this.subscribedHalt ?? this.halt())
      return 'off'
    }
    if (!this.deps.consent.granted) {
      if (!(await this.deps.ask())) return 'off'
      this.deps.consent.grant()
    }
    if (!this.deps.readOnly && this.deps.canStreamNow() && !this.deps.streamer.active && !this.deps.streamer.isTransitioning) {
      await this.deps.streamer.start().catch((error) => console.warn('[keyframes] start after consent failed:', error))
    }
    return 'on'
  }

  /**
   * A scan in a Place has begun: stream by default (D15), but only on a device that has agreed. Resolves whether it
   * started. A device that has not agreed, or said no, starts nothing and is not asked: asking is the person's tap.
   */
  autoStart(placeSelected: boolean): boolean {
    const { consent, streamer, readOnly } = this.deps
    if (!shouldAutoStartStreaming({
      consent: consent.state,
      placeSelected,
      readOnly,
      streaming: streamer.active,
      transitioning: streamer.isTransitioning,
    })) return false
    void streamer.start().catch((error) => console.warn('[keyframes] automatic start failed:', error))
    return true
  }

  /** Notes a session this device has opened, so its frames can be named for deletion later. */
  noteSession(sessionId: string): void {
    this.deps.ledger.add(sessionId)
  }

  /**
   * Stops sending now: the stream is abandoned (nothing queued is sent, the upload in flight is cancelled) and the
   * service worker's queue is emptied of frames. Safe to call again while it runs, and when nothing is sending.
   *
   * Each call issues the stop itself and does not join one already running: that one may have begun before the person said
   * yes again, and a stream started since is not part of it. `abandon` and the worker's drop are both harmless to repeat
   * (a stream that is already closed is left as it is). The stop does not wait on anything that can fail: the payload the
   * finalize carries is read first, and if it cannot be read the stream is abandoned without one.
   */
  halt(): Promise<void> {
    let payload: FinalizePayload | undefined
    try {
      payload = this.deps.finalizePayload()
    } catch (error) {
      console.warn('[keyframes] could not read what the finalize carries; stopping without it:', error)
    }
    let stopping: Promise<void>
    try {
      stopping = this.deps.streamer.abandon(payload)
    } catch (error) {
      stopping = Promise.reject(error)
    }
    const dropping = (async () => {
      try {
        await (this.deps.dropQueued ?? (() => dropQueuedKeyframeUploads()))()
      } catch (error) {
        console.warn('[keyframes] could not drop queued frames:', error)
      }
    })()
    return Promise.all([
      stopping.catch((error: unknown) => {
        console.warn('[keyframes] abandon failed:', error)
      }),
      dropping,
    ]).then(() => undefined)
  }

  /**
   * "Delete frames this phone sent". Asks first, then names each session this device remembers sending to this server.
   * Resolves the line the person is told; the empty string when they declined. A stream that is running is stopped first:
   * the session being sent is one of the sessions deleted, and a stream left running would carry on into a session that
   * no longer exists. Deleting is never part of withdrawal: a person who only wants sending to stop keeps the
   * reconstruction of a room they still want.
   */
  async deleteSent(): Promise<string> {
    const { ledger, streamer } = this.deps
    const sessions = ledger.count
    if (sessions === 0) {
      return deleteResultText({ deleted: 0, alreadyGone: 0, failed: 0, offline: false, elsewhere: ledger.elsewhere, forgotten: ledger.forgotten }, false)
    }
    const running = () => streamer.active || streamer.isTransitioning
    if (!this.deps.confirmDelete(running(), sessions)) return ''
    if (running()) await this.halt()
    const result = await (this.deps.deleteSent ?? (() => deleteSentFrames(ledger)))()
    return deleteResultText(result, true)
  }
}
