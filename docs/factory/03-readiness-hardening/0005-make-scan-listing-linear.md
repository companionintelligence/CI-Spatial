> **Type:** Backend
> **Wave:** 03-readiness-hardening
> **Branch:** `perf/linear-scan-listing`
> **Commit style:** `perf(server): summary`
> **Design:** this ticket is the spec
> **Dependencies:** `0001` (its verification runs `npm run gen:test-data`). Independent of `0004` and `0006`.

## Goal

Make `GET /scans` linear in the number of scans. It is currently **quadratic** — every
scan re-sweeps the whole sessions directory — so a library of ~2,900 files took **120
seconds**, against 18ms on an empty directory. That timeout is not theoretical: it is what
made the editor's geomap fail during the readiness review, because the viewer never
populated.

## Non-goals

- Do not add an in-process cache keyed on directory mtime. It is **incorrect** here, and
  this was tested rather than assumed — see Pinned conventions.
- Do not add a persisted index file on disk. Rejected — see Open questions.
- Do not change the `StoredScanInfo` return shape, so no call site needs editing.
- Do not change `readScanMeta`'s merge semantics. Copy them verbatim; blanking them
  silently empties `qualitySummary` across the world manifest and type-checking will not
  catch it.
- Do not extend `withWorldLock` or add locking. This path is read-only; ADR 0004's lock is
  for world-file persistence and is deliberately untouched.
- Do not use an unbounded `Promise.all` over the whole directory — file-descriptor
  exhaustion on a 2,900-file directory.

## Pinned conventions

**ADR 0001** — this touches a server route's data path, so per `CLAUDE.md` it states what
it reuses. Verified at `6217e0b`:

| Existing | Where | How used |
| --- | --- | --- |
| `StoredScanInfo` | `main.ts:1174-1179` | return shape unchanged, so **both** call sites (`main.ts:1473` `synthesizeWorld`, `main.ts:1607` `refreshWorldScans`) are untouched — `:1329` is the definition, not a caller |
| **`GET /sessions` sweep** | `main.ts:1102-1113` | **the sweep already exists here** — `readDir(SESSIONS_DIR)` → `isDirectory` guard → parse `session.json` → swallow. `loadSessionIndex` must be expressed so this route and the index share one implementation, not two. See Open questions. |
| `readScanMeta()` | `main.ts:1223-1238` | extended with a second `index` parameter; merge at `:1232-1237` copied **verbatim** |
| `isDerivedScanFile()` | `main.ts:487-489` | called; already used at `:514` and `:1333`, this adds the missing third site at `:1123` |
| `SESSIONS_DIR` | `main.ts:135` | reused as-is — no new env var |
| `withWorldLock()` | `world_lock.ts:51` | **not** extended; read path needs no lock |
| `world_lock.ts` module layout | `world_lock.ts:26-28` | the pattern for why a helper lives outside `main.ts` — importable and unit-testable without `main.ts`'s top-level `Deno.serve` |

The quadratic, precisely:

1. `listStoredScans()` (`main.ts:1329-1344`) loops every non-derived `.glb`, awaiting
   `readScanMeta(entry.name)` (`:1339`) serially.
2. `readScanMeta()` (`:1223-1238`) calls `readSessionRecordForScan(filename, meta)` (`:1230`).
3. `readSessionRecordForScan()` (`:1240-1263`) does `Deno.readDir(SESSIONS_DIR)` (`:1247`)
   and reads `session.json` for **every** session directory — for **every** scan. The
   `explicit` short-circuit at `:1249` only helps scans that carry a `sessionId`.

So the cost is O(scans × sessions), not merely "serial stats".

**Why an mtime cache is wrong** (verified empirically, do not re-propose): POSIX directory
mtime changes on entry add/remove/rename but **not** on in-place file rewrites. Rewriting
`scans/a.json` and `scans/sessions/s1/session.json` left `scans/` mtime byte-identical;
only creating/deleting a `.glb` bumped it. `POST /sessions/:id/finalize` (`main.ts:870`)
rewrites `session.json` in place, and `readScanMeta` merges that record's
`qualitySummary` / `keyframeCount` / `pointCount` / `detectionCount` / `poseCount` into
every scan. An mtime cache would serve stale quality summaries and a stale
`ScanManifest.status` (`main.ts:1323-1327`) indefinitely after any finalize.

Measured on the live directory: 162 of 282 `.glb` (57%) are derived `.opt`/`.lodN`
artifacts.

## Before implementation

1. `main.ts:1329-1344` — `listStoredScans()`.
2. `main.ts:1223-1238` — `readScanMeta()` and its merge block at `:1232-1237`.
3. `main.ts:1240-1263` — `readSessionRecordForScan()`, the sweep to remove.
4. `main.ts:1119-1153` — `/scan-locations`, which is missing the `isDerivedScanFile` filter.
5. `world_lock.ts:1-60` — the module pattern and its header comment explaining why it is
   not in `main.ts`; `world_lock.test.ts` for the Deno test style to model.
6. `deno.json` `tasks.test` — it enumerates every test file explicitly.

## Open questions & answers

- Q: Batching, mtime cache, or index file? — A: **Neither cache. Fix the algorithm**: build
  the session index once per call, then bounded-concurrency batches. The mtime cache is
  incorrect (above); a persisted index file adds a format with no reader/writer today plus
  corruption, migration and multi-process staleness, and only hides the quadratic behind a
  cold start. Once the work is linear the measured result beats the empty-directory
  baseline, so a cache buys nothing and costs an invalidation contract spanning
  `/upload-scan` (`:471`), `DELETE /scans/:filename` (`:692`), `DELETE /scans` (`:718`),
  session finalize (`:870`), and every job runner writing a `.manifest.json`. (decided
  during drafting, 2026-08-17)
- Q: Why a new `scan_index.ts` module rather than a helper inside `main.ts`? — A: So it can
  be unit-tested without importing `main.ts`'s unconditional top-level `Deno.serve`. This
  is the reason `world_lock.ts:26-28` already gives for itself; the ticket follows the
  established precedent rather than inventing one. (decided during drafting, 2026-08-17)
- Q: Should `scan_index.ts` import `asString`/`asNumber` from `main.ts`? — A: **No** —
  that reintroduces the side-effect import the module split exists to avoid. Inline the two
  three-line predicates. Do not create a shared utils module for six lines. (decided during
  drafting, 2026-08-17)
- Q: Is the `/scan-locations` filter part of this ticket or its own? — A: **This one.** It
  is the same missing-filter bug in the same listing family, one line, and its output is
  provably unchanged (derived files have no companion `.json`). (decided during drafting,
  2026-08-17)
- Q: Should a wall-clock budget be asserted? — A: **No.** Assert the **read count**, which
  is deterministic; absolute latency is flaky under `retries: 1` and a shared host. (decided
  during drafting, 2026-08-17)
- Q: `GET /sessions` (`main.ts:1102-1113`) already performs exactly the sweep
  `loadSessionIndex` would add — same `readDir`, same `isDirectory` guard, same parse, same
  swallow. Does this ticket create the codebase's third `ScanManifest`? — A: **It would, as
  originally drafted.** The first draft's justification greps (`sessionIndex|sessionsBy|byGlb|
  loadSessions|sessionMap`) could never have surfaced it, because the existing sweep is
  inline in a route handler and shares none of those names. **Resolution: `loadSessionIndex`
  must become the single implementation and `GET /sessions` must be re-expressed in terms of
  it** (it needs the records as an array; the index already holds them). Confirm before
  coding that the route's output is byte-identical afterwards — it is a public API. (found by
  the reuse audit, 2026-08-17)
- Q: Is `sessionForScan` as a pure Map lookup actually parity with today's behaviour? — A:
  **No — this was a correctness bug in the first draft.** Building the index with
  `if (!entry.isDirectory) continue` drops the direct-read fallback at `main.ts:1257-1261`.
  When `meta.sessionId` is set and the map misses, `sessionForScan` must still do **one**
  direct `readTextFile` of `${SESSIONS_DIR}/${sessionId}/session.json` — O(1) per scan, no
  blowup, and it is the path the `sessionId`-carrying scans on this tree actually exercise.
  Cover it in the test. (found by the reuse audit, 2026-08-17)
- Q: Is the proposed `api-test-homes.spec.ts` parity assertion meaningful? — A: **Not as
  first written.** `GET /scans` (`main.ts:497-540`) returns only `{filename, size, uploadedAt}`,
  so asserting merged session fields against it is vacuous. The assertion must be made against
  `GET /worlds/default`, where `scanManifestFromStored` surfaces the merged
  `qualitySummary`/`status`. (found by the reuse audit, 2026-08-17)

## Files impacted

- **New:** `scan_index.ts` — exports `loadSessionIndex(sessionsDir)` and
  `sessionForScan(index, filename, meta)`; sweeps sessions **once**, returning
  `{ byGlb: Map<string, Record<string, unknown>>, bySessionId: Map<string, Record<string, unknown>> }`.
  `sessionForScan` keeps the `main.ts:1257-1261` direct-read fallback for an explicit
  `sessionId` that the index missed.
- **Changed:** `main.ts` — `GET /sessions` (`:1102-1113`) re-expressed in terms of
  `loadSessionIndex` so the sweep exists once, not twice. Its JSON output must stay
  byte-identical.
- **New:** `scan_index.test.ts` — Deno test, modelled on `world_lock.test.ts`.
- **Changed:** `main.ts` — delete `readSessionRecordForScan` (`:1240-1263`); `readScanMeta`
  (`:1223`) gains an `index: SessionIndex` parameter and `:1230` becomes a Map lookup;
  `listStoredScans` (`:1329-1344`) collects names, calls `loadSessionIndex(SESSIONS_DIR)`
  once, then resolves stat+meta in bounded `Promise.all` batches of 64; add the import
  beside the existing `withWorldLock` import at `:48`; add `isDerivedScanFile` to
  `/scan-locations` at `:1123`.
- **Changed:** `deno.json` — append `scan_index.test.ts` to `tasks.test`, which enumerates
  files explicitly and will otherwise not run it.
- **Changed:** `tests/api-test-homes.spec.ts` — one parity test after `:107-116`.
- **Changed:** `docs/factory/atlas.html` — the "Scan storage" fcard.

## Schema required

None. `StoredScanInfo` (`main.ts:1174-1179`) is unchanged, which is what keeps all three
`listStoredScans()` call sites (`:1473`, `:1607`, and the `/scans` route) untouched.
`SessionIndex` is a module-internal type in `scan_index.ts`, not a domain type — it indexes
existing session records, it does not describe a new "place" or "thing" (ADR 0001).

## Definition of Done

- [ ] `scans/sessions/` is swept exactly **once** per `listStoredScans()` call, not once
      per scan.
- [ ] `readScanMeta`'s merge (`main.ts:1232-1237`) is byte-for-byte the same behaviour.
- [ ] `listStoredScans()` returns the same `StoredScanInfo[]`, in the same order, as before.
- [ ] `/scan-locations` filters derived files via the existing `isDerivedScanFile()`.
- [ ] `readSessionRecordForScan` is deleted (it has exactly one caller, `main.ts:1230`).
- [ ] Concurrency is bounded at 64; no unbounded `Promise.all` over the directory.
- [ ] `deno task check` and `deno task test` pass, with `scan_index.test.ts` included.
- [ ] `GET /worlds/default` output is diffed before/after on the real directory and is
      identical.

## Tests

- [ ] `scan_index.test.ts` — "builds the session index with one read per session": 50
      scans / 50 sessions, 15 carrying `sessionId`; count `Deno.readTextFile` calls via a
      shim and assert exactly 50 session reads. Current code counts 1,800.
- [ ] `scan_index.test.ts` — resolves by explicit `sessionId` (directory name) even when
      that record's `glbFilename` names a different `.glb` (pins `main.ts:1252`).
- [ ] `scan_index.test.ts` — falls back to `glbFilename` match, first in readDir order.
- [ ] `scan_index.test.ts` — returns null for an unmatched scan and for an unparseable
      `session.json` (pins the `:1253` swallow and the `:1262` null).
- [ ] `scan_index.test.ts` — merge order unchanged: a session field and a scan-meta field
      with the same key resolve to the scan-meta value; `keyframeCount` falls back
      meta → session → 0.
- [ ] `tests/api-test-homes.spec.ts` (after `:116`) — end-to-end parity: `POST /sessions`,
      finalize with a `qualitySummary` and a `glbFilename` naming an uploaded home, then
      `GET /worlds/default` and assert that scan's `qualitySummary` is present.

```
export PATH="$HOME/.deno/bin:$PATH"
deno task check
deno task test
deno test --allow-read --allow-write --allow-env scan_index.test.ts

export PATH="$HOME/.nvm/versions/node/v26.3.0/bin:$PATH"
npm run gen:test-data
SCANS_DIR=/tmp/api-scans WORLDS_DIR=/tmp/api-worlds INFERENCE_MODE=mock PORT=8123 npm run server &
API_URL=http://localhost:8123 npx playwright test --project=api api-test-homes

# before/after on the real library
time curl -s -o /dev/null localhost:8123/scans
# re-measure the derived ratio at any time
cd scans && ls -1 *.glb | grep -cE '\.(opt|lod[0-9]+)\.glb$' && ls -1 *.glb | grep -vcE '\.(opt|lod[0-9]+)\.glb$'
```

## Acceptance Criteria

- [ ] **Given** N scans and S sessions, **when** `GET /scans` is served, **then** exactly S
      `session.json` reads occur, not N×S.
- [ ] **Given** the ~2,900-file library that took 120s, **when** `GET /scans` is called,
      **then** it returns in well under a second.
- [ ] **Given** a scan whose session was finalized with a `qualitySummary`, **when**
      `GET /worlds/default` is read, **then** that summary is present — the merge did not
      regress.
- [ ] **Given** the same directory before and after, **then** `GET /scans` and
      `GET /worlds/default` produce identical output.
- [ ] **Given** `/scan-locations`, **then** it no longer attempts a metadata read for
      derived `.opt`/`.lodN` files, and its output is unchanged.

## Risks / potential issues

- **Risk:** Losing `readScanMeta`'s session merge silently blanks `qualitySummary` and
  `keyframeCount` across the world manifest — invisible to the type checker.
  — **Mitigation:** Copy `main.ts:1232-1237` verbatim; pinned by both the merge-order unit
  test and the end-to-end parity test.
- **Risk:** Collecting names before stat-ing could change tie-break order for scans sharing
  an `uploadedAt`, shifting the `index` passed to `scanManifestFromStored` and moving scans
  on the fallback grid (`main.ts:1386`). — **Mitigation:** Preserve `Deno.readDir` order in
  the names array and keep the single `localeCompare` sort (`:1342`); V8's sort is stable.
  Diff `GET /worlds/default` before and after.
- **Risk:** `scan_index.ts` importing helpers from `main.ts` would pull in its top-level
  `Deno.serve` and break the unit test — exactly what `world_lock.ts:26-28` documents.
  — **Mitigation:** Inline the two predicates.
- **Risk:** `deno.json`'s `tasks.test` enumerates files, so a new test silently never runs.
  — **Mitigation:** Appending it is a Definition-of-Done item; confirm the count rises.
- **Risk:** Someone later re-proposes the mtime cache. — **Mitigation:** The empirical
  disproof is recorded in Pinned conventions.

## Subtasks

1. [ ] Read the six locations in "Before implementation"; re-verify line numbers.
2. [ ] `grep -n readSessionRecordForScan main.ts` and `grep -n readScanMeta main.ts` to
       reconfirm each has exactly one caller.
3. [ ] Write `scan_index.ts` with inlined predicates and the two exports.
4. [ ] Write `scan_index.test.ts` with the read-count shim; confirm it counts 1,800 against
       current `main.ts` before the refactor, then 50 after.
5. [ ] Append `scan_index.test.ts` to `deno.json` `tasks.test`.
6. [ ] Refactor `readScanMeta` and `listStoredScans`; delete `readSessionRecordForScan`.
7. [ ] Add `isDerivedScanFile` to `/scan-locations` at `main.ts:1123`.
8. [ ] Add the parity test to `tests/api-test-homes.spec.ts`.
9. [ ] Diff `GET /scans` and `GET /worlds/default` before/after on the real directory.
10. [ ] Flip this ticket's atlas diff to `is-done` with the merged PR number.
