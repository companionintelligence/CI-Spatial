> **Type:** Spike
> **Wave:** 11-panoramic-canvas
> **Branch:** `spike/qwen3-vl-8b-fit`
> **Commit style:** `docs(inference): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None — lands first, and its answer shapes 0005 and any future 0008.

## Goal

Answer one unmeasured question before anything is built on a guess: **does Qwen3-VL-8B
inference fit a card on this fleet?** The answer decides whether OneCanvas is an on-fleet
capability or an off-box subsystem.

## Why this is a ticket and not an assumption

The paper reports *training* compute — 8× RTX A6000 (48 GB) for 72.5 wall-clock hours — and
**no inference VRAM or latency figure at all**. Everything downstream would otherwise rest on
an arithmetic guess: 8B at fp16 is ~16 GB of weights, plus activations and canvas tokens,
against `beta-1`'s 23.98 GiB per card. That is plausibly enough and might comfortably not be.

Wave 10 is the cautionary case in the other direction: 4DAnyone needed 43.3 GiB on one CUDA
device, nothing on the fleet came close, and the whole wave had to be shaped around that. The
cost of measuring is an afternoon; the cost of not measuring is a wave built on the wrong
deployment shape.

ADR 0005 rule 5 — *tolerance constants are measured, not chosen* — generalises here: pick the
deployment shape from a measurement, not the other way round, and write down what was measured.

## Non-goals

- Do not implement the canvas, depth, or any adapter. This ticket produces **numbers and a
  decision**, and touches no runtime code.
- Do not train anything. Training is emphatically out of scope and always will be — the whole
  point of OneCanvas is that the backbone stays frozen.
- Do not attempt to run OneCanvas itself. Its code is unreleased; this measures the **backbone**
  it is built on, which is the part that determines whether the adapters could ever be hosted.
- Do not benchmark accuracy. Fit and latency only.

## Pinned conventions

**ADR 0001** — touches no schema, no config variable and no client↔server connection. This is a
measurement recorded in docs. N/A by the standard the ADR sets, and the search that establishes
it is short: nothing in the repo currently loads an 8B model, and `.env.example`'s
`OLLAMA_MODEL` is the one existing knob that names a model.

**Where the numbers go.** Two places, both existing:

- the measured table lands in this ticket's *Open questions & answers*, which is this repo's
  audit trail — there is no issue thread;
- the procedure lands in `docs/testing/DEVICE_TESTING.md`, beside the room-loop benchmark and
  Checklist C, because it is a "go run this on a real machine" procedure of exactly that kind.

**The existing model knobs** are `OLLAMA_MODEL` (default `qwen3-vl:4b`) and `OLLAMA_NUM_CTX`.
`.env.example` already warns that the model's full window — 262144 for `qwen3-vl:4b` — reserves
~44 GB of KV cache, which is itself a strong hint that context length, not weights, is what will
decide this. Measure with the context actually needed for a canvas, not the default.

**`beta-1` is ROCm, not CUDA** (2× Radeon RX 7900 XTX, ROCm 6.4). Ollama supports ROCm; a
PyTorch/transformers adapter stack with Flash Attention 2 does not, without work. Measure the
Ollama path, and record that distinction — it is the difference between "the backbone fits" and
"the eventual adapters can be hosted here".

## Before implementation

- `.env.example` — the `OLLAMA_MODEL` / `OLLAMA_NUM_CTX` block and its KV-cache warning.
- `server/inference.ts` — how the Ollama engine is addressed and what it sends.
- `docs/testing/DEVICE_TESTING.md` — the room-loop benchmark's structure, as the model for a
  written, repeatable procedure with a results table.
- `docs/factory/10-4d-person-capture/README.md` § "Why the inference is not on the appliance" —
  the format this ticket's findings should mirror, including probing the fleet rather than
  assuming it.
- The paper's § on training compute, so the numbers quoted here stay accurate.

## Open questions & answers

- Q: Why measure the 8B when the repo defaults to `qwen3-vl:4b`? — A: Because 0005 ships against
  whatever is running, but any future OneCanvas adapter is trained on the 8B and will not
  transfer to the 4B. Measuring both is what tells us whether the eventual swap is affordable or
  a procurement question. (Decided in this ticket.)
- Q: Is a canvas image even a normal VLM input, size-wise? — **OPEN, and part of what this
  measures.** An equirectangular canvas at the paper's evaluation resolutions (320×240 and
  640×480) is an ordinary image; the token cost is what it is. Record tokens-in alongside VRAM,
  because a canvas that fits in memory but blows the context window is the same "no" by another
  route.
- Q: What counts as a pass? — A: The backbone loads and answers a canvas-sized image within a
  latency a user would tolerate for a whole-scene question — **adopted as ~30 s**, on the
  grounds that this is a considered question about a room, not an interactive autocomplete.
  Record the real number; if it is wildly outside that, say so rather than moving the goalposts.
  (Decided in this ticket.)
- Q: If it does not fit, is the wave dead? — A: No. 0002–0006 are unaffected: depth, the canvas,
  frame selection, the editor surface and whole-scene questions against the *existing* 4B model
  all stand. Only the eventual adapter's home changes, from local to a
  `subsystems/onecanvas/` worker on the `4d-capture` pattern already in the tree. (Decided in
  this ticket.)

## Files impacted

Changed:
- `docs/testing/DEVICE_TESTING.md` — a new measurement procedure
- this ticket — the results table

No runtime code.

## Schema required

None.

## Definition of Done

- [ ] `qwen3-vl:8b` pulled on `beta-1` and its **peak VRAM** recorded, at a context sized for a
      canvas rather than the model default
- [ ] **Latency** recorded for one canvas-sized image + question, at 320×240 and 640×480
- [ ] The same two numbers recorded for the existing `qwen3-vl:4b`, which is what 0005 ships
      against regardless
- [ ] **Tokens-in** recorded for a canvas image, so a context-window ceiling is visible if there
      is one
- [ ] A decision written down in Open questions & answers: **on-fleet** or **off-box**, with the
      numbers that justify it
- [ ] The procedure written into `docs/testing/DEVICE_TESTING.md` so it can be re-run when the
      fleet or the model changes

## Tests

No automated tests — this ticket produces measurements. Verification is that the numbers exist
and the procedure is repeatable by someone else.

- [ ] A second person (or a later re-run) can follow the written procedure without asking
      questions
- [ ] The recorded numbers name the host, the ROCm/driver version and the model tag, so a future
      reader can tell whether they still apply

```bash
# on beta-1
ollama pull qwen3-vl:8b
rocm-smi --showmeminfo vram      # baseline, then again under load
# time one canvas-sized request through the running server
```

## Acceptance Criteria

- [ ] Given the measurement is done, When someone asks "can we host the OneCanvas backbone
      here", Then the answer is a number in this ticket rather than an opinion
- [ ] Given the 8B does not fit, When 0005 is implemented, Then it targets the 4B locally and
      the off-box path is recorded as the future adapter's home
- [ ] Given the 8B does fit, Then that is stated with peak VRAM and headroom, not as "it seemed
      fine"

## Risks / potential issues

- **Risk:** Ollama's memory behaviour is not the same as a transformers + LoRA adapter stack, so
  a pass here does not guarantee the eventual adapters fit. — **Mitigation:** say so explicitly
  in the recorded decision. This measures the backbone, which is a *necessary* condition, not a
  sufficient one.
- **Risk:** `beta-1` is ROCm and the adapter stack expects CUDA (Flash Attention 2). — **Mitigation:**
  record the distinction. A backbone that fits on ROCm still leaves a porting question, and that
  is exactly the shape wave 10 hit.
- **Risk:** The context window, not the weights, is the binding constraint —
  `.env.example` already warns the full window reserves ~44 GB of KV cache. — **Mitigation:**
  measure at a canvas-sized context, and record `OLLAMA_NUM_CTX` alongside every number.
- **Risk:** The measurement is never taken, and the wave proceeds on the guess anyway — which is
  what happened to wave 09's ticket 0006. — **Mitigation:** 0005's Definition of Done cites this
  ticket's decision, so skipping it is visible rather than silent.

## Subtasks

1. [ ] Pull `qwen3-vl:8b` on `beta-1`; record baseline and loaded VRAM
2. [ ] Time one canvas-sized request at 320×240 and at 640×480; record tokens-in
3. [ ] Repeat for `qwen3-vl:4b`
4. [ ] Write the procedure into `docs/testing/DEVICE_TESTING.md`
5. [ ] Record the numbers and the on-fleet/off-box decision in Open questions & answers
