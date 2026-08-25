> **Type:** Frontend
> **Wave:** 11-panoramic-canvas
> **Branch:** `feat/canvas-layer`
> **Commit style:** `feat(viewer): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0003, 0005

## Goal

Make the canvas something a person can look at and aim. A `canvas` layer in the World Editor,
a way to re-centre it on a point of interest, and the question surface from 0005 attached to
whichever origin is selected.

This is what makes "situated reasoning" concrete rather than a property of a manifest.

## Non-goals

- Do not build a second question UI. 0005 owns the request; this is the surface that calls it.
- Do not add a general timeline or animation. The canvas is a still.
- Do not add a full 360° tour experience. An inside-out sphere and a flat view are enough to
  see whether the canvas is right.
- Do not re-render the canvas client-side. Re-centring enqueues a `build-canvas` job with a new
  origin; the geometry stays on the server where it is tested.

## Pinned conventions

**ADR 0001** — reuses the layer, artifact and job surfaces 0003 established; adds no schema.

*Layer.* Follow `src/viewer/splat-layer.ts`: discover the artifact from the scan's base name
(`filename` minus `.glb`), attach under `loadedScans.get(scanId).root` so the transform gizmo
and the scan's visibility apply for free, and drive a visibility toggle. That attach point is
`src/viewer/viewer.ts` — the same line the splat mesh uses.

*Loading.* The canvas is one PNG. No windowed loader, no sequence — this is deliberately much
simpler than wave 10's `splat4d` layer, and should not borrow its machinery.

*Sphere view.* An inside-out `THREE.SphereGeometry` with the canvas as its texture is the whole
implementation. Equirectangular maps to a sphere's UVs directly, which is the point of the
projection.

*Job triggering.* The editor already has a job-queue surface (`src/viewer/splat-toolbox.ts`
posts `{ type, scanId }` to `POST /worlds/:slug/jobs`). Re-centring is one more of those, with
an origin in the payload. Do not invent a second way to enqueue.

*Copy.* Match the repo's voice — plain, second-person, says what happened. And carry 0005's
honesty caveat into the question surface: this is a whole-scene question to the local model,
not OneCanvas.

## Before implementation

- `src/viewer/splat-layer.ts` — per-scan artifact discovery and the manifest-first pattern.
- `src/viewer/viewer.ts` — where the splat mesh attaches under the scan root; how layers are
  toggled; `loadedScans`.
- `src/viewer/splat-toolbox.ts` — how a job is queued from the editor.
- `src/viewer/quality-tier.ts` — `jobProcessingLabel`, which needs entries for the new jobs.
- `docs/adr/0005-*.md` — the calibration anchor, which is one of the origins offered.
- `docs/product/UX_FLOW.md` — the editor's existing vocabulary, so this lands as part of it.

## Open questions & answers

- Q: Flat image or sphere? — A: **Both, toggled.** The flat equirectangular view is how you spot
  a geometry bug (a mirrored or rotated canvas is obvious as a strip and invisible as a sphere);
  the sphere is how you judge whether it reads as the room. They serve different purposes and
  both are cheap. (Decided in this ticket.)
- Q: How is a new origin chosen? — A: Three ways, in increasing specificity: the scene centroid
  (default, already built), the Place's calibration anchor if it has one, and a click in the 3D
  view. The click is the one that makes situated reasoning tangible — *"from where I am
  standing, what is behind me?"* (Decided in this ticket.)
- Q: Re-centring rebuilds server-side — that is a job round-trip, not instant. Is that
  acceptable? — A: Yes, and it should *look* like a job: it queues, it shows progress, it lands.
  Pretending it is instant would mean reimplementing the projection in the browser, in
  untested code, in a second place. (Decided in this ticket.)
- Q: Does the canvas need to align with the scan's geometry in 3D? — A: The sphere is centred on
  the canvas's own origin, which is in the same world frame as the scan, so yes — and that
  alignment is itself a check. If the sphere's walls do not line up with the point cloud's
  walls, the canvas is wrong. Worth saying in the UI.
- Q: What if the scan has no canvas? — A: The layer is absent, and the panel offers to build
  one — the same shape as the splat panel's "Queue the splat-train job to create one".

## Files impacted

New:
- `src/viewer/canvas-layer.ts` — discovery, load, flat/sphere presentation
- `tests/mock-canvas-layer.spec.ts`

Changed:
- `src/viewer/viewer.ts` — register the layer, the origin picker, the question surface
- `src/viewer/quality-tier.ts` — `build-canvas` / `depth-reconstruct` / `semantic-pass` labels
- `viewer.html` — the panel markup
- `docs/product/UX_FLOW.md` — the editor gains a surface; keep the doc true

## Schema required

None. Consumes `CanvasManifest` (0003) and the `semantic-pass` artifact (0005).

## Definition of Done

- [ ] A scan with a canvas shows a `canvas` layer; a scan without one offers to build it
- [ ] Flat and sphere presentations, toggleable
- [ ] The sphere attaches under the scan root, so the gizmo and scan visibility apply
- [ ] An origin can be chosen — centroid, calibration anchor, or a clicked point — and re-centring
      queues a `build-canvas` job with that origin, showing progress like any other job
- [ ] The question surface posts to 0005's path and shows the answer, carrying its caveat
- [ ] `jobProcessingLabel` has entries for all three new job types
- [ ] `npx tsc --noEmit` and `npm run build` pass

## Tests

- [ ] Unit (Node): origin-payload construction — a clicked point becomes the right world-space
      origin for the job payload
- [ ] Playwright (`mock-canvas-layer.spec.ts`, `chromium-mock`): against a fixture canvas, the
      layer appears, the flat/sphere toggle switches, and toggling scan visibility hides it
- [ ] Playwright: a scan with no canvas shows the build affordance instead of an empty layer
- [ ] Playwright: re-centring posts a `build-canvas` job carrying the chosen origin
- [ ] Regression: `mock-splat-train.spec.ts` — the splat layer is untouched

```bash
npx tsc --noEmit
npm run build
npx playwright test tests/mock-canvas-layer.spec.ts tests/mock-splat-train.spec.ts --project=chromium-mock
```

## Acceptance Criteria

- [ ] Given a scan with a canvas, When it is opened, Then the canvas can be seen flat and as a
      sphere, and the sphere's walls line up with the scan's geometry
- [ ] Given a clicked point, When the user re-centres, Then a `build-canvas` job queues with
      that origin and the new canvas appears when it lands
- [ ] Given a question typed into the panel, Then an answer comes back, with the caveat visible
- [ ] Given a scan with no canvas, Then nothing dead is rendered

## Risks / potential issues

- **Risk:** a texture-mapped sphere hides geometry errors that a flat strip makes obvious. —
  **Mitigation:** both views ship, and the flat one is the default for exactly this reason.
- **Risk:** one canvas per origin could accumulate quickly if re-centring is easy. —
  **Mitigation:** 0003 hash-suffixes situated canvases so they do not overwrite the default;
  retention is recorded as deferred in the wave README.
- **Risk:** the question surface invites comparison with OneCanvas's published numbers. —
  **Mitigation:** the caveat is in the copy, and it is a Definition-of-Done item in 0005 as
  well as here.
- **Risk:** `UX_FLOW.md` gets stale the moment this lands. — **Mitigation:** updating it is in
  Files impacted, not left to 0007.

## Subtasks

1. [ ] `canvas-layer.ts`: manifest discovery, texture load, flat + sphere
2. [ ] Attach under the scan root; wire the visibility toggle
3. [ ] Panel markup and the build affordance for canvas-less scans
4. [ ] Origin picker: centroid / anchor / clicked point → job payload
5. [ ] Question surface calling 0005, with the caveat
6. [ ] `quality-tier.ts` labels for the three new job types
7. [ ] Update `UX_FLOW.md`
8. [ ] Tests; `npx tsc --noEmit`, `npm run build`
