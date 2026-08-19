> **Type:** Backend
> **Wave:** 04-capture-path-truthfulness
> **Branch:** `fix/detection-model-default`
> **Commit style:** `fix(inference): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None

## Goal

Stop the server-side detection path writing invented objects to disk. Default the Ollama
engine to a model that can actually follow `SPATIAL_DETECTION_PROMPT`, and pin the request
context window so that model fits on the GPU instead of spilling onto CPU.

**Status: implemented 2026-08-18** during the Lume Pad 2 session that found the defect.
This ticket documents the change and its verification; the diff is in the working tree.

## The defect, precisely

`inference.ts:146` defaulted to `moondream:latest`, a 1B phi2-based captioner.
`src/inference/prompt.ts` is written — and its own docstring says so — for LFM2.5-VL.
moondream cannot produce structured detections, so it **copies the few-shot example out of
the prompt** and repeats it until it hits the token cap.

Reproduced directly against Ollama, prompt unchanged, on `dist/test-fixtures/room.jpg`:

```
"\n [0.22, 0.24, 0.78, 0.68]"
```

That is `prompt.ts:11`'s example bbox, verbatim. On a real desk photograph — mug, two
keyboards, two monitors, microphone, no plant anywhere — it emitted 32 copies of
`{"label": "potted plant", "bbox": [0.22, 0.24, 0.78, 0.68]}`.

The parser then rescues it rather than rejecting it:

1. `parseDetections`' salvage branch (`src/inference/prompt.ts:36-45`) closes the truncated
   array
2. `dedupeDetections` collapses the identical copies to one (IoU 1.0, above the 0.82
   threshold)
3. `coerceDetection` (`src/inference/prompt.ts:95-101`) fills the fields the model never
   emitted — `confidence` defaults to **0.8**, `description` to `A ${label}`

Which is exactly the `potted plant / 80% / "A potted plant"` the HUD showed. When moondream
also copied the example's `description`, that string survived dedupe as a *second* label —
hence `"small fern, white pot"` appearing in `scans/*.json` as though it were an object.

Measured across the 16 scan sidecars on disk: **31 of 38 labels are the prompt example**
(`potted plant` x27, `small fern, white pot` x4). The other 7 — monitor, table, keyboard,
mouse, lamp, vase, power strip — are real, one occurrence each. The failure rate is ~82%,
not 100%, which is why it reads as "detection is a bit unreliable" rather than "detection
is fabricated".

Head-to-head on one identical 896 px desk photo, same prompt, `temperature: 0.1`:

| Model | Result | Time |
|---|---|---|
| `moondream:latest` | `potted plant` + 20 copies of the example's numbers | 3.4 s |
| `qwen3-vl:4b` | 8 correct objects, correct boxes, two keyboards distinguished by colour | 17 s |
| `moondream:latest` on a blank grey frame | `potted plant` | 2 s |
| `qwen3-vl:4b` on a blank grey frame | `[]` | 1.7 s |

The blank-frame row is the one that matters: the replacement declines to hallucinate.

## The second defect: unpinned context

The Ollama payload in `inference.ts` set only `temperature`. With no `num_ctx`, Ollama uses
the model's full window — **262144** for `qwen3-vl:4b` — which reserves ~44 GB of KV cache,
overflows a 24 GB RTX 4090, and forces a 50/50 CPU/GPU split.

| `num_ctx` | Footprint | Processor | Time | Objects |
|---|---|---|---|---|
| 262144 (Ollama default) | 44 GB | 50/50 CPU/GPU | 116-177 s | — |
| 4096 | 3.5 GB | 100% GPU | 13.5 s | ~3 (truncates) |
| **8192 (chosen)** | **3.5-4.2 GB** | **100% GPU** | **17-20 s** | **8** |
| 32768 | 7.9 GB | 100% GPU | 13-19 s | 8 |

8192 is the default because it is the smallest window that returns a complete object list,
and 3.5 GB fits GPUs far smaller than the one this was measured on. 32768 is marginally
faster on a 4090 but costs 4.4 GB for no additional objects.

Captures already arrive downscaled to a 1280 px long edge (`src/capture/capture.ts:21`),
about 1.2k vision tokens, so 8192 leaves ample generation headroom. No capture-side change
is needed or wanted.

## Non-goals

- Do not edit `SPATIAL_DETECTION_PROMPT`. It is correct — `qwen3-vl:4b` follows it exactly,
  including the `bbox` key name, the 0-1 fractions, and the sub-7-word descriptions. The
  prompt was never the defect, and changing it here would confound the verification.
- Do not remove or weaken the salvage branch in `parseDetections`. With a capable model its
  truncation-recovery is correct and load-bearing — at `num_ctx` 4096 it is the only reason
  a truncated-but-real 3-object response survives at all. Its role in hiding this bug is a
  documentation problem, addressed in the atlas diff, not a code problem.
- Do not change `INFERENCE_MODE=onnx` or `mock`. Only the `ollama` branch is in scope.
- Do not backfill or delete the 219 existing scans carrying fabricated detections. That is a
  data migration with its own blast radius; see Risks.
- Do not add a "reject the example bbox" guard. It would have caught this, but it hard-codes
  one model's failure signature and would silently drop a legitimate centred detection.
  Revisit only if a second model is found to parrot.

## Pinned conventions

**ADR 0001** — this adds a config variable, so it states what it reuses. Verified at
`489cdcd`:

| Existing | Where | How used |
| --- | --- | --- |
| `OLLAMA_HOST`, `OLLAMA_MODEL` | `inference.ts:145-146` | `OLLAMA_NUM_CTX` joins the existing `OLLAMA_*` family and is read the same way, `Deno.env.get(...) ?? <default>` |
| `MAX_NEW_TOKENS` | `inference.ts:34` | the new constant sits beside it, module-level, same shape |
| the Ollama `options` object | `inference.ts` payload | extended with one key; `temperature: 0.1` untouched |
| `visionModels` fallback list | `inference.ts:188` | reordered, not replaced; the fallback mechanism is unchanged |
| `.env.example` inference block | `.env.example:47-51` | the new var is documented in the block that already owns Ollama config |

No new type, route, queue or connection. This is a default-value change plus one request
option.

## Before implementation

- `inference.ts:130-200` — engine constructor and the Ollama readiness/fallback path
- the Ollama `payload` in `inference.ts` — the `options` object
- `src/inference/prompt.ts` — read `SPATIAL_DETECTION_PROMPT` and `coerceDetection`
  together; the `0.8` and `A ${label}` defaults are what turn a partial copy into a
  confident-looking detection
- `.env.example:47-56`

## Open questions & answers

- Q: Is the prompt or the model at fault? — A: The model. `qwen3-vl:4b` follows the
  unmodified prompt correctly on the same images. (Measured 2026-08-18.)
- Q: Is `temperature: 0.1` implicated in the empty-output case seen on-device? — A: No.
  Reproduced at 0.1 with full correct output in 16.6 s. (Measured 2026-08-18.)
- Q: Why 8192 rather than the 32768 configured on the dev host's Ollama server? — A: A
  server-level `OLLAMA_CONTEXT_LENGTH` does not travel with the repo. Pinning per-request
  makes the behaviour reproducible on CI and any other deployment, and 8192 is the smallest
  validated window returning a complete list. (Decided 2026-08-18.)
- Q: Add `qwen3-vl:4b` to `visionModels`, or remove `moondream:latest`? — A: Reorder, don't
  remove. moondream stays as last-resort fallback for a host that has only it pulled — a
  degraded engine beats a dead one, and the fallback already warns with the substituted
  model name. (Decided 2026-08-18.)

## Files impacted

Changed:
- `inference.ts` — default model, `visionModels` order, `OLLAMA_NUM_CTX` constant, payload
- `.env.example` — documented default and the new variable
- `docs/factory/atlas.html` — entry at `:350`

## Schema required

None. `OLLAMA_NUM_CTX` is an env-read integer with an in-code default, not persisted state.

## Definition of Done

- [x] `inference.ts:146` defaults to `qwen3-vl:4b`
- [x] `visionModels` is ordered capable-first, `moondream:latest` last
- [x] `OLLAMA_NUM_CTX` exists, defaults to 8192, and reaches the Ollama request
- [x] `.env.example` documents both, and states what an unpinned context costs
- [ ] `atlas.html:350` names the new default and states the salvage trade-off honestly

## Tests

- [x] `deno task check` passes
- [ ] `npm run test:mock:unit` still passes (the mock path must be unaffected)
- [ ] A fresh scan's `labels` contains no detection whose bbox is exactly
      `[0.22, 0.24, 0.78, 0.68]`

```
deno task check
npm run test:mock:unit
npm run verify
```

## Acceptance Criteria

- [x] Given the server starts with no `OLLAMA_MODEL` set, `GET /health` reports
      `"model":"Ollama/qwen3-vl:4b"`
- [x] Given a capture of a scene containing no plant, When it is inferred, Then the returned
      labels do not include `potted plant`
- [x] Given the default config, When a capture is inferred, Then `ollama ps` reports
      `100% GPU` at context 8192 — not a CPU/GPU split
- [x] Verified on-device (Lume Pad 2, 2026-08-18): three consecutive autosaves recorded
      `keyboard, can, smartphone, plastic container, monitor, paper, snack, tablet, packet`
      — real, varied, scene-appropriate objects

## Risks / potential issues

- **Risk:** `qwen3-vl:4b` is ~6x slower per capture (17-20 s vs 3 s). — **Mitigation:**
  Accepted deliberately; the 3 s result was fabricated. Flagged as a UX cost to be decided
  separately. `OLLAMA_NUM_CTX=4096` trades object count for ~4 s if needed. Note the
  device-testing handoff's historical "35-47 s" figure — this path has had latency trouble
  before, so the regression risk is real and should be watched.
- **Risk:** A host with only `moondream:latest` pulled silently falls back to it and starts
  fabricating again. — **Mitigation:** The existing fallback `console.warn` names the
  substituted model. That is not enough to surface in the UI; if it should be, that wants
  its own ticket rather than being smuggled in here.
- **Risk:** 219 existing scans carry fabricated detections, indistinguishable from real ones
  except by inspecting labels for the example strings. — **Mitigation:** Out of scope by
  decision. Anyone reading historical scan data should treat `potted plant` and
  `small fern, white pot` as suspect until a cleanup ticket exists.
- **Risk:** VRAM contention — the 44 GB allocation was observed spilling, leaving the GPU at
  23.5/24.5 GB. — **Mitigation:** Pinning `num_ctx` is precisely the fix; after the change
  the same host sat at 9.9 GB used, 14.2 GB free.

## Subtasks

1. [x] Change the `OLLAMA_MODEL` default to `qwen3-vl:4b`
2. [x] Reorder `visionModels` capable-first
3. [x] Add the `OLLAMA_NUM_CTX` constant and pass it in the payload `options`
4. [x] Document both in `.env.example`
5. [ ] Update `atlas.html:350`
6. [ ] Run `npm run verify`
