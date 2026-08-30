/**
 * Keep the screen awake while a scan is running.
 *
 * Found on real hardware: a gimbal-driven dome scan produced zero keyframes
 * across ten converged positions because the phone's screen locked partway
 * through. Android backgrounds Chrome on lock, `document.visibilityState`
 * flips to 'hidden', and `KeyframeStreamer._tick()` correctly bails on
 * `this._hidden` (src/capture/keyframes.ts:209) — so the session stays open,
 * the HUD keeps claiming it is streaming, and not one frame is ever sent.
 *
 * The streamer's behaviour is right; nothing was stopping the lock. That is
 * only visible in an unattended capture, because a person holding the phone
 * keeps touching it and never lets it time out.
 *
 * The lock is released by the browser itself whenever the page is hidden, so
 * it cannot be acquired once and forgotten: `visibilitychange` has to
 * re-acquire it on the way back. That reacquisition is the part every naive
 * implementation misses.
 */

/** The slice of the API we use — `navigator.wakeLock` is still unshipped in some browsers. */
interface WakeLockSentinelLike {
  released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}
interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>
}

export interface ScreenWakeLock {
  /** Acquire, and hold across visibility changes, until `stop()`. */
  start(): Promise<void>
  stop(): Promise<void>
  /** True while we believe we hold the lock. Test seam and HUD hook. */
  readonly held: boolean
}

/**
 * @param nav  injectable for tests; defaults to the real navigator.
 * @param doc  injectable for tests; defaults to the real document.
 */
export function createScreenWakeLock(
  nav: { wakeLock?: WakeLockLike } = (globalThis.navigator ?? {}) as { wakeLock?: WakeLockLike },
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> =
    globalThis.document,
): ScreenWakeLock {
  let sentinel: WakeLockSentinelLike | null = null
  let wanted = false

  const acquire = async (): Promise<void> => {
    // Not an error worth surfacing: Safari < 16.4 and any non-secure context
    // simply do not have it, and a scan is still perfectly usable while the
    // person is holding the phone. Unattended capture is the case that suffers.
    if (!wanted || sentinel || !nav.wakeLock) return
    try {
      const s = await nav.wakeLock.request('screen')
      // A lock released by the browser (tab hidden, battery saver) must not
      // leave us believing we still hold one, or the reacquire below no-ops.
      s.addEventListener('release', () => { if (sentinel === s) sentinel = null })
      sentinel = wanted ? s : (await s.release(), null)
    } catch {
      sentinel = null
    }
  }

  const onVisibility = (): void => {
    if (doc.visibilityState === 'visible') void acquire()
  }

  return {
    get held() { return sentinel !== null && !sentinel.released },
    async start() {
      if (wanted) return
      wanted = true
      doc.addEventListener('visibilitychange', onVisibility)
      await acquire()
    },
    async stop() {
      wanted = false
      doc.removeEventListener('visibilitychange', onVisibility)
      const s = sentinel
      sentinel = null
      if (s && !s.released) await s.release().catch(() => {})
    },
  }
}
