/**
 * Aggregates per-member clock offsets into a take's sync record.
 *
 * The client half (`src/capture/clock-sync.ts`) estimates each device's offset
 * from server time. This is the half that turns N such estimates into the one
 * number that actually governs whether clips may be sliced as simultaneous:
 * the **inter-member residual**.
 *
 * Why the residual rather than the offsets: an offset is a device's distance
 * from the server, and a systematic error shared by every member cancels out
 * when their frames are aligned to each other. What corrupts a per-timestep
 * train is members disagreeing *among themselves*. So the residual is the
 * half-width of the offset-corrected spread across members.
 *
 * A single client cannot compute this — which is the whole reason a solo take
 * reports `'unsynced'` instead of a residual of zero. Zero would be a
 * fabricated measurement of a quantity that does not exist for one client, and
 * ADR 0005 rule 3 is explicit that a value naming a verification must be backed
 * by one.
 *
 * Lives outside `main.ts` so it is unit-testable without `Deno.serve`.
 */
import { DEFAULT_SYNC_TOLERANCE_MS, type TakeSync } from '../../src/world/types.ts'

export interface MemberOffset {
  clientId: string
  /** Device→server offset in ms, from the client's own estimate. */
  offsetMs: number
  /** Round-trip samples behind that estimate. */
  sampleCount: number
}

/**
 * Half-width of the spread across member offsets.
 *
 * Half-width rather than full range because it is the per-member worst case: if
 * members span 80ms, any one of them is at most 40ms from the midpoint the
 * slicer aligns on.
 */
export function residualOf(offsets: number[]): number {
  if (offsets.length < 2) return 0
  let min = offsets[0]
  let max = offsets[0]
  for (const o of offsets) {
    if (o < min) min = o
    if (o > max) max = o
  }
  return (max - min) / 2
}

/**
 * Build each member's `TakeSync` record.
 *
 * Returns a map keyed by `clientId`, because each member session stores its own
 * record — the offset is per device, and only the residual is shared.
 *
 * Fewer than two members yields `'unsynced'` for every member, with a reason
 * that distinguishes the two honest cases: a genuinely solo capture, versus a
 * take that expected peers and never got them.
 */
export function buildTakeSync(
  members: MemberOffset[],
  measuredAt: string,
  opts: { expectedMembers?: number; toleranceMs?: number } = {},
): Map<string, TakeSync> {
  const toleranceMs = opts.toleranceMs ?? DEFAULT_SYNC_TOLERANCE_MS
  const out = new Map<string, TakeSync>()

  if (members.length < 2) {
    // 'solo-take' means one device was ever expected; 'insufficient-peers'
    // means more were and did not arrive. Same absence, different stories, and
    // only the second one is worth investigating.
    const reason = (opts.expectedMembers ?? members.length) <= 1 ? 'solo-take' : 'insufficient-peers'
    for (const m of members) {
      out.set(m.clientId, { version: 1, measuredAt, method: 'unsynced', reason })
    }
    return out
  }

  const residualMs = residualOf(members.map(m => m.offsetMs))
  for (const m of members) {
    out.set(m.clientId, {
      version: 1,
      measuredAt,
      method: 'measured',
      offsetMs: m.offsetMs,
      residualMs,
      toleranceMs,
      sampleCount: m.sampleCount,
    })
  }
  return out
}

/**
 * A record for a member whose offset exchange never completed.
 *
 * Separate from {@link buildTakeSync} because a failed exchange is per-member:
 * one device dropping must not downgrade the others, which still measured each
 * other perfectly well.
 */
export function exchangeFailed(measuredAt: string): TakeSync {
  return { version: 1, measuredAt, method: 'unsynced', reason: 'exchange-failed' }
}

/**
 * Whether a take's members may be sliced as simultaneous.
 *
 * `false` for every `'unsynced'` record — including a solo take, whose clips are
 * never *cross*-sliced in the first place. The densify path does not consult
 * this; it has one clip and one timeline.
 */
export function withinTolerance(sync: TakeSync | null | undefined): boolean {
  if (!sync || sync.method !== 'measured') return false
  return sync.residualMs <= sync.toleranceMs
}
