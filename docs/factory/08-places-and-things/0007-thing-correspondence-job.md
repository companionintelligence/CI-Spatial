> **Type:** Backend
> **Wave:** 08-places-and-things
> **Branch:** `feat/thing-correspondence`
> **Commit style:** `feat(things): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0006 (non-destructive observations) — hard. 0006 is what puts
> per-object world positions into a record the *server* can read; see "The gap this
> depends on," below. 0008 does not depend on this ticket and can land in parallel;
> 0009 depends on this one.

## Goal

Know that the chair in session 1 is the chair in session 2 — give every real object a
durable identity that outlives the scan it was observed in, so the editor can say
**added / removed / moved / unchanged** instead of just rendering two piles of
detections on top of each other.

## The gap this depends on

Nothing server-side currently carries a per-object world position.

- A detection's 3D position lives in the exported GLB and is read only in the browser
  — `collectDetections(root)` walking `userData` (`src/viewer/viewer.ts:825-861`).
- What the server holds per scan is a *count* (`ScanManifest.detectionCount`,
  `src/world/types.ts:157`, populated at `main.ts:1395` from the scan's meta sidecar)
  and a flat `labels: string[]` (`main.ts:3181`) with no coordinates. The `floor-plan`
  branch says so out loud at `main.ts:3214`: *"No object positions available for
  floor-plan generation."*
- `src/scene/store.ts`'s `StoredDetection` (`:17-19`) is browser IndexedDB, per-session,
  keyed by the same derived mutable key described below.

So the matcher's input is 0006's deliverable, not this ticket's. **This ticket assumes
0006 lands a server-readable, per-scan set of observation records carrying at minimum
`{ scanId, targetId, label, worldPos }`.** If 0006's shape differs, reconcile before
coding — do not invent a second observation record here (ADR 0001).

## Non-goals

- Do not add ML, embedding, or descriptor-based matching. Label + proximity only.
- Do not build any UI. The timeline is 0008; tag propagation is 0009. This ticket ends
  at persisted `Thing`/`ThingObservation` records and a pure change-computing function.
- Do not automatically merge two existing `Thing`s. A merge destroys identity that 0009
  hangs tags off; if the matcher believes two Things are one, it leaves them alone and
  the ambiguity is surfaced, not resolved.
- Do not change in-session dedupe. `DEDUP_RADIUS_M` and `mergeDetections`
  (`src/spatial/resolver.ts:19`, `:306-330`) stay exactly as they are — they answer a
  different question (see Pinned conventions).
- Do not store `added`/`removed`/`moved`/`unchanged` on disk. They are derived; see
  "The outcome vocabulary."
- Do not add a second job queue, a poller, or a cron. ADR 0003.
- Do not rename `semantic-pass` or repurpose it (see the decision in Open questions).

## Pinned conventions

### ADR 0001 — `Thing` is the one genuinely new type in this wave, and here is the search

ADR 0001 requires that "N/A, this is new" be backed by a real search. Verified by
reading the source, not the docs:

| Candidate | Where | Why it cannot carry cross-session identity |
| --- | --- | --- |
| `WorldDetection` | `src/spatial/resolver.ts:22-28` | **No stable id at all.** Identity is a *derived, mutable* map key computed at merge time: `` `${det.label}:${bucket(det.worldPos)}` `` (`:324`, with `bucket()` rounding to 0.1 m at `:348-350`). Move the object or change its label and the key changes — that is the opposite of a durable identity. |
| `StoredDetection` | `src/scene/store.ts:17-19` | `WorldDetection` plus a thumbnail, held in the browser's `'ci-xr-scan'` IndexedDB, keyed by the same derived key, scoped to one session record. Not visible to the server. |
| `DetectObject` / `DetectObjectRecord` | `src/world/detect-objects.ts:35-61` | Explicitly fenced off. Its own header, `:21-25`: *"Intentionally NOT part of the RawDetection → WorldDetection → StoredDetection lineage (ADR 0001 …): this is a different producer with a different contract than a VLM detection — do not unify it with `WorldDetection`."* It is splat_analyzer's `interactions.json` output, in the splat's own coordinate frame, and carries no id field. |
| `FurnitureItem` | `src/shared/test-homes.ts:15-23` | Synthetic ground-truth fixture data for the 24 procedural test homes; its header at `:12-14` carries the same explicit do-not-unify fence. No id, no session, not real. |
| `EditPatch` | `src/world/types.ts:131-144` | A record of a *user edit* — `patchId`, `targetId`, `scope`, `transform?`, `category?`. `targetId` is scan-namespaced (`` `${scanId}:${name}:lod` ``, `src/viewer/viewer.ts:837`), so it names an observation inside one scan, not an object across scans. It is the audit trail of what a person changed, not what exists. |
| `ScanManifest` | `src/world/types.ts:146-163` | A *place* record — one uploaded GLB's position and metadata. Wrong side of the things/places split. |

**Conclusion: nothing existing carries a durable cross-session object identity, so
`Thing` is warranted.** It is a *thing* in ADR 0001's vocabulary and belongs in the
same file as the other domain types, `src/world/types.ts`.

What this ticket **reuses** rather than duplicating:

| Existing | Where | How used |
| --- | --- | --- |
| `WorldJob` + `WorldJobType` | `src/world/types.ts:16-29`, `:174-189` | The correspondence pass is a `WorldJob`. ADR 0003: sole job system. |
| `createWorldJob` / `completeJobSoon` / `WorldJobPump` | `main.ts:1794-1820`, `:1939-1941`, `world_job_pump.ts:55-73` | Enqueue and single-flight execution, unchanged. |
| `updateWorld()` | `main.ts:1588-1598` | The only way this job persists anything. ADR 0004. |
| `claimJobScan` / `commitWorldJob` / `failWorldJob` | `main.ts:2610-2626`, `:2665-2686`, `:2687-2691` | The claim-run-commit boilerplate ADR 0004 factored out. This job is world-scoped so it does not use `claimJobScan`, but it must use `commitWorldJob`/`failWorldJob`. |
| `Vec3` | `src/world/types.ts:37-41` | Positions. Do not declare a fourth `{x,y,z}` shape. |
| `crypto.randomUUID()` | `main.ts:1803`, `:3022` | Id generation, house style. |
| `SEMANTIC_TAGS` | `src/viewer/editor.ts:16-29` | The anchor vocabulary for label normalisation — the synonym table maps onto these, it does not replace them. |

### ADR 0002 — where the types go

`Thing`, `ThingObservation`, and `ThingChangeKind` are declared in
`src/world/types.ts`, which has zero `Deno.*` references and is the established
browser-safe home. 0008 and 0009 both import them from the viewer. Do **not** declare
them in a root-level Deno driver and re-export — `tsc --noEmit` type-checks the body of
a type-only import's source file, which is how 30+ "Cannot find name 'Deno'" errors
appeared last time. `npm run build` (`tsc --noEmit && vite build`) is the real gate;
`deno task check` never catches this.

### ADR 0003 — every registration site for a new `WorldJobType`

Adding `'thing-correspondence'` means touching **all** of:

1. `WorldJobType` union — `src/world/types.ts:16-29`.
2. `WORLD_JOB_TYPES` Set — `main.ts:1154-1167`. Note it deliberately **omits**
   `'optimize-scan'`: a type absent from this Set is rejected by
   `POST /worlds/:slug/jobs` (`main.ts:3059-3061`) and is unreachable from the viewer.
   `'thing-correspondence'` **must** be added here — it is user-triggerable.
3. Viewer job `<select id="job-type">` — `viewer.html:1064-1075`. Add
   `<option value="thing-correspondence">Match things across sessions</option>`.
   (The dropdown today lists ten of the twelve Set members — `splat-detect` and
   `memory-push` are queued from elsewhere. This one belongs in the list.)
4. `_dispatchWorldJob` if-chain — `main.ts:1978-2006`. Add the branch **before** the
   generic 650 ms placeholder path at `:2008-2013`, mirroring `:2003-2006`.
5. `jobResultFor` — `main.ts:2741-2775`. **Compiler-enforced:** it returns `string`
   with no `default`, so a missing case is a `deno check` failure.
6. `jobArtifactsFor` — `main.ts:2777-2865`. **Not** compiler-enforced: the return type
   is `WorldJob['artifacts']`, which admits `undefined`, and `'memory-push'` and
   `'optimize-scan'` already fall through to `undefined` with no case. Add a case
   deliberately; the compiler will not remind you.
7. `jobProcessingLabel` — `src/viewer/quality-tier.ts:78-97`. Optional (it has
   `default: return null`), but add `case 'thing-correspondence': return 'matching things'`.
8. `jobFailureReason` — `main.ts:2703-2718`. **Do not** add the new type to the
   requires-a-selected-scan list at `:2705`. Correspondence is world-scoped.
9. `applyCompletedJobToWorld` — `main.ts:2720-2739`. Leave alone; it early-returns at
   `:2722` when the job has no scan, which is correct here.

Enqueue path: `updateWorld(slug, w => createWorldJob(w, 'thing-correspondence', undefined, { target: w.shareSlug }))`
then `await completeJobSoon(slug, job.jobId)` — the shape `POST /worlds/:slug/jobs`
already uses at `main.ts:3062-3063`.

**Dedupe needs one small extension.** `findDuplicateWorldJob`
(`world_job_pump.ts:99-110`) returns `undefined` immediately when the target is
`undefined`, and `worldJobTarget` (`:80-84`) only knows `scanId` and
`payload.filename`. A world-scoped job has neither, so it gets no dedupe today. Extend
`worldJobTarget` with a third fallback — `payload.target` when it is a string — and
enqueue with `payload: { target: world.shareSlug }`. Do not smuggle a slug through a
field literally named `filename`. This is a should, not a must: the pump is single-flight
globally (`world_job_pump.ts:55-73`), so a duplicate would run serially and, because the
job is idempotent (below), be a no-op. Dedupe just avoids the wasted pass.

### ADR 0003 §"Crash recovery" — idempotency is mandatory here

ADR 0003:174-177 states plainly that requeue-always is the default and that *"if a
future job type has a genuinely non-idempotent side effect, requeue-always should be
revisited for that type specifically."* Re-running a matcher that mutates `Thing`
records is exactly that hazard: a naive implementation that appends links on every run
would multiply observations after every crash or every click of the button.

**This ticket does not revisit requeue-always. It makes the job idempotent instead.**
Four rules, all testable:

- **R1 — recompute, don't append.** Each run recomputes the full matcher-origin link
  set from the current observations. It does not read its own previous matcher output
  as input.
- **R2 — user links are inputs, never outputs.** A `ThingObservation` with
  `origin: 'user'` is carried through verbatim and pins its observation to its
  `thingId`; the matcher may not reassign it, and a re-run may not overwrite it.
- **R3 — natural keys, stable ids.** A `ThingObservation` is uniquely identified by
  `(scanId, targetId)`. On each run, look up the existing record by that pair and reuse
  its `observationId`; mint `crypto.randomUUID()` only for a genuinely new pair. Same
  for `Thing`: an existing `Thing` is reused whenever it still claims at least one of
  its observations, so `thingId` survives re-runs.
- **R4 — the only fields a no-op re-run may change are `updatedAt`.** This is the test.

### The matcher

Label + proximity, across the sessions of one `WorldProject`. Pin these as named
constants in `thing_match.ts`, each with the comment that justifies it:

| Constant | Value | Why |
| --- | --- | --- |
| `THING_MATCH_RADIUS_M` | `0.75` | The cross-session radius, deliberately **not** `DEDUP_RADIUS_M`. |
| `THING_MOVED_MIN_M` | `0.15` | Above this, a match is reported `moved`; at or below, `unchanged`. |
| `THING_COVERAGE_RADIUS_M` | `3.0` | How near a later session must have observed *something* before absence counts as `removed` rather than silence. |

**Why the cross-session radius differs from the in-session one.** `DEDUP_RADIUS_M = 0.3`
(`src/spatial/resolver.ts:19`) answers *"are these two hit-tests the same observation?"*
— the spread it has to tolerate is hit-test scatter within a single walkthrough, over
seconds, against one SLAM feature map. The cross-session radius answers a different
question: *"is this the same physical object as the one I saw last week?"* It has to
tolerate two error sources the in-session case does not — the object genuinely moving
(a chair gets pushed in, a lamp shifts along a table), and each session carrying its own
independent local→world alignment error. Reusing 0.3 m would report every pushed-in
chair as `removed` **and** `added`, which is worse than useless: 0009 then propagates
the tag to nothing.

The larger radius is only safe because of the uniqueness rule below. Do not raise it
without also tightening that rule.

**Reuse the in-session precedent's shape, not its number.** `findNearbyKey`
(`src/spatial/resolver.ts:332-338`) is the exact predicate to copy: same label, then
Euclidean distance below a threshold, with `dist()` at `:340-345`. The cross-session
matcher is that function with (a) a different radius, (b) label *equivalence* rather
than label equality, and (c) a uniqueness requirement.

**Label instability.** The VLM does not return a stable label — the same chair comes
back as `"chair"`, then `"armchair"`, then `"seat"`. Exact-label matching would split
one object into three Things. Pin a three-tier equivalence, in `thing_match.ts`:

1. Exact match after `normalizeLabel()` — lowercase, trim, collapse whitespace, strip a
   trailing plural `s`.
2. A curated synonym table anchored on `SEMANTIC_TAGS` (`src/viewer/editor.ts:16-29`),
   mapping observed variants onto a canonical tag: `armchair|seat|stool → chair`,
   `couch|settee → sofa`, `tv|television|monitor → monitor`, and so on. The table lives
   next to the matcher, is data not code, and is explicitly incomplete — an unknown
   label simply falls back to tier 1.
3. Nothing else. No fuzzy string distance, no embeddings (non-goal).

A `Thing` records `label` (the most recent non-empty observed label) plus
`labelHistory`, so the drift is preserved rather than overwritten. The match itself is
made on the canonical form; the display label is whatever was seen last.

**Uniqueness / ambiguity.** For an observation *o* in session B and a candidate set
*C* = every `Thing` whose last known position is within `THING_MATCH_RADIUS_M` of *o*
and whose canonical label is equivalent:

- `|C| == 0` → *o* starts a new `Thing`.
- `|C| == 1` → match.
- `|C| >= 2` → **leave unmatched and surface it.** Do not pick the nearest. Do not
  break the tie by confidence, recency, or label specificity. The unmatched observation
  gets its own fresh `Thing` — every observation always has a `thingId`, so 0008 can
  still render it — and the ambiguity is recorded both in the job's `result` string and
  as a `thing-ambiguity` artifact entry naming the observation and its candidates, so a
  person can see it and correct it. Two dining chairs 0.5 m apart is the canonical case,
  and guessing there is exactly how a wrong tag gets propagated for the rest of time.

Matching is greedy over observations sorted by ascending distance to their single
candidate, and a `Thing` may claim at most one observation per scan.

### The outcome vocabulary

`added` / `removed` / `moved` / `unchanged`, computed **at read time** by an exported
pure function — `thingChangesBetween(things, observations, fromSessionId, toSessionId)`
in `thing_match.ts` — and **never persisted**. Persisting them would mean rewriting
every earlier verdict each time a new session lands, which is the "silently rewrite
history" risk this ticket is trying not to create.

Evidence required for each:

| Verdict | Evidence |
| --- | --- |
| `added` | The Thing has an observation in session B and no observation in any session captured before B. |
| `moved` | The Thing has an observation in both A and B, and the distance between them exceeds `THING_MOVED_MIN_M`. |
| `unchanged` | Observed in both, distance at or below `THING_MOVED_MIN_M`. |
| `removed` | Observed in A (or earlier), **not** observed in B, **and** session B observed at least one other Thing within `THING_COVERAGE_RADIUS_M` of the Thing's last known position. |

That last clause is the honest part. Absence is not evidence of removal if the scanner
never walked into that room. **A Thing that is absent from B with no nearby coverage is
omitted from the change list entirely** — it is not reported as `removed`, and it is not
reported as anything else. Four verdicts, no fifth; silence is the fifth state.

### Persistence — `worlds/<slug>.json`, not a sidecar

`WorldProject` gains `things: Thing[]` and `thingObservations: ThingObservation[]`,
written only through `updateWorld()` (ADR 0004).

Justified against file-size growth:

- **The repo's own answer to "this array grows" is a bound, not a second file.**
  `WorldProject` already holds `scans[]`, `jobs[]`, `editPatches[]` (`types.ts:191-203`)
  in one file, and ADR 0003 solved unbounded `jobs[]` growth with `MAX_WORLD_JOB_HISTORY
  = 200` (`world_job_pump.ts:114`), not by moving jobs out.
- **A sidecar would reintroduce the bug ADR 0004 exists to close.** `withWorldLock`
  (`world_lock.ts`) serialises `worlds/*.json` only. A `things/<slug>.json` would need
  its own lock — `withThingLock` next to `withWorldLock` is precisely the parallel
  system ADR 0001 forbids, and getting it wrong reproduces the lost-update pattern ADR
  0004 documents (4 jobs stranded at `progress: 0.35`).
- **Size is small and bounded by reality, not by usage.** A `Thing` is roughly 250
  bytes of JSON; a `ThingObservation` roughly 200. One Thing exists per distinct
  physical object per world — a house is hundreds, not thousands. Observations grow
  linearly with sessions × objects, which is the same order as the detections already
  implied by `scans[]`.
- **Guard rather than trim.** Unlike `jobs[]`, a `Thing` must never be silently
  trimmed — 0009 hangs tags off `thingId`, so dropping a Thing strands a tag. Pin
  `MAX_THINGS_PER_WORLD = 5000` and **fail the job** with an explicit message when a run
  would exceed it, rather than growing quietly or deleting silently. Hitting that cap
  means the matcher is malfunctioning, and a failed job says so.

### Everything else

- Branch `feat/thing-correspondence`; commits `feat(things): …`.
- New matcher module is `thing_match.ts` at the repo root, following the
  `world_job_pump.ts` / `world_lock.ts` / `world_prune.ts` precedent: pure, no
  `main.ts` import, no top-level side effects, unit-testable on its own.
- Deno tests are `*.test.ts` at the root, and the file **must be added to the explicit
  list** in `deno.json:8`'s `test` task — that task names every file individually, so a
  new test file that is not listed silently never runs.

## Before implementation

- `docs/adr/0001-reuse-existing-domain-model.md` — the whole thing, and especially the
  "things and places" split.
- `docs/adr/0003-merged-job-system.md` — §"Single-flight execution", §"Dedupe",
  §"Crash recovery" (lines 135-177, and 174-177 in particular), §"Placeholder
  WorldJobTypes".
- `docs/adr/0004-world-file-writes-are-serialized-per-slug.md` — all of it. The
  not-reentrant rule at `:57-59` bites any mutator that calls `loadWorld` for its own
  slug.
- `docs/adr/0002-shared-types-importable-by-the-browser-must-live-in-deno-api-free-files.md`
- `src/spatial/resolver.ts:19`, `:22-28`, `:300-350` — the in-session precedent, in full.
- `main.ts:1794-1820` (`createWorldJob`), `:1939-1941` (`completeJobSoon`),
  `:1953-2042` (`_dispatchWorldJob`), `:2255-2340` (`_runSplatDetectJob` — the runner
  to copy structure from), `:2477-2560` (`_runOptimizeScanJob` — the world-scoped,
  no-`scanId` runner, the closer analogue), `:2610-2691` (the claim/commit/fail helpers).
- `world_job_pump.ts:1-115` — the pump, `worldJobTarget`, `findDuplicateWorldJob`.
- `src/world/detect-objects.ts:1-26` and `src/shared/test-homes.ts:12-14` — the two
  do-not-unify fences, so the search in Pinned conventions is verified, not copied.
- Ticket 0006, once drafted — its observation record is this job's input.

## Open questions & answers

- Q: Revive the placeholder `semantic-pass`, or add a new `WorldJobType`? — **A: add a
  new type, `'thing-correspondence'`.** (decided by owner, 2026-08-19.) What
  `semantic-pass` does today, verified: it is in the union (`types.ts:21`), in
  `WORLD_JOB_TYPES` (`main.ts:1159`), in the viewer dropdown (`viewer.html:1069`), has
  **no** branch in `_dispatchWorldJob` and so falls to the generic 650 ms placeholder
  path (`main.ts:2008-2013`), and already carries three scan-scoped behaviours: it is in
  `jobFailureReason`'s requires-a-selected-scan list (`main.ts:2705`, so a
  `semantic-pass` job with no `scanId` **fails**), `applyCompletedJobToWorld` rewrites
  the scan's status for it (`:2724-2726`), and `jobArtifactsFor` builds a per-scan
  `'semantic-report'` (`:2797-2802`). Correspondence is world-scoped by definition —
  reviving `semantic-pass` would mean undoing all three, which is a larger diff than
  adding a member, *and* it would silently change the meaning of a name already exposed
  in the viewer dropdown and in `jobProcessingLabel`'s "labeling objects"
  (`quality-tier.ts:86-87`). A job named `semantic-pass` that computes cross-session
  object identity is this codebase's third `ScanManifest`, in job-type form. ADR 0003's
  §"Placeholder WorldJobTypes" leaves whether a placeholder ever gets a runner as "a
  separate, later owner decision" and reserves it for nothing; this is that decision,
  and the answer is that `semantic-pass` keeps its scan-scoped meaning for whoever
  eventually implements it.
- Q: Is correspondence destructive of the underlying observations? — A: No.
  Non-destructive, always. It writes `Thing`/`ThingObservation` records alongside the
  observations from 0006 and never edits or deletes one. (owner, 2026-08-19)
- Q: Client-side or server-side? — A: Server-side, as a `WorldJob`, persisted. Not
  recomputed in the browser on each load. (owner, 2026-08-19)
- Q: Is correspondence correctable by a user? — A: Yes — that is what
  `ThingObservation.origin: 'user'` is for, and rule R2 is what makes a correction
  survive the next run. The *API* for making a correction is deliberately out of scope
  here (no UI in this ticket); the schema must support it from day one so 0009 does not
  have to migrate. (owner, 2026-08-19)
- Q: Where do the change verdicts live? — A: Derived, never stored. See "The outcome
  vocabulary." (owner, 2026-08-19)
- Q: Where does the data live — `worlds/*.json` or a sidecar? — A: `worlds/*.json` via
  `updateWorld()`. Justified in Pinned conventions §"Persistence". (owner, 2026-08-19)
- Q: What is the right value for `THING_MATCH_RADIUS_M`? — **OPEN on the exact number.**
  `0.75` is pinned as the starting value and the reasoning for *why it differs from
  0.3* is settled. Calibrate against a real two-session corpus of the same room before
  the wave closes, and record the measured false-match / missed-match counts in this
  section. Do not raise it without tightening the uniqueness rule.
- Q: What is the right value for `THING_MOVED_MIN_M`? — **OPEN on the exact number.**
  `0.15` is pinned as the starting value: large enough that per-session alignment jitter
  does not read as movement, small enough that a person would call it moved. Same
  calibration pass.
- Q: Does the matcher run over every session pair, or only the newest against the
  accumulated Things? — A: Newest against accumulated. A `Thing`'s `lastPosition` is the
  running anchor. Full recomputation from scratch is still required to hold R1, but the
  *anchor* for matching a new session is the accumulated state, not a pairwise sweep.
- Q: What happens to a `Thing` whose only observation was in a scan that has since been
  deleted? — **OPEN.** `refreshWorldScans` (`main.ts:1603+`) already prunes scans whose
  `.glb` has gone (guarded by `pruneScansMissingFromDisk`). Orphaned observations must
  be pruned with them, but an orphaned *Thing* carrying a user tag from 0009 must not
  be. Decide before coding; the safe default is to keep the Thing and let it hold zero
  observations.

## Files impacted

New:
- `thing_match.ts` — the matcher, the label normaliser + synonym table, the constants,
  and `thingChangesBetween()`. Pure; no `main.ts` import, no `Deno.*` at module scope.
- `thing_match.test.ts` — Deno unit tests (and its entry in `deno.json:8`).

Changed:
- `src/world/types.ts` — `Thing`, `ThingObservation`, `ThingChangeKind`;
  `'thing-correspondence'` in `WorldJobType` (`:16-29`); `things` and
  `thingObservations` on `WorldProject` (`:191-203`).
- `main.ts` — `WORLD_JOB_TYPES` (`:1154-1167`); `_runThingCorrespondenceJob` (new, next
  to `_runOptimizeScanJob` at `:2477`); the `_dispatchWorldJob` branch (`:1978-2006`);
  `jobResultFor` (`:2741-2775`); `jobArtifactsFor` (`:2777-2865`).
- `world_job_pump.ts` — `worldJobTarget`'s third fallback (`:80-84`).
- `viewer.html` — the `<option>` in `#job-type` (`:1064-1075`).
- `src/viewer/quality-tier.ts` — `jobProcessingLabel` (`:78-97`).
- `deno.json` — the new test file in the `test` task's explicit list (`:8`).
- `docs/factory/atlas.html` — the "World / scan data model" fcard (`~:439`) and the
  domain-type table rows (`~:534-540`) gain `Thing`; a before/after diff line records
  that nothing carried cross-session identity before this wave.

## Schema required

Declared in `src/world/types.ts` (ADR 0002). All timestamps ISO 8601 strings, matching
every other type in the file. All ids `crypto.randomUUID()`-derived, house style.

```ts
/**
 * A durable cross-session object identity inside one WorldProject — the "thing"
 * half of ADR 0001's things/places split, and the only type in this wave that is
 * genuinely new (see 08-places-and-things/0007 for the search that justifies it).
 * Nothing in the RawDetection → WorldDetection → StoredDetection lineage carries
 * an identity that survives a second walkthrough; this does.
 */
export interface Thing {
  thingId: string                 // `thing-${crypto.randomUUID()}`
  worldId: string
  /** Most recent non-empty observed label. Display only — matching uses the canonical form. */
  label: string
  /** Every distinct label this Thing has been observed under, most recent first. Bounded to 8. */
  labelHistory: string[]
  /** Canonical label the matcher keys on (normalizeLabel + synonym table). */
  canonicalLabel: string
  /** Most recent observed position, world/ENU frame, metres. The matching anchor. */
  lastPosition: Vec3
  /** capturedAt of the earliest scan this Thing was observed in; null if that scan had none. */
  firstSeenAt: string | null
  /** capturedAt of the most recent scan this Thing was observed in; null likewise. */
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * One observation of a Thing inside one scan — the correspondence link itself.
 * Natural key is (scanId, targetId); observationId is stable across job re-runs
 * because the runner looks the record up by that pair before minting a new id.
 */
export interface ThingObservation {
  observationId: string           // `obs-${crypto.randomUUID()}`
  thingId: string
  scanId: string
  /** ScanManifest.sessionId of the owning scan, copied for grouping without a join. */
  sessionId: string | null
  /** The scan-namespaced object id the viewer already uses: `${scanId}:${name}:lod`. */
  targetId: string
  /** Label exactly as observed in this scan — not normalised, not overwritten. */
  label: string
  position: Vec3
  /** The owning scan's capturedAt. */
  observedAt: string | null
  /** How the link was made. 'user' links are inputs to the matcher and are never revised by it. */
  origin: 'matcher' | 'user'
  /** Matcher distance-derived score, 0–1. Absent when origin is 'user'. */
  score?: number
  createdAt: string
}

/** Derived at read time by thingChangesBetween(); never persisted. */
export type ThingChangeKind = 'added' | 'removed' | 'moved' | 'unchanged'
```

`WorldProject` (`src/world/types.ts:191-203`) gains:

```ts
  things: Thing[]                 // default []
  thingObservations: ThingObservation[]   // default []
```

Both default to `[]`. Every read path must tolerate their absence from an existing
`worlds/*.json` written before this ticket — use `world.things ?? []`, the same way
older fields are defended elsewhere, rather than requiring a migration.

`WorldJobType` (`:16-29`) gains `| 'thing-correspondence'`.

No changes to `WorldDetection`, `DetectObject`, `FurnitureItem`, `EditPatch`, or
`ScanManifest`.

## Definition of Done

- [ ] `Thing`, `ThingObservation`, `ThingChangeKind` declared in `src/world/types.ts`;
      `WorldProject` carries `things` and `thingObservations`, both defaulting to `[]`
- [ ] `'thing-correspondence'` registered at all nine sites listed in Pinned conventions
- [ ] `thing_match.ts` exports the matcher, `normalizeLabel`, the synonym table, the
      three pinned constants, and `thingChangesBetween()` — and imports neither
      `main.ts` nor anything that touches `Deno.*` at module scope
- [ ] The runner persists exclusively through `updateWorld()` (ADR 0004) and never calls
      `loadWorld` for its own slug inside a mutator
- [ ] The job is idempotent under rules R1–R4: a second run over unchanged input changes
      nothing but `updatedAt`
- [ ] A user-origin observation link survives a matcher re-run untouched
- [ ] Ambiguous observations (two or more candidates in radius) are left unmatched and
      named in the job's `result` and artifacts
- [ ] Label drift across `chair` / `armchair` / `seat` resolves to one `Thing`, with the
      drift preserved in `labelHistory`
- [ ] `deno task check`, `deno task test`, `npm run verify` all pass
- [ ] The atlas entries named in Files impacted are updated, and the wave badge flipped

## Tests

Deno, in `thing_match.test.ts` (registered in `deno.json:8`):

- [ ] Same object slightly moved matches — one observation at `(1.0, 0.5, 2.0)` labelled
      `chair` in session A, one at `(1.3, 0.5, 2.1)` labelled `chair` in session B → one
      `Thing`, two observations, verdict `moved`
- [ ] Movement below `THING_MOVED_MIN_M` reports `unchanged`, not `moved`
- [ ] Genuinely different objects do not match — same label, 2.0 m apart (beyond
      `THING_MATCH_RADIUS_M`) → two `Thing`s, verdicts `added` and `added`
- [ ] Different labels at the same position do not match — `chair` and `table` at
      identical coordinates → two `Thing`s
- [ ] Label drift matches — `chair` → `armchair` → `seat` across three sessions → one
      `Thing`, `labelHistory` length 3, `label === 'seat'`
- [ ] An object present in session 1 and absent in session 2, **with** nearby coverage
      in session 2, reports `removed`
- [ ] The same absence **without** nearby coverage within `THING_COVERAGE_RADIUS_M` is
      omitted from the change list entirely — asserted as absent, not as `removed`
- [ ] Ambiguity is left unmatched — two `chair` observations 0.5 m apart in session A,
      one `chair` between them in session B → B's observation joins neither existing
      Thing; it gets its own, and the ambiguity is reported
- [ ] The job is idempotent across two runs — run the matcher twice over the same input
      and assert the resulting `things` / `thingObservations` are deep-equal apart from
      `updatedAt` (rule R4), including that every `thingId` and `observationId` is
      unchanged (rules R3)
- [ ] A `ThingObservation` with `origin: 'user'` pinning an observation to a Thing the
      matcher would not have chosen survives a re-run unmodified (rule R2)
- [ ] `MAX_THINGS_PER_WORLD` is enforced by failing, not by trimming

Deno, in an existing or new server test:

- [ ] `POST /worlds/:slug/jobs` with `type: 'thing-correspondence'` is accepted (proves
      the `WORLD_JOB_TYPES` registration) and the job reaches `completed`
- [ ] The job does **not** fail with "requires a selected scan" when no `scanId` is
      supplied (proves it was correctly kept out of `jobFailureReason`'s list at
      `main.ts:2705`)

```
deno task check
deno task test
npm run verify
```

## Acceptance Criteria

- [ ] Given a world with two sessions of the same room, When the correspondence job
      runs, Then every object observed in both sessions has exactly one `Thing` with two
      `ThingObservation`s
- [ ] Given that job has already run, When it is queued again with no new scans, Then
      the world file's `things` and `thingObservations` are byte-identical apart from
      `updatedAt`
- [ ] Given two candidate Things within the match radius of one observation, When the
      matcher runs, Then it matches neither and the job's `result` names the ambiguity
- [ ] Given a user has corrected a correspondence, When the job re-runs, Then the
      correction stands
- [ ] Given the job crashes mid-run, When the server restarts and boot recovery requeues
      it (ADR 0003 §"Crash recovery"), Then the completed state is the same as if it had
      never crashed
- [ ] Given a world file written before this ticket (no `things` key), When it is loaded,
      Then nothing throws and the arrays read as empty
- [ ] `deno task check`, `deno task test`, and `npm run verify` pass

## Risks / potential issues

- **Risk:** A false match silently rewrites history, and 0009 will then propagate a tag
  along it into every future visit. **A wrong match is strictly worse than no match** —
  no match leaves two Things a person can merge later; a wrong match asserts a fact
  nobody asked to verify. — **Mitigation:** Bias the heuristic toward not matching, and
  say so in the code: the uniqueness rule (`|C| >= 2` → no match) is not a tiebreak
  fallback, it is the point. Never guess the nearest. Never break ties. Ship the
  ambiguity in the job result so a person sees it. The whole design accepts more
  duplicate Things in exchange for fewer wrong ones.
- **Risk:** Label instability from the VLM (`chair` → `armchair` → `seat`) breaks
  exact-label matching and splits one object into three Things — which then look like a
  `removed` plus an `added` in the editor. — **Mitigation:** the three-tier
  normalise-then-synonym equivalence, with `labelHistory` preserving the drift rather
  than hiding it. The synonym table is deliberately small and data-shaped so it can be
  extended without touching the matcher.
- **Risk:** Unbounded `Thing` growth. If the matcher misfires, every session adds a full
  room's worth of new Things and `worlds/<slug>.json` grows without limit — the same
  failure ADR 0003 had to fix for `jobs[]`. — **Mitigation:** `MAX_THINGS_PER_WORLD =
  5000` **fails the job** rather than trimming (a trimmed Thing strands a 0009 tag), and
  each run logs the Thing count so a runaway is visible before it hits the cap.
- **Risk:** Re-running a matcher that mutates Thing records is exactly the
  non-idempotent hazard ADR 0003:174-177 warns about, and boot recovery is
  requeue-always. — **Mitigation:** rules R1–R4 and the two-run deep-equal test. This is
  the single most important test in the ticket.
- **Risk:** The two thresholds are guesses until calibrated, and the wrong value fails
  quietly — too tight reports phantom churn, too loose merges neighbours. —
  **Mitigation:** both are named constants with their reasoning in a comment, both are
  flagged OPEN above, and the calibration pass on a real two-session corpus is a subtask,
  not an afterthought.
- **Risk:** 0006's observation shape may not match what this ticket assumes. —
  **Mitigation:** the dependency is stated as a hard block with the minimum fields
  named; reconcile before coding rather than declaring a second observation record.
- **Risk:** Cross-session alignment error is the real floor on all of this. Two sessions
  of the same room can be metres apart if their geo fixes disagree — no proximity
  matcher survives that. — **Mitigation:** out of scope, but worth measuring during
  calibration: if the observed inter-session offset exceeds `THING_MATCH_RADIUS_M`
  systematically, the answer is an alignment ticket, not a bigger radius.
- **Risk:** Growing `worlds/<slug>.json` increases the cost of every `updateWorld` cycle,
  and ADR 0004 already documents write contention on that file getting worse. —
  **Mitigation:** the sections stay short (this job commits once at the end, not per
  Thing), and long work stays outside the lock per ADR 0004:60-64.

## Subtasks

1. [ ] Read 0006's landed observation record and reconcile this ticket's assumed
       `{ scanId, targetId, label, worldPos }` against it
2. [ ] Declare `Thing`, `ThingObservation`, `ThingChangeKind` and the two
       `WorldProject` arrays in `src/world/types.ts`; confirm `npm run build` still
       passes (ADR 0002's real gate)
3. [ ] Write `thing_match.ts`: constants, `normalizeLabel`, the synonym table, the
       greedy unique matcher, `thingChangesBetween()`
4. [ ] Write `thing_match.test.ts` covering every case in Tests, and register it in
       `deno.json:8`
5. [ ] Add `'thing-correspondence'` to `WorldJobType` and `WORLD_JOB_TYPES`, then let
       `deno task check` point at `jobResultFor`; add `jobArtifactsFor` by hand (the
       compiler will not ask)
6. [ ] Write `_runThingCorrespondenceJob`, modelled on `_runOptimizeScanJob`
       (`main.ts:2477`) for the world-scoped, no-`scanId` shape and on
       `_runSplatDetectJob` (`:2255`) for the claim/commit rhythm; persist only through
       `updateWorld`/`commitWorldJob`
7. [ ] Wire the `_dispatchWorldJob` branch ahead of the generic placeholder path
8. [ ] Extend `worldJobTarget` with the `payload.target` fallback and enqueue with
       `{ target: shareSlug }` so dedupe engages
9. [ ] Add the viewer `<option>` and the `jobProcessingLabel` case
10. [ ] Prove idempotency: run the job twice against a seeded two-session world and diff
        the world file
11. [ ] Calibrate `THING_MATCH_RADIUS_M` and `THING_MOVED_MIN_M` on a real two-session
        corpus; record the measured numbers in Open questions
12. [ ] Update `docs/factory/atlas.html` and run `npm run verify`
