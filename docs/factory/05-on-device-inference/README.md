# Wave: 05-on-device-inference

Make the WebGPU inference toggle real. The product offers *"On-device — no data leaves your
phone"* (`src/ui/panel.ts:268`) and has never been able to honour it. Wave 04 ticket 0004
gates that control; this wave earns it back.

## Why port rather than remove

The decision was taken deliberately (2026-08-18) against the cheaper option of deleting the
toggle. Two reasons:

1. **The claim is strategic, not incidental.** The product's own tagline is *"Private
   spatial memory for places you own."* On-device inference is the strongest form of that
   promise. Deleting the control and re-adding it later is churn.
2. **Most of the work already exists.** `inference.ts` already drives LFM2.5-VL by hand — a
   3-stage `embed_tokens` / `embed_images` / `decoder` autoregressive loop with a manually
   managed KV cache (`inference.ts:431-520`). `download_models.py` already provisions the
   weights *"for both browser and Deno server paths"*, by its own docstring. The worker
   scaffolding, progress protocol, dtype quantisation config and `parseDetections` wiring
   are all written and correct.

What is missing is narrower than it looks: the worker asks Transformers.js for a
`pipeline('image-text-to-text', ...)` task that **no released version registers** (verified
against 3.8.1 and 4.2.0), and nothing serves the weights to a phone.

## The shape of the work

The port is not "make it work in the browser". It is **one driver, two runtimes** — which is
also what ADR 0001 demands, since the alternative is a second copy of a subtle
autoregressive loop that will drift from the first.

The existing driver's runtime-specific surface is small and well-isolated:

| Concern | Server today | Browser needs |
|---|---|---|
| session creation | `ort.InferenceSession.create(path)` via `onnxruntime-node` (`inference.ts:236-238`) | same call via `onnxruntime-web`, WebGPU EP |
| tokenizer load | `Deno.readTextFile(TOKENIZER_DIR + 'tokenizer.json')` (`:244`) | `fetch` from `/models/` |
| image decode | Jimp (`patchifyImage`, `:559`) | `OffscreenCanvas` / `createImageBitmap` |
| weights | local filesystem | ~2.2 GB over the tailnet, cached |

Everything else — the prefill/decode loop, KV-cache threading, patchify maths, prompt and
parsing — is already runtime-agnostic and simply needs lifting out from behind `Deno.*` and
`ort` imports.

## Tickets

| # | Ticket | One-line goal |
|---|--------|---------------|
| 0001 | [extract-lfm-driver-runtime-port](0001-extract-lfm-driver-runtime-port.md) | Lift the LFM2.5-VL loop out of `inference.ts` behind a runtime port interface, with the server as the first consumer and **no behaviour change** |
| 0002 | [browser-model-provisioning](0002-browser-model-provisioning.md) | Get ~2.2 GB of weights onto a phone once, cached, with honest progress and quota handling |
| 0003 | [webgpu-driver-runtime](0003-webgpu-driver-runtime.md) | Implement the browser side of the port interface on `onnxruntime-web` and replace the dead `pipeline()` call |
| 0004 | [ungate-toggle-and-fallback-policy](0004-ungate-toggle-and-fallback-policy.md) | Restore the control wave 04 gated, and decide what happens when on-device inference fails — without ever silently contradicting the privacy claim |

## Execution order

**Strictly sequential.** Each ticket is the previous one's precondition:

0001 → 0002 → 0003 → 0004

0001 first and alone, because it is the only ticket that can be verified against a *known
answer*: the server path must produce byte-identical detections before and after the
extraction. Every later ticket introduces a new variable (new runtime, new transport, new
device), and doing any of them before the driver is isolated means debugging the loop and
the runtime simultaneously.

0002 before 0003 because there is no point running a driver with nothing to load, and
because the provisioning question — 2.2 GB onto a phone — is the one most likely to change
the shape of the wave. If it proves impractical, 0003 and 0004 are not worth starting.

## Viability spikes — all three answered, 2026-08-18

The wave's three go/no-go unknowns were spiked before any implementation. All three passed,
and each answer is folded into its ticket.

| Spike | Result |
|---|---|
| **Does the ONNX driver work?** | **Yes.** Five correct objects on a real desk photo in 19.9 s, confidences 0.93-0.99 |
| **WebGPU on the target device?** | **Yes.** Qualcomm Adreno 6xx, `shader-f16` present |
| **Is 2.2 GB to a phone practical?** | **Yes.** 10.04 GB quota, 21.6 MB/s (~104 s), `persist()` granted |

Three corrections to the record came out of the spikes:

1. **The model is 2.2 GB, not ~1.5 GB.** README.md:190 and `download_models.py` both
   understate it by 47%.
2. **`download_models.py` fails on Windows** — its `↓` progress glyph crashes on cp1252.
   `PYTHONUTF8=1` works around it. This wants a one-line readiness fix, not a wave-05 ticket.
3. **The CV corpus cannot serve as 0001's oracle.** The *working* driver scores 0.0% on it,
   because `test-data/cv/` is coloured rectangles built for the mock detector. A 0.0%
   baseline cannot detect a regression. See 0001, and the successor wave below.

One unknown remains open and specific: the adapter's `maxStorageBufferBindingSize` is
512 MiB while `decoder_q4.onnx_data` is 1.13 GiB. Per-tensor allocation probably makes this
fine, but 0003 must measure the largest individual tensor before writing runtime code.

## Successor

The 0.0% corpus result is not this wave's problem to fix, but it is a real hole: the harness
`README.md:148` recommends for choosing an inference model gives a working model a score of
zero, and cannot distinguish it from one that fabricates. Wave 06 addresses that, and 0001's
oracle depends on it. Until it lands, 0001 uses a hand-recorded set of real photographs.

## Atlas diff

- **`atlas.html:353` — the WebGPU path.** Wave 04 ticket 0004 marks it in-progress. This
  wave rewrites it to describe what actually ships: one hand-rolled LFM2.5-VL driver behind
  a runtime port, running on `onnxruntime-node` server-side and `onnxruntime-web`/WebGPU in
  the browser — not a Transformers.js pipeline, which was never able to express this.
- **`atlas.html:351` — "ONNX local VLM".** Gains the fact that the driver is now shared
  rather than server-only. Its description of the 3-stage loop stays accurate.

A new entry may be warranted for browser model provisioning if 0002 introduces a caching
layer distinct from the existing service worker. Decide when 0002's open questions close —
do not pre-write an entry for a design that has not been chosen.
