# UI flow screenshots

Generated, not hand-curated. Delete a folder and re-run its spec to rebuild it.

| Folder | Spec | Command |
| --- | --- | --- |
| `mobile/` | `tests/mock-ui-mobile.spec.ts` | `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 npx playwright test --project=chromium-mock mock-ui-mobile --workers=1` |
| `desktop/` | `tests/mock-ui-desktop.spec.ts` | same, with `mock-ui-desktop` |

`--workers=1` is not optional: these specs share server-side session state with
every other `mock-*` spec, and a parallel run interleaves scans.

## What produced these

The phone screens are driven by the scripted 8th Wall mock (`?mock=xr8`), not a
real device. That is a constraint, not a shortcut — the test phone on hand
(XREAL Beam Pro) has no ARCore, so the WebXR path cannot run on it, and its 8th
Wall pipeline loads but never emits a camera frame. There is no on-device AR
capture to photograph.

Two things are stubbed client-side, each for a stated reason:

- **`/infer`** for the shots that need objects in the panel. The dev server
  these ran against answers with the real Ollama engine (`/health` → mode
  `ollama`), not `INFERENCE_MODE=mock`, and the real VLM finds nothing in the
  mock runtime's synthetic frame — so without a stub the panel is empty and
  there is nothing to export. The stub returns two detections in the
  `RawDetection` shape, which is what `INFERENCE_MODE=mock` does server-side.
- **`/upload-scan`** for the four export outcomes, so each screenshot shows one
  exact outcome rather than whatever the server happened to say.

Everything else — the Place sheet's contents, the HUD, the quality guidance,
the history drawer — is the app's own behaviour against the live dev server.

## mobile/ — 393×852 @2× (iPhone 15 metrics), unless noted

| File | Screen |
| --- | --- |
| `01-ftue-step-1.png` | FTUE step 1 of 2 — "Allow camera & motion" |
| `01-ftue-step-2.png` | FTUE step 2 of 2 — "Walk slowly"; the button reads "Get Started" here |
| `02-start-screen.png` | Start screen, ready state — the one recommended method, "Other ways", and the Place Scan Editor |
| `02b-start-screen-other-ways.png` | The same screen with "Other ways" open — the methods that were ranked and not chosen |
| `03-place-picker.png` | Place sheet as a Scan tap opens it (location card, two nav rows, Areas, Skip for now) |
| `04-place-picker-nearby-empty.png` | "Places nearby" popup with no GPS fix — the empty state, and the "Show all N saved places" escape hatch |
| `05-place-picker-all-places.png` | The same popup after tapping Show all |
| `06-place-picker-selected.png` | Sheet with a place chosen — "Selected project" row filled, Continue button appears |
| `07-place-picker-areas.png` | Areas section expanded, with the "Add an area" form |
| `08-place-new-form-viewport.png` | **Create New Place Project**, as the phone shows it. Not scrolled, not cropped |
| `09-place-new-form-full.png` | The same form's panel captured as an element, so the whole box is in one image |
| `10-scanning-hud-initialising.png` | HUD before tracking locks — "Move camera to initialise tracking…", 0 pts |
| `11-scanning-hud-tracking.png` | HUD tracking — point count, SPARSE verdict chip, coverage bar, "2 areas missing" |
| `12-quality-guidance.png` | The coverage/quality overlay cropped out of the HUD, legible at 1:1 |
| `13-capture-dialog.png` | The "Latest scan" dialog that auto-opens on a resolved capture |
| `14-detections-panel-empty.png` | Side panel with no objects — "No objects yet", export actions disabled |
| `15-detections-panel.png` | Side panel populated (stubbed `/infer`) — object cards, Export GLB, server-processing actions |
| `16-history-drawer.png` | Session history drawer |
| `17-export-succeeded.png` | Export → **"Exported"**, and the "View in 3D" link revealed |
| `18-export-server-rejected.png` | Export → **"Saved on device"** (server returned 500) |
| `19-export-queued-offline.png` | Export → **"Saved — will sync"** (service worker queued it) |
| `20-export-cancelled.png` | Export → **"Cancelled"** (backed out of the low-quality confirm) |
| `21-permission-denied-banner.png` | The motion/orientation denial banner over a running scan |
| `22-video-upload.png` | Walkthrough-video upload path after picking a file |
| `23-place-picker-small.png` | Place sheet at **375×667** (iPhone SE metrics) |
| `24-place-new-form-small-viewport.png` | Create New Place Project at **375×667** |
| `25-place-new-form-keyboard-sim.png` | The same form at **375×340** — a simulated keyboard-shrunk viewport. See below |
| `measurements.json` | Panel geometry against the fold for the shots above |

## The "Create New Place Project doesn't fit" report

Partly reproduced, and the numbers say where the line is. From
`measurements.json`:

| Viewport | Panel height | Save button bottom | Below the fold? |
| --- | --- | --- | --- |
| 393×852 (iPhone 15) | 366 px | 594 px | no — 258 px of clearance |
| 375×667 (iPhone SE) | 366 px | 502 px | no — 165 px of clearance |
| 375×667, name field focused | 366 px | 502 px | no — focus alone changes nothing |
| 375×340 (keyboard simulated) | 316 px | 363 px | **yes — 23 px past the bottom** |

The popup is vertically centred and 366 px tall, so it fits any viewport taller
than about 380 px and clips below that. The soft keyboard is what takes a phone
under that line: iOS Safari leaves roughly 340 px of visual viewport on an SE
with the keyboard up, which is exactly the state the form is filled in.
`25-place-new-form-keyboard-sim.png` is that geometry — the "Save new place"
button is sliced by the bottom edge and only reachable by scrolling the panel.

Headless Chromium has no soft keyboard, so that height is set directly rather
than raised by a real keyboard. It is a simulation and the file name says so.
What it is not is a guess: the popup is centred in the viewport, so shrinking
the viewport is precisely what a keyboard does to it.

## Other things these shots show, unprompted

- **Onboarding is 2 steps, not 5.** The previous version of this spec drove the
  overlay by toggling `.active` on `.onboard-step` indices 0–4 and wrote five
  PNGs. `index.html` has only `data-step="0"` and `data-step="1"`, so shots 3, 4
  and 5 were the same screen photographed three more times. The spec now steps
  the real Next button and stops when it says "Get Started", and
  `measurements.json` records the count it found.
- **The scanner action rail overlaps the side panel.** In `15`, `17`–`20` the
  right-hand icon column (display, brightness, layers, upload, camera, person,
  history) sits on top of the panel's footer buttons rather than being pushed
  aside or hidden — the layers badge lands on "Scene Description", the camera
  icon on "Clear session".
- **No GPS fix in a headless browser**, so `04` shows the Place sheet's
  no-fix path. That is not an artefact of testing: it is what a user gets
  indoors, and it is the state where "Suggested Places Nearby" is empty and the
  only way to an existing place is the "Show all" control.
