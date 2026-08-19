# Wave: 08-places-and-things

Nine tickets to make the product's own tagline true. `index.html` says *"Private spatial
memory for places you own."* Today the system has no concept of a place, no concept of a
thing that persists between visits, and no way to look at a moment in time.

It is not that these were never designed. Two of the three already exist in the codebase
as fully-typed, entirely unused declarations.

## What is actually there

**A place model that was written and never wired.** `src/project/project-store.ts`
declares `Project { projectId, name, address?, notes?, floors: Floor[] }`,
`Floor { floorId, name, level, rooms: Room[] }`, `Room { roomId, name, zone? }`, and
`ScanEntry { scanId, projectId, sessionId, … }` — a many-to-one foreign key from scans to
places, with an IndexedDB `byProject` index, a `listScans(projectId)` query, and a server
CRUD mirror at `/projects` backed by `PROJECTS_FILE`. `architecture.md` diagrams it as the
top of the ER model.

`projectStore` is constructed at `src/main.ts:163` and never referenced again. Nothing
calls `createProject`, `addScan`, or `listScans`. `scanEntry` is never built, so
`projectId` in every exported GLB is permanently `null` and every detection is filed under
`Floor_Ground` / `Room_Unknown`. Until this wave's atlas pass,
`docs/factory/atlas.html` did not mention `projectId` once.

**A world that looks like a place and isn't.** `synthesizeWorld(slug)` ignores its own
slug: it takes a global `readDir` of every scan on disk and keeps the first 24.
`refreshWorldScans` then pushes every new scan into every world. Creating a second world
gives you a second view of the same global bucket. ADR 0003 already conceded this in
writing — *"no `WorldProject` association today"* — and parked everything under `'default'`.
There is also no distance guard: `docs/UI_MANUAL.md:610` records a real incident where a
phone scan in one location and test homes in another landed in one ENU frame and broke the
overview.

**No time axis.** `docs/UX_FLOW.md:260` states it plainly: *"Time is stored but not
scrubbable."* `capturedAt` is rendered as a string and nothing sorts, groups, or ranges by
it. `sessionId` is read by the viewer only to build splat sidecar URLs.

**A merge that throws away the evidence of movement.** `mergeDetections` keeps the *first*
observation's position and timestamp and discards every later one, bumping only confidence.
A chair that moves during a walkthrough is already unrepresentable — before anyone asks the
harder question of whether it moved between two walkthroughs.

## Why GPS cannot do this for us

Place assignment is explicit — geo only ever *suggests*, and a human confirms. That is not
caution for its own sake. On 2026-08-19, on a Galaxy Tab S8 Ultra sitting still on a table,
the geo chip reported two different street addresses — `30902 Club House Drive` and
`30856/30862 Calle Moraga` — with accuracy swinging between ±5 m and ±33 m and coordinates
wandering roughly 65 m. Auto-clustering by coordinate would have filed one room as two
places, or two rooms as one.

## The ownership rule

The decision that shapes the whole wave:

> **Project owns scan membership. World derives it.**

A scan is captured *at a place* — a physical fact, fixed at capture time, so `projectId` is
the durable truth. A world is a *composition choice* — "these scans of this place, stitched,
shared at this slug" — so `world.scans[]` becomes a filter over a project's scans rather
than an independent list. That single rule is also what kills the global-sweep bug.

```
Project   projectId   physical place, addressed, has floors/rooms   ← owns membership
  Session sessionId   one walkthrough visit
    Scan  scanId      one uploaded GLB
      observations of Things
Thing     thingId     an object corresponded across sessions
World     worldId     a shareable composed view over a Project      ← derived
```

`Thing` is the only genuinely new type in waves 07 and 08. Ticket 0007 documents the ADR
0001 search that justifies it — `WorldDetection` has no stable id, `DetectObject` and
`FurnitureItem` both carry header comments explicitly refusing unification, and `EditPatch`
is a user edit, not an object identity.

## Why this order

**0001 and 0002 first, because everything is downstream of `projectId` being real.** 0001
is types only — moving the place model into `src/world/types.ts` so both runtimes can import
it under ADR 0002, and adding `projectId` to `ScanManifest`. 0002 makes it flow from capture
through export and upload into the manifest. No UI in either.

**0003 then 0004** put a human in the loop: the picker that records the place at capture
time, then the management surface that makes duplicate places fixable. Management follows
the picker because geo-suggest-confirm *will* produce two "Kitchen"s, and merge is the
answer to that — not a way to avoid it.

**0005 converts the world.** It is deliberately after 0002 and separate from it, because it
changes what every existing world contains and deserves its own review.

**0006 is independent of the entire place chain** and can land in parallel with 0001–0005.
It only needs wave 07's node-level provenance. It is the substrate for 0007: until every
observation survives with its own session and timestamp, there is nothing for a matcher to
compare.

**0007 is the hard one.** A wrong match is worse than no match, because 0009 then propagates
a wrong tag into every future visit. The heuristic is biased toward leaving things unmatched.

**0008 needs only wave 07** and can land early — but it is listed late because a scrubber
over uncorresponded scans shows *change* without explaining it. It becomes far more useful
after 0007.

**0009 last**, since it depends on correspondence existing and being correctable.

## Tickets

| # | Ticket | One-line goal |
|---|--------|---------------|
| 0001 | [unify-place-model-types](0001-unify-place-model-types.md) | One place model, in the one home the browser can import from — and `projectId` on `ScanManifest` |
| 0002 | [wire-place-registry](0002-wire-place-registry.md) | Make the dead `ProjectStore` real: carry `projectId` capture → export → upload → manifest |
| 0003 | [scanner-place-picker](0003-scanner-place-picker.md) | Ask which place this is *before* AR starts — geo suggests, the user confirms |
| 0004 | [place-management](0004-place-management.md) | Rename, delete, **merge**, and floor/room assignment — the duplicate places the picker will inevitably create |
| 0005 | [world-as-derived-view](0005-world-as-derived-view.md) | Stop every world absorbing every scan; add the geo-distance guard that `UI_MANUAL.md` already asked for |
| 0006 | [non-destructive-observations](0006-non-destructive-observations.md) | Stop discarding every observation after the first — keep each with its own session and timestamp |
| 0007 | [thing-correspondence-job](0007-thing-correspondence-job.md) | Know that the chair in session 1 is the chair in session 2 — added / removed / moved, as a `WorldJob` |
| 0008 | [timeline-scrubber](0008-timeline-scrubber.md) | Make time scrubbable, against the per-scan visibility machinery that already exists |
| 0009 | [tags-follow-things](0009-tags-follow-things.md) | Tag "my armchair" once and have it stay tagged across visits |

**Parallelism.** 0006 → 0007 is independent of the place chain and can run alongside
0001–0005. 0008 needs only wave 07. The place chain (0001 → 0002 → {0003 → 0004, 0005}) is
strictly serial because 0002–0005 all touch `main.ts`'s world-synthesis path.

## Atlas diff

Three of these had no "before" in the atlas at all. This wave's atlas pass added the
description first, then diffed it — a diff against nothing is not a diff. Those three
are marked *(gap filled)* below; the atlas now carries both halves.

- **`Project` / `Floor` / `Room`** — *(gap filled: `projectId` previously appeared zero
  times in the atlas.)* Today declared in `src/project/project-store.ts`, constructed
  once at `src/main.ts:163` and never used again → Project is the place that owns scan
  membership (0001, 0002).
- **`WorldProject`** — today `synthesizeWorld` ignores its own slug and every world absorbs
  every scan globally → a derived view over one Project's scans, with a distance guard (0005).
- **`PROJECTS_FILE`** — today backs a CRUD API nothing calls → the live place registry (0002).
- **`WorldDetection` merge** — today `mergeDetections` keeps the first observation and
  discards the rest → every observation retained with its own session and timestamp (0006).
- **Temporal** — *(gap filled: `timeline`, `temporal` and `scrub` previously appeared
  zero times in the atlas.)* Today `UX_FLOW.md:260` concedes "Time is stored but not
  scrubbable" → the editor scrubs the composite by session (0008).
- **`EditPatch` tags** — today scoped to one `scanId` via a scan-namespaced `targetId`, so a
  tag cannot follow an object across visits → tags resolve through their Thing (0009).
- **`Thing` / correspondence** — new capability, no prior entry (0007).

## Deferred

**The real consolidated GLB.** The owner's merge decision is hybrid: phase 1 keeps the
existing multi-root virtual composite, because that is what keeps every scan independently
filterable for the scrubber. A single merged artifact per place is deferred to a later wave
that revives `export-world` — an existing placeholder `WorldJobType` whose stated purpose is
already *"combined GLB and semantic JSON worker"*. Nothing new needs to be added to the job
system for it; `@gltf-transform/functions` already ships `mergeDocuments`, installed and
unimported, and `lingbot_map_glb.ts` already proves the Deno server can author a GLB from
scratch. Wave 07 ticket 0004 is what makes that merge reversible.

**Atlas backlog.** The Development-waves section of `docs/factory/atlas.html` was three
waves behind — 04, 05 and 06 had no cards. Noted here rather than made a ticket; it was
fixed as part of this wave's atlas pass, which backfilled all three alongside 07 and 08.
