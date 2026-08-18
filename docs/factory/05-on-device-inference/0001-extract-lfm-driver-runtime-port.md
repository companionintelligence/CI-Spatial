> **Type:** Backend
> **Wave:** 05-on-device-inference
> **Branch:** `feat/extract-lfm-driver`
> **Commit style:** `refactor(inference): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None. Precondition for every other ticket in this wave.

## Goal

Lift the LFM2.5-VL inference loop out of `inference.ts` into a runtime-agnostic module
behind a small port interface, with the existing Deno/`onnxruntime-node` path as its first
consumer and **no observable behaviour change**.

This is a pure refactor. It ships no new capability. Its entire value is that ticket 0003
can then add a second runtime without copying a subtle autoregressive loop.

## Step zero: establish that the driver works at all

**Nobody has run this code path.** `public/models/` is populated only by an optional
`python3 download_models.py` (README.md:190-199) and is absent on the working checkout, so
`INFERENCE_MODE=onnx` is unverified.

Before any refactoring:

1. Run `python3 download_models.py` (~1.5 GB)
2. Start with `INFERENCE_MODE=onnx`
3. Infer the CV corpus in `test-data/cv/` and record the exact detections

That recording is the oracle for this ticket — the refactor is correct if and only if it
reproduces it. **If the driver turns out to be broken, stop and re-plan the wave.** Fixing
it is a different ticket with a different risk profile, and doing it inside a refactor makes
both unreviewable.

## What moves and what stays

The runtime-specific surface is small and already well isolated:

| Concern | Today | Port member |
| --- | --- | --- |
| session creation | `ort.InferenceSession.create(`${MODEL_DIR}...onnx`, opts)` (`inference.ts:236-238`) | `createSession(name, opts)` |
| tokenizer load | `Deno.readTextFile(`${TOKENIZER_DIR}tokenizer.json`)` (`:244`) | `readJson(name)` |
| image decode | Jimp, inside `patchifyImage` (`:559`) | `decodeImage(bytes) -> {data, width, height}` |
| tensor construction | `new ort.Tensor(...)` | supplied by the port, since each runtime brings its own |

Everything else is already runtime-agnostic and moves wholesale:

- the prefill/decode loop and its KV-cache threading (`inference.ts:431-520`) — note
  `past_key_values.N.key/value` in, `present.N.key/value` out
- the patchify maths in `patchifyImage` (`:559+`), minus the Jimp decode
- prompt construction and `parseDetections`, already shared with the browser worker

## Non-goals

- **No behaviour change.** Not a faster loop, not a better prompt, not a bug fix. If a bug
  is found during extraction, record it and fix it in a separate commit *before or after*,
  never inside the move.
- Do not touch `INFERENCE_MODE=ollama` or `mock`.
- Do not add `onnxruntime-web` or any browser code. That is ticket 0003.
- Do not change `MODEL_DIR` / `TOKENIZER_DIR` semantics or `download_models.py`.
- Do not "improve" the KV-cache handling while moving it. It is the subtlest code in the
  repo and the oracle only catches output differences, not latent fragility.

## Pinned conventions

**ADR 0001** — this creates a module boundary, so it states what it reuses. Verified at
`b314055`:

| Existing | Where | How used |
| --- | --- | --- |
| `SPATIAL_DETECTION_PROMPT`, `parseDetections`, `RawDetection` | `src/inference/prompt.ts` | already imported by **both** `inference.ts` and `src/inference/webgpu.worker.ts`; the extracted driver keeps using them, no new copy |
| the 3-stage loop and KV cache | `inference.ts:431-520` | **moved**, not reimplemented |
| `patchifyImage` | `inference.ts:559` | moved; only its Jimp decode becomes a port member |
| `MODEL_DIR` / `TOKENIZER_DIR` | `inference.ts:24-31`, `.env.example:64-65` | unchanged; the Deno port implementation reads them exactly as today |
| `InferenceEngine` class | `inference.ts:130+` | keeps its public shape — `_inferOnnx` becomes a thin call into the driver |
| `download_models.py` | repo root | unchanged; already provisions for both paths by design |

**The whole point of this ticket is ADR 0001 compliance.** The alternative — implementing the
loop again in the browser — is precisely the "third `ScanManifest`" the ADR exists to
prevent, and it would be far more dangerous than a duplicated type because divergence would
show up as subtly wrong detections rather than a type error.

## Before implementation

- `inference.ts:220-260` — session and tokenizer setup
- `inference.ts:431-520` — the prefill/decode loop; read the KV-cache naming carefully
- `inference.ts:559+` — `patchifyImage`
- `src/inference/webgpu.worker.ts` — the intended browser consumer, so the port interface
  is shaped against a real second caller rather than invented
- `docs/adr/0001-reuse-existing-domain-model.md`
- `deno.json:18` — how `onnxruntime-node` is resolved today

## Open questions & answers

- Q: Does the ONNX path currently work? — **OPEN and load-bearing.** Step zero answers it.
  Everything downstream assumes yes.
- Q: Where should the extracted module live? — OPEN. `src/inference/` is where the browser
  half lives and where `prompt.ts` already sits, so both runtimes can import it; but
  `main.ts`/`inference.ts` are Deno-resolved via `deno.json` while `src/` is Vite-resolved.
  **Confirm a module under `src/inference/` can be imported by `inference.ts` under Deno**
  before committing to the location — this is the single most likely thing to derail the
  ticket.
- Q: Is `ort.Tensor` shape-compatible between `onnxruntime-node` and `onnxruntime-web`? —
  OPEN. Both expose `Tensor` with the same constructor signature at 1.21, but this must be
  confirmed rather than assumed, since the port hands tensors across the boundary.
- Q: Should the port be an interface or a set of injected functions? — A: Injected functions
  in a single object. It is four members, all stateless; an interface with implementations
  adds ceremony for no gain. (Decided 2026-08-18.)

## Files impacted

Changed:
- `inference.ts` — `_inferOnnx` becomes a thin call; setup moves behind the Deno port impl

Added:
- an LFM2.5-VL driver module (location per the second open question)
- a Deno/`onnxruntime-node` implementation of the port

## Schema required

None. No persisted state, no wire format, no config change.

## Definition of Done

- [ ] Step zero completed: the ONNX path is confirmed working and its output recorded
- [ ] The loop, KV cache and patchify maths live in one runtime-agnostic module
- [ ] `inference.ts` consumes it through the port and behaves identically
- [ ] The module imports nothing from `Deno`, `onnxruntime-node`, or Jimp
- [ ] `deno task check` and `npx tsc --noEmit` both pass
- [ ] Output on the CV corpus is identical to the step-zero recording

## Tests

- [ ] Record CV-corpus detections before the change; assert equality after
- [ ] `npm run test:mock:unit` unaffected
- [ ] `npm run verify`

```
python3 download_models.py
INFERENCE_MODE=onnx npm run eval:cv     # baseline, before
# ... extract ...
INFERENCE_MODE=onnx npm run eval:cv     # must match
npm run verify
```

## Acceptance Criteria

- [ ] Given the same image and `INFERENCE_MODE=onnx`, When inferred before and after, Then
      the detections are identical
- [ ] Given the driver module, When it is type-checked in isolation, Then it references no
      runtime-specific API
- [ ] Given ticket 0003, Then adding a browser runtime requires implementing four functions
      and no changes to the loop

## Risks / potential issues

- **Risk:** The ONNX path may not work, invalidating the premise. — **Mitigation:** Step
  zero. Stop and re-plan rather than refactoring on top of a broken baseline.
- **Risk:** Deno and Vite resolve modules differently; a shared module under `src/` may not
  import cleanly under Deno. — **Mitigation:** The second open question. Resolve it *first* —
  it can force a different file layout for the whole wave. Note CLAUDE.md's precedent that
  `vite.config.ts` and `main.ts` deliberately keep parallel implementations across the
  runtime boundary rather than sharing a module; that precedent is about a 20-line function,
  and does not obviously extend to an autoregressive decode loop, but it is the reason to
  check rather than assume.
- **Risk:** A silent behavioural change in KV-cache handling. — **Mitigation:** The oracle
  compares full detection output, and the loop moves verbatim.
- **Risk:** The refactor lands and ticket 0003 never does, leaving indirection with one
  consumer. — **Mitigation:** Accepted. The indirection is four functions and the
  extraction is independently defensible for testability.

## Subtasks

1. [ ] **Step zero** — download the model, run `INFERENCE_MODE=onnx`, record the baseline
2. [ ] Resolve where the module lives so both runtimes can import it
3. [ ] Define the four-member port
4. [ ] Move the loop, KV cache and patchify maths verbatim
5. [ ] Implement the Deno/`onnxruntime-node` port
6. [ ] Rewire `_inferOnnx`
7. [ ] Re-run the CV corpus and diff against the baseline
8. [ ] `npm run verify`
