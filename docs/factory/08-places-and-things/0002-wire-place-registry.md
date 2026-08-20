> **Type:** Backend + Frontend
> **Wave:** 08-places-and-things
> **Branch:** `feat/place-registry-wiring`
> **Commit style:** `feat(places): summary`
> **Design:** this ticket is the spec
> **Dependencies:** `08-places-and-things/0001-unify-place-model-types.md` (types moved into
> `src/world/types.ts`, `ScanManifest.projectId` exists). Transitively, wave
> `07-scan-identity` complete.

## Goal

Make Project a real, carried identity end to end — capture → export → upload → manifest —
with **no UI**. After this ticket a scan's `projectId` reaches
`ScanManifest.projectId` in `worlds/<slug>.json` and the GLB's own scene `extras`, and
`ProjectStore` stops being dead code.

## What is dead today (verified — see 0001 for the full audit)

- `src/main.ts:163-164` (`new ProjectStore()`, `await projectStore.open()`) are the only two
  references to `projectStore` in `src/`. No `createProject`, `addScan`, or `listScans` is
  ever called.
- `ExportData.scanEntry` (`src/export/gltf.ts:75`) is never supplied. Both call sites pass
  only `{ store, pointCloud, poseHistory, geoFix, qualitySummary }`:
  - `src/main.ts:468-471` — manual export (`download: true, upload: true, filenamePrefix: 'room-scan'`)
  - `src/main.ts:529-532` — autosave (`download: false, upload: true, filenamePrefix: 'autosave-room-scan'`)
- So `projectId: scanEntry?.projectId ?? null` (`gltf.ts:138`) is permanently `null`,
  `floorName` (`gltf.ts:126`) permanently `'Floor_Ground'`, `roomName` (`gltf.ts:127`)
  permanently `'Room_Unknown'`.
- The upload metadata sidecar (`gltf.ts:347-372`) has no `projectId` key. It is written to
  `<glb>.json` by `main.ts:469-475` inside the `/upload-scan` handler.
- `scanManifestFromStored` (`main.ts:1369-1403`) reads ~10 fields out of that sidecar and
  none of them is `projectId`.

## The fix

Five connected pieces. Each is small; the ordering matters because the last one is the only
one that is observable.

### 1. Make `projectStore` actually used

`src/main.ts` gains a small place-registry helper — create a place, list places, get one,
and assign the current session's scan to one. It talks to the server routes
(`GET/POST /projects`, `GET/PUT/DELETE /projects/:id`, `main.ts:3285-3348`) and mirrors into
`ProjectStore` for offline. **No DOM, no buttons, no panel** — the surface is a module-level
function set plus a `?project=<projectId>` query-parameter override on the scanner URL for
on-device testing (`npm run qr -- "/scanner.html?world=default&project=proj-…"`).

The "current place" for a capture session is resolved once, at scanner boot, in this order:

1. `?project=<projectId>` in the scanner URL, if it names a place the server knows.
2. The last place used on this device (a single scalar in `localStorage`).
3. The default place — see piece 5.

It is resolved **once per session** and does not change mid-walkthrough:
`projectId` is fixed at capture time (owner decision, below).

### 2. Build the `ScanEntry` `exportToGLB` already accepts

`ExportData.scanEntry` (`gltf.ts:75`) is an existing, declared, unused parameter. Populate
it — do not add a new parameter next to it. Construct one `ScanEntry` per capture session
from the resolved place plus `store.sessionId`, and pass it from **both** call sites
(`src/main.ts:468-471` and `:529-532`). The autosave path runs repeatedly within one session
and must reuse the same `ScanEntry`, not mint a new one per autosave.

Effect, all of it already-written code that starts working: `gltf.ts:126-128` produce real
`floorName` / `roomName` / `scanName`, `gltf.ts:138` writes a real `projectId` into the GLB
scene extras, and the Floor/Room group hierarchy documented at `gltf.ts:6-16` stops being a
fixed stub.

### 3. Add `projectId` to the upload metadata sidecar

`uploadToServer` (`gltf.ts:339-372`) currently destructures
`const { store, pointCloud, poseHistory, geoFix, qualitySummary } = data` at `:345` — it
does not pull `scanEntry` out of the same `ExportData`. Add it, and add three flat keys to
the metadata object alongside the existing flat geo block (`gltf.ts:365-371`), which is the
established precedent for "written flat so the server can index it":

```
projectId, floorId, roomId
```

Flat, not nested, matching `geoLat`/`geoLng`/`geoBearing`/`geoAddress`. This lands in
`<glb>.json` unchanged via `main.ts:469-475`.

### 4. Read it server-side into `ScanManifest.projectId`

`scanManifestFromStored` (`main.ts:1369-1403`) builds every `ScanManifest`. Set
`projectId: asString(scan.meta['projectId'])` — `asString` (`main.ts:1199`) already returns
`string | null` for a missing or non-string value, which is exactly the required semantics.
Follow `geoPoseFromMeta` (`main.ts:1207-1218`) as the sibling pattern: a small pure function
over `Record<string, unknown>` using the `asString`/`asNumber` guards, no schema library.

**The non-obvious part — `refreshWorldScans` (`main.ts:1603-1650`).** It re-derives every
scan from disk on every `GET /worlds/:slug`:

```ts
const next = scanManifestFromStored(storedScan, world.originGeoPose, index, world.shareSlug)
changed = changed
  || scan.status !== next.status
  || scan.frameSetUrl !== next.frameSetUrl
  || JSON.stringify(scan.qualitySummary ?? null) !== JSON.stringify(next.qualitySummary ?? null)
  || JSON.stringify(scan.layerIndex) !== JSON.stringify(next.layerIndex)
return { ...scan, ...next, localToWorld: scan.localToWorld, name: scan.name || next.name }
```

Two consequences that must be handled deliberately:

- `{ ...scan, ...next }` means `next` **wins**. Whatever `scanManifestFromStored` derives
  from the sidecar overwrites whatever is in `worlds/<slug>.json`. So the `<glb>.json`
  sidecar — not the world file — is the durable server-side record of a scan's
  `projectId`. Any later re-assignment must rewrite the sidecar. Only `localToWorld` and a
  non-empty `name` are explicitly preserved from the world file.
- `changed` does **not** currently compare `projectId`. Add `|| scan.projectId !== next.projectId`
  or a `projectId` change will be computed and then not persisted, resurfacing on the next
  reload. This is the single easiest thing to get wrong in this ticket.

`registerSessionScan` (`main.ts:1414-1439`) builds a synthetic `StoredScanInfo` for the
video/photo-ingest path; add `projectId` to its `meta` object so ingested sessions can carry
a place too.

### 5. A default place, so no scan is orphaned before 0003's picker

Introduce exactly one default place, created lazily on first use, server-side, through the
existing `mutateProjects()` chain (`main.ts:3272-3283`). Pinned identity:
`projectId: 'proj-default'`, `name: 'Unassigned'`, one `Ground Floor` floor with no rooms —
the same floor shape `POST /projects` already creates at `main.ts:3308`. A fixed id, not
`proj-${Date.now()}`, so it is idempotent across restarts and recognisable in a manifest.

**This does not backfill anything.** The 4 scans currently on disk
(`scans/1787174311700_…`, `1787174371857_…`, `1787174954604_…`, `1787175480232_…`) keep
`projectId: null`. `null` means *unassigned place* and stays valid indefinitely (0001).
Assigning them to `'proj-default'` would be a guess dressed as data, and it would make
"never had a place" indistinguishable from "explicitly filed as unassigned". New captures
get `'proj-default'` because the scanner resolves a place at boot; old files get `null`
because nobody ever told us where they were.

## Non-goals

- **No place-picker UI.** That is ticket 0003. No dropdown, no modal, no chip. The
  `?project=` query parameter and the localStorage recall are plumbing for on-device
  testing, not a user-facing feature — do not style them, do not surface them in the
  scanner panel.
- **No place-management UI** — no rename, delete, merge, or floor/room editing. That is
  ticket 0004, and it owns that whole surface.
- **No change to how worlds select scans.** `WorldProject.scans[]` (`src/world/types.ts:197`)
  keeps its current membership semantics. Making it a derived view over a Project's scans is
  ticket 0005.
- **No geo clustering, ever, in this ticket.** Assignment is explicit. Geo may only *suggest*
  — and this ticket adds no suggestion either. See the empirical GPS note in Open questions.
- **Do not backfill the 4 existing scans.**
- **Do not add a second projects-file env var.** `PROJECTS_FILE` already exists at
  `main.ts:3257`.
- **Do not rename the IndexedDB database `'ci-xr-projects'`** or bump its `DB_VERSION`
  (`src/project/project-store.ts:68-69`). This ticket is the first thing that ever writes
  real data to it — see Risks.
- **Do not change the `proj-${Date.now()}` id generator** for user-created places in this
  ticket. `'proj-default'` is a fixed literal and sidesteps it; changing the generator is a
  compat decision over 95 existing records and needs its own ticket.
- **Do not add a schema/validation library.** `asString`/`asNumber` guards only.
- **Do not write `worlds/*.json` outside `updateWorld()`** (ADR 0004).

## Pinned conventions

**ADR 0001 — what this reuses.** This ticket touches schema *and* a client↔server
connection, so it states its reuse explicitly:

| Existing | Where | How this extends it |
| --- | --- | --- |
| `Project`, `Floor`, `Room`, `ScanEntry` | `src/world/types.ts` (moved there by 0001) | Populated, not redefined. No new place type. |
| `ScanManifest.projectId` | `src/world/types.ts:146-163` (added by 0001) | Populated from the sidecar instead of hardcoded `null`. |
| `ExportData.scanEntry` | `src/export/gltf.ts:75` | The existing optional param is finally supplied. **No new parameter.** |
| `GET/POST /projects`, `GET/PUT/DELETE /projects/:id` | `main.ts:3285-3348` | Reused as-is. No new place route. |
| `PROJECTS_FILE` | `main.ts:3257`, `Deno.env.get('PROJECTS_FILE') ?? './projects.json'` | Reused. No new env var. |
| `mutateProjects()` | `main.ts:3272-3283` | The default-place creation goes through this existing serialized chain. |
| the flat geo keys in the sidecar | `src/export/gltf.ts:365-371` | `projectId`/`floorId`/`roomId` are added flat, same rationale ("so the server can index them"). |
| `asString` / `asNumber` | `main.ts:1199` / `main.ts:1195` | Used for the new meta read, matching `geoPoseFromMeta` (`main.ts:1207-1218`). |
| `ProjectStore` | `src/project/project-store.ts:75` | Its existing methods are called. No new client store, no new object store, no new index. |

Nothing new is invented except the `'proj-default'` literal and the three sidecar keys.

**ADR 0002** — `ScanEntry` and friends are imported by both runtimes from
`src/world/types.ts` after 0001. Nothing in this ticket may declare a browser-importable
type outside that file (or `src/world/manifests.ts` / `src/shared/*.ts`). **`npm run build`
(`tsc --noEmit && vite build`) is the real gate**; `deno check` does not exercise the
frontend program. `npm run verify` runs `tsc --noEmit` but **not** `vite build`.

**ADR 0004** — every world-file read-modify-write goes through `updateWorld()`
(`main.ts:1588`) or `mutateWorldFiles()` (`main.ts:1501`). Never
`readWorldUnlocked`/`writeWorldUnlocked`. The lock is not reentrant: a mutator already holds
the live `world` object and must not call `loadWorld`/`updateWorld` for its own slug.

**Other pinned values:**

- Branch `type/short-scope`; commit `type(scope): summary`.
- Hono handlers in `main.ts`. CORS via the existing `isAllowedOrigin()`.
- Config via `Deno.env.get('X') ?? <default>` at module scope.
- House ID generator is `crypto.randomUUID()` (`main.ts:1444-1446`, `main.ts:3267`) — for
  anything genuinely new. `'proj-default'` is deliberately fixed, not generated.
- Deno tests are `*.test.ts` at the repo root, run by `deno task test`. **That task in
  `deno.json` names every test file explicitly** — a new test file that is not added to
  that list silently never runs. Playwright specs live in `tests/`.
- Full gate: `npm run verify`.

## Before implementation

- `docs/factory/08-places-and-things/0001-unify-place-model-types.md` — the full audit this
  ticket builds on. Do not re-derive it.
- `docs/adr/0001-reuse-existing-domain-model.md`, `docs/adr/0002-…`, `docs/adr/0004-…`.
- `docs/adr/0003-merged-job-system.md` § "Which world does an `optimize-scan` `WorldJob`
  belong to?" (~`:83-96`) — the documented statement that `/upload-scan`,
  `/scans/:filename/optimize`, and `/sessions/:id/finalize` "all operate on raw filenames in
  `SCANS_DIR` with **no** `WorldProject` association today", and the decision to park
  everything under the `'default'` world. This ticket is the first thing that gives an
  upload a place. Read it before changing the upload contract.
- `src/export/gltf.ts:19-27`, `:71-78`, `:113-155`, `:334-397` — imports, `ExportData`,
  `exportToGLB`'s `scene.userData`, and `uploadToServer` in full.
- `src/main.ts:150-180` (the boot block containing `projectStore`), `:454-504`
  (`exportManualScan`), `:506-542` (`queueAutoSave` / `runAutoSave`).
- `src/project/project-store.ts` in full — especially `createProject` (`:99-117`),
  `addScan` (`:164-171`), `listScans` (`:181-189`), `getScanBySession` (`:191-199`).
- `main.ts:432-486` — the `/upload-scan` handler end to end, including the exclusive-create
  filename claim (`:460`) and the sidecar write (`:469-475`).
- `main.ts:1195-1238` — the `as*` guards, `geoPoseFromMeta`, `readScanMeta`. Note
  `readScanMeta` (`:1230-1237`) merges the session record *under* the sidecar meta
  (`{ ...session, ...meta }`), so a sidecar key wins over a session key of the same name.
- `main.ts:1359-1403` — `scanIdFor`, `scanNameFor`, `scanManifestFromStored`.
- `main.ts:1414-1439` — `registerSessionScan`.
- `main.ts:1600-1660` — `refreshWorldScans`, especially the `changed` comparison at
  `:1644-1648` and the merge at `:1649`.
- `main.ts:3245-3348` — `ProjectRecord`, `PROJECTS_FILE`, `mutateProjects`, all five routes.
- `projects.json` — 95 fixture records you must not break.

## Open questions & answers

- Q: Three-level identity? — A: **Project (place) → Session (one walkthrough) → Scan (one
  uploaded GLB), plus Thing.** (Decided by owner, 2026-08-19.)
- Q: Who owns scan membership? — A: **The Project.** `WorldProject.scans[]` becomes a
  derived view over a Project's scans, not an independent list. `projectId` is **fixed at
  capture time**. That derivation is ticket 0005; this ticket only guarantees the
  `projectId` is present and truthful so 0005 has something to derive from. It is also why
  the place is resolved once at scanner boot and not re-read per autosave. (Decided by
  owner, 2026-08-19.)
- Q: Can a scan be auto-assigned to a place from its GPS fix? — A: **No. Geo suggests, the
  user confirms — and this ticket does neither.** Empirical justification: on a *stationary*
  Galaxy Tab S8 Ultra the geo chip reported two different street addresses — "30902 Club
  House Drive" and "30856/30862 Calle Moraga", Laguna Niguel CA — with accuracy swinging
  from ±5 m to ±33 m and coordinates varying by ~65 m in one sitting. Coordinate clustering
  **will** misgroup indoor scans, and it will do so silently and confidently. Assignment is
  explicit, always. (Decided by owner, 2026-08-19.)
- Q: **Which store is authoritative for places — the client IndexedDB `'ci-xr-projects'` or
  the server's `/projects` + `PROJECTS_FILE`?** — A: **The server is authoritative; the
  client IndexedDB is an offline mirror.** Recorded here because "two stores of record" is
  the actual hazard in this ticket. Justification:
  1. It matches how scans already work. The server owns `SCANS_DIR` and
     `worlds/<slug>.json`; the client's `'ci-xr-scan'` IndexedDB
     (`src/scene/store.ts`) is a capture-side buffer that gets uploaded. Places should not
     invert that relationship.
  2. `ScanManifest.projectId` lives in a server-owned file. If the client were authoritative
     the server would be storing foreign keys into a database it cannot read.
  3. Multiple devices scan the same building. A client-authoritative place list makes two
     phones produce two disjoint place sets for one house, and nothing could ever reconcile
     them — precisely the multi-store failure ADR 0001 exists to prevent.
  4. The offline queue already assumes the server is the destination
     (`src/shared/offline-queue.ts`, `isQueuedOffline` at `gltf.ts:383`).

  **Pinned rules:** writes go to the server first and are mirrored into IndexedDB on
  success. Reads prefer the server and fall back to the mirror when offline. A place created
  while offline is a **local draft** — it is written to IndexedDB with a client-minted id and
  pushed on reconnect, and until then a scan captured against it carries that id, which the
  server will not recognise. That last case is a real hole; see Risks. Nothing in this ticket
  performs a merge or conflict resolution — if the two diverge, the server wins on next read.
  (Decided by owner + verified against the codebase, 2026-08-19.)
- Q: Does a scan uploaded without `projectId` still succeed? — A: **Yes, and it must.**
  `asString(meta['projectId'])` returns `null` for a missing key. `/upload-scan` gains no
  required field. See the compatibility story in Risks.
- Q: Should the 4 existing scans be backfilled to `'proj-default'`? — A: **No.** `null` and
  `'proj-default'` mean different things: "we never knew" versus "explicitly filed as
  unassigned". Backfilling destroys that distinction on the only four real captures on disk.
- Q: Why `'proj-default'` rather than `proj-${Date.now()}`? — A: Idempotence. A fixed id
  means the lazy-create is safe to run on every boot, survives restarts, and is greppable in
  a manifest. It also avoids the millisecond-collision hazard in the existing generator —
  `projects.json` already holds `proj-1781069353719` and `proj-1781069353723`, 4 ms apart.
- Q: Does `ScanEntry.scanId` conflict with `ScanManifest.scanId`? — A: They are the same
  concept and must agree. Wave 07 establishes a unique `scanId` per upload; use it.
  `scanIdFor` (`main.ts:1359-1363`) currently derives `scan-<sessionId>` server-side.
  **Confirm against wave 07's landed shape before implementing** — if 07 changed
  `scanIdFor`, this ticket follows it rather than minting a third scheme.
- Q: Should `floorId`/`roomId` be carried too, or only `projectId`? — A: **All three.**
  `ScanEntry` already has all three (`project-store.ts:57-58`), `gltf.ts:126-127` already
  reads `floorId`/`roomId`, and sending only `projectId` would leave the Floor/Room groups
  as the same stub they are today. `floorId` defaults to the place's single Ground Floor;
  `roomId` stays `undefined` until 0004 lets anyone create a room.
- Q: Is `docs/factory/07-scan-identity/` populated? — A: **No — empty as of drafting.** Do
  not begin until 07 exists and has landed.

## Files impacted

**Changed:**

- `src/main.ts` — resolve a place at boot near `:163-164`; build one `ScanEntry` per
  session; pass it at `:468-471` and `:529-532`.
- `src/export/gltf.ts` — destructure `scanEntry` in `uploadToServer` (`:345`); add
  `projectId`/`floorId`/`roomId` to the metadata object (`:347-372`). `exportToGLB` itself
  (`:113-155`) needs **no** change — it already handles `scanEntry`.
- `src/project/project-store.ts` — no schema change; may gain a small
  `ensureDefaultProject`-style helper only if it cannot live in `src/main.ts`. Prefer not to
  touch this file.
- `main.ts` — `projectId` in `scanManifestFromStored` (`:1369-1403`); the `changed`
  comparison in `refreshWorldScans` (`:1644-1648`); `projectId` in `registerSessionScan`'s
  synthetic meta (`:1429-1434`); lazy default-place creation via `mutateProjects`
  (`:3272-3283`).
- `docs/factory/atlas.html` — see below.

**New:**

- `place_registry.test.ts` (repo root) — Deno test. **Must be added to `deno.json`'s
  `tasks.test` file list**, which is explicit.

**Not changed:** no new route, no new env var, no new IndexedDB store or index, no new
`WorldJobType`, no change to `/upload-scan`'s required fields.

### Atlas diff (required)

- The "World / scan data model" fcard (`atlas.html:394`) — flip 0001's `changing` badge to
  done and state that `projectId` is now *carried*, not just *declared*.
- The data-model table row for `ScanManifest (world)` (`atlas.html:535`) — `projectId` moves
  from "declared, always null" to populated.
- Add or update the capture→upload path entry to say that an upload now carries a place. The
  ADR 0003 "no `WorldProject` association" sentence is the one this change makes partially
  false — a scan still has no *world*, but it now has a *place*. Fix that sentence precisely;
  do not overstate it. **Point at the ticket; never restate its content.**

## Schema required

### `ScanManifest.projectId` — populated (field added by 0001)

```ts
projectId: string | null   // asString(meta['projectId']) — null = unassigned place
```

Still required-and-nullable. Still permanently valid as `null`. No referential integrity is
enforced: a `projectId` naming a deleted place must render as unassigned, never throw.

### Upload metadata sidecar (`<glb>.json`) — three new keys

Written by `uploadToServer` (`src/export/gltf.ts:347-372`), persisted verbatim by
`main.ts:469-475`, read by `scanManifestFromStored`.

| Key | Type | Default when absent | Read as |
| --- | --- | --- | --- |
| `projectId` | `string \| null` | absent → `null` | `asString(meta['projectId'])` |
| `floorId` | `string \| null` | absent → `null` | `asString(meta['floorId'])` |
| `roomId` | `string \| null` | absent → `null` | `asString(meta['roomId'])` |

Flat, top-level, alongside `geoLat`/`geoLng`/`geoBearing`/`geoAddress`. **Additive only** —
no existing key changes type, is renamed, or is removed. An older client that sends none of
them produces exactly today's sidecar and must keep working.

Note `readScanMeta` (`main.ts:1220-1238`) spreads `{ ...session, ...meta }`, so a sidecar
`projectId` wins over a session record's. That is the intended precedence.

### `ProjectRecord` server-side

Unchanged in shape from 0001 (`floors: Floor[]`). This ticket adds only the lazily-created
default record:

```json
{
  "projectId": "proj-default",
  "name": "Unassigned",
  "createdAt": <epoch ms>,
  "updatedAt": <epoch ms>,
  "floors": [{ "floorId": "floor-default", "name": "Ground Floor", "level": 0, "rooms": [] }]
}
```

Created through `mutateProjects()` only, and only if no record with `projectId === 'proj-default'`
already exists. `address` and `notes` are omitted (both optional).

### Client IndexedDB `'ci-xr-projects'`

**No schema change.** Same `DB_NAME`, same `DB_VERSION` (1), same `projects` / `scans`
object stores, same `byProject` / `bySession` indexes. This ticket is the first code to
write real records into it.

## Definition of Done

- [ ] A place is resolved once at scanner boot (`?project=` → localStorage → `'proj-default'`)
      and does not change during a session
- [ ] `projectStore` is genuinely used: create, list, get, and assign all have live call
      sites; `src/main.ts:163-164` are no longer the only references
- [ ] One `ScanEntry` per capture session, reused across autosaves, passed at **both**
      `src/main.ts:468-471` and `:529-532`
- [ ] `gltf.ts:138` writes a real `projectId` into the GLB scene extras; `gltf.ts:126-127`
      produce real `floorName`/`roomName` for an assigned scan
- [ ] The `<glb>.json` sidecar carries `projectId`, `floorId`, `roomId`
- [ ] `scanManifestFromStored` sets `projectId` from the sidecar via `asString`
- [ ] `refreshWorldScans`'s `changed` comparison includes `projectId`, so an assignment
      persists across a world reload
- [ ] `registerSessionScan`'s synthetic meta carries `projectId`
- [ ] The `'proj-default'` place is created lazily through `mutateProjects()` and is
      idempotent across restarts
- [ ] The 4 pre-existing scans still read `projectId: null` — not backfilled
- [ ] An upload with no `projectId` still returns 200 and yields `projectId: null`
- [ ] The server-authoritative decision is implemented as written: server write first,
      IndexedDB mirror on success, server wins on read
- [ ] No UI. No picker, no management surface, no new panel control
- [ ] Atlas updated and badged

## Tests

- [ ] **Deno:** an upload whose sidecar carries `projectId: 'proj-x'` produces
      `ScanManifest.projectId === 'proj-x'`
- [ ] **Deno:** an upload with **no** `projectId` key succeeds and produces
      `ScanManifest.projectId === null` — the backward-compat case for the 4 existing scans
      and for any client that predates this change
- [ ] **Deno:** a sidecar with `projectId: 42` (wrong type) or `projectId: ""` yields `null`,
      not a throw — `asString` semantics
- [ ] **Deno round-trip:** capture → export → upload → manifest. Build the sidecar the way
      `uploadToServer` does, POST it to `/upload-scan`, read the resulting
      `worlds/default.json`, and assert `projectId`, `floorId`, `roomId` survived
- [ ] **Deno:** `refreshWorldScans` persists a changed `projectId` — mutate the sidecar on
      disk, reload the world, assert the world file was rewritten (this is the test that
      catches the missing `changed` comparison)
- [ ] **Deno:** default-place creation is idempotent — call it twice, assert exactly one
      `'proj-default'` record in `PROJECTS_FILE`
- [ ] The new `place_registry.test.ts` is listed in `deno.json`'s `tasks.test`
- [ ] `deno task check` passes
- [ ] `deno task test` passes (including the new file)
- [ ] `npm run build` passes — the ADR 0002 gate, since `ScanEntry` is now imported by
      browser code from `src/world/types.ts`
- [ ] `npm run verify` passes end to end

```
deno task check
deno task test
npm run build
npm run verify
```

## Acceptance Criteria

- [ ] Given the scanner is opened with `?project=proj-default`, When a scan is exported and
      uploaded, Then `scans/<ts>_<name>.json` contains `"projectId": "proj-default"` and
      `worlds/default.json`'s matching `ScanManifest` does too
- [ ] Given the same scan's GLB, When its scene extras are read, Then `projectId` is
      `"proj-default"` (not `null`) and `floorName` is not `"Floor_Ground"` unless the place
      genuinely has only the default Ground Floor
- [ ] Given a POST to `/upload-scan` whose `metadata` field omits `projectId` entirely, Then
      the response is 200 and the resulting `ScanManifest.projectId` is `null`
- [ ] Given the 4 pre-existing scans, When the world is reloaded after this change, Then all
      four still have `"projectId": null` and no other field changed
- [ ] Given a scan already assigned to `'proj-a'`, When its sidecar is rewritten to `'proj-b'`
      and `GET /worlds/default` is called, Then `worlds/default.json` on disk shows `'proj-b'`
      — the change persisted, it did not merely appear in the response
- [ ] Given the server is started twice against the same `PROJECTS_FILE`, Then
      `projects.json` contains exactly one `'proj-default'` record
- [ ] Given the existing 95 fixture records in `projects.json`, When the server starts, Then
      `GET /projects` returns 200 and 96 records
- [ ] Given a full autosave sequence within one session (three autosaves), Then all three
      uploads carry the **same** `projectId` and the same `ScanEntry.scanId`
- [ ] Given the scanner UI, Then nothing visible changed — no new control, no new label

## Risks / potential issues

- **Risk: this ticket changes the `/upload-scan` contract.** ADR 0003 (~`:83-96`) documents
  that `/upload-scan`, `/scans/:filename/optimize`, and `/sessions/:id/finalize` operate on
  raw filenames with **no** `WorldProject` association, and parks everything under the
  `'default'` world. An upload now carries a place. — **Mitigation:** The change is strictly
  additive and the compatibility story is explicit: `projectId`/`floorId`/`roomId` are
  optional sidecar keys, `/upload-scan` requires no new field, and a client that sends none
  of them (an older PWA still installed on a phone, a replayed offline-queue entry captured
  before this change, `scripts/ingest-*.mjs`, any Playwright fixture) gets `null` and a 200 —
  identical behavior to today. Add an explicit test for the omitted-key path, not just the
  present-key path. This ticket does **not** give an upload a *world*; ADR 0003's parking
  decision stands.
- **Risk: two stores of record for places.** The client IndexedDB `'ci-xr-projects'` and the
  server's `PROJECTS_FILE` can diverge, and this is the single most likely way this ticket
  goes wrong. — **Mitigation:** The authority question is answered and pinned above, not
  fudged: server-authoritative, client mirrors, server wins on read. Implement exactly that.
  Do not add a merge algorithm. If the mirror is stale, it is discarded.
- **Risk: an offline-created place produces a scan with an id the server has never seen.**
  The client mints a local draft id, the scan uploads with it, the place push fails or is
  never retried, and the server ends up holding a `projectId` that resolves to nothing. —
  **Mitigation:** This is a real hole, not a hypothetical. It is acceptable because
  `ScanManifest.projectId` carries no referential integrity by design — an unresolvable id
  renders as unassigned, exactly like `null`, and never throws. Prefix local drafts
  distinguishably (e.g. `proj-local-<uuid>`) so a dangling id is recognisable on sight rather
  than looking like server data. A real reconciliation is 0004's problem; note it there.
- **Risk: `refreshWorldScans` silently discards the assignment.** `{ ...scan, ...next }`
  (`main.ts:1649`) makes the sidecar authoritative, and the `changed` flag (`:1644-1648`) does
  not compare `projectId`. Miss either and assignment appears to work and then evaporates on
  the next `GET /worlds/:slug`. — **Mitigation:** Both are called out above, and the
  "persists a changed `projectId`" test exists specifically to catch it. Assert the **file on
  disk**, not the HTTP response.
- **Risk: `'ci-xr-projects'` starts holding real user data for the first time.** It is not in
  CLAUDE.md's do-not-rename table — but it is absent only because nothing ever wrote to it,
  and this ticket ends that. From here on it has the same property as `'ci-xr-scan'`:
  renaming it, or bumping `DB_VERSION` without an `onupgradeneeded` path, makes the browser
  open a fresh empty database and orphans the user's local place list. — **Mitigation:** Do
  not touch `DB_NAME`, `DB_VERSION`, store names, or index names. Flag to the wave owner that
  the do-not-rename table should gain a row once this lands.
- **Risk: `proj-${Date.now()}` collides.** Two `POST /projects` calls in the same millisecond
  produce the same `projectId`, and `mutateProjects` pushes without a uniqueness check
  (`main.ts:3299-3312`). `projects.json` already holds records 4 ms apart. — **Mitigation:**
  Out of scope; `'proj-default'` is a fixed literal and is unaffected. Do not let a
  user-created place from 0003/0004 ship on this generator without addressing it — raise it
  as a ticket rather than fixing it here.
- **Risk: `ScanEntry.scanId` invents a third id scheme.** `scanIdFor` (`main.ts:1359-1363`)
  derives `scan-<sessionId>`; `ProjectStore.addScan` (`project-store.ts:164-171`) mints
  `scan-<ms>-<rand>`; wave 07 establishes its own. — **Mitigation:** Verify wave 07's landed
  `scanId` shape first and follow it. Do not add a fourth. If they cannot be reconciled,
  stop and raise it rather than picking one.
- **Risk: the autosave path mints a new `ScanEntry` per save.** `runAutoSave`
  (`src/main.ts:514-542`) runs on a 1200 ms debounce and can fire many times per session; a
  fresh `ScanEntry` each time would give one walkthrough many `scanId`s and break the
  Session→Scan level of the identity model. — **Mitigation:** Build the `ScanEntry` once at
  session start and hold it alongside `store`, `pointCloud`, and `poseHistory` in the same
  boot scope. Test it (three-autosaves acceptance criterion).
- **Risk: `noUnusedLocals: true`** (`tsconfig.json`) means a half-wired helper fails the
  build rather than lingering. — **Mitigation:** This is a feature, not a hazard; it is the
  reason the dead `projectStore` survived (it *is* used, by `.open()`). Do not silence it.
- **Risk: this ticket lands and 0003's picker slips**, leaving every scan filed under
  `'Unassigned'` and the place model technically live but practically useless. —
  **Mitigation:** Acceptable and honest — `'proj-default'` is truthful about what it knows.
  But schedule 0003 before merging this.

## Subtasks

1. [ ] Re-verify every line reference against `HEAD`, and confirm wave 07's landed `scanId`
       shape, before editing
2. [ ] Implement lazy `'proj-default'` creation in `main.ts` via `mutateProjects()`; assert
       idempotence
3. [ ] Add `projectId: asString(scan.meta['projectId'])` (plus `floorId`/`roomId` if they are
       carried on the manifest) to `scanManifestFromStored` (`main.ts:1369-1403`)
4. [ ] Add `|| scan.projectId !== next.projectId` to `refreshWorldScans`'s `changed`
       comparison (`main.ts:1644-1648`)
5. [ ] Add `projectId` to `registerSessionScan`'s synthetic meta (`main.ts:1429-1434`)
6. [ ] Add `scanEntry` to `uploadToServer`'s destructure (`gltf.ts:345`) and the three flat
       keys to the metadata object (`gltf.ts:347-372`)
7. [ ] Build the client place registry in `src/main.ts`: resolve at boot, create/list/get,
       mirror to `ProjectStore`, server-authoritative
8. [ ] Construct one `ScanEntry` per session; pass it at `src/main.ts:468-471` and `:529-532`
9. [ ] Write `place_registry.test.ts` and add it to `deno.json`'s `tasks.test` list
10. [ ] Run `deno task check`, `deno task test`, `npm run build`, `npm run verify`
11. [ ] Manual check on device: upload with `?project=`, then inspect `scans/<ts>_*.json` and
        `worlds/default.json`; confirm the 4 old scans are still `null`
12. [ ] Update the atlas entries and badge them; fix the ADR 0003 "no association" sentence
        precisely
