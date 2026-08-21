# 0004 — Full place management: rename, delete, merge, floor/room assignment

> **Type:** Frontend
> **Wave:** 08-places-and-things
> **Branch:** `feat/place-management`
> **Commit style:** `feat(places): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 08/0003 (scanner place picker), which depends on 08/0002 (place registry
> wired; `projectId` flows capture → manifest), which depends on 08/0001 (types unified),
> which depends on wave 07 complete.

## Goal

Make the Project / Floor / Room model **usable** rather than merely declared. The types
have existed since `src/project/project-store.ts` was written; almost none of them can be
edited from any UI, and the parts that can be edited from the API are only ever exercised
by Playwright. The owner explicitly chose full management over a minimal picker: 08/0003
lets a user *choose* a place, this ticket lets them *maintain* the set of places.

## What is actually missing today, verified

| Capability | State on `main` |
| --- | --- |
| Create a place | Exists: `ProjectStore.createProject` (src/project/project-store.ts:99-117) and `POST /projects` (main.ts:3291-3314) |
| **Rename** a place | No UI anywhere. Server-side only via `PUT /projects/:id` (main.ts:3324-3336), a whole-record replace |
| **Delete** a place | `ProjectStore.deleteProject` (src/project/project-store.ts:133-137) **silently cascade-deletes every one of its `ScanEntry` records** in a `for` loop before removing the project. `DELETE /projects/:id` (main.ts:3338-3348) just splices the record and knows nothing about scans |
| **Merge** two places | Does not exist in any form |
| Add a floor / room | `addFloor` (:140-148), `addRoom` (:151-160). No rename, no delete, no UI |
| Assign a scan to a floor/room | `ScanEntry.floorId` / `roomId` exist (:57-58). Nothing ever sets them |
| Floor/room names in the export | `src/export/gltf.ts:126-127` — permanently `'Floor_Ground'` / `'Room_Unknown'`, because both `exportToGLB` call sites (src/main.ts:468-471, :529-532) omit `scanEntry` entirely |
| Real floor/room data | None. Every one of the ~90 records in `projects.json` is Playwright residue — names like `"Test Building"`, `"Get By ID"`, `"After Update"`, each with exactly one `"Ground Floor"` and `"rooms": []`. **No room has ever existed in this repo's data.** |

That last row is a risk, not a curiosity: the floor/room code paths have never run against
real input.

## Non-goals

- Do not add automatic duplicate detection or auto-merge. Merge is always an explicit,
  user-chosen pair.
- Do not bulk re-file historical scans. One scan at a time, chosen by the user.
- Do not change how worlds derive their scan list — that is 08/0005.
- Do not add place management to the scanner (`index.html`). See the location pin.
- Do not rewrite GLBs that were already exported. Floor/room names become meaningful for
  exports made **after** an assignment; existing files stay as they are.
- Do not add place-level permissions, sharing, or membership. `WorldMember`
  (src/world/types.ts:165-172) is a different axis and stays untouched.
- Do not touch the geo-suggest logic from 08/0003.

## Pinned conventions

**ADR 0001** (`docs/adr/0001-reuse-existing-domain-model.md`) — this ticket touches schema,
a client↔server connection, and adds a route, so it states what it reuses.

| Reused | Where | How this ticket uses it |
| --- | --- | --- |
| `Project`, `Floor`, `Room`, `ScanEntry` | unified by 08/0001 (today: `src/project/project-store.ts:18-64`, duplicated loosely as `ProjectRecord` at `main.ts:3247-3255` with `floors: unknown[]`) | imported as-is. **No new type** except the merge request/response envelope |
| `ProjectStore` | `src/project/project-store.ts:75-246` | extended with rename/delete-floor/room and a merge helper. Not replaced, not forked |
| `PUT /projects/:id` | `main.ts:3324-3336` | carries **all** floor and room CRUD. `floors` is part of the record, so no per-floor or per-room route is needed |
| `mutateProjects()` | `main.ts:3272-3283` | the existing per-file serialized read-modify-write queue; the merge endpoint runs inside it, it does not open `projects.json` itself |
| `updateWorld()` / `mutateWorldFiles()` | per ADR 0004 | the only sanctioned way to rewrite `worlds/*.json`. The merge's manifest rewrite goes through them |
| `.sidebar-tab` / `.sidebar-panel` | viewer.html:1017-1029, wired generically at src/viewer/viewer.ts:2444-2456 | a new tab needs **no change** to the switcher — it iterates `document.querySelectorAll('.sidebar-tab')` |
| `ScanManifest.projectId` | added by 08/0001 to `src/world/types.ts:146-163` | rewritten by merge, never re-derived |
| `exportToGLB`'s `scanEntry` | `src/export/gltf.ts:75, 126-128` | already accepts the assignment; this ticket makes it carry names too |

**Searched before adding the merge route:** `grep -n "projects" main.ts` — the only project
routes are `GET/POST /projects` (:3285-3314) and `GET/PUT/DELETE /projects/:id`
(:3316-3348). There is nothing that combines two records, and `PUT` is a whole-record
replace that cannot express "and also move every scan and manifest that pointed at the
other one". **A merge endpoint is genuinely new.** Everything else in this ticket rides
existing routes.

**ADR 0002** — `Project`/`Floor`/`Room`/`ScanEntry` are imported by both the viewer (browser)
and `main.ts` (Deno), so after 08/0001 they must live in a Deno-API-free file. `npm run
build` is the gate.

**ADR 0004** (`docs/adr/0004-world-file-writes-are-serialized-per-slug.md`) — every
read-modify-write of a world file runs inside `withWorldLock`. `readWorldUnlocked` /
`writeWorldUnlocked` must not appear in this ticket's diff.

**Do not rename** (CLAUDE.md): `ci-xr-scan`, `ci-xr-geo-fix`, `companion-scan-onboarded`.
None are touched here. Note also that `ProjectStore`'s own DB name `'ci-xr-projects'`
(src/project/project-store.ts:68) is persisted user data and gets the same treatment even
though it predates the registry.

### Pinned decisions

**Location — the viewer sidebar, not the scanner.** A new tab
`#tab-btn-places` / `#tab-places`, added to `#sidebar-tabs` (viewer.html:1017-1022) beside
Scans / World / Layers / Edit, with logic in a new `src/viewer/places.ts`. Rationale: place
management is a desk activity done after capture, on a screen big enough for a list plus a
merge confirmation; the scanner is a capture tool held one-handed while walking, and
08/0003 already gives it the only place interaction it needs. Adding rename/delete/merge to
the phone would also put a destructive control one mis-tap away from `#capture-btn`. See
Open questions.

**Delete — refuse to delete a non-empty place.** `DELETE /projects/:id` returns
**409** with `{ error: 'project has scans', scanCount: N }` when any `ScanEntry` or
`ScanManifest` still points at it. The UI shows "N scans are filed here — move or delete
them first" with a link that filters the scan list to that place. An **empty** place
deletes after a single confirm naming the place: *"Delete "Kitchen"? This place has no
scans. This cannot be undone."* This directly replaces
`ProjectStore.deleteProject`'s current silent cascade over `listScans()`
(src/project/project-store.ts:133-137), which is the data-loss bug this ticket must not
preserve.

**Merge — `POST /projects/:id/merge`, body `{ sourceProjectId }`. Source merges *into*
`:id`; the target survives.**

| Aspect | Pinned behaviour |
| --- | --- |
| Target identity | Keeps `projectId`, `name`, `address`, `notes`, `createdAt`. `updatedAt` bumped |
| Source floors | Appended to `target.floors`, then re-sorted by `level` (matching `addFloor`, src/project/project-store.ts:145). `floorId`s preserved |
| Source rooms | Travel with their floor. `roomId`s preserved |
| Id collision | `floorId`/`roomId` are `` `floor-${Date.now()}` `` / `` `room-${Date.now()}` `` (:143, :156) — same-millisecond creation collides. On collision, mint a fresh id and **remap every scan that referenced the old one** in the same operation |
| `ScanEntry` | Every entry with `projectId === source` gets `projectId = target`. `floorId`/`roomId` preserved, or remapped per the row above |
| `ScanManifest` | Every manifest in `worlds/*.json` with `projectId === source` is rewritten to the target, via `mutateWorldFiles` (ADR 0004) |
| Source record | Deleted **last**, only after every rewrite above has succeeded |
| Self-merge | `sourceProjectId === :id` → **400** |
| Missing source | **200** `{ ok: true, movedScans: 0, alreadyMerged: true }` — *not* 404. This is what makes a retry safe |
| Response | `{ ok, targetProjectId, movedScans, movedFloors, movedRooms, rewrittenManifests, remappedIds }` — merge always reports what it moved |
| Invariant | Total `ScanEntry` count and total `ScanManifest` count are **identical before and after**. Merge moves; it never deletes a scan |

**Merge ordering is the transactionality story.** `projects.json` is serialized by
`mutateProjects` (main.ts:3272-3283) and `worlds/*.json` by ADR 0004's per-slug lock —
**two separate serialization domains, so no single transaction spans both.** The ordering
above is chosen so that any partial failure is safe and re-runnable: rewrites happen first,
the source record is removed last. A crash mid-merge leaves the source project still
present with some of its scans already moved — re-running the identical request finishes
the job, and because a missing source is a 200 rather than a 404, the client can retry
blindly. **At no point does a scan point at a `projectId` that no longer exists.**

**Floor/room labels in the export.** Assignment alone does not make
`src/export/gltf.ts:126-127` meaningful — `` `Floor_${scanEntry.floorId.slice(-4)}` ``
yields `Floor_3719`, an id fragment, not a name. Pin: `exportToGLB` receives the resolved
`Project` alongside `scanEntry` and names the nodes from `Floor.name` / `Room.name` (e.g.
`Ground Floor`, `Kitchen`), keeping `'Floor_Ground'` / `'Room_Unknown'` as the unassigned
fallbacks. Safe: `grep -rn "Floor_\|Room_"` finds no parser of the prefix — the only other
occurrences are `scripts/generate-test-homes.mjs:130-149` (fixture generation) and the
docstring at src/export/gltf.ts:7-8, and `src/viewer/editor.ts:67-68, 119` reads both as
plain display strings.

## Before implementation

- `src/project/project-store.ts` — whole file (246 lines). Especially `deleteProject`
  (:133-137, the cascade), `addFloor`/`addRoom` (:140-160), and the `byProject`/`bySession`
  indexes (:88-89) that make the "scans for this place" query cheap.
- `main.ts:3245-3348` — the entire project block: `ProjectRecord`, `PROJECTS_FILE`,
  `loadProjects`/`saveProjects`, `mutateProjects`, and all five routes.
- `docs/adr/0004-world-file-writes-are-serialized-per-slug.md` — whole ADR, especially the
  Decision section's three locked entry points and the "not reentrant" rule.
- `viewer.html:1012-1082` — the sidebar, its tab buttons, and the `.edit-section` /
  `.world-stat` markup conventions a Places panel should match.
- `src/viewer/viewer.ts:2444-2460` — the tab switcher, to confirm a new tab needs no change
  to it.
- `src/export/gltf.ts:1-30` (the tree docstring), `:60-90` (`ExportData`), `:113-145`.
- `src/main.ts:440-542` — the two `exportToGLB` call sites.
- `docs/factory/08-places-and-things/0003-scanner-place-picker.md` — this ticket must not
  contradict its pins, especially "geo suggests, user confirms".
- `tests/project.spec.ts` (whole file, 150 lines) — the existing `/projects` API test
  patterns to extend.
- `projects.json` — skim it. Seeing ~90 identical Playwright leftovers is the fastest way
  to understand why "real data will exercise untested paths" is in Risks.

## Open questions & answers

- Q: Scanner or editor for this UI? — A: **Editor / viewer sidebar**, pinned above.
  Management is a desk activity; the scanner stays a capture tool. The concrete argument
  beyond ergonomics: the scanner's action rail (index.html:1621-1635) sits directly beside
  `#capture-btn`, and a delete or merge control there is one mis-tap from a destructive
  action during a live scan. (Decided by owner, 2026-08-19.)
- Q: Delete a place with scans — cascade, orphan, or refuse? — A: **Refuse (409)**, pinned
  above. Cascade is what the code does today and it is silent data loss. Orphaning would
  leave `ScanEntry.projectId` pointing at nothing, which every consumer would then have to
  defend against. Refusing is the only option that cannot destroy a scan.
- Q: Which direction does merge run? — A: **Source into target**; the URL's `:id` is the
  survivor. The UI must state this in the confirmation in plain words: *"Merge 'Kitchen (2)'
  into 'Kitchen'. 3 scans move. 'Kitchen (2)' is removed. This cannot be undone."*
- Q: Is merge idempotent? — A: Yes, by the "missing source → 200" rule. Pinned.
- Q: Who rewrites the client-side `ScanEntry` records — server or client? — **OPEN, resolve
  before coding.** Depends on what 08/0002 made canonical. If the server owns the registry,
  merge is entirely server-side and the client just refetches. If `ProjectStore`'s
  IndexedDB is still authoritative for `ScanEntry`, the client must perform its own rewrite
  **after** a successful server merge, and that rewrite must itself be idempotent (setting
  `projectId = target` on a record already at target is a no-op) so an interrupted client
  can re-run. Do not design for both — read 08/0002 and pick one.
- Q: Do floors and rooms need their own routes? — A: **No.** `PUT /projects/:id`
  (main.ts:3324-3336) replaces the whole record and `floors` is part of it. Only merge is a
  new route.
- Q: Does deleting a floor delete its rooms? — A: Yes, structurally — `Room[]` is nested
  inside `Floor` (src/project/project-store.ts:30). So deleting a floor must apply the same
  refusal rule as deleting a place: refuse while any `ScanEntry` still carries that
  `floorId` (or a `roomId` belonging to it).
- Q: Does merge touch `WorldProject.scans` ordering or `EditPatch` records? — A: No. It
  rewrites `ScanManifest.projectId` and nothing else in the world file. Edit patches key off
  `worldId`/`scanId` (src/world/types.ts:131-144) and are unaffected.
- Q: Should merge offer an undo? — A: **OPEN.** Out of scope as pinned, but the response's
  `remappedIds` is deliberately shaped so a future inverse operation is possible. Decide
  whether to keep that field before merging, since removing it later is a breaking change.

## Files impacted

**New:**
- `src/viewer/places.ts` — the Places panel: list, rename, delete, merge, floor/room CRUD,
  scan assignment.
- `tests/mock-place-management.spec.ts` — Playwright, `chromium-mock` project.
- `project_merge.test.ts` (repo root, beside `world_lock.test.ts` and the other Deno tests)
  — merge idempotency and the scan-preservation invariant.

**Changed:**
- `viewer.html` — `#tab-btn-places` / `#tab-places` in `#sidebar-tabs` (:1017-1022) and a
  matching `.sidebar-panel`; panel markup reusing the `.edit-section` convention (:1034+).
- `main.ts` — `POST /projects/:id/merge`; scan-aware `DELETE /projects/:id` (409 path).
- `src/project/project-store.ts` — `renameProject`, `renameFloor`, `deleteFloor`,
  `renameRoom`, `deleteRoom`, `assignScan(scanId, floorId?, roomId?)`; `deleteProject`
  changed to **refuse** on non-empty rather than cascade.
- `src/export/gltf.ts:113-145` — accept the resolved `Project` and name floor/room nodes
  from `Floor.name` / `Room.name`.
- `src/main.ts:468-471, 529-532` — pass the resolved project alongside the selection
  08/0003 already supplies.
- `deno.json` — register `project_merge.test.ts` if the `test` task enumerates files rather
  than globbing (check before assuming).
- `docs/factory/atlas.html` — the wave-08 Places entry (created by 08/0001 or 08/0002; the
  atlas mentions projects exactly once today, the `PROJECTS_FILE` row at :596). Flip the
  badge and add the merge route to the routes/env surface.

## Schema required

**No new domain types.** `Project`, `Floor`, `Room`, `ScanEntry` come from 08/0001
unchanged. Two new API envelopes, and they are request/response shapes rather than domain
records:

```ts
// POST /projects/:id/merge
interface MergeProjectsRequest {
  /** The place being absorbed. Must differ from :id (400 if equal). */
  sourceProjectId: string
}

interface MergeProjectsResponse {
  ok: true
  targetProjectId: string
  movedScans: number
  movedFloors: number
  movedRooms: number
  rewrittenManifests: number
  /** Populated only when a same-millisecond floorId/roomId collision forced a remint. */
  remappedIds: Array<{ kind: 'floor' | 'room'; from: string; to: string }>
  /** True when the source no longer existed — an already-applied merge, replayed. */
  alreadyMerged?: boolean
}
```

Per ADR 0002 these live wherever 08/0001 put the project types, so both `main.ts` and
`src/viewer/places.ts` can import them.

`DELETE /projects/:id` gains one response shape, not a new type:
`409 { error: 'project has scans', scanCount: number }`.

No new env var. `PROJECTS_FILE` (main.ts:3257) already parameterises the backing store.

## Definition of Done

- [ ] A **Places** tab exists in the viewer sidebar and lists every place with its scan
      count
- [ ] Rename works and persists across a reload
- [ ] Deleting an **empty** place works after one explicit confirmation naming the place
- [ ] Deleting a place **with scans** is refused with a 409 and a message stating the count
      — no scan is ever deleted as a side effect of deleting a place
- [ ] `ProjectStore.deleteProject`'s silent `for`-loop cascade over `listScans()`
      (src/project/project-store.ts:133-137) is gone
- [ ] `POST /projects/:id/merge` merges source into target with the pinned semantics
- [ ] Merge is idempotent: replaying the identical request returns 200 with
      `alreadyMerged: true`, and changes nothing
- [ ] Merge preserves every scan: total `ScanEntry` and `ScanManifest` counts are unchanged
- [ ] Merge rewrites `ScanManifest.projectId` through `updateWorld`/`mutateWorldFiles`;
      `readWorldUnlocked`/`writeWorldUnlocked` appear nowhere in the diff
- [ ] A same-millisecond `floorId`/`roomId` collision is detected, reminted, and every
      referencing scan is remapped — reported in `remappedIds`
- [ ] Floors and rooms can be created, renamed, and deleted; deleting one still referenced
      by a scan is refused
- [ ] A scan can be assigned to a floor and a room from the Places panel
- [ ] A GLB exported after assignment carries the floor's and room's **names** (e.g.
      `Ground Floor`, `Kitchen`), not `Floor_3719`, and an unassigned scan still yields
      `Floor_Ground` / `Room_Unknown`
- [ ] `npm run build`, `deno task test`, and `npm run verify` pass

## Tests

Playwright (`tests/mock-place-management.spec.ts`, `--project=chromium-mock`) for the UI,
extending `tests/project.spec.ts`'s request-based patterns for the API, and a Deno test for
the merge invariants.

- [ ] Places tab renders and lists places with scan counts
- [ ] Rename persists across a page reload
- [ ] Delete of an empty place succeeds after confirmation
- [ ] Delete of a place with ≥1 scan is refused; the scan still exists afterwards
- [ ] Merge moves scans: target scan count before + source scan count before === target
      scan count after
- [ ] Merge moves floors and rooms and reports the counts
- [ ] Floor create / rename / delete; room create / rename / delete
- [ ] Assigning a scan to a floor and room persists and shows in the list
- [ ] `project_merge.test.ts` (Deno): **idempotency** — run the same merge twice; second
      returns `alreadyMerged: true` and the on-disk `projects.json` and `worlds/*.json` are
      byte-identical to the post-first-merge state
- [ ] `project_merge.test.ts` (Deno): **scan preservation** — seed N scans across both
      places, merge, assert exactly N afterwards, all on the target
- [ ] `project_merge.test.ts` (Deno): **self-merge** returns 400
- [ ] `project_merge.test.ts` (Deno): **missing source** returns 200 with
      `alreadyMerged: true`
- [ ] `project_merge.test.ts` (Deno): **id collision** — two floors with an identical
      `floorId`; assert a remint, a `remappedIds` entry, and that the scan that referenced
      the old id now references the new one
- [ ] `project_merge.test.ts` (Deno): **partial-failure replay** — interrupt after the scan
      rewrite but before the source delete, re-run, and assert the final state matches a
      clean merge

```
# verification commands
npm ci                 # NEVER `npm install` — see CLAUDE.md; a mutated tree makes
                       # Playwright report a bogus "two different versions of
                       # @playwright/test"
npm run build          # tsc --noEmit && vite build
deno task check
deno task test         # includes project_merge.test.ts
npx playwright test --project=chromium-mock mock-place-management
npx playwright test --project=api project
npm run verify
```

## Acceptance Criteria

- [ ] Given two places named "Kitchen" (the duplicate that geo-suggest-confirm inevitably
      produces), When the user merges one into the other, Then every scan from both is
      filed under the survivor and none is lost
- [ ] Given a merge that is retried after a network failure, When the identical request is
      replayed, Then the result is a 200 with `alreadyMerged: true` and no double-move
- [ ] Given a merge interrupted between the scan rewrite and the source delete, When the
      request is re-run, Then the final state matches a clean merge — and at no point does
      any scan reference a deleted `projectId`
- [ ] Given a place with 3 scans, When the user tries to delete it, Then it is refused with
      "3 scans are filed here" and all 3 scans still exist
- [ ] Given a place with 0 scans, When the user confirms deletion, Then it is removed
- [ ] Given a scan assigned to floor "Ground Floor" and room "Kitchen", When it is exported,
      Then the GLB's floor and room nodes are named `Ground Floor` and `Kitchen`
- [ ] Given a scan with no assignment, When it is exported, Then the nodes remain
      `Floor_Ground` and `Room_Unknown`
- [ ] Given the scanner (`index.html`), Then it offers no rename, delete, or merge control

## Risks / potential issues

- **Risk: merge is the sharp edge.** It rewrites `projectId` across many `ScanEntry`
  records and many `worlds/*.json` manifests, spanning two independent serialization
  domains — `mutateProjects` (main.ts:3272-3283) and ADR 0004's per-slug world lock. There
  is no transaction across both, and a partially-applied merge is worse than no merge. —
  **Mitigation:** the pinned ordering (rewrite first, delete the source last), idempotency
  by design (missing source → 200), and the Deno partial-failure-replay test. Reviewers
  should treat any reordering of those three steps as a correctness bug.
- **Risk: ADR 0004's lock is not reentrant.** A merge that iterates worlds and calls
  `updateWorld` from inside another `updateWorld` mutator deadlocks. — **Mitigation:** use
  `mutateWorldFiles` (one lock per file, sequentially) for the sweep, never a nested
  `loadWorld`/`updateWorld` for the same slug. The ADR states this explicitly.
- **Risk: deleting a place is data loss.** The current cascade
  (src/project/project-store.ts:133-137) already deletes every scan silently. — **Mitigation:**
  the 409 refusal rule, and an explicit DoD item that the cascade loop is gone. Do not leave
  it in place "for the empty case" — an empty place has nothing to cascade over, so keeping
  the loop only preserves the hazard.
- **Risk: floors and rooms have never seen real data.** Every record in `projects.json` is
  Playwright residue with one auto-created "Ground Floor" and `"rooms": []`. Nothing has
  ever created a room, sorted a non-trivial `floors` array, or hit the `floorId` collision
  path. — **Mitigation:** the Deno tests seed real multi-floor, multi-room fixtures rather
  than reusing `projects.json`; treat every floor/room code path as unverified.
- **Risk: `PUT /projects/:id` is a whole-record last-write-wins replace**
  (main.ts:3331: `projects[idx] = { ...body, projectId: id, updatedAt: Date.now() }`).
  `mutateProjects` serializes the write but not the read-modify-write across two HTTP
  requests, so two editors racing lose one edit, and a client that PUTs a body missing
  `floors` silently drops every floor. — **Mitigation:** the Places panel always PUTs the
  full record it just read, and refetches after every mutation. Flagged rather than fixed —
  a proper conditional update is its own ticket.
- **Risk: `ScanEntry` lives in browser IndexedDB while manifests live server-side**, so
  "merge" may need a client half. — **Mitigation:** the OPEN question above; resolve against
  08/0002 before coding and design for exactly one registry.
- **Risk: renaming a place breaks nothing visible, so it looks safe** — but 08/0003's
  session key stores a `projectId`, and 08/0005 derives world scan lists. — **Mitigation:**
  rename only ever changes `name`; `projectId` is immutable, everywhere, always. Merge is
  the only operation that changes a scan's `projectId`.
- **Risk: `projectId` is fixed at capture time** (owner decision, 08/0002), so this panel is
  the *only* legitimate way a scan's place ever changes afterwards. — **Mitigation:** keep
  it that way; reject any other write path added elsewhere.

## Subtasks

1. [ ] Resolve the OPEN registry-ownership question against 08/0002 — server-side merge
       only, or server + idempotent client rewrite. Do not start until it is answered
2. [ ] Add `#tab-btn-places` / `#tab-places` to `viewer.html` and confirm the existing
       switcher (src/viewer/viewer.ts:2444-2456) picks it up with no change
3. [ ] `src/viewer/places.ts`: list places with scan counts, matching `.edit-section` markup
4. [ ] Rename, wired through `PUT /projects/:id` with a full-record PUT
5. [ ] Replace `ProjectStore.deleteProject`'s cascade with the refusal rule; add the 409
       path to `DELETE /projects/:id`; wire the confirm UX
6. [ ] Floor and room CRUD (create / rename / delete), including the "refuse while
       referenced" rule for delete
7. [ ] Scan → floor/room assignment (`ScanEntry.floorId` / `roomId`)
8. [ ] `POST /projects/:id/merge` inside `mutateProjects`, with the pinned ordering,
       collision remint, and full response envelope
9. [ ] Manifest rewrite via `mutateWorldFiles` (ADR 0004); confirm no unlocked primitive
       appears in the diff
10. [ ] Merge UI: pick source, pick target, confirmation stating direction, counts, and
        irreversibility
11. [ ] `src/export/gltf.ts:113-145` — accept the resolved `Project`, name nodes from
        `Floor.name`/`Room.name`, keep the unassigned fallbacks
12. [ ] Pass the resolved project at both `exportToGLB` call sites (src/main.ts:468-471,
        :529-532)
13. [ ] `project_merge.test.ts` — all six Deno cases
14. [ ] `tests/mock-place-management.spec.ts` — the UI cases
15. [ ] `npm run build`, `deno task test`, `npm run verify`
16. [ ] Update the wave-08 atlas entry: flip the badge, add the merge route
