# Metric alignment (Umeyama)

The stage that puts real metres into a splat.

> **Status: unverified end to end.** `server/splat/splat_align.ts` and its
> refusal contract are covered by 19 Deno unit tests
> (`tests/unit/deno/splat_align.test.ts`), including a synthetic-session run
> that recovers a known scale. It has **not** been run against a real
> calibrated capture, so no measured `scale` or `residualM` from real hardware
> is recorded anywhere yet. Per ADR 0005, do not describe this stage as
> verified until a run on a physically measured scan is written down.

## Why this stage exists

Monocular structure-from-motion recovers geometry only **up to an unknown
scale**. COLMAP reconstructs a room perfectly well, but its output has no
metres in it, sits at an arbitrary origin, and has an arbitrary heading —
nothing in a set of images fixes how big the room actually is.
[`colmap-poses.md`](colmap-poses.md) gravity-aligns the model, which fixes
*orientation*; it does nothing about scale.

So a trained splat could be rendered, but not measured, not placed beside its
own mesh, and not fused with a second visit to the same Place. **Any claim of
real-world dimensions from a splat alone is false.**

The metre stick was already in the session. The *same* keyframes COLMAP solved
also carry capture-time AR poses, and a calibrated scan carries
`ScanCalibration.sessionToProject` — whose `two-point-ground` tier is backed by
a physically measured `separationM`. That measurement is the only evidence the
session's units really are metres. Two descriptions of one physical camera
path — one in SfM units, one in metres — and Umeyama (1991) recovers the 7-DoF
similarity between them in closed form: rotation (3), translation (3), uniform
scale (1).

## What it reads and writes

| | |
|---|---|
| SfM side | `colmap.poses.json`, else `lingbot-map.poses.json`, via `readSolvedPoses()` — the one reader that already serves both providers (ADR 0001) |
| Metric side | `keyframes.jsonl` capture-time poses, moved into the Place frame by `ScanCalibration.sessionToProject` |
| Calibration source | the scan's `<base>.json` meta sidecar, **not** `ScanManifest` — the manifest only carries the flattened `calibrationMethod`/`calibrationStatus` summary, which is not enough to fit against |
| Output | `<base>.splat-align.manifest.json` beside the splat (session dir when there is no splat), served through the gated `/scans/…` suffix allowlist |

The `.ply` itself is never read — the fit needs only poses and calibration, so
the stage can run before or after training. The splat path only names the
manifest and fills its `plyPath` field.

Correspondences are paired **by filename**, not by index — the two providers
register different subsets of frames.

Manifest fields (`SplatAlignManifest`, `src/world/manifests.ts`):
`tool: 'umeyama'`, `projectTransform`, `scale`, `residualM`,
`correspondenceCount`, `calibrationMethod`, plus the `PipelineManifestBase`
envelope.

### `projectTransform` is ROW-major

Translation sits at indices 3/7/11, with the scale already folded into the
rotation block. `THREE.Matrix4.fromArray` reads **column**-major, so feeding
it this array transposes it silently. Use `Matrix4.set(...)` (which takes
row-major arguments) or transpose first. The convention is pinned by the
field's doc comment and asserted in the tests rather than left to the reader —
note that `ScanCalibration.sessionToProject`, on the other side of this same
stage, *is* column-major.

## Running it

**Not auto-chained.** `splat-train` auto-chains `colmap-poses` (before) and
`splat-finish` (after); `splat-align` is queued explicitly.

```bash
curl -X POST http://localhost:8000/worlds/default/jobs \
  -H 'content-type: application/json' \
  -d '{"type":"splat-align","scanId":"<scan-id>"}'
```

On success the job reports `1 SfM unit = <scale> m` with the residual in cm
and the camera count behind it.

## What consumes it

- **The viewer** (`src/viewer/splat-layer.ts`). When a trustworthy fit exists,
  the `SplatMesh`'s local transform is set from `projectTransform` so the splat
  stands in metric project space; otherwise the mesh is left as authored and
  the panel says why. `formatAlignmentStatus()` writes either
  *"Aligned to project space at metric scale — 1 SfM unit = …"* or
  *"Unaligned — arbitrary SfM scale (reason)"*. The readout never shows a bare
  number without naming its frame.
- **memory-push** (`server/memory_push.ts`), which ships the fit to CI-Server
  as the event's `spatial_frame`. Detected-object extents are converted into
  project-frame lengths **only** when that frame says a length can be converted
  at all.

Note what is *not* wired: the editor's two-click measure tool
(`src/viewer/measure.ts`) still writes an `m` suffix unconditionally and does
not consult this manifest. Its own header documents the gap.

## It refuses rather than guesses

A wrong scale is worse than no scale: it silently makes every downstream
distance, fusion and measurement wrong while looking fine. So every one of
these is a `skipped` manifest with a remediation, never an `ok` and never a
crash:

| Refusal | Why |
|---|---|
| No calibration, or `method: 'uncalibrated'` | Nothing establishes what a metre is in this session. The AR runtime's own units are unverified, and claiming metres from them is exactly the unbacked claim ADR 0005 rule 3 forbids. |
| No solved poses in the session | Remediation points at `colmap-poses` — CPU, no GPU needed. |
| No keyframe carries a capture-time pose | A pose-less (photo/video ingest) session has no metric camera path to fit against at all. |
| Fewer than 4 paired centres (`DEFAULT_MIN_CORRESPONDENCES`) | Three points fix a similarity exactly, so four is the first count where `residualM` is a measurement rather than arithmetic that is zero by construction. |
| Collinear camera path (`spreadRatio` < `COLLINEAR_SPREAD_RATIO`, 1e-3) | A capture walked in a straight line leaves the roll about that line completely unconstrained — and that failure is **invisible in the residual**, since an arbitrary roll maps the line onto the line with zero error. A rank test, not a spatial tolerance. |
| `scale` ≤ 0 | Happens when the *metric* cloud has no extent (every calibrated centre coincident). It fits with a residual of 0 while collapsing the scene to a point. |
| RMS residual > `DEFAULT_MAX_RESIDUAL_M` (0.25 m) | Deliberately loose. It is **not** a quality bar — it is the line between "these two point sets describe the same camera path" and "something upstream is wrong" (mis-paired frames, drifted AR tracking, a partial COLMAP model). Tightening it into a quality threshold would need the measurement procedure ADR 0005 rule 5 demands, which nothing here has run. |

An invalid session directory is an `error`, not a skip.

`calibrationMethod` is carried into the manifest so a consumer can judge how
far to trust `scale` — ADR 0005 rule 4 keeps the calibration tiers explicit
rather than blending them into one confidence number.

## Tests

```bash
deno task test    # includes tests/unit/deno/splat_align.test.ts
```

Covered: the closed-form fit against a known rotation/translation/scale; the
reflection guard (`det(R) = +1` at every rank); finiteness on collinear,
coincident and empty input; the row-major convention; filename pairing; and
each refusal path above. Not covered: a real calibrated capture — see the
status note at the top.
