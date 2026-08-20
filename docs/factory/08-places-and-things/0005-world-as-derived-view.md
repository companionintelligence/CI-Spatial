> **Type:** Backend
> **Wave:** 08-places-and-things
> **Branch:** `fix/world-derived-view`
> **Commit style:** `fix(worlds): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0002 (`projectId` flowing capture → export → upload → `ScanManifest`).
> 0001 declares the place model and puts `projectId` on `ScanManifest`; this ticket is the
> first consumer of it. Do not start before 0002 lands — without a populated
> `ScanManifest.projectId` every scan is `null` and this change is a no-op that only adds
> the geo guard.

## Goal

Make a `WorldProject` mean *a place* instead of *the first 24 files on disk*. Membership
becomes derived from the world's Project (`scans whose projectId matches`) rather than a
global directory sweep, and a scan geo-anchored absurdly far from the world's origin stops
being silently placed at its raw ENU offset.

## The defect, precisely

Three separate functions cooperate to make every world the same global bucket. Verified by
reading `main.ts` at the current worktree HEAD.

### 1. `synthesizeWorld(slug)` ignores its own slug

`main.ts:1466-1492`. The `slug` argument reaches `worldId`, `name`, `shareSlug` and the
`frameSetUrl` builder — and nothing else. Scan selection is:

```ts
const stored = await listStoredScans()
const included = stored.filter(shouldIncludeInWorld).slice(0, 24)
const source = included.length > 0 ? included : stored.slice(0, 8)
```

`listStoredScans()` (`main.ts:1307-1338`) is a global `Deno.readDir(SCANS_DIR)` sweep of
every `.glb` on the box. So a second world created via `POST /worlds`
(`main.ts:2971-2985`) — which only ever sets `world.name` (`main.ts:2982`) — is **born
holding the same global first-24 scans as the first world.**

### 2. `refreshWorldScans` keeps pushing every new global scan into every world

`main.ts:1603-1666`, additions block at `main.ts:1652-1656`:

```ts
const existing = new Set(world.scans.map(scan => scan.filename))
const additions = stored
  .filter(shouldIncludeInWorld)
  .filter(scan => !existing.has(scan.filename))
  .slice(0, 12)
```

There is no world term in that predicate. And `refreshWorldScans` is called from
`readWorldUnlocked` (`main.ts:1560`) — so this runs on **every read** of **every world**,
and writes the file (`main.ts:1658`, `main.ts:1665`). A `GET /worlds/:slug` on world A
grows world A by up to 12 of world B's scans.

### 3. `shouldIncludeInWorld` has no notion of place

`main.ts:1340-1349`. The whole predicate:

```ts
return scan.size > 512
  || hasGeoPose(geo)
  || qualitySummaryFromMeta(scan.meta) !== null
  || asString(scan.meta['sessionId']) !== null
  || asNumber(scan.meta['pointCount']) !== null
  || asNumber(scan.meta['poseCount']) !== null
  || asNumber(scan.meta['detectionCount']) !== null
```

Size, geo-presence, quality, session, three counts. No world, no place, no proximity. Any
scan larger than 512 bytes qualifies for every world that exists.

### ADR 0003 already conceded this in writing

`docs/adr/0003-merged-job-system.md:84-96`, section *"Which world does an `optimize-scan`
`WorldJob` belong to?"*:

> "This is the one real gap the wave's tickets didn't surface: `/upload-scan`,
> `/scans/:filename/optimize`, and `/sessions/:id/finalize` … all operate on raw filenames
> in `SCANS_DIR` with **no** `WorldProject` association today — `GET /scans` … is a
> raw-filesystem listing, entirely separate from a world's own `scans[]` array."
>
> "**Decision: park `optimize-scan` `WorldJob`s under the `'default'` world**, exactly
> matching the existing precedent in `enqueueLegacyProcessJob` …"

That decision was correct for that merge and is unchanged by this ticket. It is quoted
here because it is the written record that the association this ticket adds did not exist.

### And no UI has ever picked a world

- `scanner.html` — **zero** occurrences of the string `world`. The capture surface cannot
  express which place it is scanning.
- `index.html:1521` and `index.html:1561` — both hardcode `/viewer.html?world=default`.
- `src/viewer/viewer.ts:90` — `const initialWorldSlug = query.get('world') || 'default'`.

So in practice one world exists, it is `default`, and it accumulates everything. The
global-sweep bug has been invisible because nothing has ever created a second world in
anger.

### 4. No geo guard — the separate, worse half

`inferWorldOrigin` (`main.ts:1351-1357`) takes the **first** geotagged scan in the list as
the world origin and freezes it. `scanManifestFromStored` (`main.ts:1369-1403`) then places
every scan relative to that origin with **no distance check at all**
(`main.ts:1378-1381`):

```ts
const translation = hasGeoPose(origin) && hasGeoPose(geoPose)
  ? geoToEnu(origin, geoPose)
  : { x: (index % 6) * 3, y: 0, z: Math.floor(index / 6) * 3 }
```

`geoToEnu` (`src/world/geo.ts:22-36`) is unbounded metres. A scan 500 km from the origin
lands at `x ≈ 500000` in the same ENU frame as the room next door, and the editor fits its
camera to the bounding box of both.

This is not hypothetical. `docs/UI_MANUAL.md:610-614` already files it as an **observed**
failure:

> "**Two disconnected geo clusters silently break the overview**: a world containing scans
> geo-anchored in different cities fits the camera to a mostly-empty box (this happened in
> capture — an autosaved phone scan at one location + test homes at another). Detect
> multi-cluster worlds and offer "focus largest cluster" instead of a raw fit."

## Non-goals

- **Do not** do any alignment or registration work. `align-scan` is a placeholder and stays
  one — verified: it is in ADR 0003's list of seven `WorldJobType`s with no dedicated
  `_run*Job` (`docs/adr/0003-merged-job-system.md:198-209`); its only behaviour is the
  preflight at `main.ts:2714-2716` (`'align-scan needs at least two scans …'`), the status
  flip to `'aligned'` at `main.ts:2723`, and the honest placeholder result string at
  `main.ts:2747-2748` (*"A GPU/Open3D worker can refine this…"*). `docs/UX_FLOW.md:253`
  says the same. Leave all of it exactly as it is.
- **Do not** build a merged/consolidated GLB. That is deferred to a later wave that revives
  `export-world` (wave README, "Deferred").
- **Do not** add a world-picker to the scanner. That is ticket 0003's place picker, and it
  picks a *Project*, not a world.
- **Do not** touch `synthesizeWorld`'s fallback-grid placement for no-GPS scans
  (`docs/UX_FLOW.md:251`) — the guard reuses it, it does not replace it.
- **Do not** change the `'default'`-world parking decision for `optimize-scan` jobs
  (ADR 0003:93). Job scoping is out of scope; only `scans[]` membership changes.
- **Do not** write `worlds/*.json` outside `updateWorld`/`mutateWorldFiles` (ADR 0004).

## Pinned conventions

**ADR 0001** (`docs/adr/0001-reuse-existing-domain-model.md`) — this touches schema and a
server route, so it states what it extends. Searched `main.ts`, `src/world/types.ts`,
`src/project/project-store.ts` before concluding anything is new:

| Existing | Where | How this ticket uses it |
| --- | --- | --- |
| `WorldProject` | `src/world/types.ts:191-203` | **extended** with one nullable field. No new world type. |
| `ScanManifest.projectId` | added by ticket 0001 to `src/world/types.ts:146-163` | **consumed**, not redefined. This ticket does not add it. |
| `Project` / `ProjectRecord` | `src/project/project-store.ts:33-41` (browser) and `main.ts:3247-3255` (server, `PROJECTS_FILE`, `main.ts:3257`) | **reused as the place**. No new "place" type is introduced — the wave README's ownership rule is *Project owns membership, World derives it*. |
| `/projects` CRUD | `main.ts:3285-3348` | **reused**. Do not add a parallel place API. |
| `updateWorld` / `mutateWorldFiles` | `main.ts:1588-1598`, `main.ts:1501+` | the only write paths (ADR 0004). |
| `geoToEnu` / `hasGeoPose` | `src/world/geo.ts:22-36`, `:16-20` | **reused** for the distance computation. Do not hand-roll a second haversine. |
| fallback grid `{ x: (index % 6) * 3, y: 0, z: … }` | `main.ts:1380` | **reused** as where an out-of-range scan goes. Do not invent a second placement. |
| `pruneScansMissingFromDisk` | `world_prune.ts:62` | untouched; it guards a different failure (a thinned `scans/` dir) and must keep working. |
| `world_prune.ts` as a pure, root-level, unit-testable module | `world_prune.ts` + `world_prune.test.ts` | **the pattern this ticket follows** for the new membership module — same reason `world_lock.ts` and `world_job_pump.ts` are separate files: testable without `main.ts`'s top-level side effects (ADR 0004:52-54). |

**ADR 0002** (`docs/adr/0002-shared-types-importable-by-the-browser-must-live-in-Deno-API-free-files.md`)
— `WorldProject` lives in `src/world/types.ts`, which the browser imports. The added field
is a plain nullable string; **no Deno API may be referenced from that file.** `npm run
build` (`tsc --noEmit && vite build`, `package.json`) is the real gate for that, not
`deno check`.

**ADR 0004** — every world mutation goes through `updateWorld(slug, mutate)`. Never write
`worlds/*.json` directly; never call `readWorldUnlocked`/`writeWorldUnlocked` outside the
three locked entry points. The lock is not reentrant.

**ADR 0003** — job scoping is unchanged. `optimize-scan` stays parked on `'default'`.

**No schema library.** Hand-written interfaces plus ad-hoc guards (`asString`, `asNumber`,
`hasGeoPose`) — match `main.ts:1340-1349`'s existing style exactly.

**Config.** Module scope, `Deno.env.get('X') ?? <default>`, matching
`main.ts:3257`'s `const PROJECTS_FILE = Deno.env.get('PROJECTS_FILE') ?? './projects.json'`.

**Branch/commit.** `fix/world-derived-view`; `fix(worlds): …`.

**Tests.** New Deno `*.test.ts` at the repo root. **`deno.json`'s `test` task lists its
files explicitly** — a new test file that is not added to that list is never run by
`deno task test` or by `npm run verify`. Adding it is part of this ticket.

## Before implementation

- `main.ts:1307-1403` — `listStoredScans`, `shouldIncludeInWorld`, `inferWorldOrigin`,
  `scanIdFor`, `scanManifestFromStored`. The whole synthesis path.
- `main.ts:1414-1439` — `registerSessionScan`. Session-backed scans have a synthetic
  `<sessionId>.glb` filename that never lands on disk; they must keep surviving.
- `main.ts:1459-1492` — `writeWorldUnlocked`, `synthesizeWorld`.
- `main.ts:1556-1598` — `readWorldUnlocked`, `loadWorld`, `updateWorld`. Note that
  `readWorldUnlocked` calls `refreshWorldScans`, which **writes** — a read is a write here.
- `main.ts:1603-1666` — `refreshWorldScans` in full, including the prune guard.
- `main.ts:2949-2985` — `GET /worlds` (reduced shape) and `POST /worlds`.
- `main.ts:3245-3348` — the server-side Project registry this world will point at.
- `src/project/project-store.ts:33-64` — `Project` and `ScanEntry { projectId, sessionId,
  scanFilename? }`, the browser-side membership 0002 wires up.
- `world_prune.ts` and `world_prune.test.ts` — the module/test shape to copy.
- `docs/UI_MANUAL.md:605-614` — the two observed failures this ticket half-fixes.
- `docs/factory/08-places-and-things/README.md:44-51` — the measured GPS numbers the
  threshold has to clear.
- ADR 0001, ADR 0002, ADR 0003:84-96, ADR 0004.

## Open questions & answers

- Q: Who owns scan membership — Project or World? — A: **Project owns it; `WorldProject.scans[]`
  becomes a derived view.** A scan is captured *at a place*, which is a physical fact fixed
  at capture time, so `projectId` is the durable truth. A world is a composition choice
  ("these scans, stitched, shared at this slug"). (decided by owner, 2026-08-19)
- Q: Where does the world→project link live? 0001 adds `ScanManifest.projectId`; does it
  also add `WorldProject.projectId`? — A: **No — this ticket adds it.** 0001 is scoped to
  the scan side. Coordinate at implementation time: if 0001 has already added
  `WorldProject.projectId`, this ticket consumes it rather than re-declaring it. Either way
  exactly one declaration exists, in `src/world/types.ts`. (decided by owner, 2026-08-19)
- Q: What happens to the worlds that exist today holding a global mix? — A: **Nothing is
  removed.** A one-shot backfill gives every existing world `projectId: null` and freezes
  its current `scans[]` verbatim as its membership. No existing world loses a scan on
  upgrade. See "Migration", below. (decided by owner, 2026-08-19 — migration policy is
  *real backfill on both sides, nothing silently lost*)
- Q: And scans with `projectId: null`, which 0002 says remain valid forever? — A: **A
  `projectId: null` world is the legacy bucket and keeps today's unassigned-scan
  behaviour.** `'default'` is that world. An unassigned scan still lands somewhere and is
  still visible; it just stops leaking into *project-scoped* worlds. (decided by owner,
  2026-08-19)
- Q: What is the geo-distance threshold, and is an out-of-range scan rejected or flagged? —
  A: **250 m, flagged not dropped.** See "The geo guard" for the justification and the
  exact behaviour. (decided by owner, 2026-08-19)
- Q: Does removing the global sweep also remove the 24/12 caps? — A: **No.** The ceiling
  stays at 24 for both membership modes — `docs/UI_MANUAL.md:602-603` credits progressive
  LOD with keeping *a 24-scan world* interactive, and an uncapped place with 200 scans
  would regress that. What changes is that truncation stops being silent: see
  `scanCountTotal` under "Schema required". (decided by owner, 2026-08-19)
- Q: Should the guard also fix the "focus largest cluster" half of `UI_MANUAL.md:610-614`?
  — A: **No, out of scope.** This ticket stops the absurd placement from being *created*;
  the camera-fit heuristic for worlds that already contain two clusters is a viewer change
  and belongs with the editor work. Note it in the wave README's follow-ups.

## Files impacted

New:
- `world_membership.ts` — pure, root-level module (sibling of `world_prune.ts`): the
  membership predicate and the geo-distance guard, exported as pure functions so they are
  testable without `main.ts`'s top-level side effects.
- `world_membership.test.ts` — its Deno tests.

Changed:
- `main.ts` — `shouldIncludeInWorld`, `synthesizeWorld`, `refreshWorldScans`,
  `scanManifestFromStored`, `POST /worlds`, `GET /worlds`, plus the one-shot backfill.
- `src/world/types.ts` — `WorldProject.projectId`, and the two `ScanManifest` guard fields.
- `deno.json` — add `world_membership.test.ts` to the `test` task's file list.
- `docs/factory/atlas.html` — the `WorldProject` entries at `:394` and `:534`.
- `docs/factory/08-places-and-things/README.md` — flip 0005's badge.

## Schema required

All three additions are optional/nullable so every existing `worlds/*.json` still parses.
Declared in `src/world/types.ts` (browser-importable — ADR 0002; no Deno APIs).

**`WorldProject`** (`src/world/types.ts:191-203`) gains:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `projectId` | `string \| null` | `null` | The Project (`main.ts:3247`, `src/project/project-store.ts:33`) this world is a view over. `null` = the legacy/unassigned bucket. |

**`ScanManifest`** (`src/world/types.ts:146-163`) gains, on top of 0001's `projectId`:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `geoDistanceM` | `number \| null` | `null` | Metres from `world.originGeoPose` to this scan's `geoPose`. `null` when either lacks a geo fix. Diagnostic — the editor can show it. |
| `geoOutlier` | `boolean` | `false` (omit when false) | `true` when `geoDistanceM > WORLD_SCAN_MAX_RADIUS_M`. When true, `localToWorld` is the fallback grid, not the ENU offset. |

Do **not** add a new `ScanManifestStatus` member for this. The union
(`src/world/types.ts:35`: `'ready' | 'needs-review' | 'needs-rescan' | 'processing' |
'aligned' | 'error'`) describes *reconstruction* state and is already consumed by
`applyCompletedJobToWorld` (`main.ts:2720-2739`) and `scanStatusFromQuality`
(`main.ts:1298-1302`). A geo outlier is orthogonal to all of them — a perfectly `'ready'`
scan can be an outlier.

**`GET /worlds`** (`main.ts:2961-2968`) gains one field to the reduced shape:

| Field | Type | Meaning |
| --- | --- | --- |
| `scanCountTotal` | `number` | How many scans the world's membership rule matched *before* the 24 ceiling. `scanCount` stays "how many are in `scans[]`". Equal in the common case. |

**Config**, module scope in `main.ts`, per the pinned convention:

```ts
const WORLD_SCAN_MAX_RADIUS_M = Number(Deno.env.get('WORLD_SCAN_MAX_RADIUS_M') ?? 250)
```

## The membership rule

One table. Implement it as a pure predicate in `world_membership.ts` and call it from both
`synthesizeWorld` and `refreshWorldScans` — the same predicate, not two copies (this is the
duplication that caused the bug in the first place).

| `world.projectId` | Membership | `refreshWorldScans` may add |
| --- | --- | --- |
| a project id | stored scans whose `projectId` equals it | any stored scan with that `projectId`, up to the ceiling |
| `null` (legacy, incl. `'default'`) | the world's existing `scans[]`, preserved verbatim | only stored scans whose `projectId` is `null` — i.e. exactly today's behaviour, minus the leak of assigned scans |

`shouldIncludeInWorld` (`main.ts:1340-1349`) keeps its existing seven-way "is this a real
scan at all" test **unchanged** and becomes the *first* of two gates. The new
project-matching predicate is the second. Do not fold them together — the first answers
"is this a scan", the second answers "is it this world's scan".

`registerSessionScan` (`main.ts:1414-1439`) pushes a synthetic entry directly onto
`world.scans` for a session with no uploaded `.glb`. That path is unchanged and its entries
must keep surviving `refreshWorldScans` (they already do, via the `if (!storedScan) return
scan` guard at `main.ts:1642`).

**The manual-alignment escape hatch must not regress.** `main.ts:1649`:

```ts
return { ...scan, ...next, localToWorld: scan.localToWorld, name: scan.name || next.name }
```

`refreshWorldScans` deliberately preserves a scan's `localToWorld` so a manually aligned
scan (drag the gizmo → **Save Transform** → `EditPatch`, `docs/UX_FLOW.md:252`) is not
recomputed back to its geo placement on the next read. Keep that spread exactly as it is.
The geo guard changes what `scanManifestFromStored` *computes*, never what
`refreshWorldScans` *preserves* — so a user who manually placed a far-away scan keeps their
placement, outlier flag or not.

## The geo guard

**Threshold: `WORLD_SCAN_MAX_RADIUS_M = 250` metres**, overridable by env var.

Justification, from measurements this repo already recorded rather than from a guess:

- **It must clear real GPS noise by a wide margin.** On 2026-08-19, on a Galaxy Tab S8
  Ultra sitting still on a table, the geo chip reported two different street addresses,
  with accuracy swinging between **±5 m and ±33 m** and coordinates wandering roughly
  **65 m** (`docs/factory/08-places-and-things/README.md:44-51`). 250 m is ~7.5× the worst
  accuracy figure and ~4× the observed wander, so stationary jitter can never trip it.
- **`accuracyM` cannot be leaned on to tighten it.** Verified: the upload metadata payload
  (`src/export/gltf.ts:347-372`) writes `geoLat`, `geoLng`, `geoBearing`, `geoAddress`,
  `geoDisplayAddress`, `geoFixedAt` — and **not** `geoAccuracy` or `geoAltitudeM`, both of
  which `geoPoseFromMeta` reads (`main.ts:1211`, `main.ts:1213`). So `accuracyM` is `null`
  for uploaded scans today. A fixed threshold is the only honest option; an
  accuracy-scaled one would silently degrade to a constant anyway.
- **It must comfortably contain a real place.** A 250 m radius is a 500 m disc, ~20
  hectares. That holds any house and garden, any apartment block, and most commercial
  buildings and campuses — the things a Project represents.
- **It is orders of magnitude below the failure it stops.** The observed incident was scans
  in *different cities* (`docs/UI_MANUAL.md:610-614`) — kilometres to hundreds of
  kilometres. There is no plausible value between 65 m of jitter and inter-city distance
  that this threshold could get wrong.

**Behaviour when exceeded — flag, never drop.** In `scanManifestFromStored`
(`main.ts:1378-1381`), compute `geoDistanceM` first; if it exceeds the threshold, take the
**existing fallback-grid branch** (`{ x: (index % 6) * 3, y: 0, z: Math.floor(index / 6) *
3 }`) instead of `geoToEnu`, and set `geoOutlier: true`. This reuses the placement that
no-GPS and video-ingest scans already get (`docs/UX_FLOW.md:251`), so the scan stays
visible, loadable, selectable, and manually alignable. Dropping it would be exactly the
silent data loss the migration policy forbids.

Log it once per scan, in the style of `main.ts:1626`/`main.ts:1634`:

```
[worlds] scan <filename> is <n> m from world origin (> 250 m) — placed on the fallback grid
```

## Definition of Done

- [ ] `WorldProject.projectId: string | null` declared once in `src/world/types.ts`
- [ ] `world_membership.ts` exists as a pure module and holds the single membership
      predicate + the geo guard; `main.ts` has no second copy of either
- [ ] `synthesizeWorld` no longer calls `listStoredScans().filter(shouldIncludeInWorld)
      .slice(0, 24)` unconditionally — selection is project-scoped
- [ ] `refreshWorldScans`'s additions block is project-scoped
- [ ] Two worlds over two different projects have disjoint `scans[]`
- [ ] A scan farther than `WORLD_SCAN_MAX_RADIUS_M` from the origin is placed on the
      fallback grid with `geoOutlier: true`, not at its raw ENU offset — and is still present
- [ ] `main.ts:1649`'s `localToWorld: scan.localToWorld` preservation is byte-identical
- [ ] Every world file on disk before the upgrade still parses and still holds every scan
      it held, with `projectId: null`
- [ ] `align-scan` is untouched — still a placeholder
- [ ] `GET /worlds` reports `scanCountTotal` alongside `scanCount`
- [ ] `world_membership.test.ts` is added to `deno.json`'s `test` task file list
- [ ] `deno task check`, `deno task test`, `npm run build` and `npm run verify` pass
- [ ] `atlas.html:394` and `atlas.html:534` describe what shipped; the wave README's 0005
      badge is flipped

## Tests

New `world_membership.test.ts` (Deno, repo root, added to `deno.json`'s `test` task):

- [ ] Two projects yield two worlds with **disjoint** scan lists — the direct regression on
      `synthesizeWorld`'s global sweep
- [ ] A world with `projectId: null` matches only scans whose `projectId` is `null`, and an
      assigned scan does not leak into it
- [ ] A `projectId: null` scan still lands in the legacy world — nothing is orphaned
- [ ] A scan at 100 m from origin is geo-placed (`geoOutlier` falsy, `localToWorld` from
      `geoToEnu`)
- [ ] A scan at 500 km from origin is **not** geo-placed: `geoOutlier: true`, translation is
      the fallback grid, and the scan is still in `scans[]`
- [ ] A scan at exactly `WORLD_SCAN_MAX_RADIUS_M` is placed (boundary is inclusive)
- [ ] Two scans with no geo fix at all still get distinct fallback-grid slots (no regression
      on the `index % 6` placement)
- [ ] A manually set `localToWorld` survives a `refreshWorldScans` cycle, for both an
      in-range and an out-of-range scan
- [ ] The membership ceiling of 24 truncates deterministically and `scanCountTotal` reports
      the untruncated count

Extend the existing Playwright API coverage rather than adding a parallel spec — `tests/`
already has `api-optimize-scan-worldjob.spec.ts` and `server.spec.ts` hitting these routes:

- [ ] `POST /worlds` with a `projectId`, then `GET /worlds/:slug`, returns only that
      project's scans
- [ ] `GET /worlds` reports `scanCount` and `scanCountTotal`

```
deno task check
deno task test
npm run build
npm run verify
npm run test:api
```

## Acceptance Criteria

- [ ] Given two Projects each with three uploaded scans, When a world is created for each,
      Then each world's `scans[]` contains exactly its own three — not six
- [ ] Given world A is read repeatedly while scans are uploaded to project B, Then world A's
      scan count does not grow
- [ ] Given a scan geotagged 500 km from a world's origin, When the world is read, Then that
      scan is present, is on the fallback grid, carries `geoOutlier: true`, and the editor's
      camera fit is not blown out to a 500 km box
- [ ] Given a scan the user manually aligned with the gizmo, When the world is read again,
      Then its transform is unchanged
- [ ] Given a scan with `projectId: null`, When the default world is read, Then the scan is
      there — exactly as it is today
- [ ] Given every `worlds/*.json` that existed before the upgrade, When the server boots,
      Then each holds every scan it held before, plus `projectId: null`
- [ ] Given a queued `align-scan` job, Then it behaves exactly as it does today

## Risks / potential issues

- **Risk (loudest one): this changes what every existing world contains.** `world.scans[]`
  is what the editor renders, what `scanForJob` (`main.ts:2698-2701`) resolves against, and
  what `jobFailureReason`'s `world.scans.length < 2` check (`main.ts:2714`) reads. Get the
  membership rule wrong and a world silently empties. — **Mitigation:** the backfill freezes
  every existing world's `scans[]` verbatim with `projectId: null`; nothing is recomputed on
  upgrade. Membership derivation only governs *additions* for legacy worlds and *everything*
  for worlds explicitly created against a project. Pin this with the "existing world still
  holds every scan" test before touching `synthesizeWorld`.
- **Risk: `GET /worlds`'s reduced shape (`main.ts:2961-2968`) changes values.** `scanCount`
  will drop for anyone who had created a second world, because that world was double-counting
  the first world's scans. Consumers: the editor's world list and `tests/server.spec.ts`. —
  **Mitigation:** the value change is the fix, not a regression; `scanCountTotal` makes the
  ceiling visible. Update the assertions and say so in the commit message.
- **Risk: a read is a write.** `readWorldUnlocked` (`main.ts:1560`) calls
  `refreshWorldScans`, which calls `writeWorldUnlocked`. Any bug in the new predicate is
  persisted on the first `GET`, not just displayed. — **Mitigation:** never remove a scan in
  `refreshWorldScans` — the additions block is the only place membership is applied there.
  Removal, if ever wanted, is a separate explicit action. `pruneScansMissingFromDisk`
  (`world_prune.ts:62`) stays the only pruner.
- **Risk: the backfill is a `mutateWorldFiles` sweep over every world.** ADR 0004 warns that
  long work inside a lock serializes the server. — **Mitigation:** the mutator is
  field-assignment only, no I/O, and `mutateWorldFiles` already takes one lock per file
  (`main.ts:1501` docblock).
- **Risk: 0002 not fully landed means every `projectId` is `null`.** Then every world is the
  legacy bucket and this ticket's visible effect is only the geo guard. — **Mitigation:**
  that is a safe degradation, not a failure — but do not merge this claiming the membership
  fix works until 0002's `projectId` is verified flowing into `ScanManifest`.
- **Risk: `accuracyM` is `null` for uploaded scans** (`src/export/gltf.ts:347-372` omits
  `geoAccuracy`), so the guard cannot adapt to a genuinely poor fix. — **Mitigation:** the
  fixed 250 m threshold is set far above the worst measured accuracy for exactly this reason.
  Worth a follow-up ticket to add `geoAccuracy`/`geoAltitudeM` to the upload metadata; note
  it in the wave README rather than doing it here.
- **Risk: the 24 ceiling now bites a real place.** A house scanned across 40 sessions
  truncates. — **Mitigation:** `scanCountTotal` makes it visible rather than silent; raising
  the ceiling is a viewer-performance decision, not this ticket's.
- **Risk: `safeSlug`-derived world ids and project ids are different namespaces** —
  `worldId` is `world-${safeSlug(slug)}` (`main.ts:1473`), `projectId` is `proj-${Date.now()}`
  (`main.ts:3302`). Do not conflate them or derive one from the other.

## Subtasks

1. [ ] Confirm 0002 has landed and `ScanManifest.projectId` is populated on real uploads
2. [ ] Coordinate with 0001 on where `WorldProject.projectId` is declared; declare it in
       `src/world/types.ts` if 0001 has not
3. [ ] Add `geoDistanceM` / `geoOutlier` to `ScanManifest`
4. [ ] Write `world_membership.ts`: the membership predicate and the geo guard, pure, no
       `main.ts` imports
5. [ ] Write `world_membership.test.ts` and add it to `deno.json`'s `test` task list
6. [ ] Wire the geo guard into `scanManifestFromStored` (`main.ts:1378-1381`), reusing the
       existing fallback-grid branch
7. [ ] Wire the membership predicate into `synthesizeWorld` (`main.ts:1466-1492`)
8. [ ] Wire it into `refreshWorldScans`'s additions block (`main.ts:1652-1656`), leaving
       `main.ts:1649`'s `localToWorld` preservation untouched
9. [ ] Accept and store `projectId` in `POST /worlds` (`main.ts:2971-2985`)
10. [ ] Add `scanCountTotal` to `GET /worlds` (`main.ts:2961-2968`)
11. [ ] Write the one-shot backfill over `WORLDS_DIR` via `mutateWorldFiles`: set
        `projectId: null`, change nothing else
12. [ ] Run `deno task check`, `deno task test`, `npm run build`, `npm run verify`
13. [ ] Verify by hand: create two worlds against two projects, confirm disjoint scan lists
14. [ ] Verify by hand: a far-away geotagged scan no longer blows out the editor camera fit
15. [ ] Update `atlas.html:394` and `:534`; flip the 0005 badge in the wave README
