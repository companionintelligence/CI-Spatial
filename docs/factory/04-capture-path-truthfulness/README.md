# Wave: 04-capture-path-truthfulness

Five defects on the capture path — scan → detect → accumulate → show. They are one wave
because they are one failure mode: **each reports success it has not earned, and none of
them produces an error a user could act on.**

That is why they survived. `worlds/default.json` holds 254 scans and 219 of them carry
detections. 179 carry exactly one. Nothing in the UI, the logs, or the on-disk manifest
ever said anything was wrong.

All five were found in a single Lume Pad 2 device session on 2026-08-18.

## What each one was silently claiming

| # | The claim | The reality |
|---|---|---|
| 0001 | `potted plant · 80%`, with a world position | `moondream:latest` cannot do structured detection. It copied the few-shot example out of the prompt. 31 of 38 labels written to disk were the example's own `label` and `description` strings. |
| 0002 | `SPARSE · 631 pts` after five minutes, "sweep the room more slowly" | The WebXR provider fed the accumulator **one** point per frame from a single centre ray, while the scanner asked for a 6×6 grid and the 8th Wall provider delivered one. The HUD hint makes this failure *worse*. |
| 0003 | nothing at all — no preview, no object, no error the user noticed | A capture is only persisted *after* inference returns. An inference failure discards the frame, the pose and the timestamp. Six captures, zero retained. |
| 0004 | "On-device — no data leaves your phone" | `pipeline('image-text-to-text', …)` is not a registered task in **any** released transformers.js, 3.8.1 or 4.2.0. The toggle has never worked. |
| 0005 | a fresh photograph of whatever the camera is pointed at | The companion `getUserMedia` stream stalls and `drawImage` keeps re-encoding the last decoded frame. Six byte-identical JPEGs across 47 minutes. |

0003 and 0005 compound viciously: a stale frame yields a confident detection of a scene the
user has already walked away from, and a failed detection then destroys the only evidence
of what was actually captured.

## Why this order

**0001 first, because nothing downstream is measurable until it lands.** While the model
invents objects, a resolver bug, a thumbnail bug, a placement bug and a stale frame are
indistinguishable from a hallucination — every one of them just looks like "the detection
is wrong". It was `0.22, 0.24, 0.78, 0.68` appearing in *every* detection that finally
separated them.

**0002 second**, because the coverage verdict and the quality recommendations are computed
over a point cloud the provider was starving. Tuning thresholds against that input would
have encoded the starvation as the baseline.

**0003 third.** It is the only one that changes durability semantics, so it wants to land
against a path whose other legs are known-good — and it makes 0005 far easier to diagnose,
because the offending frames stop being destroyed on the way out.

**0005 fourth**, on the evidence 0003 preserves. Its central unknown — whether the camera
stream can be re-acquired without killing the ARCore session — may mean the honest fix is
to report the stall rather than recover from it.

**0004 last, because it is a subtraction** and the only one that is purely a correction to
what the product says about itself.

0001 and 0002 were implemented on 2026-08-18 during the session that found all five; their
tickets are written to match what shipped. 0003, 0004 and 0005 are open.

## Tickets

| # | Ticket | One-line goal |
|---|--------|---------------|
| 0001 | [swap-detection-model-and-pin-context](0001-swap-detection-model-and-pin-context.md) | **Stop writing invented objects to disk** — default to a model that can actually do the task, and pin the context window so it fits on the GPU |
| 0002 | [webxr-hit-test-probe-grid](0002-webxr-hit-test-probe-grid.md) | Give the WebXR provider the 6×6 probe grid the scanner already asks it for |
| 0003 | [persist-capture-before-inference](0003-persist-capture-before-inference.md) | Stop destroying the frame when detection fails — the capture is the part that cannot be repeated |
| 0004 | [retire-webgpu-inference-toggle](0004-retire-webgpu-inference-toggle.md) | Remove a privacy claim the code cannot honour |
| 0005 | [webxr-stale-camera-frame](0005-webxr-stale-camera-frame.md) | Stop handing every capture the same frozen frame |

0002 and 0005 touch `src/ar/webxr.ts` in disjoint regions and can be worked in either
order. 0003 and 0005 must agree on what happens to a capture rejected as stale.

## Atlas diff

Two entries in `docs/factory/atlas.html` are wrong once this wave lands, and one of them
is wrong *today*:

- **`atlas.html:350` — "Ollama VLM detection (default)".** `default moondream:latest`
  becomes `qwen3-vl:4b` (0001). Separately, the sentence "salvages truncated model output
  rather than discarding it" is written as a virtue; it is the mechanism that laundered a
  parroted prompt example into 219 scans of confident detections. 0001 rewrites it to say
  what salvage costs as well as what it buys.
- **`atlas.html:353` — the WebGPU path.** "runs the same ONNX model directly in the browser
  via Transformers.js/WebGPU" is false now, not after this wave. 0004 replaces the entry
  with the ONNX-driver route that could actually work.

No new atlas entries. Nothing here adds a subsystem; four tickets correct existing ones and
the fifth deletes one.
