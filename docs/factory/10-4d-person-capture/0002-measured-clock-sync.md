> **Type:** Full-stack
> **Wave:** 10-4d-person-capture
> **Branch:** `feat/take-clock-sync`
> **Commit style:** `feat(capture): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0001 (needs the take room and `clientId`)

## Goal

Make N phones in a take agree on *when*. Estimate each client's offset from server time over
the take room socket, persist it per session, and — crucially — persist the **measured residual**
alongside it, so a take can only claim to be synchronised when something measured it.

## Why this is not optional detail

Per-timestep reconstruction (0005/0006) slices every clip at the same instant and trains one
splat from that slice. If two phones are 100 ms apart and the subject is moving at 1 m/s, the
frames they contribute to "timestep 12" are 10 cm apart in the world. That is not a subtle
quality loss — it is two different poses fed to the trainer as if they were one, and it shows up
as a smeared or doubled reconstruction with no error message anywhere.

So the sync residual is not diagnostics. It is an input to whether a take is usable at all, and
0006 must be able to read it.

## Non-goals

- Do not attempt sub-frame optical sync (flash/clap alignment against the recorded video). It is
  the more accurate technique and it is a plausible follow-up, but it needs decoded video frames
  and therefore belongs in the processing subsystem, not the capture client. Record what a
  network round-trip can measure honestly, and leave the refinement to a later wave.
- Do not gate recording on a good residual. A take with poor sync is still worth keeping — the
  single-clip 4DAnyone path does not care about cross-client sync at all. Report, don't block.
- Do not invent a new transport. The offset exchange rides the room socket from 0001.
- Do not adjust device clocks or touch `Date.now()` globally. Offsets are recorded and applied
  at slice time, never by mutating time.

## Pinned conventions

**ADR 0005 governs this ticket**, and rules 3 and 5 apply directly — they are explicitly not
spatial-specific:

> "**3. A status value that claims verification must be backed by a measurement.** If a method
> cannot measure agreement … it does not get to report `'verified'` — it reports
> `'provisional'`, and its type does not carry residual/tolerance fields at all."

> "**5. Tolerance constants are measured, not chosen.** … A tolerance set below the real
> repeatability floor makes every correct repeat visit report a false mismatch, which is worse
> than no check at all."

> "**Applicability beyond calibration.** Rules 3 and 5 are not spatial-specific. Any field that
> reports a quality, confidence, or verification verdict … is subject to the same standard:
> **if nothing measured it, do not name it as though something did.**"

Concretely, `TakeSync` is a **discriminated union on `method`**, and only the measured member
carries `residualMs`/`toleranceMs` — so "this tier cannot be verified" is *unstateable* rather
than merely undocumented. Mirror `ProjectSpatialFrame` (`src/world/types.ts:156-211`) exactly:
same shape, same doc-comment density, same "load-bearing" annotations on fields that are.

**ADR 0001** — touches schema and a client↔server connection. Schema: extends the session record
that 0001 established; searched for an existing timing field before adding one — `session.json`
carries `startedAt`/`finalizedAt` wall-clock stamps and `keyframes.jsonl` records per-frame
`timestamp`, but all are *unqualified device time* with no offset or accuracy attached, so there
is nothing to reuse. Connection: extends 0001's room verbs, adds no endpoint.

**The tolerance must be measured before it is pinned.** Do not ship a chosen
`DEFAULT_SYNC_TOLERANCE_MS`. Wave 09 hit exactly this and ticket 0006 there closed unrun,
leaving three adopted constants — that outcome is acceptable *only when stated*. Either measure
the real spread (see Tests) and cite it at the constant's definition, or mark it adopted with an
explicit revisit trigger. Silence is the failure mode.

**Estimator.** Standard NTP-style offset from a round-trip, `offset = ((t1 - t0) + (t2 - t3)) / 2`
with RTT `= (t3 - t0) - (t2 - t1)`. Take the median offset of the lowest-RTT samples rather than
the mean of all of them — a single delayed packet skews a mean badly, and the low-RTT samples are
the ones whose symmetry assumption holds.

## Before implementation

- `src/world/types.ts:156-211` — `ProjectSpatialFrame`'s discriminated union. This is the shape
  to copy, including how the doc comments explain *why* a field is where it is.
- `docs/adr/0005-spatial-frames-are-established-by-geometry-and-verified-by-measurement.md` —
  rules 3 and 5 and the "Applicability beyond calibration" clause.
- `docs/factory/09-ground-anchor-calibration/0001-honest-calibration-status.md` — the ticket that
  removed a fabricated `'verified'`. Read its Q&A on why a fourth union member was rejected; the
  same reasoning applies to inventing a third sync status.
- `server/world/rtc_rooms.ts` and the room verbs from 0001.
- `server/main.ts:797-950` — the session routes that persist this.
- `docs/testing/DEVICE_TESTING.md` — where the measurement procedure goes.

## Open questions & answers

- Q: Why not just trust each device's wall clock? — A: Because nothing measures it. Phone clocks
  drift, NTP sync state is invisible to the page, and a browser has no API to ask "how good is my
  clock". An unmeasured wall clock is exactly the `'verified'`-without-a-measurement failure ADR
  0005 was written about. (Decided in this ticket.)
- Q: Should a take with a bad residual be rejected at capture time? — A: No. The single-clip path
  ignores cross-client sync entirely, and even a poorly-synced multi-clip take is salvageable by
  processing only its best subset. Rejecting at capture destroys data the user cannot re-shoot.
  Report the residual; let 0006 decide. (Decided in this ticket.)
- Q: A third `syncStatus` member for "measured but out of tolerance"? — A: No, for the same
  reason wave 09 rejected a fourth calibration status: it widens a persisted union for no
  behavioural difference and forces every reader to handle it. `'measured'` carries `residualMs`
  and `toleranceMs`; whether it is *within* tolerance is a comparison any reader can do, not a
  separate state. (Decided in this ticket.)
- Q: How many round-trips, and how often? — A: Burst of ~11 at join, then one every 10 s while
  the room is open, keeping a rolling window. Re-estimate immediately before `arm`. These are
  **adopted** parameters — cheap on a LAN, and the burst count is odd so the median is a real
  sample. Revisit if the measured spread says the window is too short. (Decided in this ticket.)
- Q: What is the residual, exactly — offset error or inter-client spread? — A: Inter-client
  spread is what actually matters for slicing, so `residualMs` is the **half-width of the
  offset-corrected disagreement across the take's members**, computed server-side where all
  members' estimates are visible. A single client alone cannot compute it, which is why a solo
  take reports `'unsynced'` rather than a fake zero. (Decided in this ticket.)
- Q: Does a solo take report `'measured'` with `residualMs: 0`? — A: **No.** Zero would be a
  fabricated measurement of a quantity that does not exist for one client. A solo take reports
  `method: 'unsynced'`, which is honest and is also *correct* — the single-clip path has nothing
  to synchronise. (Decided in this ticket.)

## Files impacted

New:
- `src/capture/clock-sync.ts` — the client estimator (pure, no DOM, so it unit-tests in Node)
- `server/world/take_sync.ts` — server-side aggregation of member offsets into a residual
- `tests/unit/deno/take_sync.test.ts`
- `tests/unit/node/clock_sync.test.ts`

Changed:
- `src/world/types.ts` — `TakeSync` union (see Schema required)
- `server/main.ts` — room verbs for the offset exchange; persist sync into `session.json`
- `server/world/rtc_rooms.ts` — carry each member's latest offset estimate
- `src/main.ts` — start the estimator when joining a take room
- `docs/testing/DEVICE_TESTING.md` — the measurement procedure (see Tests)

## Schema required

Extends the session record from 0001. Mirrors `ProjectSpatialFrame`'s discriminated-union shape.

```ts
/**
 * How well a take's members agree on the time.
 *
 * `'measured'` is the only member that may be treated as synchronised, and it is
 * the only one carrying a residual — so a claim of sync is unstateable without
 * the measurement that backs it (ADR 0005 rule 3).
 *
 * `'unsynced'` is not a failure. A solo take has nothing to synchronise, and the
 * single-clip 4DAnyone path never reads this field.
 */
export type TakeSync = {
  version: 1
  measuredAt: string
} & (
  | {
      method: 'measured'
      /** This client's offset from server time, ms. Applied at slice time; never used to mutate a clock. */
      offsetMs: number
      /**
       * Load-bearing: half-width of the offset-corrected disagreement across
       * this take's members, in ms. Computed server-side, where every member's
       * estimate is visible — a single client cannot compute it, which is why
       * a solo take is `'unsynced'` rather than a fabricated zero.
       */
      residualMs: number
      /** Max residual at which members may be sliced as simultaneous. See Pinned conventions — this must be measured, not chosen. */
      toleranceMs: number
      /** Round-trip samples behind the estimate, so a thin estimate is visible as thin. */
      sampleCount: number
    }
  | {
      method: 'unsynced'
      /** Why no measurement exists: a solo take, or a room that never reached two members. */
      reason: 'solo-take' | 'insufficient-peers' | 'exchange-failed'
    }
)
```

Added to the session record as `sync?: TakeSync | null`. Optional and nullable — every existing
`session.json` stays valid, and absent means what it has always meant: nobody measured.

## Definition of Done

- [x] Each `capture` member estimates its offset over the room socket and reports it
- [x] The server aggregates member offsets into a residual and writes `TakeSync` into each
      member session's `session.json`
- [x] A solo take persists `method: 'unsynced'`, `reason: 'solo-take'` — never a zero residual
- [x] `toleranceMs` is either backed by a cited measurement or explicitly marked adopted with a
      revisit trigger at its definition
- [x] No code path constructs `method: 'measured'` without a real `residualMs`
- [x] Pre-existing `session.json` files load unchanged
- [x] `deno task check`, `npx tsc --noEmit`, `deno task test` pass

## Tests

- [x] Unit (`clock_sync.test.ts`, Node — needs no DOM but lives with the browser-side suite):
      the estimator recovers a known injected offset from synthetic timestamps; a single
      high-RTT outlier does not move the median estimate
- [x] Unit (`take_sync.test.ts`, Deno): aggregation across three member offsets produces the
      expected residual half-width; two members produce a residual; one member produces
      `'unsynced'` with `reason: 'solo-take'`
- [x] Unit: a member that never completes the exchange yields `reason: 'exchange-failed'`, not a
      `'measured'` record
- [x] Grep check: no code path writes `method: 'measured'` without `residualMs` — the union
      should make this a type error, and the grep confirms it
- [x] Playwright (`api-person-capture.spec.ts`): two simulated members exchange offsets and both
      sessions persist a `'measured'` record
- [ ] **Device (Checklist C, `docs/testing/DEVICE_TESTING.md`)**: two real phones on the same
      tailnet join a take; record the observed residual across ≥10 runs. This spread is what
      `DEFAULT_SYNC_TOLERANCE_MS` must be set from. Track as explicitly unrun until a person
      does it — do not silently ship a chosen constant.

```bash
deno task check
deno task test
npx tsc --noEmit
npm run test:store   # node suite
npx playwright test tests/api-person-capture.spec.ts
```

## Acceptance Criteria

- [x] Given two phones in a take room, When both complete the offset exchange, Then each
      session persists `method: 'measured'` with a non-zero `sampleCount` and a real `residualMs`
- [x] Given one phone recording alone, When the take finalizes, Then its session persists
      `method: 'unsynced'`, `reason: 'solo-take'`, and carries **no** `residualMs` field at all
- [x] Given a member whose socket drops before the exchange completes, When the take finalizes,
      Then that member's session reports `'exchange-failed'` and the other members are unaffected
- [x] Given a take whose residual exceeds tolerance, When it finalizes, Then it is still stored
      and still processable — the residual is reported, not enforced

## Risks / potential issues

- **Risk:** Network round-trip sync has a floor set by path asymmetry, and on a phone over Wi-Fi
  that floor may be tens of ms — possibly worse than the tolerance a moving subject needs. —
  **Mitigation:** this is exactly why the residual is measured and surfaced rather than assumed.
  If the device measurement says the floor is too high, the honest outcome is that multi-client
  takes need optical sync (deferred, see Non-goals) and the wave ships the single-clip path
  first. That is a real possible finding, not a failure of this ticket.
- **Risk:** Browser timer resolution is deliberately coarsened for Spectre mitigation —
  `performance.now()` is clamped (~100 µs to 1 ms depending on isolation). — **Mitigation:**
  well below the expected network floor, so it does not dominate; note it at the estimator so
  nobody later mistakes it for the limiting factor.
- **Risk:** `toleranceMs` ships adopted because the device run does not happen, repeating wave
  09's ticket 0006 outcome. — **Mitigation:** acceptable *if stated* — the constant's definition
  must say it is adopted and name its revisit trigger. Wave 09's README is the model for
  recording that honestly rather than quietly.
- **Risk:** Sync is measured at room time but recording may start much later, after drift. —
  **Mitigation:** re-estimate immediately before `arm`, and stamp `measuredAt` so a stale
  estimate is visible as stale.

## Subtasks

1. [x] Write the pure estimator in `src/capture/clock-sync.ts` with its unit tests first
2. [x] Add the offset-exchange verbs to the room protocol from 0001
3. [x] Add `server/world/take_sync.ts` aggregation with its unit tests
4. [x] Define the `TakeSync` union in `src/world/types.ts`, mirroring `ProjectSpatialFrame`
5. [x] Persist `sync` into each member's `session.json`; confirm absent-field back-compat
6. [x] Wire the estimator into the take-room join path in `src/main.ts`
7. [x] Write the Checklist C procedure in `docs/testing/DEVICE_TESTING.md`
8. [x] Set `DEFAULT_SYNC_TOLERANCE_MS` from the measurement, or mark it adopted with a trigger
9. [x] `deno task check`, `deno task test`, `npx tsc --noEmit`
