# House validation protocol

End-to-end field test of the Companion-Scan pipeline in a real, lived-in,
**two-story house** — the operator's own test house. This is the acceptance run:
capture every room two ways (live AR + video), process on beta-1, and review
whether the reconstructions are aligned, complete, and recognizable.

> **Privacy:** this document never records the street address. Refer only to
> "the operator's two-story test house". The one exemplar session saved as a
> fixture (Phase 4) is stored privately outside the repo.

---

## Pass criteria

Capture is a **pass** only when every row holds. Numbers are floors, not targets.

### Per room

| Metric | Pass floor | Where to read it |
|--------|-----------|------------------|
| SLAM point count | ≥ 20,000 pts | scanner HUD / session `pointCount` |
| Surface coverage | ≥ 70% | scanner coverage meter |
| Detections | ≥ 3 objects | scanner side panel / `detectionCount` |
| Keyframes captured | ≥ 40 | session `keyframeCount` |
| LingBot cloud | ≥ 1,000,000 pts | `lingbot-map.point-cloud.ply` |
| Trained splat | `status: ok`, ≥ 100,000 gaussians | `<base>.splat-train.manifest.json` |
| Splat recognizable | room is visually identifiable in the viewer | viewer, by eye |

### Whole house

| Check | Pass criterion |
|-------|----------------|
| Room alignment | rooms sit within **±0.5 m** of a hand-drawn floor plan |
| Vertical connectivity | the stairwell connects the two floors in one world |
| AR vs video | both arms produce recognizable, comparable maps of each room |

---

## Phase 0 — Preflight (from the laptop, over Tailscale)

Do this **before** walking into the house. All from the laptop; beta-1 stays put.

1. **Readiness gate:**
   ```sh
   API_URL=http://beta-1.capybara-ulmer.ts.net:8000 npm run test:house
   ```
   All green. This confirms the server is healthy, the engine is ready, the world
   has scanner+editor members, the `splat-train`/`lingbot-map-reconstruct`/
   `splat-detect` job types are live, and `/ingest-video` is wired.
2. **Links:**
   ```sh
   npm run links:house
   ```
   Copy the scanner link (or `npm run links:house -- --qr scanner` for a QR to
   scan with the phone).
3. **GPU idle:** `rocm-smi` on the box shows both cards near idle (no stale job
   hogging VRAM before you start).
4. **Phone reachable:** open `/smoke.html` on the iPhone over Tailscale — it must
   pass before you rely on the scanner in the field.

---

## Phase 1 — AR capture path (room by room)

Live AR scan from the iPhone scanner. Order matters: **start at the front door,
outside**, so the first GPS fix anchors the world origin.

> **#1 failure mode (from the July sessions): sessions with 0 keyframes because
> cloud streaming was never turned on.** Confirm **☁ STREAMING ON** in the HUD as
> the very first action in every room, before you sweep.

Route: **front door (outside, for GPS) → downstairs loop → stairwell → upstairs.**

Per room:
1. **☁ STREAMING ON first.** Verify the cloud indicator is live.
2. **Slow sweep + loop closure.** Sweep the room slowly; end where you started so
   the tracker closes the loop. Watch coverage and point count climb toward the
   floors above.
3. **2–4 captures** per room (more for large/L-shaped rooms).
4. **Export before leaving the room.** Do not carry an un-exported session into
   the next room.

**Stairwell technique:** stairs are where tracking dies. Move slowly, keep the
far wall and a stair edge in frame for features, and do a deliberate continuous
sweep from the bottom landing up to the top so the two floors share tracking.

---

## Phase 2 — Video capture path (per floor)

The non-interactive arm — a fallback and a comparison. Shoot **60–90 s of video
per floor** on the iPhone (one continuous walk, slow, overlapping views).

Upload either way:
- **Scanner:** the **Upload video** control → `POST /ingest-video`.
- **curl (from the laptop):**
  ```sh
  curl -X POST http://beta-1.capybara-ulmer.ts.net:8000/ingest-video \
    -F video=@floor1.mp4 -F name='Downstairs (video)' -F fps=2
  # → 202 { sessionId, scanId, jobId, frameCount }
  ```
Ingest registers a scan and auto-enqueues `lingbot-map-reconstruct` (which
estimates the poses the video frames lack).

---

## Phase 3 — Processing (on the box)

Watch two log streams while jobs run:
```sh
npm run logs:watch                                   # dev server
journalctl --user -u cscan-server -f                 # service
```

Per session, run the toolbox chain (from the editor's **Splat Toolbox**, or via
`POST /worlds/default/jobs`):
1. **lingbot-map-reconstruct** — estimates poses + builds the point cloud
   (~minutes). Video-ingest sessions already enqueue this automatically.
2. **splat-train** (Brush) — trains the 3DGS. **6–20 min/room** depending on
   keyframe count and quality.
3. **splat-detect** (splat_analyzer / OWLv2) — open-vocab detection over the
   splat or the converted point cloud.

Detect runs on `HIP_VISIBLE_DEVICES=1`; train uses the wgpu adapter pin. Keep
both explicit so a warm Ollama model does not OOM the torch job.

---

## Phase 4 — Review (on the laptop)

Open each room in the viewer over Tailscale and fill the results matrix.

Per room, compare **point cloud vs trained splat vs detection boxes**:
- Does the splat look like the room? (recognizable pass floor)
- Do the detection boxes land on real objects?
- Does the room sit in the right place relative to its neighbors on your
  hand-drawn floor plan (±0.5 m)?

### Results matrix (template)

| Room | Floor | KF | SLAM pts | Cov % | Det | Cloud pts | Splat gauss | Splat OK? | Aligned? | AR/video |
|------|-------|----|----------|-------|-----|-----------|-------------|-----------|----------|----------|
| _e.g. Kitchen_ | 1 | | | | | | | | | |
| | | | | | | | | | | |

**Save one exemplar room** as a private fixture for regression use:
```sh
cp -r <SCANS_DIR>/sessions/<best-room-session> \
  ~/devel/SpatialTestData/house-$(date +%Y%m%d)/
```
Document which room and why in your run notes. Keep it outside the repo tree.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Browser cert warning | self-signed dev cert | accept it once per device; it's expected over Tailscale |
| "Server unreachable" | box down / wrong host | re-run `npm run test:house`; check `journalctl --user -u cscan-server` |
| First infer slow / stalls | model warming | wait for `engineLoadState: ready` on `/health` before scanning |
| **Keyframes = 0** | **cloud streaming off** | **turn ☁ STREAMING ON before sweeping — the #1 failure** |
| Tracking lost on stairs | few features, fast motion | slow down, keep a stair edge + far wall in frame, sweep continuously |
| Splat job `skipped` | `BRUSH_BIN` missing/unbuilt | build Brush, set `BRUSH_BIN` (see `docs/splat-train.md` — Setup) |
| Detect `skipped` | splat-analyzer venv/dir missing | check `SPLAT_DETECT_PYTHON` / `SPLAT_DETECT_DIR` (see `docs/splat-toolbox.md`) |

---

See also: `docs/splat-toolbox.md` (the tools), `docs/splat-train.md` (Brush
wiring), `scripts/house-links.mjs` (`npm run links:house`).
