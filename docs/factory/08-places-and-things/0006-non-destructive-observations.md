> **Type:** Frontend
> **Wave:** 08-places-and-things
> **Branch:** `feat/non-destructive-observations`
> **Commit style:** `feat(detections): summary`
> **Design:** this ticket is the spec
> **Dependencies:** wave 07 ticket 0003 (`07-scan-identity/0003-node-level-glb-provenance.md`)
> — node-level GLB provenance. An observation needs a session and capture identity worth
> recording; 0003 is what makes `sessionId`/`captureIndex` survive export.
> **Independent of the place chain (0001–0005) and can land in parallel with it.**

## Goal

Stop throwing away every observation after the first. Keep each one with its own session,
timestamp and position, so that "did this move?" becomes a question the data can answer —
which is the substrate ticket 0007's correspondence job consumes.

## The defect, precisely

### 1. The merge discards everything but a confidence bump

`mergeDetections`, `src/spatial/resolver.ts:306-330`, with `DEDUP_RADIUS_M = 0.3`
(`src/spatial/resolver.ts:19`). On a match:

```ts
const prev = merged.get(key)!
merged.set(key, {
  ...prev,
  confidence: Math.max(prev.confidence, det.confidence),
  description: det.confidence > prev.confidence ? det.description : prev.description,
})
```

`...prev` first, and only two fields overridden. So the merged record **keeps the first
observation's `worldPos`, `worldRot`, `bbox`, `captureTimestamp` and `captureIndex`**, and
the later observation contributes nothing but a possible confidence/description bump. There
is no observation count, no last-seen, no list of contributing captures.

`findNearbyKey` (`src/spatial/resolver.ts:332-338`) is what decides a match — exact label
equality plus Euclidean distance under 0.3 m:

```ts
for (const [key, existing] of map) {
  if (existing.label !== det.label) continue
  if (dist(existing.worldPos, det.worldPos) < DEDUP_RADIUS_M) return key
}
```

Consequence: **movement is already unrepresentable *within a single session*,** before any
cross-session question arises. Walk into a room, photograph a chair, someone slides it 20 cm,
photograph it again — the app records one chair, at the first position, at the first
timestamp, and the second photograph leaves no trace it ever happened.

### 2. Detection identity is a derived, mutable key

The Map key is minted at `src/spatial/resolver.ts:324`:

```ts
const newKey = `${det.label}:${bucket(det.worldPos)}`
```

`bucket` (`src/spatial/resolver.ts:347-350`) rounds each axis to 0.1 m. So identity is
`label` + a 10 cm position bucket — **both of which change.**

- `store.updateDetection` (`src/scene/store.ts:116-123`) patches `label` and `description`
  in place and **does not rekey**:
  ```ts
  this._detections.set(key, { ...det, ...patch })
  ```
  Called from `src/ui/panel.ts:449` and `src/ui/history.ts:319`. Rename "chair" to "armchair"
  and the record lives on under the key `chair:1.2,0.0,-0.4` — a key that now asserts
  something false. Nothing errors; `findNearbyKey` simply stops matching it, because it
  compares `existing.label` (now `armchair`) not the key.
- Moving an object across a 0.1 m bucket boundary changes the identity a *new* record would
  be filed under.

### 3. A corollary the key mutation already causes

`src/main.ts:373` builds the thumbnail map key from the **incoming** detection:

```ts
const key = `${wd.label}:${bucket(wd.worldPos)}`
```

then `mergeDetections` (`src/main.ts:378`) may return that detection filed under the
**previous** record's key. `store.upsert(merged, thumbMap)` (`src/main.ts:379`,
`src/scene/store.ts:99-114`) looks the thumbnail up by the merged key — so whenever a
re-observation lands in a different 0.1 m bucket than the record it merged into (entirely
possible inside a 0.3 m dedup radius), the freshly captured thumbnail is silently dropped and
`existing?.thumbnailDataUrl` wins. `bucket()` is also duplicated —
`src/main.ts:1200-1202` and `src/spatial/resolver.ts:347-350` — which is how the two ended up
able to disagree.

## Non-goals

- **Do not** do cross-session matching. Deciding that session 1's chair *is* session 2's
  chair is ticket 0007 — a heuristic, non-destructive, server-side, persisted `WorldJob`.
  This ticket only makes the data it needs exist.
- **Do not** build UI for browsing observation history. No timeline (that is 0008), no
  "seen 4×" drawer, no per-observation rows.
- **Do not** make any server-side change. Nothing in `main.ts`, no route, no `WorldJob`.
- **Do not** rename the IndexedDB database. `'ci-xr-scan'` is frozen
  (`src/shared/storage-keys.ts:68-75`, CLAUDE.md "Do not rename"). A version bump plus a
  forward migration is the correct approach and is what this ticket does.
- **Do not** change the Map key format or `selected: Set<string>`. See the answered question
  on rekeying — the pre-existing rename-without-rekey bug is *narrowed*, not fixed, here.
- **Do not** change `DEDUP_RADIUS_M` or the display-level dedup behaviour a user sees.

## Pinned conventions

**ADR 0001** (`docs/adr/0001-reuse-existing-domain-model.md`) — this changes a "thing"
schema, so it states what it extends. Searched `src/spatial/resolver.ts`,
`src/scene/store.ts`, `src/world/types.ts` and `src/inference/prompt.ts` first:

| Existing | Where | How this ticket uses it |
| --- | --- | --- |
| `WorldDetection extends RawDetection` | `src/spatial/resolver.ts:22-28` | **extended** with `detectionId` + `observations`. ADR 0001 names `WorldDetection` as *the* "thing" type — no parallel object-record type. |
| `StoredDetection extends WorldDetection` | `src/scene/store.ts:17-19` | **extended** by inheritance; only `thumbnailDataUrl` is added there today and that stays. |
| `RawDetection` | `src/inference/prompt.ts` | untouched — it is the VLM's output shape, not a persisted record. |
| IndexedDB `'ci-xr-scan'` / store `'sessions'` / `keyPath: 'sessionId'` | `src/scene/store.ts:29-31`, name from `src/shared/storage-keys.ts:75` | **reused unchanged.** Version bumps; nothing is renamed or recreated. |
| `DEDUP_RADIUS_M`, `findNearbyKey`, `bucket`, `dist` | `src/spatial/resolver.ts:19`, `:332-350` | **reused** as the display-merge rule, unchanged in behaviour. |
| `DetectionStore.upsert` | `src/scene/store.ts:99-114` | **extended**, not replaced. The thumbnail precedence at `:109` is pinned by four existing tests and must not change. |
| `detection_store.test.ts`, `resolver.test.ts` | repo root | **extended.** Do not add parallel spec files (same instruction wave 04 ticket 0003 gave). |
| `tests/mock-session-reload.spec.ts` | `tests/` | **extended** for the real-IndexedDB migration check — it already opens `'ci-xr-scan'` by name and reads the `'sessions'` store directly (`:23`, `:34-40`). |

**ADR 0002**
(`docs/adr/0002-shared-types-importable-by-the-browser-must-live-in-Deno-API-free-files.md`)
— `src/spatial/resolver.ts` and `src/scene/store.ts` are browser modules and
`detection_store.test.ts` / `resolver.test.ts` import them under Node's type-stripping
loader. **No Deno API may appear in either, and no new import may drag one in.** Note the
existing `.ts`-extension convention this forces: `src/scene/store.ts:15` imports
`'../shared/storage-keys.ts'` with an explicit extension precisely so Node's ESM loader can
resolve it. Any new cross-module import in these files needs the same. `npm run build`
(`tsc --noEmit && vite build`) is the real gate, not `deno check`.

**No schema library.** Hand-written interfaces plus ad-hoc guards, matching
`ensureValidRotation` / `isFiniteVec3` (`src/spatial/resolver.ts:54-82`).

**Branch/commit.** `feat/non-destructive-observations`; `feat(detections): …`.

**Tests.** `npm run test:store` and `npm run test:resolver` (Node type-stripping, repo
root); `npm run test:mock` for the Playwright migration check; `npm run build` and
`npm run verify` as the gate.

## Before implementation

- `src/spatial/resolver.ts:19-28` and `:286-350` — `DEDUP_RADIUS_M`, `WorldDetection`, the
  `results.push({...})` at `:286-294`, `mergeDetections`, `findNearbyKey`, `dist`, `bucket`
- `src/scene/store.ts` in full — 310 lines; every method touches the record shape
- `src/scene/store.ts:29-32` and `:268-280` — the DB constants and `openDB`'s
  `onupgradeneeded`, which today only creates the store when absent
- `src/scene/store.ts:255-263` — `persist()`, the exact on-disk record
- `src/scene/store.ts:244-249` — `adopt()`, the read-side counterpart
- `src/main.ts:363-389` — the capture handler's merge/thumbnail/upsert block, and
  `src/main.ts:1200-1202` — the duplicate `bucket()`
- `src/main.ts:158` — `resumeLatestSession()` at boot
- `src/ui/history.ts:57, 124, 138, 184, 204, 319` and `src/ui/panel.ts:449` — every UI
  consumer of the stored shape
- `src/shared/storage-keys.ts:11-19, 68-75` — why the DB name is frozen
- `detection_store.test.ts` (4 tests, `:40-95`) and `resolver.test.ts` (5 tests) — the two
  suites to extend, and the "construct the store without `open()`" pattern
  (`detection_store.test.ts:15-16`) that lets these run with no IndexedDB at all
- `tests/mock-session-reload.spec.ts:19-45` — how a Playwright test reads the real DB
- CLAUDE.md "Do not rename", ADR 0001, ADR 0002

## Open questions & answers

- Q: Does merging still happen for display? — A: **Yes.** The representative record stays,
  observations live underneath it. A user must not suddenly see 40 chairs where they saw
  one. The Map returned by `mergeDetections` keeps exactly the same cardinality it has
  today. (decided by owner, 2026-08-19)
- Q: Which observation supplies the representative's position? — A: **The first, unchanged.**
  Tempting to switch to most-recent, but hit-test results jitter by up to the full 0.3 m
  dedup radius between captures, so a most-recent representative makes every re-observed
  object visibly hop around the room during a walkthrough — a real UX regression traded for
  no new information, since the movement question is 0007's to answer. Confidence and
  description precedence also stay byte-identical to `src/spatial/resolver.ts:319-320`.
  What changes is only that the later observations now survive. (decided by owner, 2026-08-19)
- Q: Stable id, or keep the positional key as identity? — A: **Both, with different jobs.**
  A `detectionId` becomes the record's identity; the `label:bucket(worldPos)` string stays
  the Map key. Splitting them is what lets identity survive a rename or a bucket-boundary
  crossing without rewriting `selected: Set<string>`, the thumbnail-map contract at
  `src/main.ts:373`, and every DOM key in `panel.ts`/`history.ts` in the same commit.
  (decided by owner, 2026-08-19)
- Q: What about records that already exist with no `detectionId`? — A: **The migration mints
  one for every record**, and the same normalisation runs on the read path so a record
  written by an older tab mid-upgrade is also repaired. See "IndexedDB migration".
  (decided by owner, 2026-08-19)
- Q: Migration or accept the loss? — A: **Real forward migration.** DB version 1 → 2,
  name unchanged, every existing session preserved with a synthesised single observation
  per detection. The owner's migration policy for this wave is *real backfill on both sides,
  nothing silently lost.* (decided by owner, 2026-08-19)
- Q: The rename-without-rekeying bug (`store.updateDetection`, `src/scene/store.ts:117-123`)
  — fix it or leave it? — A: **Leave it, narrowed, and say so.** `updateDetection` keeps
  patching without rekeying. What changes: the record now carries a `detectionId` that a
  rename cannot invalidate, and each observation carries the `label` **as observed**, which
  a rename never rewrites. The Map key is thereby demoted from "a truth claim about this
  record" to "an opaque handle" — strictly better than today. Actual rekeying is deferred to
  whichever ticket owns the selection/DOM-key rewrite; it is not free and it is not this
  ticket. (decided by owner, 2026-08-19)
- Q: Unbounded observation growth? — A: **Capped at 50 per detection, compacted from the
  middle.** See "Retention". (decided by owner, 2026-08-19)
- Q: Should the duplicate `bucket()` (`src/main.ts:1200-1202` vs
  `src/spatial/resolver.ts:347-350`) be de-duplicated here? — A: **Yes — export the
  resolver's one and delete `main.ts`'s copy.** It is three lines, it is in the blast radius,
  it is an ADR 0001 violation sitting in exactly the code this ticket edits, and the
  thumbnail-key corollary above is what two copies can cost. Do not expand scope beyond that.

## Files impacted

Changed:
- `src/spatial/resolver.ts` — `WorldDetection`, `DetectionObservation`, `mergeDetections`,
  the `results.push` at `:286-294`, compaction, and `export`ing `bucket`
- `src/scene/store.ts` — `DB_VERSION`, `onupgradeneeded`, the migration + normalisation
  functions, `persist`, `adopt`, `readSession`, `upsert`
- `src/main.ts` — import `bucket` from the resolver, delete the local copy at `:1200-1202`
- `detection_store.test.ts` — extended
- `resolver.test.ts` — extended
- `tests/mock-session-reload.spec.ts` — extended with the v1→v2 case
- `docs/factory/atlas.html` — the `WorldDetection` entries at `:543` and `:546`
- `docs/factory/08-places-and-things/README.md` — flip 0006's badge

New: none. Every type extends an existing one and every test extends an existing suite.

## Schema required

All in `src/spatial/resolver.ts` (browser-importable, no Deno APIs — ADR 0002).

**New: `DetectionObservation`** — one sighting, complete and immutable once written.

| Field | Type | Notes |
| --- | --- | --- |
| `observationId` | `string` | `obs-${crypto.randomUUID()}`. Minted in `resolveDetections`. |
| `sessionId` | `string` | The capture session this sighting belongs to — the field 0007 groups by. |
| `label` | `string` | The label **as observed**. Never rewritten by `updateDetection`. |
| `confidence` | `number` | As observed. |
| `description` | `string` | As observed. |
| `bbox` | `[number, number, number, number]` | As observed. |
| `worldPos` | `{ x: number; y: number; z: number }` | As resolved. Always finite — `isFiniteVec3` (`src/spatial/resolver.ts:79-82`) already guarantees this before any push. |
| `worldRot` | `{ x: number; y: number; z: number; w: number }` | As resolved. |
| `captureTimestamp` | `number` | ms epoch, the `timestamp` argument to `resolveDetections`. |
| `captureIndex` | `number \| null` | `null` when unset — mirrors the existing optional at `src/spatial/resolver.ts:27`. |

**Extended: `WorldDetection`** (`src/spatial/resolver.ts:22-28`) — every existing field
keeps its current meaning and its current value. Three added:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `detectionId` | `string` | minted | `det-${crypto.randomUUID()}`. Stable across renames, bucket crossings and merges. |
| `observations` | `DetectionObservation[]` | `[]` | Oldest first. Never reordered. |
| `lastSeenAt` | `number` | `captureTimestamp` | Derived: `observations.at(-1).captureTimestamp`. Denormalised so a consumer need not scan the array. |

`observations.length` is the observation count — do not add a separate counter field that
can drift out of sync with the array.

**Representative derivation — pin it exactly.** After a merge, the top-level fields are:

| Field | Rule | Same as today? |
| --- | --- | --- |
| `worldPos`, `worldRot`, `bbox`, `captureTimestamp`, `captureIndex` | the **first** observation's | yes (`...prev`) |
| `confidence` | `Math.max` over all observations | yes (`:319`) |
| `description` | the highest-confidence observation's; on a tie the earlier one keeps it | yes (`:320`) |
| `label` | untouched by merge; owned by `updateDetection` | yes |
| `detectionId` | the existing record's on a merge; freshly minted on a new record | new |
| `lastSeenAt` | the newest observation's `captureTimestamp` | new |

**`StoredDetection`** (`src/scene/store.ts:17-19`) needs **no change** — it extends
`WorldDetection` and inherits all three fields. `thumbnailDataUrl` stays exactly as it is.

**Retention.** Module scope in `src/spatial/resolver.ts`, alongside `DEDUP_RADIUS_M`
(`:19`):

```ts
const MAX_OBSERVATIONS_PER_DETECTION = 50
```

When an append would exceed it, **keep the first observation and the most recent 49** —
drop from the middle. Rationale: the first is the representative and the session anchor, the
newest are what a movement question needs, and the 150th photograph of the same chair from
the same doorway carries no information the 3rd did not. Size: an observation is ~200 bytes
of JSON, so the cap is ~10 KB per detection and ~400 KB for a 40-object session — negligible
next to the base64 `thumbnailDataUrl` JPEGs the same records already carry, which dominate
IndexedDB usage by orders of magnitude. `checkStorageQuota` (`src/main.ts:162`, `:385`)
keeps working unchanged; this does not move the needle it watches.

## IndexedDB migration

**Required, and it must not lose a session.**

Today (`src/scene/store.ts:29-31`, `:268-280`): DB `'ci-xr-scan'`, **version 1**, one object
store `'sessions'`, `keyPath: 'sessionId'`. The record (`:255-263`):

```ts
{ sessionId, startedAt, detections: [key, StoredDetection][] }
```

— `detections` is an array of `[string, StoredDetection]` pairs, not an object.

**The DB name must not change.** `src/shared/storage-keys.ts:68-75` and CLAUDE.md's
"Do not rename" table both say renaming orphans every existing user's persisted session
data, because the browser opens a fresh empty database under the new name. A version bump
plus a forward migration is the sanctioned route.

Changes:

1. `DB_VERSION` 1 → **2** (`src/scene/store.ts:31`). `DB_NAME` and `STORE_NAME` unchanged.
2. `onupgradeneeded` (`:271-276`) keeps its existing "create the store if absent" branch —
   that is the fresh-install path — and gains a `oldVersion < 2` branch that opens a cursor
   over `'sessions'` **inside the versionchange transaction** (`req.transaction`) and rewrites
   each record in place.
3. Each rewrite maps every `[key, StoredDetection]` pair through one pure function:

   ```ts
   export function normalizeStoredDetection(
     det: StoredDetection,
     sessionId: string,
   ): StoredDetection
   ```

   which, when `det.observations` is already a non-empty array, returns `det` unchanged
   (idempotent), and otherwise returns `det` spread with:
   - `detectionId: det.detectionId ?? \`det-${crypto.randomUUID()}\``
   - `observations: [<one observation synthesised from the fields already present>]` —
     `sessionId` from the enclosing record, and `label`, `confidence`, `description`, `bbox`,
     `worldPos`, `worldRot`, `captureTimestamp`, `captureIndex ?? null` from `det` itself
   - `lastSeenAt: det.captureTimestamp`

   Nothing is dropped: `thumbnailDataUrl` and every other field pass through the spread.
   `startedAt` and `sessionId` on the enclosing record are untouched, so `getAllSessions`'
   sort (`:176`) and the history drawer's ordering are unaffected.

4. **The same function runs on the read path**, in `adopt()` (`:244-249`) and `readSession()`
   (`:193-199`), so a record written by an older tab in another window before its upgrade
   completed is repaired on load rather than crashing a consumer that expects
   `observations`. One implementation, two call sites — ADR 0001.

Every consumer of the v1 shape keeps working because nothing is removed and the enclosing
record is structurally identical: `resumeLatestSession` (`:173-182`, called from
`src/main.ts:158`), `readSession` (`:193-199`), `allSessions` (`:202-210` — counts
`detections.length`, still pairs), `loadSession` (`:222-231`), `deleteSession` (`:234-242`),
`adopt` (`:244-249`), and the `SessionHistory` UI (`src/ui/history.ts:57, 124, 138, 184,
204, 319`). Walk each one and confirm rather than assuming.

## Definition of Done

- [ ] `DetectionObservation` declared once, in `src/spatial/resolver.ts`
- [ ] `WorldDetection` carries `detectionId`, `observations`, `lastSeenAt`
- [ ] A second observation of the same object within `DEDUP_RADIUS_M` produces **one** record
      with **two** observations
- [ ] The representative's `worldPos`/`captureTimestamp`/`confidence`/`description` are
      byte-identical to today's behaviour
- [ ] A merged record keeps the existing record's `detectionId`
- [ ] `observations` is capped at 50, keeping the first and the newest 49
- [ ] Observations record the label **as observed**; `updateDetection` does not rewrite them
- [ ] DB version is 2, name is still `'ci-xr-scan'`, store is still `'sessions'`
- [ ] Every pre-existing session still loads after the upgrade, with one synthesised
      observation per detection and no field lost
- [ ] `normalizeStoredDetection` is idempotent and runs on both the migration and the read path
- [ ] `bucket()` exists once, exported from `src/spatial/resolver.ts`; `src/main.ts:1200-1202`
      is deleted and `src/main.ts:373` uses the import
- [ ] The four existing `detection_store.test.ts` tests and five existing `resolver.test.ts`
      tests pass **unmodified**
- [ ] No Deno API reaches `src/spatial/resolver.ts` or `src/scene/store.ts` (ADR 0002)
- [ ] `npm run test:store`, `npm run test:resolver`, `npm run test:mock`, `npm run build`
      and `npm run verify` pass
- [ ] `atlas.html:543`/`:546` describe what shipped; the wave README's 0006 badge is flipped

## Tests

Extend `detection_store.test.ts` (currently 4 tests, `:40-95`, all thumbnail precedence in
`upsert`) — keep using its no-`open()` pattern so no IndexedDB is needed:

- [ ] `upsert` retains an existing record's `observations` across a re-upsert of the same key
- [ ] `upsert` does not clobber an existing record's `detectionId`
- [ ] `normalizeStoredDetection` on a v1-shaped detection yields exactly one observation and
      loses no field — assert `thumbnailDataUrl` survives explicitly
- [ ] `normalizeStoredDetection` is idempotent: running it twice yields one observation, not two
- [ ] `updateDetection` changes the representative `label` and leaves every observation's
      `label` untouched — the pin on the narrowed rename behaviour
- [ ] The four existing tests still pass with no edit

Extend `resolver.test.ts` (currently 5 tests, all about non-finite positions never
persisting):

- [ ] **merge keeps all observations**: two detections of the same label 0.1 m apart merge to
      one record with two observations carrying both positions and both timestamps
- [ ] the merged representative's `worldPos` and `captureTimestamp` are still the **first**
      observation's — pins the deliberate no-jitter decision
- [ ] `confidence` is the max and `description` follows today's precedence, including the
      equal-confidence tie
- [ ] the merged record keeps the **first** record's `detectionId`
- [ ] two detections of the same label 1.0 m apart stay two records, each with one observation
- [ ] compaction: 60 observations of one detection leave 50, the first among them and the 49
      newest, in order
- [ ] a detection dropped for a non-finite position still contributes no observation (the
      existing skip at `src/spatial/resolver.ts:279-282` must not be bypassed)

Extend `tests/mock-session-reload.spec.ts` — the only place a real IndexedDB exists:

- [ ] **v1 → v2 migration**: seed a version-1 `'ci-xr-scan'` DB with a v1-shaped session
      record, load the app, and assert the session still loads, the detection count is
      unchanged, and each detection now has exactly one observation and a `detectionId`
- [ ] a v2 DB opened again is not re-migrated (no duplicate observations)

```
npm run test:store
npm run test:resolver
npm run test:mock
npm run build
npm run verify
```

## Acceptance Criteria

- [ ] Given a chair photographed twice from slightly different angles in one session, When
      the session is inspected, Then one detection exists carrying two observations with
      distinct timestamps and positions
- [ ] Given the same, When the panel and 3D view render, Then the user still sees **one**
      chair, in the same place they see it today
- [ ] Given a detection renamed from "chair" to "armchair", Then the representative label is
      "armchair", every observation still reads "chair", and `detectionId` is unchanged
- [ ] Given a user with an existing scan session in IndexedDB, When they load the app after
      the upgrade, Then their session loads with every detection and every thumbnail intact
- [ ] Given that upgraded session, Then each detection has exactly one observation
      reconstructed from what was already stored
- [ ] Given a detection observed 60 times, Then 50 observations are retained and the very
      first is one of them
- [ ] Given the app offline / IndexedDB unavailable (`src/scene/store.ts:72-75`), Then
      behaviour degrades exactly as it does today

## Risks / potential issues

- **Risk: unbounded observation growth across many sessions of one place.** This is the
  scaling failure the feature invites. — **Mitigation:** `MAX_OBSERVATIONS_PER_DETECTION = 50`
  with middle-drop compaction, pinned by a test. Note that today's store is
  **per-session** — a record's observations can only accumulate within one session until
  0007 introduces cross-session Things, so the cap is generous for the shape that exists now
  and 0007 must revisit it for the shape it creates.
- **Risk: IndexedDB size on a phone.** — **Mitigation:** measured above at ~10 KB per
  detection worst case, against `thumbnailDataUrl` JPEGs already stored per detection that
  are orders of magnitude larger. `checkStorageQuota` (`src/main.ts:162`, `:385`) is
  unchanged and still fires. Re-measure on device before merging rather than trusting the
  estimate.
- **Risk: the display-merge regresses the existing dedupe UX.** If cardinality changes, the
  user sees a room full of duplicate pins. — **Mitigation:** the merge returns a Map of
  identical cardinality; the "1.0 m apart stays two records" and "0.1 m apart stays one
  record" tests are the guard. Do not touch `DEDUP_RADIUS_M` or `findNearbyKey`'s predicate.
- **Risk: a botched migration bricks real user data**, and unlike a server file there is no
  backup. — **Mitigation:** the migration is additive-only (spread, never delete), idempotent,
  and expressed as a pure function tested without IndexedDB before the cursor loop is written.
  The cursor runs inside the versionchange transaction so a throw aborts the upgrade and
  leaves the v1 DB intact rather than half-written. Do not write a "recreate the store"
  path — `createObjectStore` on an existing store would drop every session.
- **Risk: two tabs open across the upgrade.** The second tab holds a v1 connection and blocks
  the upgrade; meanwhile it can write v1-shaped records. — **Mitigation:** this is exactly
  why `normalizeStoredDetection` also runs on the read path. Consider an `onblocked` handler
  on the open request that logs, matching the existing "IndexedDB unavailable" degradation at
  `src/scene/store.ts:72-75` — warn, do not throw.
- **Risk: `crypto.randomUUID()` availability.** It needs a secure context in browsers. — The
  app is HTTPS-only (Vite HTTPS dev server, Tailscale certs) and
  `src/inference/router.ts:119` already calls it in browser code, so this is established
  precedent — but confirm it resolves under Node's type-stripping test runner too, since
  `detection_store.test.ts` will now exercise the minting path.
- **Risk: the rename-without-rekey bug is left in place** and someone later reads
  `detectionId` as having fixed it. — **Mitigation:** it is answered explicitly above; repeat
  the "leave alone, narrowed" note in the `updateDetection` docblock so the next reader finds
  it at the call site rather than in a ticket.
- **Risk: exporting `bucket()` from the resolver creates an import cycle** —
  `src/main.ts` already imports from `./spatial/resolver` (`src/main.ts:24`), so this is a
  new named import on an existing edge, not a new edge. Verify with `npm run build` anyway.

## Subtasks

1. [ ] Confirm wave 07 ticket 0003 has landed and `sessionId`/`captureIndex` are trustworthy
2. [ ] Declare `DetectionObservation` and extend `WorldDetection` in
       `src/spatial/resolver.ts`
3. [ ] Mint `detectionId` + the first observation in `resolveDetections`'s push
       (`src/spatial/resolver.ts:286-294`)
4. [ ] Rewrite `mergeDetections` (`:306-330`) to append an observation instead of discarding
       it, preserving every representative-derivation rule in the table above
5. [ ] Add `MAX_OBSERVATIONS_PER_DETECTION` and middle-drop compaction
6. [ ] Export `bucket()`; delete `src/main.ts:1200-1202`; point `src/main.ts:373` at the import
7. [ ] Write `normalizeStoredDetection` as a pure exported function in `src/scene/store.ts`
8. [ ] Bump `DB_VERSION` to 2 and add the `oldVersion < 2` cursor migration to
       `onupgradeneeded`
9. [ ] Call `normalizeStoredDetection` from `adopt()` and `readSession()`
10. [ ] Walk every consumer listed under "IndexedDB migration" and confirm each still works
11. [ ] Extend `detection_store.test.ts` (keep the existing four intact)
12. [ ] Extend `resolver.test.ts` (keep the existing five intact)
13. [ ] Extend `tests/mock-session-reload.spec.ts` with the v1→v2 case
14. [ ] Run `npm run test:store`, `npm run test:resolver`, `npm run test:mock`,
        `npm run build`, `npm run verify`
15. [ ] Measure IndexedDB usage on a real device across a realistic session
16. [ ] Verify on device: a pre-upgrade session survives the upgrade with thumbnails intact
17. [ ] Update `atlas.html:543`/`:546`; flip the 0006 badge in the wave README
