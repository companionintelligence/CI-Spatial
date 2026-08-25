/**
 * Clock-offset estimation for a multi-device take.
 *
 * N phones recording one subject need to agree on *when*, because per-timestep
 * reconstruction slices every clip at the same instant. This module is the
 * client half: it estimates this device's offset from server time over the take
 * room socket. The server aggregates those estimates into an inter-member
 * residual (`server/world/take_sync.ts`) — a single client cannot compute that,
 * which is why a solo take reports `'unsynced'` rather than a fabricated zero.
 *
 * Deliberately pure and DOM-free so it unit-tests without a browser: the
 * transport is injected. The estimator is standard NTP:
 *
 *     offset = ((t1 - t0) + (t2 - t3)) / 2
 *     rtt    = (t3 - t0) - (t2 - t1)
 *
 * with t0/t3 read on the device and t1/t2 on the server.
 *
 * **Median of the lowest-RTT samples, not the mean of all of them.** NTP's
 * symmetry assumption — that the request and response legs took equally long —
 * holds best on the fastest exchanges. A single delayed packet skews a mean
 * badly, and on a phone over Wi-Fi delayed packets are routine rather than
 * exceptional.
 *
 * See docs/factory/10-4d-person-capture/0002-measured-clock-sync.md.
 */

export interface SyncSample {
  /** Device time when the probe was sent. */
  t0: number
  /** Server time when the probe arrived. */
  t1: number
  /** Server time when the reply was sent. */
  t2: number
  /** Device time when the reply arrived. */
  t3: number
}

export interface OffsetEstimate {
  /** Device→server offset in ms: serverTime ≈ deviceTime + offsetMs. */
  offsetMs: number
  /** Round-trip time of the samples the estimate was drawn from. */
  bestRttMs: number
  /** How many samples were collected (not how many survived filtering). */
  sampleCount: number
}

/** Offset implied by one round-trip. */
export function offsetOf(s: SyncSample): number {
  return ((s.t1 - s.t0) + (s.t2 - s.t3)) / 2
}

/** Round-trip time of one exchange, excluding the server's own processing gap. */
export function rttOf(s: SyncSample): number {
  return (s.t3 - s.t0) - (s.t2 - s.t1)
}

/** Median of a numeric list. Even-length lists average the middle pair. */
export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Fraction of samples, best-RTT first, that feed the estimate.
 *
 * **Adopted, not measured.** NTP-family implementations commonly keep a
 * similar-sized best subset; nothing here has characterised the real
 * distribution on a phone link. Revisit alongside `DEFAULT_SYNC_TOLERANCE_MS`
 * when the Checklist C procedure is run.
 */
export const BEST_SAMPLE_FRACTION = 0.4

/**
 * Estimate this device's offset from the lowest-RTT samples.
 *
 * Returns `null` for an empty set rather than a zero offset — "no measurement"
 * and "measured zero" are different claims, and conflating them is precisely
 * the failure ADR 0005 rule 3 is about.
 */
export function estimateOffset(samples: SyncSample[]): OffsetEstimate | null {
  if (samples.length === 0) return null
  const byRtt = [...samples].sort((a, b) => rttOf(a) - rttOf(b))
  const keep = Math.max(1, Math.round(byRtt.length * BEST_SAMPLE_FRACTION))
  const best = byRtt.slice(0, keep)
  return {
    offsetMs: median(best.map(offsetOf)),
    bestRttMs: rttOf(byRtt[0]),
    sampleCount: samples.length,
  }
}

/** How a probe reaches the server and how a reply comes back. */
export interface SyncTransport {
  /** Send one probe; resolve with the server's two timestamps. */
  probe(id: string): Promise<{ t1: number; t2: number }>
  /** Device clock. Injected so tests need no real time. */
  now(): number
}

/**
 * Burst size at join.
 *
 * **Adopted.** Odd so the median is a real sample rather than an average of
 * two, and small enough to complete in well under a second on a LAN.
 */
export const SYNC_BURST_SAMPLES = 11

/**
 * Run a burst of probes and estimate the offset.
 *
 * A probe that rejects is skipped rather than aborting the burst — one dropped
 * packet on a phone link is routine, and discarding the whole estimate for it
 * would make sync fail exactly where it is most needed. If *every* probe fails
 * the result is `null`, which the caller records as `'exchange-failed'`.
 */
export async function measureOffset(
  transport: SyncTransport,
  sampleCount: number = SYNC_BURST_SAMPLES,
): Promise<OffsetEstimate | null> {
  const samples: SyncSample[] = []
  for (let i = 0; i < sampleCount; i++) {
    const t0 = transport.now()
    try {
      const { t1, t2 } = await transport.probe(`sync-${i}`)
      samples.push({ t0, t1, t2, t3: transport.now() })
    } catch {
      // Dropped probe — keep going; the burst is sized to tolerate a few.
    }
  }
  return estimateOffset(samples)
}
