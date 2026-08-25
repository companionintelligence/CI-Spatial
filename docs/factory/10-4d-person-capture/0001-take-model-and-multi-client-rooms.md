> **Type:** Backend
> **Wave:** 10-4d-person-capture
> **Branch:** `feat/capture-takes`
> **Commit style:** `feat(capture): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None — lands first; every other ticket in the wave needs this vocabulary.

## Goal

Give the app a way to say "these N clips are of the same person at the same moment": a **Take**.
A Take is not a new aggregate — it is the set of capture sessions sharing a `takeId`. This
ticket adds that field, and generalizes the `/rtc-signal` room relay from its hard-coded
one-phone-one-viewer pair to an N-member room so several phones can coordinate a shared
recording.

## Non-goals

- Do not add recording. `MediaRecorder` is ticket 0003; this ticket ships only the take
  vocabulary and the room the recorders will later coordinate in.
- Do not add clock synchronisation. Estimating and persisting `clockOffsetMs` /
  `syncResidualMs` is ticket 0002 — leave those fields to it, so the type never carries a field
  with no producer.
- Do not change the existing live-feed behaviour. `RtcBroadcaster` ↔ `LiveFeed` is a 1:1
  phone→viewer preview and must keep working through this refactor.
- Do not build a second relay, a second WebSocket endpoint, or a room concept parallel to
  `rtcRooms`. See Pinned conventions.
- Do not add authentication to the room. It inherits what `/rtc-signal` has today — the CORS
  origin allowlist and nothing else. Tightening that is its own ticket.

## Pinned conventions

**ADR 0001** — this touches schema and a client↔server connection, so the search is recorded
here.

*Schema.* Searched for an existing type that can carry "several simultaneous captures of one
subject" before adding anything:

| Candidate | Where | Why it cannot carry a Take |
| --- | --- | --- |
| `ScanManifest` | `src/world/types.ts:399` | One scan = one uploaded GLB, one `sessionId`. It is the *place* record; a take is a grouping of capture sessions, and `ScanManifest` has no multiplicity. |
| `WorldProject` | `src/world/types.ts:519` | Far too coarse — a Place holds many takes over time. |
| `Area` / `areaId` | `src/world/types.ts:57` (`AreaKind`) | Spatial subdivision of a Place, not a temporal grouping. |
| capture `Session` | `server/session_id.ts`, `scans/sessions/<id>/session.json` | **This is the right one.** A session is already "one device, one continuous capture". N devices capturing together is N sessions needing one shared key. |

**Decision: extend the existing session record with `takeId` and `clientId`.** A Take is
therefore a derived set — the sessions sharing a `takeId` — not a stored aggregate. No new
identity system, no second directory layout.

*Id format.* `takeId` follows the existing `sess-`/`scan-`/`proj-` prefix convention:
`take-<8 hex>`, matching `TAKE_ID_RE = /^take-[A-Za-z0-9_-]{1,64}$/`, mirroring `PROJECT_ID_RE`
at `server/project_media.ts:26`. If slugging is needed, reuse `safeSlug()` from
`server/scan_id.ts:26` — and heed its header warning that it is **lossy**, so callers minting
identifiers must assert uniqueness themselves.

*Vocabulary sharing.* `sessionId` vocabulary is deliberately split across two files so both
runtimes can use it — `src/shared/session-id.ts` (browser) and `server/session_id.ts` (Deno).
Put `takeId`'s regex and helpers in the same pair, not in one of them.

*Connection.* Searched for an existing bidirectional client↔server channel before touching
anything: `/events` (`server/main.ts:4353`) is broadcast-only and explicitly ignores inbound
messages; `/rtc-signal` (`server/main.ts:4386`) is the only bidirectional socket. **Extend
`/rtc-signal`.** Do not add `/take-signal`.

*Room shape.* The current room is a 2-slot map (`server/main.ts:4392-4397`):

```ts
interface RtcPeer { ws: WebSocket; role: 'phone' | 'viewer' }
const rtcRooms = new Map<string, Partial<Record<'phone' | 'viewer', RtcPeer>>>()
```

Generalize to a member map keyed by peer id, **keeping `phone` and `viewer` as reserved
singleton roles** with exactly their current semantics — including the superseded-socket
handling at `server/main.ts:4419-4427` and `:4457-4463`, which exists because a reconnecting
peer's later `close` used to evict its own replacement and wedge the room for both sides.

*Room id sanitisation* stays `replace(/[^a-zA-Z0-9_-]/g, '')` — unchanged.

*Feature gate.* `/rtc-signal` returns 404 unless `VITE_ENABLE_WEBRTC_LIVE === 'true'`
(`server/main.ts:282`, `:4400-4402`). Take rooms must **not** inherit that gate — live preview
is experimental, but coordinated capture is the point of this wave. Split the guard so the
`capture` role works with the flag off while `phone`/`viewer` keep it.

## Before implementation

- `server/main.ts:4386-4470` — the whole `/rtc-signal` handler. Read the superseded-socket
  comments before touching the close handler; they encode a real bug.
- `server/main.ts:4353-4383` — `/events`, to confirm it is broadcast-only and not a candidate.
- `server/session_id.ts` and `src/shared/session-id.ts` — the two-file vocabulary split, and the
  deliberate `sessionDirPath()` (shape only) vs `resolveSessionDir()` (shape + existence) split.
- `server/main.ts:797-950` — `POST /sessions`, `/sessions/:id/keyframes`, `/sessions/:id/finalize`.
- `server/scan_id.ts:26-81` — `safeSlug()` and its lossiness warning.
- `server/scan_index.ts:44-80` — `loadSessionIndex()`, the sweep-once pattern and its "not a
  cache" header.
- `tests/mock-rtc-room.spec.ts`, `tests/mock-rtc-robustness.spec.ts` — the two regressions that
  must keep passing. The robustness spec counts `RTCPeerConnection` constructions against
  closes; a refactor that changes reconnect timing can break it.
- `server/world/world_job_pump.ts` — the precedent for extracting testable logic out of
  `main.ts` rather than leaving it as module-level state.

## Open questions & answers

- Q: Should a Take be a stored aggregate (`takes/<id>.json`) rather than a derived set? — A:
  No. A stored aggregate is a second place where "which sessions belong together" lives, and it
  would need its own lock, crash recovery, and trim policy — all of which flat session files
  already have. Deriving the set matches how `server/scan_index.ts` already resolves sessions to
  scans. Revisit if a take ever needs state no member session can hold. (Decided in this ticket.)
- Q: `server/scan_index.ts`'s header records an incident where per-scan session lookup was
  O(scans × sessions) and made 2,900 files take 120 s. Does deriving takes reintroduce that? —
  A: Only if implemented naively. Reuse `loadSessionIndex(sessionsDir)`, which already sweeps
  `sessions/` **once** per request, and add `takeId` grouping to that same pass — do not add a
  per-take directory scan. Note its header also says it is explicitly **not a cache**:
  `finalize` rewrites `session.json` in place, so mtime-keying would serve stale data forever.
  (Decided in this ticket.)
- Q: Should the `capture` role reuse the `phone` role name? — A: No. `phone` carries the
  singleton reconnect semantics the live feed depends on, and a room can legitimately hold both
  a live-preview `phone` and several `capture` members at once. Distinct roles keep the two
  behaviours separable and keep the existing specs meaningful. (Decided in this ticket.)
- Q: What happens when a `capture` member drops mid-take? — A: The room broadcasts an updated
  roster; the take is not cancelled. Whether a take with a missing member is still usable is a
  *processing* question (0005/0006 see the clip count), not a signalling one. The relay's job is
  to report the roster truthfully. (Decided in this ticket.)
- Q: Should room membership be capped? — A: Yes, defensively. `MAX_TAKE_MEMBERS = 8`, rejecting
  further joins with an explicit message rather than silently. This is an **adopted** bound, not
  a measured one — state that at its definition with a revisit trigger, in the spirit of ADR
  0005 rule 5. (Decided in this ticket.)
- Q: Does the take need to be tied to a Place/`projectId` at creation? — A: Not by this ticket.
  Sessions already carry Place association through the existing finalize/registration path, and
  forcing it earlier would block the "start recording now, file it afterwards" flow the recorder
  wants. 0004 is where a take lands in a Place. (Decided in this ticket.)

- Q: (found during implementation) Should the roster be broadcast to every member of a room? —
  A: **No — capture members only.** The first implementation sent it to everyone on join, ahead
  of `peer-ready`. `mock-rtc-room.spec.ts` asserts on the *first* frame a joining viewer
  receives, so this silently broke the live-feed rendezvous — the exact behaviour this ticket's
  Non-goals said not to change. A phone/viewer preview pair has no use for a roster; it is a
  take concept. Fixed by filtering the roster to `role === 'capture'` on both join and leave,
  which restores the preview pair's message stream byte-for-byte. (Decided 2026-08-24.)

## Files impacted

New:
- `server/take_id.ts` — `TAKE_ID_RE`, `newTakeId()`, mirroring `session_id.ts`
- `src/shared/take-id.ts` — the browser half of the same vocabulary
- `server/world/rtc_rooms.ts` — extracted room-membership logic, testable without `main.ts`
- `tests/unit/deno/take_id.test.ts`
- `tests/unit/deno/rtc_rooms.test.ts`
- `tests/api-person-capture.spec.ts` (one consolidated spec for the whole wave, rather than one per ticket)

Changed:
- `server/main.ts` — `/rtc-signal` room model; `POST /sessions` accepts `takeId`/`clientId`
- `server/scan_index.ts` — group the existing single sweep by `takeId`
- `src/world/types.ts` — session-record fields (see Schema required)

## Schema required

Extends the existing capture-session record. No new top-level type.

```ts
/** A Take is N simultaneous captures of one subject. It is the set of sessions
 *  sharing a takeId — deliberately derived, not stored (see this ticket's Q&A). */
takeId?: string | null      // 'take-<8 hex>'; null/absent = an ordinary solo capture
clientId?: string | null    // stable per-device id within a take; null when takeId is null
```

Both optional and nullable, so **every existing `session.json` on disk stays valid and
deserializes unchanged**. Absent `takeId` means what it has always meant: a normal single-device
capture. No migration.

Room-relay types (server-internal, not persisted):

```ts
type RtcRole = 'phone' | 'viewer' | 'capture'
interface RtcPeer { ws: WebSocket; role: RtcRole; peerId: string; clientLabel?: string }
/** roomId → members. 'phone' and 'viewer' remain reserved singleton roles. */
const rtcRooms = new Map<string, Map<string, RtcPeer>>()
const MAX_TAKE_MEMBERS = 8   // adopted bound, not measured — see Q&A
```

Room control verbs (JSON; SDP/ICE payloads stay uninspected as today):
`join`, `roster`, `arm`, `start`, `stop`, `status`, `leave`.

## Definition of Done

- [x] `takeId` and `clientId` are accepted by `POST /sessions`, persisted to `session.json`, and
      round-trip through `GET /sessions/:id`
- [x] A session with no `takeId` behaves exactly as before, and pre-existing `session.json`
      files load without error or migration
- [x] `/rtc-signal` accepts `role=capture` and supports up to `MAX_TAKE_MEMBERS` concurrent
      members per room, broadcasting a `roster` on every join and leave
- [x] `role=phone` and `role=viewer` retain singleton semantics, including superseded-socket
      handling — a reconnect does not wedge the room
- [x] `role=capture` works with `VITE_ENABLE_WEBRTC_LIVE` unset; `phone`/`viewer` still 404
      without it
- [x] Take grouping is served from the existing single `loadSessionIndex()` sweep
- [x] `deno task check` and `npx tsc --noEmit` pass

## Tests

- [x] Unit (`take_id.test.ts`): `TAKE_ID_RE` accepts well-formed ids and rejects path
      separators, leading dots, and over-length input
- [x] Unit (`rtc_rooms.test.ts`): N members join and leave; roster reflects membership; the
      `MAX_TAKE_MEMBERS + 1`th join is rejected with a message, not silently dropped
- [x] Unit: a superseded `phone` socket closing after its replacement registered does **not**
      evict the live peer (the existing bug, under the new data structure)
- [x] Unit: a `capture` member leaving does not tear down a room that still holds a `phone`
- [x] Playwright (`api-person-capture.spec.ts`): create a session with a `takeId`, read it back, confirm
      two sessions sharing a `takeId` are grouped, and confirm a session without one is not
- [x] Existing `mock-rtc-room.spec.ts` and `mock-rtc-robustness.spec.ts` pass with **no edits**

```bash
deno task check
deno task test
npx tsc --noEmit
npx playwright test tests/api-person-capture.spec.ts tests/mock-rtc-room.spec.ts tests/mock-rtc-robustness.spec.ts
```

## Acceptance Criteria

- [x] Given two phones joining `/rtc-signal?role=capture&room=take-abc123`, When both are
      connected, Then each receives a `roster` naming both members
- [x] Given a third client joining that same room as `role=viewer`, When it connects, Then the
      existing live-feed offer/answer flow completes unchanged
- [x] Given a `capture` member whose socket drops, When it reconnects with the same `clientId`,
      Then the roster shows one member for that client, not two
- [x] Given a `session.json` written before this ticket, When the server loads it, Then it
      parses and reports `takeId` as absent
- [x] Given `VITE_ENABLE_WEBRTC_LIVE` unset, When a client requests `role=capture`, Then the
      socket upgrades; When it requests `role=phone`, Then it receives 404

## Risks / potential issues

- **Risk:** Refactoring the room data structure breaks the live feed in a way the mocked specs
  do not catch — they use a mock peer connection, not a real one. — **Mitigation:** keep the two
  reserved roles on their exact current code paths and treat `capture` as an addition beside
  them, not a rewrite. Add a Checklist C item for a real phone→editor preview after this lands.
- **Risk:** Splitting the `VITE_ENABLE_WEBRTC_LIVE` guard creates a half-gated endpoint that is
  confusing to reason about. — **Mitigation:** guard per-role at one point with an explicit
  comment saying why capture is ungated; do not scatter the check.
- **Risk:** `takeId` being optional means downstream code may forget the solo case — which is
  the *common* path. — **Mitigation:** 0005's frame-set contract treats "one clip" as a
  first-class input rather than a degenerate take; test the solo path explicitly downstream.
- **Risk:** `MAX_TAKE_MEMBERS = 8` is adopted, not measured; a real shoot may want more, or the
  relay may struggle below it. — **Mitigation:** stated as adopted at its definition with a
  revisit trigger, matching how wave 09 handled its unmeasured tolerances.

## Subtasks

1. [x] Add `server/take_id.ts` and `src/shared/take-id.ts` with the shared regex and minting
2. [x] Extend the session record with `takeId`/`clientId`; confirm absent-field back-compat
3. [x] Accept and persist both in `POST /sessions`; surface them in `GET /sessions/:id`
4. [x] Extract room membership into `server/world/rtc_rooms.ts`, mirroring how
       `world_job_pump.ts` was extracted out of `main.ts` for exactly this reason
5. [x] Generalize `rtcRooms` to a member map; keep `phone`/`viewer` singleton semantics
6. [x] Add the `capture` role, roster broadcast, member cap, and the split feature gate
7. [x] Group by `takeId` inside the existing `loadSessionIndex()` sweep
8. [x] Write the unit and Playwright tests; confirm both existing RTC specs still pass
9. [x] `deno task check`, `deno task test`, `npx tsc --noEmit`
