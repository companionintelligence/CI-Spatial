> **Type:** Frontend
> **Wave:** 05-on-device-inference
> **Branch:** `feat/webgpu-driver-runtime`
> **Commit style:** `feat(inference): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0001 (the driver and its port), 0002 (weights actually present)

## Goal

Implement the browser half of the runtime port on `onnxruntime-web` with the WebGPU
execution provider, and delete the `pipeline('image-text-to-text', ...)` call that has never
worked. After this ticket, selecting on-device inference runs the same LFM2.5-VL loop the
server runs, on the phone's GPU.

## What this replaces

`src/inference/webgpu.worker.ts:84` today:

```js
pipelinePromise = call('image-text-to-text', 'LiquidAI/LFM2.5-VL-1.6B-ONNX', pipelineOpts)
```

`image-text-to-text` is not a registered Transformers.js pipeline task in 3.8.1 or 4.2.0.
The `pipeline()` API cannot express this model, which is why 0001 extracted a hand-rolled
driver instead of waiting for upstream.

**Most of this worker survives.** The `env` configuration, the progress protocol, the
message handler, the `parseDetections` wiring and the dtype intent are all correct. Only the
model-construction and generation calls change.

The dtype block already names the right components:

```js
dtype: { embed_tokens: 'fp16', embed_images: 'fp16', decoder: 'q4' }
```

Those map exactly onto the three files the server driver loads —
`embed_tokens_fp16.onnx`, `embed_images_fp16.onnx`, `decoder_q4.onnx` (`inference.ts:236-238`).
With a hand-rolled driver the quantisation choice stops being a hint to a pipeline and
becomes simply which files `createSession(name)` opens.

## The four port members, browser side

| Port member | Browser implementation |
| --- | --- |
| `createSession(name, opts)` | `ort.InferenceSession.create(url \| ArrayBuffer, { executionProviders: ['webgpu'] })` from `onnxruntime-web`, reading whatever 0002 cached |
| `readJson(name)` | `fetch('/models/.../tokenizer.json').then(r => r.json())`, or the 0002 cache |
| `decodeImage(bytes)` | `createImageBitmap` + `OffscreenCanvas` — the worker is already off the main thread, and `getImageData` is already used elsewhere in the capture path |
| `Tensor` | `onnxruntime-web`'s `Tensor` |

If 0001 shaped the port correctly, this ticket adds one file plus a dependency and changes
roughly twenty lines of the worker.

## Non-goals

- Do not modify the driver module from 0001. If the browser needs a change to it, that is a
  signal the port boundary is wrong — fix the boundary, and re-run 0001's oracle afterwards.
- Do not re-enable the toggle. That is 0004, deliberately separate so this ticket can land
  and be tested behind the gate.
- Do not implement fallback behaviour. Also 0004.
- Do not add `onnxruntime-web` to `deno.json`. The server keeps `onnxruntime-node`
  (`deno.json:18`); two runtimes is the entire premise.
- Do not change `download_models.py`, `MODEL_DIR`, or the server path.

## Pinned conventions

**ADR 0001** — this adds a runtime, so it states what it reuses. Verified at `b314055`:

| Existing | Where | How used |
| --- | --- | --- |
| the LFM2.5-VL driver + port | from ticket 0001 | **the** reuse this whole wave exists for; the loop is not reimplemented |
| `SPATIAL_DETECTION_PROMPT`, `parseDetections` | `src/inference/prompt.ts` | already imported by the worker; unchanged |
| worker message protocol | `webgpu.worker.ts` / `router.ts:134-166` | unchanged — `infer` / `result` / `error` / `progress` all keep their shapes |
| `env` configuration | `webgpu.worker.ts:42-50` | unchanged; `allowRemoteModels = false` in particular must stay false |
| the cached weights | from ticket 0002 | consumed, not re-fetched |
| `onnxruntime-node` | `deno.json:18` | untouched; the browser gets `onnxruntime-web` as an npm dependency |

New dependency: `onnxruntime-web`, matching the `onnxruntime-node` major already in use
(1.21.x) so tensor semantics line up across the port.

## Before implementation

- ticket 0001's driver module and port definition
- `src/inference/webgpu.worker.ts` in full — 114 lines, most of which stays
- `inference.ts:236-244` — how the server creates sessions and loads the tokenizer, since
  the browser mirrors it
- `src/inference/router.ts:110-166` — worker lifecycle and the message contract
- onnxruntime-web docs on the WebGPU execution provider and its WASM/JSEP asset requirements

## Open questions & answers

- Q: Does the Lume Pad 2 (Chrome 151, Android 12) actually expose WebGPU? — **OPEN. Check
  first** — `navigator.gpu` on the device settles it in one line and the rest of the ticket
  is moot without it.
- Q: Can a tablet hold ~1.5 GB of weights plus WebGPU buffers? — **OPEN.** The device has
  shown memory pressure already this session (Chrome evicting its own camera client). If it
  cannot, the fp16/q4 choice may need revisiting, or the answer may be that this device class
  is out of scope.
- Q: Is fp16 supported by the device's WebGPU implementation (`shader-f16`)? — OPEN. If not,
  the vision encoder needs a different quantisation and 0002's cached files change with it.
- Q: How does per-capture latency compare with the server? — OPEN. The server path is
  17-20 s with `qwen3-vl:4b` on a desktop GPU. If on-device is minutes, it is a privacy
  option rather than a default, which affects how 0004 presents it.
- Q: Where do onnxruntime-web's WASM/JSEP assets come from? — OPEN. They must be served
  locally, not from a CDN — a CDN fetch would contradict "no data leaves your phone" exactly
  as `allowRemoteModels` would. Note `dist/` already carries
  `ort-wasm-simd-threaded.jsep.wasm` from the Transformers.js dependency; check whether that
  is reusable.

## Files impacted

Changed:
- `src/inference/webgpu.worker.ts` — model construction and generation
- `package.json` — add `onnxruntime-web`

Added:
- the browser implementation of the 0001 port

## Schema required

None.

## Definition of Done

- [ ] `navigator.gpu` confirmed present on the target device
- [ ] The browser port implements all four members against `onnxruntime-web`
- [ ] The `pipeline()` call is gone; the driver from 0001 is unmodified
- [ ] A capture inferred on-device returns detections of the same shape as the server path
- [ ] onnxruntime-web's WASM/JSEP assets are served locally, with no third-party request
- [ ] Per-capture latency and peak memory measured on-device and written down
- [ ] `npx tsc --noEmit` and `npm run verify` pass

## Tests

- [ ] On-device: infer a known scene; compare labels against the server path on the same image
- [ ] Network panel shows **zero** third-party requests during an on-device capture
- [ ] Memory does not grow across repeated captures (KV cache and session reuse)
- [ ] `npm run verify`

## Acceptance Criteria

- [ ] Given weights are provisioned and on-device is force-enabled, When a capture is taken,
      Then it returns plausible detections without contacting the server
- [ ] Given the same image, Then on-device and server detections are recognisably the same
      scene — not necessarily identical, but not a different room
- [ ] Given an on-device capture, Then no request leaves the device

## Risks / potential issues

- **Risk:** WebGPU may be unavailable or too limited on the target device. — **Mitigation:**
  First open question, one line to check. A negative answer ends the wave honestly with the
  gate from wave 04 still in place.
- **Risk:** Memory exhaustion on a tablet already showing pressure. — **Mitigation:** Measure
  peak memory; be prepared to conclude this device class is out of scope.
- **Risk:** Latency so poor the feature is unusable even when it works. — **Mitigation:**
  Measure and report. 0004 decides how it is presented; "available but slow, and honest
  about it" is a legitimate outcome.
- **Risk:** onnxruntime-web pulls WASM from a CDN by default, silently breaking the privacy
  claim this wave exists to honour. — **Mitigation:** Explicit Definition of Done item, and
  a network-panel check in the tests.
- **Risk:** Tensor semantics differ subtly between the node and web runtimes, so the shared
  driver misbehaves in one. — **Mitigation:** 0001's oracle covers the server; this ticket's
  cross-path comparison covers the browser.

## Subtasks

1. [ ] Check `navigator.gpu` and `shader-f16` on the device — **gate the rest on this**
2. [ ] Add `onnxruntime-web`, matched to the `onnxruntime-node` major
3. [ ] Ensure WASM/JSEP assets are served locally
4. [ ] Implement the four port members for the browser
5. [ ] Replace the `pipeline()` call with driver construction
6. [ ] Verify against the server path on the same images
7. [ ] Measure latency and peak memory; record both
8. [ ] `npm run verify`
