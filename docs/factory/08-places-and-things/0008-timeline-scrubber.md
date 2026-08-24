> **Type:** Frontend
> **Wave:** 08-places-and-things
> **Branch:** `feat/timeline-scrubber`
> **Commit style:** `feat(viewer): summary`
> **Design:** this ticket is the spec
> **Dependencies:** wave 07 ticket 0001 (unique `scanId` per GLB) only. Deliberately
> **not** dependent on 0006, 0007, or 0009 — the scrubber drives the visibility
> machinery that already exists and needs no correspondence data. It can land early and
> in parallel with the rest of the place chain.

## Goal

Give the World Editor a time axis. Scrub across the sessions of the current world and
see the place as it was believed to be at that point, instead of every scan ever
uploaded piled into one scene with no way to separate them but a column of checkboxes.

## The gap, precisely

There is **no** temporal filtering of any kind in the viewer today. Verified by reading
the source:

- `ScanManifest.capturedAt` (`src/world/types.ts:155`) is read in exactly **one** place
  in the whole viewer — `src/viewer/viewer.ts:611-614`, where it is formatted into a
  display string (`'Unknown date'` when absent) and dropped into the scan row's meta
  line. Nothing sorts by it, groups by it, ranges over it, or scrubs it. `grep -n
  capturedAt src/viewer/viewer.ts` returns one hit.
- `world.scans` is never sorted. `buildScanList` (`:569-587`) iterates the array in
  server order; the only `.sort()` in the file is label-collision depth ordering at
  `:493`.
- `ScanManifest.sessionId` (`src/world/types.ts:148`) exists and is populated
  (`main.ts:1385`), but the viewer reads it in exactly four places — `:1209`, `:1212`,
  `:1313`, `:1379` — all of them splat / LingBot-Map sidecar URL construction and
  "this scan has no streamed keyframes" guards. It is **never** used for grouping or
  filtering. `sessionId` appears nowhere at all in `viewer.html`.

`../../product/UX_FLOW.md:260` already concedes this in writing:

> **Time is stored but not scrubbable.** `capturedAt`, per-frame timestamps, and the
> ordered `EditPatch[]` history all exist, but there is no timeline / scrubber /
> before-vs-after diff. "4D" is achievable only by toggling `.scan-visible` checkboxes.

That line is the ticket. This change is what makes it false.

## What already exists to build on

The visibility machinery is already correct and already composes. **Drive it; do not
build a second one.**

- **Per-scan visibility works.** Each scan row gets a checkbox (`viewer.ts:595-608`)
  whose `change` handler sets `loaded.visible`, mirrors it onto `loaded.root.visible`,
  and calls `applyLayerVisibility()`.
- **Visibility is already a 2-D AND.** `applyLayerVisibility` (`:1951-1994`) composes
  `{scan visible} × {layer type visible}` at `:1959` —
  `loaded.visible && layerVisibilityFor(type, …)` — with `layerVisibilityFor` at
  `:1996-2003`.
- **Everything else already gates on the owning scan.** Detection bounds read
  `loadedScans.get(scanId)?.visible ?? true` (`:1965-1970`); HTML labels do the same
  through `isLabelVisible` (`:513-517`).
- **Every detection object already carries its `scanId`.** LOD nodes get
  `{ ...data, scanId, objectId: `${scanId}:${name}:lod` }` (`:834-838`); bounds wires get
  `wire.userData['scanId'] = scanId` (`:1095-1096`); `assignStableObjectIds`
  (`:864-875`) stamps `scanId` onto every node in the tree.
- **`LoadedScan`** (`:58-66`) is the per-scan record the whole thing hangs off:
  `{ manifest, root, layerNodes, points, visible, loaded, error? }`.

The scrubber adds a third term to that AND. It does not reimplement any of it.

## Non-goals

- Do not build a compare-two-sessions view. One cursor, one composite.
- Do not colour-by-session. Scans keep their own materials.
- Do not add diff highlighting, change badges, or added/removed/moved markers — that
  arrives with 0007's correspondence data and 0009. This ticket must not import
  anything from `thing_match.ts` or read `world.things`.
- Do not change how scans load. `enqueueScanLoad` (`:645-653`) and
  `loadScanIntoWorld` (`:655+`) are untouched: every scan in the world still loads, the
  scrubber only changes what is *shown*. Lazy-loading by time window is a separate,
  later question.
- Do not use `LayerType` as the time axis (see Risks — it structurally cannot be one).
- Do not mutate `LoadedScan.visible` from the scrubber. That field belongs to the
  checkbox.
- Do not add a server route or a schema field. Everything needed is already on
  `ScanManifest`.

## Pinned conventions

**ADR 0001** — this touches a client-side view of existing data. Nothing new is
declared. What it reuses:

| Existing | Where | How used |
| --- | --- | --- |
| `ScanManifest.capturedAt` | `src/world/types.ts:155` | the time value; **reused**, not supplemented with a second timestamp |
| `ScanManifest.sessionId` | `src/world/types.ts:148` | the grouping key; already populated, currently read only for sidecar URLs |
| `LoadedScan` | `src/viewer/viewer.ts:58-66` | **extended** by one boolean, `inTimeWindow` |
| `applyLayerVisibility()` | `:1951-1994` | reused as the single place visibility is recomputed — the scrubber calls it, exactly like the checkbox handler does |
| the per-scan checkbox | `:595-608` | reused and kept authoritative over `loaded.visible` |
| the `'Unknown date'` string | `:612-614` | reused verbatim for null-`capturedAt` axis labelling — do not invent a second wording |
| `escHtml` | already in `viewer.ts` | any label the scrubber renders |

**ADR 0002** — no new shared type is needed, so nothing new lands in
`src/world/types.ts`. `LoadedScan` is viewer-local and stays there. `npm run build`
(`tsc --noEmit && vite build`) is the gate for this ticket, not `deno task check` — the
diff is browser-side.

**ADR 0004** — N/A. This ticket writes nothing to `worlds/*.json`. If a future revision
wants to persist the cursor position, it goes through `updateWorld()`; this one does not
persist it at all.

### Pinned: point-in-time, cumulative

**The cursor is a point in time, and the view is cumulative as of that point.** A scan
is in the time window when `effectiveCapturedAt(scan) <= cursor`. Scrubbed fully right,
the scene is exactly what the editor shows today (every scan). Scrubbing left removes
later sessions, revealing the earlier state of the place.

Explicitly: **a scan captured before the cursor and never re-observed since stays
visible.** "As of visit N" means *everything known about this place as of visit N*, not
*only what visit N re-walked*. The alternative — hiding a room because you did not
re-scan it this month — would empty the house and is the wrong answer for a place model.
The refinement, "show the composite the correspondence data says was actually there,"
requires 0007 and is deliberately deferred; when it lands it changes what `<=` means,
not the control.

Not a range. A two-handle range slider is the obvious next request and is a non-goal
here: it doubles the state, doubles the test matrix, and the compare-two-sessions view
it enables is explicitly out of scope.

### Pinned: sessions are the axis, not scans

The cursor moves between **sessions**, not individual scans — a walkthrough is the unit
a person remembers. Grouping:

- Group `world.scans` by `sessionId` (`src/world/types.ts:148`).
- A scan with `sessionId === null` forms its own singleton pseudo-session keyed by its
  `scanId`.
- A session's time is `min(effectiveCapturedAt)` across its scans.
- Sessions sort ascending by that time. The slider has one stop per session, plus the
  implicit rightmost position (= all).

This is why wave 07's ticket 0001 is the dependency: `scanIdFor`
(`main.ts:1359-1363`) currently returns `` `scan-${safeSlug(sessionId)}` `` whenever the
meta carries a `sessionId`, so **today every GLB from one session collides onto one
`scanId`** and session-grouping is indistinguishable from scan-grouping. Once `scanId`
is unique per GLB, `sessionId` becomes the genuine grouping key it was always meant to
be — and the grouping code above becomes load-bearing rather than a no-op.

### Pinned: null `capturedAt` sorts first and is always visible

`effectiveCapturedAt(scan)` returns `Date.parse(scan.capturedAt)` when it parses, and
`-Infinity` otherwise. Consequences, all deliberate:

- A null-`capturedAt` scan sorts **before** every dated scan.
- It is therefore inside the window at **every** cursor position, including the
  leftmost. It is never hidden.
- Its axis label reuses the existing `'Unknown date'` string (`viewer.ts:612-614`).
- An unparseable `capturedAt` (`Number.isNaN` — the viewer already guards for this at
  `:612`) is treated identically to null.

Rationale: hiding a scan because its timestamp is missing is a silent data-loss-shaped
failure — the user cannot tell "filtered out" from "gone". Never-hidden is the safe
default. In practice this is rare: the server fills `capturedAt` from
`meta.capturedAt ?? meta.exportedAt ?? scan.uploadedAt` (`main.ts:1393`), so a null
mostly comes from a hand-edited or synthesized world file — but the type is
`string | null` (`types.ts:155`) and the viewer must honour it.

### Pinned: the checkbox vetoes, the scrubber gates

They must not fight, and the resolution is that **they compose, exactly like layer
visibility already composes**. A scan renders when it is *both* in the time window
*and* checked:

```
rendered = loaded.inTimeWindow && loaded.visible && layerVisibilityFor(type, …)
```

Mechanically:

- Add `inTimeWindow: boolean` to `LoadedScan` (`viewer.ts:58-66`), default `true`.
- The scrubber sets `inTimeWindow` and calls `applyLayerVisibility()`. It **never**
  writes `loaded.visible` — that field stays owned by the checkbox handler
  (`:601-608`), so unchecking a scan, scrubbing away, and scrubbing back leaves it
  unchecked. The user's explicit choice is never clobbered by a scrub.
- Add one helper, `scanRendered(loaded: LoadedScan): boolean` returning
  `loaded.visible && loaded.inTimeWindow`, and route the four existing read sites
  through it: `:1956` (`loaded.root.visible = …`), `:1959` (the layer AND), `:1969`
  (detection bounds), and `:516` (`isLabelVisible`). Detections, bounds, and labels then
  follow for free, because they already gate on the owning scan.
- When a scan is outside the window, disable and dim its row's checkbox so the two
  controls read as related rather than contradictory. Re-enable it when the scan
  re-enters the window; do not change its `checked` state while disabled.

Precedence in one sentence: **the scrubber decides what is available; the checkbox
decides what, among the available, is shown.**

## Before implementation

- `src/viewer/viewer.ts:58-66` — `LoadedScan`, the record gaining one field
- `src/viewer/viewer.ts:569-643` — `buildScanList` / `buildScanItem`, where the
  checkbox and the `capturedAt` label are built
- `src/viewer/viewer.ts:1951-2003` — `applyLayerVisibility` and `layerVisibilityFor`,
  the AND this extends
- `src/viewer/viewer.ts:513-517` — `isLabelVisible`, the fourth read site
- `src/viewer/viewer.ts:2699-2722` — `refreshWorldScans`, which streams in scans that
  appeared after page load and must re-derive the axis
- `viewer.html:1026-1027` (`#scan-list`) and `viewer.html:254`, `:284` (its styles) —
  where the control goes
- `src/world/types.ts:146-163` — `ScanManifest`, especially `capturedAt: string | null`
  and `sessionId: string | null`
- `main.ts:1359-1363` (`scanIdFor`) and `main.ts:1393` (the `capturedAt` fallback
  chain) — why wave 07 is the dependency, and why nulls are rare
- `../../product/UX_FLOW.md:260` — the sentence this ticket makes false
- `src/world/layers.ts:37-52` — enough to see why layers are not the axis
- Wave 07 ticket 0001, once drafted

## Open questions & answers

- Q: Timeline scrubber, solo checkboxes, compare-two, or colour-by-session? — A:
  **Timeline scrubber.** The other three are explicit non-goals. (owner, 2026-08-19)
- Q: Point-in-time or range? — A: **Point-in-time, cumulative** — a scan is shown when
  its capture time is at or before the cursor. Pinned above with the reasoning. (owner,
  2026-08-19)
- Q: What does "as of" mean for a scan captured before the cursor but not re-observed
  since? — A: **It stays visible.** The composite is everything known as of that moment.
  Refining this to "what correspondence says was actually still there" is 0007/0009
  work. (owner, 2026-08-19)
- Q: Which wins, the scrubber or the per-scan checkbox? — A: **Neither overrides the
  other; they AND.** The scrubber never writes `loaded.visible`. Pinned above. (owner,
  2026-08-19)
- Q: Sessions or individual scans as the axis stops? — A: **Sessions**, with null-session
  scans as singleton pseudo-sessions. (owner, 2026-08-19)
- Q: Where exactly does the control live in the DOM, and what is it? — **OPEN, low
  stakes.** Starting point: a `<div id="time-scrubber">` inserted above `#scan-list`
  (`viewer.html:1026`), containing an `<input type="range">` with `min=0`,
  `max=sessionCount`, `step=1`, a live readout of the selected session's formatted date,
  and the count of scans currently in-window. Keyboard-operable for free via the native
  range input; give it an `aria-label` and `aria-valuetext` carrying the date. Settle
  during implementation.
- Q: Should the cursor persist across reloads? — **OPEN.** Recommend **no** for this
  ticket: default to the rightmost position (= all scans, today's exact behaviour) on
  every load, so nobody opens the editor to a half-empty scene and files a bug. If it
  later should persist, it is a URL query param, not a new storage key — and note that
  `localStorage`/`sessionStorage` keys in this repo are do-not-rename once shipped
  (CLAUDE.md), so do not add one casually.
- Q: What happens when a world has zero or one session? — A: Hide the control entirely
  at zero or one. A one-stop slider is noise.
- Q: Does the scrubber affect the geomap, the HUD counts, or the quality panel? —
  **OPEN.** Recommend: HUD scan/point counts should reflect the visible set (they read
  from `loadedScans` already), the geomap should not (it is a separate, world-level
  view). Confirm during implementation and state the answer here.

## Files impacted

Changed:
- `src/viewer/viewer.ts` — `LoadedScan` (`:58-66`); `isLabelVisible` (`:513-517`);
  `buildScanItem`'s checkbox and meta line (`:589-643`); `applyLayerVisibility`
  (`:1951-1994`); `refreshWorldScans` (`:2699-2722`); plus the new
  `effectiveCapturedAt` / `sessionGroups` / `scanRendered` / `applyTimeCursor` helpers
- `viewer.html` — the scrubber markup above `#scan-list` (`:1026`) and its styles near
  `:254`
- `../../product/UX_FLOW.md:260` — rewrite the "Time is stored but not scrubbable" bullet; it
  becomes false the moment this lands
- `docs/factory/atlas.html` — the "Multi-scan World Editor" fcard (`~:442`) gains a
  before/after diff line: per-scan checkboxes only → a session timeline

New:
- `tests/mock-timeline-scrubber.spec.ts` — Playwright, `chromium-mock` project

## Schema required

**None.** No new type, no new field on any persisted shape, no new route, no new config
variable. `capturedAt` and `sessionId` already exist on `ScanManifest`
(`src/world/types.ts:148`, `:155`) and are already populated by the server
(`main.ts:1385`, `:1393`). The one new field, `LoadedScan.inTimeWindow: boolean`, is a
viewer-local runtime record that is never serialised.

## Definition of Done

- [ ] The World Editor shows a session timeline above the scan list when the world has
      two or more sessions, and hides it otherwise
- [ ] Scrubbing changes which scans render, and their detections, bounds, and HTML
      labels follow automatically
- [ ] The scrubber sets `LoadedScan.inTimeWindow` and calls `applyLayerVisibility()`; it
      never writes `LoadedScan.visible`
- [ ] All four existing scan-visibility read sites go through one `scanRendered()` helper
- [ ] Sessions are ordered by `min(capturedAt)`; scans with null/unparseable
      `capturedAt` sort first and are visible at every cursor position
- [ ] Scans arriving via `refreshWorldScans` re-derive the axis and land in the right
      window
- [ ] On load the cursor sits at the rightmost stop, so the default view is byte-for-byte
      today's behaviour
- [ ] `../../product/UX_FLOW.md:260` no longer claims time is not scrubbable
- [ ] `npm run build` and `npm run verify` pass

## Tests

Playwright, `tests/mock-timeline-scrubber.spec.ts`, `--project=chromium-mock`, seeded
the way `tests/mock-editor-homes.spec.ts` and `tests/mock-editor-quality.spec.ts` do
(real upload pipeline, `API_URL` / `VITE_URL`, `/scans` fetches routed to the API
server):

- [ ] Scrubbing changes which scans render — seed a world with three scans across three
      sessions at distinct `capturedAt`; assert the count of visible scan roots (or
      visible `.scan-item` rows marked in-window) changes as the cursor moves, and that
      the leftmost stop shows only the earliest session
- [ ] Cumulative semantics hold — at the middle stop, the earliest session is **still**
      visible and the latest is not
- [ ] Null `capturedAt` does not break ordering — seed a fourth scan with
      `capturedAt: null`; assert the page does not throw, the session order is stable,
      and that scan is visible at every cursor position including the leftmost
- [ ] Existing per-scan checkboxes still work — uncheck a scan inside the window and
      assert it hides; assert scrubbing away and back leaves it unchecked
- [ ] The scrubber does not resurrect an unchecked scan
- [ ] Default position — on first load, every scan is visible (no regression against
      today's behaviour)
- [ ] The control is absent for a single-session world
- [ ] Detections and labels follow their scan — with the cursor excluding a scan, that
      scan's detection bounds and HTML labels are hidden too

```
npm run build
npm run verify

# the new spec, with the mock harness running (see tests/mock-editor-quality.spec.ts's header)
npm run gen:test-data
API_URL=http://localhost:8000 VITE_URL=http://localhost:5173 \
  npx playwright test --project=chromium-mock mock-timeline-scrubber
```

## Acceptance Criteria

- [ ] Given a world with three sessions, When the cursor is at the earliest stop, Then
      only the earliest session's scans render
- [ ] Given the cursor is at the middle stop, When the scene is inspected, Then sessions
      one and two render and session three does not
- [ ] Given a scan with `capturedAt: null`, When the cursor is at any stop, Then that
      scan renders
- [ ] Given a scan is unchecked, When the cursor moves so that scan enters the window,
      Then it stays hidden
- [ ] Given a scan is outside the window, Then its row's checkbox is disabled and dimmed,
      and its `checked` state is unchanged
- [ ] Given a new scan is uploaded while the editor is open, When `refreshWorldScans`
      streams it in, Then the timeline gains its session and the scan honours the current
      cursor
- [ ] Given a single-session world, Then no timeline control is rendered
- [ ] `npm run build` and `npm run verify` pass

## Risks / potential issues

- **Risk:** Wave 07's unique-`scanId` fix means a world will suddenly hold many more
  *visible* scans than it ever has. Today `scanIdFor` (`main.ts:1359-1363`) collapses
  every GLB from one session onto one `scanId`, and both `scanItems` and `loadedScans`
  are keyed by `scanId` — so four collided scans render as one. This scrubber lands into
  a busier scene than the current code has ever rendered, and it will be blamed for the
  slowdown that the id fix actually caused. — **Mitigation:** land 0001 first, measure
  the before/after frame cost on a real multi-scan world *before* adding the scrubber, so
  the two effects are separable. Say so in the commit message.
- **Risk:** Toggling many roots is O(scans × layer nodes) per scrub tick, and
  `applyLayerVisibility` (`:1951-1994`) walks every `layerNodes` set plus every
  `detectionBoundsObjects` entry plus every label on each call. Dragging a slider fires
  it continuously. — **Mitigation:** only recompute when the derived window actually
  changes (compare the in-window session-id set, not the raw slider value), and coalesce
  to one call per animation frame. Do not optimise `applyLayerVisibility` itself in this
  ticket.
- **Risk:** `LayerType` looks like the natural axis and is not. It is a closed union of
  eleven members (`src/world/types.ts:1-12`) with no session or time discriminator; layer
  ids are type-derived — `` id: `layer-${type}` `` (`src/world/layers.ts:47`) — so they
  **collide across every scan** in a world, and `globalLayerVisible` is one flat record
  keyed by `LayerType`, shared by all scans (`viewer.ts:1997`). Filtering time through
  layers would either hide a layer everywhere or need a per-scan layer id, which is a
  much larger change. — **Mitigation:** the axis is the scan/session, via
  `LoadedScan.inTimeWindow`. Leave `LayerType` and `layer-${type}` alone. This note
  exists so the next person does not rediscover the collision the hard way.
- **Risk:** The cumulative rule quietly becomes wrong once 0007 lands — "everything known
  as of T" and "what correspondence says was there at T" diverge exactly when an object
  is removed between visits. — **Mitigation:** it is pinned as a deliberate first
  iteration and named in Open questions; 0009's work is where it gets refined. Do not
  pre-build for it here.
- **Risk:** Disabling a checkbox for an out-of-window scan can read as "this scan is
  broken." — **Mitigation:** dim the whole row and title the checkbox with the reason
  ("outside the selected time"), rather than disabling the control in isolation.
- **Risk:** A world where every scan shares one `capturedAt` (a bulk import, or the
  `uploadedAt` fallback firing for a whole batch — `main.ts:1393`) produces a
  single-stop, useless axis. — **Mitigation:** the hide-below-two-sessions rule covers
  the degenerate case; a multi-session world with identical timestamps still gets one
  stop per session because the stops are sessions, not distinct timestamps.

## Subtasks

1. [ ] Confirm wave 07 ticket 0001 has landed and `scanId` is unique per GLB; capture a
       before/after render cost on a multi-scan world
2. [ ] Add `inTimeWindow` to `LoadedScan` and the `scanRendered()` helper; route
       `viewer.ts:516`, `:1956`, `:1959`, `:1969` through it, with no behaviour change
       yet (`inTimeWindow` always `true`). Verify the editor is unchanged
3. [ ] Write `effectiveCapturedAt()` and the session-grouping function; unit-check the
       null / unparseable / null-`sessionId` cases
4. [ ] Add the scrubber markup and styles to `viewer.html` above `#scan-list`
5. [ ] Wire the cursor: set `inTimeWindow` per scan, coalesce to one
       `applyLayerVisibility()` per frame, default to the rightmost stop
6. [ ] Dim and disable out-of-window scan rows without touching their `checked` state
7. [ ] Re-derive the axis in `refreshWorldScans` (`:2699-2722`) when new scans arrive
8. [ ] Hide the control for worlds with fewer than two sessions
9. [ ] Write `tests/mock-timeline-scrubber.spec.ts` covering every case in Tests
10. [ ] Rewrite `../../product/UX_FLOW.md:260` and update the atlas's World Editor entry
11. [ ] Run `npm run build` and `npm run verify`
