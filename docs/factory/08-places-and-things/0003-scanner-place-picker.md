# 0003 — Scanner place picker: geo suggests, user confirms

> **Type:** Frontend
> **Wave:** 08-places-and-things
> **Branch:** `feat/scanner-place-picker`
> **Commit style:** `feat(scanner): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 08/0002 (place registry wired; `projectId` flows capture → manifest),
> which depends on 08/0001 (Project/Floor/Room/ScanEntry types unified), which depends on
> wave 07 complete.

## Goal

Before AR starts, the user says **which place they are scanning**, so `projectId` is
recorded at capture time instead of reconstructed later from coordinates. Geolocation
*suggests*; the user *confirms*. Nothing is ever assigned by coordinate alone.

## Why "suggest, not assign" is not a style preference

Measured on a **stationary** Galaxy Tab S8 Ultra, indoors, Laguna Niguel CA. The geo chip
(`#geo-chip`, index.html:1570; painted by `updateGeoIndicator()`, src/main.ts:1333-1347)
reported, without the device moving:

| Observation | Value |
| --- | --- |
| Reverse-geocoded address, sample 1 | "30902 Club House Drive" |
| Reverse-geocoded address, sample 2 | "30856 / 30862 Calle Moraga" — a **different street** |
| Reported accuracy range | ±5 m to ±33 m |
| Coordinate wander, device stationary | ~65 m |

Two different street addresses for one stationary tablet. Indoor GPS cannot identify a
place, so auto-assignment would file scans under confidently wrong places and the error
would only surface much later, in the editor, after the frames are already uploaded. The
fix is not better geocoding — it is a confirmation step. **Owner decision: geo suggests,
user confirms.** Never auto-assign by coordinate.

Note also that `GeoTracker._geocodeCache` (src/geo/geo-tracker.ts:59, keyed
`${lat.toFixed(4)},${lng.toFixed(4)}` at :177) is a *request* cache for Nominatim — it is
not, and must not be read as, a place identity. Two of the addresses above would land in
different cache buckets for the same physical room.

## Non-goals

- Do not add rename, delete, or merge of places — that is 08/0004.
- Do not add floor or room assignment, or floor/room CRUD — that is 08/0004.
- Do not add a map view to the picker. `src/viewer/geomap.ts` and the drawer map
  (`#geo-map`, index.html:1654) exist; wiring one into a pre-AR sheet is out of scope.
- Do not add editor-side re-filing of already-captured scans — 08/0004 and 08/0005.
- Do not add automatic duplicate detection. Confirm-flow duplicates ("Kitchen" twice) are
  expected here and are 08/0004's problem to solve, by merge.
- Do not touch the AR runtime selection, the camera pipeline, or `#start-upload-card`'s
  video path (index.html:1508-1515).
- Do not create a third place registry. See Pinned conventions.

## Pinned conventions

**ADR 0001** (`docs/adr/0001-reuse-existing-domain-model.md`) — this ticket touches a
client↔server connection and a stored value, so it states what it reuses.

| Reused | Where | How this ticket uses it |
| --- | --- | --- |
| `Project`, `ScanEntry` | unified by 08/0001 (today duplicated: `src/project/project-store.ts:33-64` vs `main.ts:3247-3255`'s `ProjectRecord`) | imported as-is; **no new type** |
| `ProjectStore` | `src/project/project-store.ts:75` | its **first real consumer**. Today `src/main.ts:163-164` constructs and opens it and nothing else in `src/main.ts` ever references it — verified by `grep -n projectStore src/main.ts`, which returns exactly those two lines |
| the place registry wired by 08/0002 | — | read through 08/0002's accessor only |
| `GeoTracker` / `GeoFix` | `src/geo/geo-tracker.ts:19-38, 54` | already instantiated at `src/main.ts:166` and started at :179-183; the picker subscribes, it does not start a second tracker |
| `geoToEnu` / `hasGeoPose` | `src/world/geo.ts:16-36` | the new `distanceM()` is built on `geoToEnu`, in the same file — see below |
| `src/shared/storage-keys.ts` | whole file | the new session key is **declared there**, not as a per-file literal. That module exists precisely to stop the literal-per-file pattern (its header cites ADR 0001) |
| `SessionHistory` | `src/ui/history.ts:10-52` | the structural template for the new class — see Before implementation |
| `exportToGLB`'s `scanEntry` input | `src/export/gltf.ts:75, 113-114, 138` | the field is already there and already writes `projectId: scanEntry?.projectId ?? null`; this ticket supplies the value |

**Searched before concluding a helper was missing:** `grep -rn -i
"haversine\|distanceM\|nearestPlace\|proximity\|distanceBetween" --include=*.ts .` The only
hits are `minDistanceM` in `src/capture/auto-capture.ts:27,44,112,131` and
`src/capture/keyframes.ts:25,63,221` (AR **local-frame** metres, not geodesic) and a
comment in `src/spatial/resolver.ts:302`. There is no geodesic distance helper anywhere in
the repo.

**ADR 0002** (`docs/adr/0002-shared-types-importable-by-the-browser-must-live-in-deno-api-free-files.md`)
— anything the browser imports must live in a Deno-API-free file
(`src/world/types.ts`, `src/shared/*.ts`, and the rest of `src/`). `npm run build`
(`tsc --noEmit && vite build`) is the real gate; a type that only "looks" importable is not.

**Do not rename** (CLAUDE.md + `src/shared/storage-keys.ts`): `companion-scan-onboarded`
(localStorage, `ONBOARDING_KEY`), `ci-xr-geo-fix` (sessionStorage, `GEO_FIX_SESSION_KEY`),
`ci-xr-scan` (IndexedDB, `SCAN_DB_NAME`). This ticket reads the first two and adds one new
key beside them; it changes none of them.

### Pinned values

| Constant | Value | Home | Justification |
| --- | --- | --- | --- |
| `PLACE_SELECTION_SESSION_KEY` | `'ci-xr-place-selection'` | `src/shared/storage-keys.ts` | **sessionStorage**, sibling of `ci-xr-geo-fix`. New key, so naming it is free — but from the moment it ships it joins that file's freeze discipline. |
| `PLACE_SUGGEST_MAX_ACCURACY_M` | `25` | `src/ui/place-picker.ts` | Above this the suggestion renders but is **not pre-selected**. Sits between the observed ±5 m good fixes (which may pre-select) and the ±33 m bad ones (which may not). |
| `PLACE_SUGGEST_MAX_DISTANCE_M` | `100` | `src/ui/place-picker.ts` | Beyond this, no suggestion row at all. The ~65 m stationary wander means a place 65 m away can genuinely be the one you are standing in; 100 m gives headroom without proposing the neighbourhood. |
| Skip semantics | `projectId = null` | — | Pinned below; `null` is already a valid `projectId` per 08/0001, and `src/export/gltf.ts:138` already writes `scanEntry?.projectId ?? null`. |
| Sheet element ids | `#place-sheet`, `#place-panel`, `#place-header`, `#place-title`, `#place-close`, `#place-body`, `#place-suggestion`, `#place-list`, `#place-new-btn`, `#place-new-name`, `#place-new-save`, `#place-skip-btn` | index.html | Mirrors `#history-drawer` / `#history-panel` / `#history-header` / `#history-title` / `#history-close` / `#history-body` (index.html:1645-1660, CSS at :415-517). |
| Start-screen entry point | `#place-chip-btn`, inside `#start-screen`, above `#start-paths` | index.html:1480-1488 | See the user-activation pin below. |

### The user-activation pin (the load-bearing one)

**The picker is a step *on* the start screen, before `#start-ar-btn` is tapped. It is never
inserted between the tap and the AR session start.**

`#start-ar-btn`'s handler (src/main.ts:101-141) calls
`DeviceOrientationEvent.requestPermission()` / `DeviceMotionEvent.requestPermission()`
**before its first `await`**, on purpose, and the comment at src/main.ts:103 says so. On the
WebXR path, `navigator.xr.requestSession()` has the same rule — src/ar/webxr.ts:74-83
records the precedent verbatim:

> `requestSession()` must run while the user gesture that triggered `start()` is still
> active. Awaiting `getUserMedia()`'s permission prompt first burns through that window, so
> `requestSession()` then rejects with "SecurityError: … requires user activation".

`../../testing/DEVICE_TESTING.md:153` states the operational form of the same rule: *"Camera prompt
never appears — Not a secure context, or Start not triggered by a user tap — don't script
the tap."*

Therefore: **zero new statements — and above all zero new `await`s — are added between the
`#start-ar-btn` click and the existing `requestPermission()` calls.** The selection is read
from an already-resolved in-memory variable, never fetched or awaited inside the handler.

## Before implementation

Read these, in this order:

- `src/ui/history.ts:10-52` — the class shape to copy: constructor resolves elements by id
  from static markup, `mount()` wires trigger + close + backdrop + Escape,
  `open()`/`close()`/`toggle()`, private async `_render()` that repaints `this.body`.
- `index.html:1645-1660` (drawer markup) and `index.html:415-517` (drawer CSS) — the visual
  and structural pattern to match.
- `index.html:1480-1528` — `#start-screen`, `#start-paths`, `#start-ar-btn` (note it ships
  `disabled aria-busy="true"` deliberately), `#start-upload-card`, `#ar-help`.
- `src/main.ts:82-148` — section 0, the start-AR gesture gate, and **its whole comment
  block**. It explains why the handler is attached at the top of boot rather than at
  section 5, and why an early tap must land somewhere.
- `src/main.ts:954-985` — `setStartButtonState()` and its docstring.
- `src/main.ts:605-662` — section 4b, `runOnboarding()`, the `ONBOARDING_KEY` gate at
  :651-653, and the `#help-btn` replay wiring.
- `src/main.ts:163-164, 179-183, 219-220, 228-230` — the unused `ProjectStore`, the
  `GeoTracker` start, `SessionHistory.mount()`, and the `#history-btn` listener (the exact
  place a `PlacePicker.mount()` belongs).
- `src/main.ts:440-542` — `exportManualScan()` and `runAutoSave()`; the two `exportToGLB`
  call sites are :468-471 and :529-532 and **neither passes `scanEntry`**.
- `src/geo/geo-tracker.ts:72-114, 176-246` — `start()`, the error path, the timeouts, and
  `_geocode()`.
- `src/world/geo.ts` — whole file (73 lines); `distanceM()` goes next to `geoToEnu`.
- `src/shared/storage-keys.ts` — whole file, especially the header's freeze rule.
- `../../testing/DEVICE_TESTING.md:54-68` (Checklist B) and `:144-158` (triage table).
- `tests/mock-ftue.spec.ts` and `tests/mock-motion-permission.spec.ts` — the two spec
  patterns this ticket's test combines.

## Open questions & answers

- Q: Is `index.html` or `scanner.html` the AR scanner? — A: **`index.html`**. Verified:
  `scanner.html` is 98 lines and does `location.replace('/' + location.search +
  location.hash)` at :88 — a branded handoff page, nothing more. `src/main.ts` drives
  `index.html`. All picker markup goes in `index.html`. (Verified 2026-08-19.)
- Q: Selection **required**, or **skip allowed** recording `projectId: null`? — A: **Skip
  allowed, pinned.** Two reasons, the second empirical. (1) `null` is already a valid
  `projectId` per 08/0001, and `src/export/gltf.ts:138` already emits
  `scanEntry?.projectId ?? null`, so nothing downstream needs a non-null value. (2)
  Requiring a selection means gating `#start-ar-btn` on it — which recreates by hand the
  exact bug src/main.ts:82-97 documents and fixes: a tap in a window where the button is
  not yet live *"reached no listener at all: no feedback, start screen still up, nothing
  started"* (~6.5 s, measured on a mobile-emulated run). Blocking capture to enforce
  bookkeeping is the wrong trade for a tool whose primary job is not to miss the scan.
  (Decided by owner, 2026-08-19.)
- Q: What if the user taps Start AR before the sheet has auto-opened? — A: That is a skip.
  `projectId` is `null`, the scan proceeds, and 08/0004's re-filing covers it. Never queue,
  replay, or block the tap.
- Q: Where does the picker sit relative to onboarding? — A: After it. `runOnboarding()` is
  awaited at src/main.ts:651-653 and its overlay covers the start screen; auto-opening the
  sheet underneath it would be invisible. Auto-open once the onboarding promise resolves,
  and only if the session has no selection yet.
- Q: What does the suggestion do when accuracy is poor? — A: **Render it, do not
  pre-select it.** Above `PLACE_SUGGEST_MAX_ACCURACY_M` (25 m) the row shows the place, the
  distance, and the accuracy, with an explicit "location is ±33 m — confirm this is right"
  line, and no row is pre-selected. Hiding the suggestion entirely would be worse: the user
  loses a useful hint and gets no explanation. (Decided by owner, 2026-08-19.)
- Q: Where does the distance helper live? — A: `src/world/geo.ts`, next to `geoToEnu`. Not
  a new module. Owner decision, and consistent with ADR 0001. Implement it as the
  horizontal length of the existing `geoToEnu()` result — `Math.hypot(v.x, v.z)` — rather
  than adding a second (haversine) projection, so there is exactly one earth model in the
  repo.
- Q: Which registry is canonical — `ProjectStore`'s IndexedDB `'ci-xr-projects'`
  (src/project/project-store.ts:68) or the server's `projects.json` behind
  `GET/POST /projects` (main.ts:3257, 3285-3348)? — A: **08/0002 decides; this ticket does
  not.** The picker reads through whatever accessor 08/0002 exposes and adds no second
  fetch path of its own. If 08/0002 has not settled it when this ticket starts, stop and
  settle it there first — adding a third read path is precisely the ADR 0001 failure mode.
- Q: Does the picker await a geo fix before rendering? — A: **No, never.** See the
  no-fix risk below.
- Q: Does the selection survive a page reload mid-session? — A: Yes — that is why the key
  is sessionStorage rather than an in-memory variable. `src/main.ts:158-161` resumes the
  last scan on reload (`store.resumeLatestSession()`); if the place did not survive with
  it, a resumed scan could be filed differently from the frames already uploaded under the
  same session. localStorage would be wrong in the other direction: tomorrow's scan of a
  different room would silently inherit today's place.

## Files impacted

**New:**
- `src/ui/place-picker.ts` — `PlacePicker`, modelled on `SessionHistory`.
- `tests/mock-place-picker.spec.ts` — Playwright, `chromium-mock` project.

**Changed:**
- `index.html` — `#place-chip-btn` inside `#start-screen` (above `#start-paths`, i.e. after
  :1486); `#place-sheet` markup as a **sibling of `#start-screen`**, not a child; sheet CSS
  beside the `#history-drawer` block at :415-517.
- `src/main.ts` — mount `PlacePicker` beside `SessionHistory` (:219-220); auto-open after
  the onboarding gate (:651-653); pass the selection into both `exportToGLB` call sites
  (:468-471 and :529-532).
- `src/world/geo.ts` — add `distanceM()`.
- `src/shared/storage-keys.ts` — add `PLACE_SELECTION_SESSION_KEY`, with the same
  comment-per-constant style as the rest of the file.
- `docs/factory/atlas.html` — wave 08 needs a **Places** entry; the atlas currently mentions
  projects exactly once, the `PROJECTS_FILE` env-var row at :596 (verified by
  `grep -n -i projects docs/factory/atlas.html`, which returns that single line). 08/0001 or
  08/0002 creates the card; this ticket flips its badge and adds the capture-time-`projectId`
  sentence.

The sheet must be a **sibling** of `#start-screen` because
`document.getElementById('start-screen')?.remove()` (src/main.ts:109) runs inside the AR
tap handler and would otherwise take the sheet's DOM with it. This is the same reasoning
already recorded for `#permission-error-banner` at src/main.ts:1003-1008.

## Schema required

**No new types.** The picker consumes `Project` and `ScanEntry` as unified by 08/0001, and
`GeoFix` from `src/geo/geo-tracker.ts:19-38`.

Two new module-level constants (`PLACE_SUGGEST_MAX_ACCURACY_M`,
`PLACE_SUGGEST_MAX_DISTANCE_M`) in `src/ui/place-picker.ts`, and one storage key:

```ts
// src/shared/storage-keys.ts
/**
 * sessionStorage key: the place the user confirmed for this capture session,
 * as a `projectId` string, or the literal 'null' when they chose "decide
 * later". Session-scoped on purpose: a reload mid-scan resumes the session
 * (src/main.ts:158-161) and must resume the same place, but a new tab or a
 * new day is a new place decision.
 */
export const PLACE_SELECTION_SESSION_KEY = 'ci-xr-place-selection'
```

One new function in `src/world/geo.ts`:

```ts
/**
 * Horizontal ground distance in metres between two geo poses.
 * Returns null when either pose has no usable fix (hasGeoPose === false).
 * Built on geoToEnu so the repo keeps exactly one earth model.
 */
export function distanceM(a: GeoPose, b: GeoPose): number | null
```

## Definition of Done

- [ ] A place sheet is reachable from the start screen, before AR starts, and never opens
      between the `#start-ar-btn` tap and the AR session start
- [ ] The sheet's top row is the geo-**suggested** nearest known place, showing its distance
      and the current fix accuracy, labelled as a suggestion needing confirmation
- [ ] No place is ever selected without an explicit user action — no code path assigns a
      `projectId` from coordinates alone
- [ ] The suggestion is pre-selected only when `accuracyM <= 25` **and** `distance <= 100`;
      otherwise it renders unselected with the accuracy stated
- [ ] Below the suggestion, the sheet lists the existing places from 08/0002's registry
- [ ] A "New place" row takes a name and creates a place through the existing registry
- [ ] A "Decide later" control records `projectId: null` and closes the sheet
- [ ] The choice is written to `PLACE_SELECTION_SESSION_KEY` and reused for the rest of the
      session — repeat autosaves never re-prompt
- [ ] Both `exportToGLB` call sites (`src/main.ts:468-471`, `:529-532`) receive the
      selection, so `scene.userData.projectId` (src/export/gltf.ts:138) is the chosen place
      rather than always `null`
- [ ] With geolocation denied, unavailable, or timed out, the sheet still renders: list +
      New place + Decide later, no suggestion row, no error dialog
- [ ] `#start-ar-btn`'s handler is byte-for-byte unchanged from its first line through the
      two `requestPermission()` calls
- [ ] `npm run build` and `npm run verify` pass

## Tests

New spec `tests/mock-place-picker.spec.ts`, `--project=chromium-mock`, iPhone-15 viewport
via the `test.use({ viewport: { width: 393, height: 852 }, … })` block copied from
`tests/mock-ftue.spec.ts:27-32`.

- [ ] The sheet is reachable from `#start-screen` **before** `#start-ar-btn` is tapped
      (`#place-sheet` visible, `#start-ar-btn` still in the DOM)
- [ ] Given `context.setGeolocation()` + `grantPermissions(['geolocation'])` with a fix
      inside 25 m of a known place, `#place-suggestion` renders with a distance and an
      accuracy and is pre-selected
- [ ] Given a fix with accuracy above 25 m, `#place-suggestion` renders and is **not**
      pre-selected, and states the accuracy
- [ ] Selecting a place then tapping Start AR: the next `/upload-scan` request body carries
      that `projectId` (assert on the intercepted request, as `mock-ftue.spec.ts` does for
      `/ingest-video`)
- [ ] "Decide later" then Start AR: the same request carries `projectId: null`
- [ ] `#place-new-name` + save creates a place and it appears in `#place-list`
- [ ] Second autosave in the same session does not re-open the sheet
- [ ] With geolocation **denied**, the sheet renders with `#place-list`, `#place-new-btn`
      and `#place-skip-btn` and no `#place-suggestion`
- [ ] **User-activation regression guard**: install the iOS-style permission stub from
      `tests/mock-motion-permission.spec.ts:29+` (`addInitScript`), have it record
      `navigator.userActivation.isActive` at call time, drive the picker, then tap
      `#start-ar-btn`, and assert `requestPermission()` was called **and** that
      `isActive === true` at that moment. This is the test that fails if anyone puts an
      `await` back between the tap and the permission request.

```
# verification commands
npm ci                 # NEVER `npm install` — see CLAUDE.md; a mutated tree makes
                       # Playwright report a bogus "two different versions of
                       # @playwright/test" and point at an innocent test.describe()
npm run build          # tsc --noEmit && vite build — the real ADR 0002 gate
npx playwright test --project=chromium-mock mock-place-picker
npm run verify
```

On-device verification follows `../../testing/DEVICE_TESTING.md` **Checklist B** (Android Chrome /
WebXR, suggested devices `hanzlas-z-fold7`, `tab-s8-ultra`) — steps 1-2 in particular, since
step 2 is exactly the "tap Start AR → grant camera → native `immersive-ar` session starts"
path this ticket must not break. Record the result in the Results matrix row "A2/B2
permissions from tap".

## Acceptance Criteria

- [ ] Given a first-time visitor, When onboarding is dismissed, Then the place sheet opens
      once, over the start screen, with AR not yet started
- [ ] Given a fix at ±8 m and "Kitchen" 4 m away, When the sheet opens, Then the top row
      reads as a suggestion, shows "4 m away · ±8 m", and is pre-selected — but AR still
      does not start until the user acts
- [ ] Given a fix at ±33 m (the observed stationary worst case), When the sheet opens, Then
      the suggestion is shown, is **not** pre-selected, and states the accuracy
- [ ] Given no geolocation fix at all, When the sheet opens, Then it is fully usable and no
      suggestion row appears
- [ ] Given a place was confirmed, When the session autosaves twice, Then both uploads carry
      that `projectId` and the sheet never reappears
- [ ] Given "Decide later", When the scan uploads, Then `projectId` is `null` and nothing
      warns, blocks, or guesses
- [ ] Given the picker was used, When `#start-ar-btn` is tapped, Then the camera/motion
      prompt appears exactly as it does today
- [ ] Given any state of the picker, Then no code path writes a `projectId` that the user
      did not explicitly choose

## Risks / potential issues

- **Risk: breaking the user-activation chain.** The single sharpest edge. This repo has
  already been bitten: src/ar/webxr.ts:74-83 records `requestSession()` failing with
  *"SecurityError: … requires user activation"* once an `await` was introduced ahead of it,
  and src/main.ts:103 marks the motion-permission calls as "before any await" for the same
  reason. — **Mitigation:** the picker resolves entirely *before* the tap (pinned above);
  the handler is not edited; the Playwright `navigator.userActivation.isActive` assertion
  pins it; Checklist B step 2 confirms on real hardware.
- **Risk: geolocation is slow, times out, or never fixes.** Observed: `[geo] Geolocation
  error: Timeout expired`. `GeoTracker.start()` uses `timeout: 15_000`
  (src/geo/geo-tracker.ts:106) and self-resolves after 8 s (:110-112), and its error path
  resolves `null` (:102-105). — **Mitigation:** the sheet **never awaits a fix**. It renders
  immediately from the registry and subscribes to `geoTracker.onUpdate`; a fix that arrives
  later injects the suggestion row into an already-open sheet. A fix that never arrives
  leaves a fully usable sheet.
- **Risk: adding a step makes people skip it, and every scan lands at `projectId: null`.**
  — **Mitigation:** accepted, and preferable to blocking capture. If skip rates turn out
  high, the answer is 08/0004's re-filing, not a mandatory gate.
- **Risk: the suggestion is confidently wrong** — the ±33 m / two-addresses case. —
  **Mitigation:** the pinned thresholds, the always-visible accuracy, and the fact that a
  suggestion is only ever pre-selected, never committed.
- **Risk: a third place registry.** `ProjectStore` (IndexedDB `'ci-xr-projects'`) and the
  server's `projects.json` already both exist and never talk. A picker that fetches "just
  this once" from the other one creates the third. — **Mitigation:** the sheet reads only
  through 08/0002's accessor; reviewers should reject any new `fetch('/projects')` or direct
  `ProjectStore` call added by this ticket outside that accessor.
- **Risk: the sheet is removed with the start screen.** `src/main.ts:109` removes
  `#start-screen` inside the tap handler. — **Mitigation:** the sheet is a sibling, per the
  pin, matching the `#permission-error-banner` precedent at src/main.ts:1003-1008.
- **Risk: a stale session selection outlives the place.** If 08/0004 later deletes or
  merges the stored `projectId`, the session key points at nothing. — **Mitigation:** on
  read, validate the id against the registry and fall back to "no selection" (re-prompt)
  rather than writing a dangling id onto an upload.

## Subtasks

1. [ ] Confirm 08/0002's registry accessor and the unified `Project`/`ScanEntry` import path
       from 08/0001; do not start until both are settled
2. [ ] Add `distanceM()` to `src/world/geo.ts`, built on `geoToEnu`
3. [ ] Add `PLACE_SELECTION_SESSION_KEY` to `src/shared/storage-keys.ts`, with the
       per-constant comment the file's style requires
4. [ ] Add `#place-chip-btn` to `#start-screen` and the `#place-sheet` markup as a sibling
       of it, with CSS mirroring the `#history-drawer` block
5. [ ] Write `src/ui/place-picker.ts` following `SessionHistory`'s shape: `mount()`,
       `open()`/`close()`/`toggle()`, private `_render()`
6. [ ] Render the list, the "New place" row, and "Decide later"; wire creation through
       08/0002's accessor
7. [ ] Add the suggestion row: nearest place by `distanceM`, gated by the two pinned
       thresholds, subscribed to `geoTracker.onUpdate`, never awaited
8. [ ] Persist and re-read the selection via `PLACE_SELECTION_SESSION_KEY`, validating the
       id against the registry on read
9. [ ] Mount beside `SessionHistory` (src/main.ts:219-220); auto-open once after the
       onboarding gate (:651-653)
10. [ ] Pass the selection into both `exportToGLB` call sites (:468-471, :529-532) — verify
        `scene.userData.projectId` is no longer always `null`
11. [ ] Re-read src/main.ts:98-148 and confirm the handler is unchanged
12. [ ] Write `tests/mock-place-picker.spec.ts`, including the `navigator.userActivation`
        guard
13. [ ] `npm run build`, `npm run verify`
14. [ ] Update the wave-08 atlas entry
15. [ ] On-device: `../../testing/DEVICE_TESTING.md` Checklist B steps 1-2 on `tab-s8-ultra`; record
        the Results matrix row
