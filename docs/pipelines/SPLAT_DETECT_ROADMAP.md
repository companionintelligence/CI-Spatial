# Splat-detect roadmap — from editor gadget to room understanding

`splat-detect` wraps [splat_analyzer](https://github.com/nigelhartman/splat_analyzer)
(render synthetic views → OWLv2 open-vocab detection → 3D boxes → `interactions.json`)
as a world job. It's live: a scan's trained splat (or LingBot point cloud) → labeled
3D boxes, shown as an overlay in the editor's Splat Toolbox.

This is a real integration but a **thin** one. This doc is the plan to make it good,
and to push it into the scanner — where splat_analyzer's actual value lives ("3D
interaction zones for WebXR").

## Honest status

- ✅ `splat-detect` world job, ROCm point renderer (`renderers/point_backend.py`), GPU1-pinned
- ✅ Editor: Detect Objects button + prompt + 3D box overlay
- ⚠️ Detection quality **never validated on a real furnished room** — only the outdoor
  garden fixture, which correctly returned 0 furniture objects
- ⚠️ Tuning knobs are now *exposed* (below) but **not calibrated** — defaults are
  run_local.py's own (score 0.12 / votes 8 / peak 0.40), which the spike showed give
  0 objects on sparse input
- ⚠️ Boxes live in the **editor only**, not the AR scanner or the scan's semantic tags
- ⚠️ Coordinate frame of `interactions.json` vs our world frame unvalidated on a real room
- ℹ️ The **memory push does ship the boxes** — `server/memory_push.ts` sends each object's
  extent (m + whole mm), rotation, peak score and vote count to CI-Server, because
  `ci.inventory`'s `length_mm`/`width_mm`/`height_mm` columns have nothing else to
  populate them from. Every push carries an `object_extents` block declaring
  `frame: splat_local`, `world_frame_aligned: false`, `calibrated: false` and the
  detector's parameters, so a consumer can tell an uncalibrated default-threshold
  run from a calibrated one. **Re-push after Phase 1** — idempotency is on
  (`companion-scan`, `scanId`), so a re-push updates the same event.

## Phase 1 — Calibrate on a real room  ⟵ **the gating work; needs real data**

Everything downstream depends on splat-detect actually finding furniture in one of our
Brush-trained room splats. Do this once you have a real trained room splat (from the
house test — `<base>.splat.ply` in `scans/`, ≥100k gaussians):

```bash
# On beta-1, against a real trained room splat:
node scripts/tune-splat-detect.mjs scans/<your-room>.splat.ply \
  --prompt "sofa, bed, tv, table, chair, lamp, desk, dresser, refrigerator, toilet, sink" \
  --quality medium --out /home/ci/.local/state/detect-tune

# Review the sweep, then load the best result in the editor to eyeball the boxes:
cat /home/ci/.local/state/detect-tune/REPORT.md
cp /home/ci/.local/state/detect-tune/<best-tag>.interactions.json scans/<your-room>.interactions.json
# open the editor → select the scan → Splat Toolbox → "Show detected object boxes"
```

`tune-splat-detect.mjs` sweeps `min_votes` × `score_threshold` × `min_peak_score` at a
fixed quality, writes one `interactions.json` per set + a `REPORT.md` table (objects and
label breakdown per set), all on GPU1. **Pick the set whose boxes actually land on the
real furniture**, then bake it into `~/.config/cscan/env`:

```
SPLAT_DETECT_QUALITY=medium
SPLAT_DETECT_MIN_VOTES=<winner>
SPLAT_DETECT_SCORE_THRESHOLD=<winner>
SPLAT_DETECT_MIN_PEAK_SCORE=<winner>
```

**Exit criteria:** a `splat-detect` job on a real room returns ≥3 correctly-placed,
correctly-labeled boxes. If no parameter set achieves this, the finding is that
point-cloud/low-fidelity splat renders are too sparse for OWLv2, and Phase 3 waits on
higher-fidelity splats (more Brush iterations, real trained input) — a legitimate
outcome, not a failure.

## Phase 2 — Expose the knobs  ✅ done in this change

`server/splat/splat_detect.ts` now takes `quality` / `scoreThreshold` / `minVotes` / `minPeakScore`
(job payload → env `SPLAT_DETECT_*` → run_local.py defaults). Default quality bumped
`low` → `medium` (90 views vs 24). Clustering knobs stay unset until Phase 1 calibrates
them, so we never fight the analyzer's own defaults blind. The Detect Objects UI can grow
a quality dropdown + advanced sliders once Phase 1 gives sensible ranges.

## Phase 3 — Into the scanner (the real payoff)  ⟵ after Phase 1 passes

Convert accepted `interactions.json` boxes into **world-anchored detections in the scan
manifest**, so they:
- render as pins in the **AR phone view** (walk the room, see labeled objects) — reuses
  the existing detection store + pin rendering
- auto-populate the **semantic tags** the editor already supports
- become the interaction zones splat_analyzer is designed for

This is what turns splat-detect from an editor overlay into room understanding you see
while scanning. Gated on Phase 1 because anchoring wrong/empty boxes into the AR view is
worse than nothing. Requires resolving the coordinate-frame question (splat space →
world ENU) — validate against a room where you know where the sofa is.

Resolving that frame question is also what lets the memory push stop hedging: today it
sends extents tagged `frame: splat_local` / `world_frame_aligned: false` (above). Once
splat space → world ENU is known, the push can state the world frame instead of
disclaiming it.

## Phase 4 — Detection-guided capture (optional)

Low-confidence or missing expected objects → capture hints ("re-scan near the TV").
Ties into the guided-capture idea from the UX review. Highest effort, lowest priority.

## Why this order

Phase 1 is the only thing that answers "does this actually work on our data," and it's
cheap once real data exists. Building Phases 3–4 before it would mean shipping
world-anchored detections tuned against a furniture-free fixture — the same class of
mistake as tuning thresholds on the garden scene. Calibrate first, then wire deep.
