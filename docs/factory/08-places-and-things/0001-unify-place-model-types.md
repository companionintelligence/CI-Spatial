> **Type:** Refactor
> **Wave:** 08-places-and-things
> **Branch:** `refactor/place-model-types`
> **Commit style:** `refactor(world): summary`
> **Design:** this ticket is the spec
> **Dependencies:** wave `07-scan-identity` complete (unique `scanId` per upload, one
> session identity, node-level GLB provenance, pipeline preserves provenance). Note that
> `docs/factory/07-scan-identity/` is an empty directory as of this drafting — the wave is
> planned, not yet written. Do not start this ticket until 07's tickets exist and have
> landed.

## Goal

Give this codebase **one** place model. Move the `Project` / `Floor` / `Room` / `ScanEntry`
declarations out of the browser-only `src/project/project-store.ts` and into
`src/world/types.ts` — the established Deno-API-free home per ADR 0002 — and add
`projectId: string | null` to `ScanManifest`. Types and schema only; no behavior changes.

## The situation, precisely

The repo currently has **two parallel "places" families** that do not know about each
other. This is the exact failure mode ADR 0001 was written for, and it is the third
instance of it (after the two `ScanManifest` types and the two job queues).

**Family A — live, server-side, `src/world/types.ts`:**

| Type | Line | Role |
| --- | --- | --- |
| `GeoPose` | `src/world/types.ts:50` | lat/lng/altitude/bearing/accuracy/address |
| `LocalFrame` | `src/world/types.ts:61` | the world's local ENU frame |
| `ScanQualitySummary` | `src/world/types.ts:107` | 14-field capture-quality record |
| `ScanManifest` | `src/world/types.ts:146` | a scan's place inside a World |
| `WorldProject` | `src/world/types.ts:191` | `worldId`, `shareSlug`, `scans[]`, `jobs[]`, … |

`main.ts:64-77` type-imports `EditPatch`, `FrameObservation`, `GeoPose`, `MemberRole`,
`ScanManifest`, `ScanManifestStatus`, `ScanQualitySummary`, `WorldJob`, `WorldJobStatus`,
`WorldJobType`, `WorldMember`, `WorldProject` from `./src/world/types.ts`. Every
`src/viewer/*` file imports `ScanManifest` from `../world/types`. This family is load-bearing.

**Family B — declared but dead, browser-side, `src/project/project-store.ts`:**

| Type | Lines | Fields |
| --- | --- | --- |
| `ScanStatus` | `:16` | `'draft' \| 'ready' \| 'archived'` |
| `Room` | `:18-22` | `roomId`, `name`, `zone?` |
| `Floor` | `:24-31` | `floorId`, `name`, `level`, `rooms: Room[]` |
| `Project` | `:33-41` | `projectId`, `name`, `address?`, `notes?`, `createdAt`, `updatedAt`, `floors: Floor[]` |
| `ScanQualitySummary` | `:43-49` | **name collision** — see below |
| `ScanEntry` | `:51-64` | `scanId`, `projectId`, `sessionId`, `scanFilename?`, `floorId?`, `roomId?`, `name`, `status`, `capturedAt`, `notes?`, `qualitySummary?` |

`ProjectStore` (`:75`) backs these with its own IndexedDB database `'ci-xr-projects'`
(`:68`, v1) holding a `projects` store keyed on `projectId` and a `scans` store keyed on
`scanId` with a `byProject` index (`:88`) and a `bySession` index (`:89`). `listScans(projectId)`
(`:181-189`) reads the `byProject` index.

A server-side CRUD mirror of Family B also exists: `GET/POST /projects` and
`GET/PUT/DELETE /projects/:id` at `main.ts:3285-3348`, over `ProjectRecord`
(`main.ts:3247-3255`), persisted to `PROJECTS_FILE` (`main.ts:3257`) behind
`mutateProjects()`'s promise chain (`main.ts:3258-3283`). `ProjectRecord.floors` is typed
`unknown[]` (`main.ts:3254`) — the server does not type floors or rooms at all, even though
`POST /projects` (`main.ts:3308`) constructs a real one:
`{ floorId: 'floor-<ms>', name: 'Ground Floor', level: 0, rooms: [] }`.

### The name collision (a fourth instance, found while verifying this ticket)

`ScanQualitySummary` is declared **twice**, in both families:

- `src/world/types.ts:107-122` — 14 fields (`coverageScore`, `coverageText`, `pointCount`,
  `detectionCount`, `poseCount`, `keyframeCount`, `lowLightFrames`, `driftEvents`,
  `reflectiveWarnings`, `missingAreas`, `trackingLost`, `status`, `recommendations`,
  `capturedAt`).
- `src/project/project-store.ts:43-49` — 5 fields (`coverageScore`, `lowLightFrames`,
  `driftEvents`, `reflectiveWarnings`, `pointCount`).

Both are in scope inside a single file today: `src/export/gltf.ts:25` imports `ScanEntry`
from `../project/project-store` and `src/export/gltf.ts:27` imports `ScanQualitySummary`
from `../world/types`. So `ExportData.qualitySummary` (`gltf.ts:78`) is the world one while
`ExportData.scanEntry.qualitySummary` (via `ScanEntry`, `project-store.ts:63`) is the
project-store one. Nothing errors because the field is never populated — see below.

### The deadness (verified)

`grep -rn "projectStore\|ProjectStore\|project-store"` across the whole tree returns exactly
five hits, three of which are the declaration itself:

```
src/export/gltf.ts:25:  import type { ScanEntry } from '../project/project-store'
src/main.ts:26:         import { ProjectStore } from './project/project-store'
src/main.ts:163:        const projectStore = new ProjectStore()
src/main.ts:164:        await projectStore.open()
src/project/project-store.ts:75: export class ProjectStore {
```

`src/main.ts:163-164` are the **only** two runtime references. There is no `createProject`,
`addScan`, `listScans`, `addFloor`, or `addRoom` call site anywhere in `src/`. The store is
opened on every scanner boot, creates its IndexedDB database, and is then never touched.

Consequences, all verified in `src/export/gltf.ts`:

- `ExportData.scanEntry` (`:75`, optional) is never supplied. Both call sites —
  `src/main.ts:468-471` (manual export) and `src/main.ts:529-532` (autosave) — pass only
  `{ store, pointCloud, poseHistory, geoFix, qualitySummary }`.
- `projectId: scanEntry?.projectId ?? null` (`gltf.ts:138`) is therefore **permanently
  `null`** in every GLB's scene `extras`.
- `floorName` (`gltf.ts:126`) is permanently `'Floor_Ground'` and `roomName` (`gltf.ts:127`)
  permanently `'Room_Unknown'`, so the Floor/Room group hierarchy documented in the file's
  own header comment (`gltf.ts:6-16`) is a fixed two-level stub in every exported scan.
- The upload metadata sidecar built by `uploadToServer` (`gltf.ts:347-372`) carries no
  `projectId` key at all.
- `ScanManifest` (`src/world/types.ts:146-163`) has **no** `projectId` field, so nothing
  server-side could read one even if it were sent.
- `docs/factory/atlas.html` does not contain the string `projectId` anywhere (`grep -c` → 0).

Meanwhile `projects.json` on this machine holds **95** `ProjectRecord`s, all Playwright
fixture residue (`"Test Building"`, `"Scan Site <ms>"`), each with a synthetic
`floor-<timestamp>` floor and zero rooms — created through the server route by tests, never
by a user, and never referenced by any scan.

## Non-goals

- **Do not wire anything.** No `ScanEntry` gets constructed, no call site gains a
  `scanEntry` argument, no scan actually receives a `projectId`. That is ticket 0002.
- **Do not build UI.** No place picker (0003), no rename/delete/merge/floor-room management
  UI (0004). Ticket 0004 owns the full place-management surface; nothing in this wave's
  0001 or 0002 may anticipate it.
- **Do not delete `src/project/project-store.ts`.** The `ProjectStore` class, its IndexedDB
  schema, and its methods stay exactly where they are. Only the six type declarations move;
  the file imports them back.
- **Do not change `WorldProject.scans[]` membership semantics.** Making `scans[]` a derived
  view over a Project's scans is ticket 0005. `WorldProject` (`src/world/types.ts:191-203`)
  is untouched by this ticket.
- **Do not rename the IndexedDB database `'ci-xr-projects'`** (`project-store.ts:68`) or
  bump `DB_VERSION` (`:69`). See Risks.
- **Do not change ID generation.** `proj-${Date.now()}` / `floor-${Date.now()}` /
  `room-${Date.now()}` stay as they are in this ticket even though they disagree with the
  house convention — see Open questions.
- **Do not backfill `projectId` onto the 4 existing scans.** `null` is a valid, permanent
  value.
- **Do not add a schema/validation library.** Hand-written interfaces only.

## Pinned conventions

**ADR 0002 is the central constraint of this ticket.** A type importable from browser code —
even via `import type` — must be **declared** in a file with zero `Deno.*` references, not
merely re-exported from one. Verified:

- `grep -c "Deno\." src/world/types.ts` → **0**. It is a valid home.
- `grep -c "Deno\." src/project/project-store.ts` → **0**. It is browser-only IndexedDB
  code and is *also* Deno-API-free today; the move is not about fixing a broken import, it
  is about consolidating the place model in the one declared home before ticket 0002 makes
  the server read these types too.
- `tsconfig.json` is `"include": ["src"]`, `"strict": true`, `"noUnusedLocals": true`,
  `"noUnusedParameters": true`, `"moduleResolution": "bundler"`,
  `"allowImportingTsExtensions": true`, `lib: ES2022 + DOM` with **no** `deno.ns`.
- **`npm run build` (`tsc --noEmit && vite build`) is the real gate.** `deno task check`
  (`deno check main.ts`) does **not** exercise the frontend program and will not catch
  cross-runtime type-import breakage. Note `npm run verify` runs `tsc --noEmit` but **not**
  `vite build` — run `npm run build` explicitly as well.

**ADR 0001 — what this reuses.** A real search for an existing place identity was done
before writing this ticket, and it found one:

| Searched | Found | Decision |
| --- | --- | --- |
| `grep -rn "projectId" src/ main.ts` | `project-store.ts` (Family B), `main.ts:3247-3348`, `gltf.ts:138` | **Reuse `projectId`.** Do not invent `locationId`, `siteId`, `placeId`, or `venueId`. |
| `grep -rn "Floor\|Room" src/world/` | nothing — the world family has no floor/room concept | **Reuse `Floor`/`Room` from `project-store.ts:18-31` verbatim.** |
| `grep -rn "interface Project\b"` | `project-store.ts:33` only | **Reuse `Project`.** |
| `grep -rn "ScanEntry"` | `project-store.ts:51`, `gltf.ts:25`, `gltf.ts:75` | **Reuse `ScanEntry`.** It is already the declared shape `exportToGLB` accepts. |

Nothing new is being invented. Every type in this ticket already exists in the repo; this
ticket changes *where they are declared* and adds *one field* to `ScanManifest`.

**ADR 0004** — no world-file write happens in this ticket. When 0002 does write, it must go
through `updateWorld()` (`main.ts:1588`), never `readWorldUnlocked`/`writeWorldUnlocked`.

**Other pinned values:**

- Branch `type/short-scope`; commit `type(scope): summary`.
- No schema library. Hand-written TypeScript interfaces in `src/world/types.ts`; ad-hoc type
  guards in `main.ts` following `asString` (`main.ts:1199`), `asNumber` (`main.ts:1195`),
  `asStringArray` (`main.ts:1203`), `hasGeoPose` (imported at `main.ts:61`).
- Hono handlers live in `main.ts`. CORS goes through the existing `isAllowedOrigin()`.
  Config is `Deno.env.get('X') ?? <default>` at module scope — `PROJECTS_FILE` already
  exists in exactly that form at `main.ts:3257` (`Deno.env.get('PROJECTS_FILE') ?? './projects.json'`).
  **Do not add a second projects-file env var.**
- House ID generator is `crypto.randomUUID()` (see `main.ts:1444-1446`, `main.ts:3267`).
- `src/world/types.ts`'s own internal import uses an explicit `.ts` extension
  (`from './manifests.ts'`, line 218); `src/` consumers import extensionless
  (`from '../world/types'`). Match whichever side you are on.

## Before implementation

Read these, in this order, before touching anything:

- `docs/adr/0002-shared-types-importable-by-the-browser-must-live-in-deno-api-free-files.md`
  — the whole ADR. This ticket is an application of it.
- `docs/adr/0001-reuse-existing-domain-model.md` — the "things and places" framing.
- `src/world/types.ts` in full (218 lines) — note the section ordering and the
  `export type { … } from './manifests.ts'` re-export block at `:205-218`, and the comment
  above it explaining why `manifests.ts` was split out. Your new place types are a *third*
  family in this file's terms; follow the same commenting discipline.
- `src/project/project-store.ts:1-73` — the header comment documents the IndexedDB schema.
  The comment must stay accurate after the move.
- `src/export/gltf.ts:19-27` (imports), `:71-78` (`ExportData`), `:113-155`
  (`exportToGLB` header and `scene.userData`) — especially `:126-128` and `:138`.
- `main.ts:3245-3348` — the whole `ProjectRecord` / `PROJECTS_FILE` / routes block.
- `main.ts:1369-1403` — `scanManifestFromStored`, the only real constructor of a
  `ScanManifest`; and `main.ts:1414-1439` — `registerSessionScan`, the second one.
- `memory_push.test.ts:128-152` — the one `ScanManifest` object literal in the test suite.
  It ends `} as unknown as ScanManifest`, so a new required field does **not** break it.
  Confirm this is still true before assuming it.
- `projects.json` — the 95 fixture records your new `Floor`/`Room` typing must still parse.

## Open questions & answers

- Q: Three-level identity or two? — A: **Three, plus Thing.** Project (a place) → Session
  (one walkthrough) → Scan (one uploaded GLB). A Thing (`WorldDetection` / `DetectObject` /
  `FurnitureItem`) lives inside a place. (Decided by owner, 2026-08-19.)
- Q: Who owns scan membership — the World or the Project? — A: **The Project owns it.**
  `WorldProject.scans[]` becomes a *derived view* over a Project's scans, not an independent
  list. `projectId` is fixed at capture time. **This ticket does not implement that** —
  it is ticket 0005 — but the schema added here is what makes it possible, which is why
  `projectId` goes on `ScanManifest` rather than being tracked in a side table.
  (Decided by owner, 2026-08-19.)
- Q: Should place assignment be automatic from GPS? — A: **No. Geo suggests, the user
  confirms.** Empirical justification: on a *stationary* Galaxy Tab S8 Ultra the geo chip
  reported two different street addresses — "30902 Club House Drive" and
  "30856/30862 Calle Moraga", Laguna Niguel CA — with accuracy swinging from ±5 m to ±33 m
  and coordinates varying by ~65 m over one sitting. Auto-clustering by coordinate **will**
  misgroup indoor scans. Relevant here because it is why `projectId` is an explicit stored
  field rather than something derived on read from `ScanManifest.geoPose`.
  (Decided by owner, 2026-08-19.)
- Q: Invent a fresh `locationId`, or reuse `projectId`? — A: **Reuse `projectId`.** It
  already exists in `ScanEntry` (`project-store.ts:52`), `ProjectRecord`
  (`main.ts:3248`), and the GLB scene extras (`gltf.ts:138`). Inventing a parallel name is
  precisely the ADR 0001 failure this wave is correcting. (Decided by owner, 2026-08-19.)
- Q: `ScanManifest.projectId` — required-and-nullable, or optional? — A: **Required,
  nullable: `projectId: string | null`.** Optional (`projectId?: string`) makes "not yet
  assigned" and "field predates the schema" indistinguishable, and the whole point of this
  wave is knowing which scans lack a place. Every constructor must state it. `null` means
  *unassigned place* and must stay valid indefinitely. (Decided 2026-08-19.)
- Q: What about the duplicated `ScanQualitySummary`? — A: **Do not merge the two shapes in
  this ticket.** `ScanEntry.qualitySummary` is currently typed against
  `project-store.ts:43-49`'s 5-field version and nothing populates it. When `ScanEntry`
  moves into `src/world/types.ts`, that 5-field interface must be **renamed** on the way in
  to avoid colliding with the existing 14-field `ScanQualitySummary` at `:107`. Pinned name:
  `ScanEntryQualitySummary`. A real reconciliation onto the one 14-field type is a behavior
  question (which fields does the client actually have at export time?) and belongs to 0002
  or later. Logged so the next reader does not think it was missed.
- Q: `proj-${Date.now()}` vs the house `crypto.randomUUID()`? — A: **Out of scope here.**
  This ticket moves declarations; it does not touch the two generators
  (`project-store.ts:102`, `main.ts:3302`). Note for 0002: two `POST /projects` calls in the
  same millisecond produce the same `projectId`, and `projects.json` already contains
  near-misses 4 ms apart (`proj-1781069353719`, `proj-1781069353723`). Changing the
  generator is a data-compat decision (95 existing records), so it needs its own ticket.
- Q: Is `docs/factory/07-scan-identity/` populated? — A: **No — the directory exists and is
  empty as of drafting.** This ticket's dependency is on 07 as a wave, not on a specific
  ticket number. Do not begin until 07 exists and has landed.

## Files impacted

**Changed:**

- `src/world/types.ts` — gains a "Places: Project / Floor / Room / ScanEntry" section with
  six declarations (`ScanStatus`, `Room`, `Floor`, `Project`, `ScanEntryQualitySummary`,
  `ScanEntry`) and one new field on `ScanManifest`.
- `src/project/project-store.ts` — the six declarations are deleted from `:16-64` and
  replaced by an `import type` from `../world/types`, plus a matching `export type` re-export
  so existing extensionless importers (`src/export/gltf.ts:25`) keep compiling unchanged.
  The header comment (`:1-12`) stays but gains a line saying where the types now live and
  why (ADR 0002).
- `main.ts` — `ProjectRecord.floors: unknown[]` (`:3254`) becomes `floors: Floor[]`, with
  `Floor` added to the existing `import type { … } from './src/world/types.ts'` block at
  `:64-77`. Consider replacing `ProjectRecord` entirely with the moved `Project` type if the
  fields prove identical — they are (`projectId`, `name`, `address?`, `notes?`, `createdAt`,
  `updatedAt`, `floors`) — but keep the `ProjectRecord` **name** as a local alias if that
  keeps the diff small; do not leave two independently-maintained shapes.
- `docs/factory/atlas.html` — three entries. See below.

**New:** none. **Deleted:** none.

### Atlas diff (required — CLAUDE.md, `docs/FACTORY.md` § "The atlas")

- `atlas.html:394` — the "World / scan data model" fcard currently lists
  `WorldProject / ScanManifest / EditPatch / WorldJob / WorldMember`. Add the place family
  and mark the card `changing`.
- `atlas.html:534-535` — the data-model table rows. Row `ScanManifest (world)` must gain
  `projectId`; add rows for `Project`, `Floor`, `Room`, `ScanEntry` pointing at
  `world/types.ts`.
- `atlas.html:500-501` — the "Naming collision — fixed" callout says `ScanManifest` "now
  names exactly one thing in this codebase". That sentence is true and stays true; add the
  `ScanQualitySummary` double-declaration next to it as an open duplication this wave found,
  with its resolution (`ScanEntryQualitySummary`) recorded. **Point at the ticket; do not
  restate its content.**

## Schema required

### Moved verbatim into `src/world/types.ts` (no field changes)

```ts
export type ScanStatus = 'draft' | 'ready' | 'archived'

export interface Room {
  roomId: string
  name: string
  zone?: string
}

export interface Floor {
  floorId: string
  /** Display label, e.g. "Ground Floor" or "Level 2" */
  name: string
  /** Ordinal level number (0 = ground) */
  level: number
  rooms: Room[]
}

export interface Project {
  projectId: string
  name: string
  address?: string
  notes?: string
  createdAt: number      // epoch ms — matches project-store.ts and main.ts:3252-3253
  updatedAt: number      // epoch ms
  floors: Floor[]
}
```

### Moved and renamed (collision avoidance — see Open questions)

```ts
/**
 * The client-side capture summary carried on a ScanEntry. NOT the same shape as
 * ScanQualitySummary above (14 fields, the server/world record). Renamed on the
 * move out of src/project/project-store.ts, where it was also called
 * ScanQualitySummary and shadowed the world one inside src/export/gltf.ts.
 */
export interface ScanEntryQualitySummary {
  coverageScore: number    // 0–1
  lowLightFrames: number
  driftEvents: number
  reflectiveWarnings: number
  pointCount: number
}

export interface ScanEntry {
  scanId: string
  projectId: string
  sessionId: string
  /** Filename of the uploaded .glb on the server (if already uploaded) */
  scanFilename?: string
  floorId?: string
  roomId?: string
  name: string
  status: ScanStatus
  capturedAt: number       // epoch ms
  notes?: string
  qualitySummary?: ScanEntryQualitySummary
}
```

### Added to the existing `ScanManifest` (`src/world/types.ts:146-163`)

```ts
export interface ScanManifest {
  scanId: string
  sessionId: string | null
  projectId: string | null   // ← NEW
  filename: string
  // … all 13 remaining fields unchanged
}
```

**`projectId` constraints:**

- **Type:** `string | null`. Required key, nullable value. Not optional (`?`).
- **Default:** `null`.
- **Meaning of `null`:** *unassigned place*. This is a legitimate, permanent state, not a
  migration placeholder. The 4 scans currently on disk
  (`scans/1787174311700_…`, `1787174371857_…`, `1787174954604_…`, `1787175480232_…`, each
  `autosave-room-scan-2026-08-19T21-*.glb`) were captured before this field existed and will
  never have a truthful value. **`null` must remain valid indefinitely** — no code may treat
  it as an error, and nothing may backfill it with a guess.
- **Referential integrity:** none enforced. A `projectId` naming a `Project` that has since
  been deleted must not crash a read; treat it as unassigned at render time. There is no FK
  mechanism here — `projects.json` and `worlds/<slug>.json` are separate files.
- **Constructors that must set it** (both currently in `main.ts`, both set `null` in this
  ticket): `scanManifestFromStored` (`main.ts:1369-1403`) and `registerSessionScan`
  (`main.ts:1414-1439`, which builds a `StoredScanInfo` and delegates). Populating it from
  real data is ticket 0002.

### `ProjectRecord.floors`

`main.ts:3254` — `floors: unknown[]` → `floors: Floor[]`. The 95 existing records in
`projects.json` all carry `[{ floorId, name, level, rooms: [] }]`, which satisfies `Floor`
exactly. `loadProjects()` (`main.ts:3260-3264`) casts JSON with `as ProjectRecord[]` and
already swallows parse errors with `catch { return [] }` — the cast does not validate, so
typing `floors` changes compile-time safety only, not runtime behavior. That is intentional
for this ticket.

No IndexedDB schema change. No `DB_VERSION` bump. No on-disk format change.

## Definition of Done

- [ ] `src/world/types.ts` declares `ScanStatus`, `Room`, `Floor`, `Project`,
      `ScanEntryQualitySummary`, `ScanEntry` in a commented "Places" section
- [ ] `ScanManifest` has `projectId: string | null` as a required, nullable key
- [ ] `src/project/project-store.ts` declares none of those six types; it imports them from
      `../world/types` and re-exports them so `src/export/gltf.ts:25` compiles unchanged
- [ ] `src/project/project-store.ts`'s header comment says where the types now live and
      cites ADR 0002
- [ ] `grep -c "Deno\." src/world/types.ts` still returns 0
- [ ] `main.ts`'s `ProjectRecord.floors` is `Floor[]`, imported from `./src/world/types.ts`
- [ ] `scanManifestFromStored` and `registerSessionScan` both set `projectId: null`
      explicitly (not by omission)
- [ ] No behavior changed: no new call site, no new route, no UI, no scan gains a real
      `projectId`
- [ ] `src/project/project-store.ts` still exists with `ProjectStore` and all its methods
- [ ] `atlas.html:394`, `:500-501`, and `:534-535` reflect the new shape, badged to this
      ticket

## Tests

- [ ] `npm run build` passes — **this is the ADR 0002 gate and the entire point of the
      ticket.** Run it, not just `npm run verify` (which runs `tsc --noEmit` but not
      `vite build`).
- [ ] `deno task check` passes (`deno check main.ts`)
- [ ] `npm run verify` passes end to end
- [ ] Assert no browser file type-imports from a Deno-API-bearing file. Mechanical check —
      for each `src/**/*.ts` import target that resolves outside `src/`, or to a repo-root
      `.ts` file, `grep -c "Deno\."` that file and require 0. Expected result today: zero
      such imports exist; the check exists to keep it that way. Record the command used in
      the PR body.
- [ ] `grep -rn "interface Room\|interface Floor\|interface Project\b\|interface ScanEntry"
      src/` returns hits only in `src/world/types.ts`
- [ ] `deno task test` passes — in particular `memory_push.test.ts`, whose `ScanManifest`
      literal at `:128-152` ends `as unknown as ScanManifest` and so must survive the new
      required field untouched. If it does not, **do not weaken the field to optional** —
      fix the literal.
- [ ] Existing `projects.json` (95 records) still round-trips through `GET /projects` with
      `floors` typed — start the server, `curl -s localhost:8000/projects | head`, confirm a
      200 and a populated array

```
npm run build
deno task check
deno task test
npm run verify
```

Note: `deno task test` in `deno.json` names its test files **explicitly**. This ticket adds
no Deno test, but if you add one you must also add its filename to that task list or it will
silently never run.

## Acceptance Criteria

- [ ] Given a clean checkout, When `npm run build` runs, Then it exits 0 with no
      "Cannot find name 'Deno'" and no unresolved-import errors
- [ ] Given `src/export/gltf.ts` is unmodified by this ticket, When the build runs, Then its
      `import type { ScanEntry } from '../project/project-store'` at `:25` still resolves —
      via the re-export, not a rewritten import
- [ ] Given `src/world/types.ts` after the change, When grepped for `Deno.`, Then the count
      is 0
- [ ] Given `src/export/gltf.ts` after the change, Then `ScanQualitySummary` inside it
      unambiguously means the 14-field `src/world/types.ts:107` one, and the 5-field shape
      is reachable only as `ScanEntryQualitySummary`
- [ ] Given the server starts against the existing 95-record `projects.json`, When
      `GET /projects` is called, Then it returns 200 and every record's `floors[0]` has
      `floorId`, `name`, `level`, and `rooms`
- [ ] Given a scan uploaded after this change, Then its `ScanManifest` in
      `worlds/default.json` contains `"projectId": null` — present and null, not absent
- [ ] Given the 4 pre-existing scans, When the world is reloaded, Then they gain
      `"projectId": null` and nothing else about them changes

## Risks / potential issues

- **Risk:** Moving types creates an import cycle. `src/world/types.ts` already imports from
  `./manifests.ts` (`:218`); if `project-store.ts` imports from `world/types.ts` while
  anything in `src/world/` imports from `project-store.ts`, that is a cycle. —
  **Mitigation:** Verified that `src/world/` currently imports nothing from
  `src/project/`; the dependency is one-directional (`project` → `world`) and must stay
  that way. `src/world/types.ts` must import **nothing** from `src/project/`. Vite will
  usually tolerate a type-only cycle silently, which is exactly why it must be prevented by
  inspection rather than by waiting for a build failure.
- **Risk:** `src/project/project-store.ts` is browser code and must remain
  Deno-API-free. — **Mitigation:** It has 0 `Deno.` references today (verified). Re-grep
  after the change. If a later ticket makes the server import `ProjectStore` itself — it
  should not; the server has `PROJECTS_FILE` — that grep is the tripwire.
- **Risk:** `projects.json` holds 95 synthetic fixture records with `floor-<timestamp>`
  floors. Typing `floors: Floor[]` could reject them. — **Mitigation:** It cannot at
  runtime: `loadProjects()` (`main.ts:3260-3263`) does an unvalidated `as` cast inside a
  `try/catch`. Verified that all 95 records structurally satisfy `Floor`. Do **not** add
  runtime validation in this ticket — that would turn a compile-time tidy-up into a
  data-migration ticket.
- **Risk:** `'ci-xr-projects'` (`project-store.ts:68`) is a second IndexedDB database
  alongside `'ci-xr-scan'` (`src/scene/store.ts`). It is **not** in CLAUDE.md's
  do-not-rename table — but treat it exactly as if it were. The table's entries earn their
  place by orphaning persisted user data on rename, and `'ci-xr-projects'` has the same
  property: renaming it (or bumping `DB_VERSION` without an upgrade path) makes the browser
  open a fresh empty database and silently orphans whatever a user's device holds. It is
  absent from the table only because nothing has ever written to it — a fact that stops
  being true the moment ticket 0002 lands. — **Mitigation:** Do not touch `DB_NAME`,
  `DB_VERSION`, the store names, or the index names in this ticket. If a future ticket needs
  a schema change there, it is a versioned `onupgradeneeded` migration, not a rename.
- **Risk:** Adding a required key to `ScanManifest` breaks an object literal somewhere. —
  **Mitigation:** Enumerated. Constructors: `main.ts:1369-1403`, `main.ts:1414-1439`. Test
  literal: `memory_push.test.ts:128-152` (shielded by `as unknown as`). Browser code only
  *consumes* `ScanManifest` — verified across all of `src/viewer/*` — and never constructs
  one. Total blast radius: two functions.
- **Risk:** The two `ScanQualitySummary` declarations mean a reviewer may "helpfully" merge
  them. — **Mitigation:** Explicitly out of scope; the rename to `ScanEntryQualitySummary`
  is the fence. Merging them is a behavior change about which fields the client can actually
  produce at export time.
- **Risk:** This ticket makes the place model look finished while nothing uses it — the same
  trap that produced the dead `ProjectStore` in the first place. — **Mitigation:** 0002 must
  follow immediately. If 0002 slips, `ProjectStore` stays dead code, only now in a more
  prominent file. Do not merge 0001 without 0002 scheduled.

## Subtasks

1. [ ] Re-verify every line reference in this ticket against `HEAD` before editing — this
       ticket was written against a working tree with `.mcp.json` modified
2. [ ] Add the "Places" section to `src/world/types.ts` with the six declarations, renaming
       the 5-field summary to `ScanEntryQualitySummary`
3. [ ] Add `projectId: string | null` to `ScanManifest`, with a comment stating that `null`
       means unassigned and is permanently valid
4. [ ] Set `projectId: null` explicitly in `scanManifestFromStored` (`main.ts:1369-1403`);
       confirm `registerSessionScan` (`main.ts:1414-1439`) inherits it via its delegation
5. [ ] Delete `src/project/project-store.ts:16-64`'s declarations; add the `import type` and
       the compatibility `export type` re-export; update the header comment with the ADR 0002
       reason
6. [ ] Change `main.ts:3254` to `floors: Floor[]`; add `Floor` to the `import type` block at
       `main.ts:64-77`; collapse `ProjectRecord` onto the moved `Project` type if the fields
       match exactly (they do)
7. [ ] Run `npm run build` — the ADR 0002 gate. Fix anything it surfaces before continuing
8. [ ] Run `deno task check`, `deno task test`, `npm run verify`
9. [ ] Run the "no browser file imports from a Deno-API-bearing file" grep; record it in the
       PR body
10. [ ] Start the server against the existing `projects.json`; confirm `GET /projects` is 200
11. [ ] Update `atlas.html:394`, `:500-501`, `:534-535`; badge them to this ticket
