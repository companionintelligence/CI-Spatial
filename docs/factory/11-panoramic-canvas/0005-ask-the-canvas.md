> **Type:** Backend
> **Wave:** 11-panoramic-canvas
> **Branch:** `feat/ask-the-canvas`
> **Commit style:** `feat(inference): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0003; reads 0001's decision

## Goal

Ask a question about a whole scanned room and get an answer — by handing the canvas to the VLM
this appliance is already running, as one image.

This is the payoff that does not wait for OneCanvas.

## Be honest about what this is

A raw RGB panorama through an **un-adapted** VLM is **not OneCanvas** and will not reproduce its
benchmark numbers. Those come from reprojecting *frozen encoder patch features* plus two stages
of LoRA training on spatial tasks. What this ships is a genuinely useful whole-scene question
path that happens to share OneCanvas's geometry.

Say that in the UI copy and in the docs. The failure mode to avoid is this feature quietly
accreting the paper's accuracy claims — the same class of overclaim wave 04 was written to
remove, and ADR 0005 rule 3 in a different costume.

## Non-goals

- Do not implement OneCanvas's adapters, position embedding, or feature reprojection.
- Do not add a second inference engine, a second prompt path, or a second route. Extend what
  exists.
- Do not make claims about accuracy the setup cannot support.
- Do not gate this on 0001's answer: it ships against whatever model is running, which today is
  `qwen3-vl:4b`.

## Pinned conventions

**ADR 0001** — touches a client↔server connection and a job type.

*Route.* Searched before adding: `POST /infer` (`server/main.ts`) already takes a multipart
image and runs it through the configured engine, with `INFER_MAX_IMAGE_BYTES` guarding it.
**Extend it** to accept a canvas + a question rather than adding an endpoint.

*Job.* `semantic-pass` is a declared `WorldJobType` **with no runner** — another placeholder,
like `depth-reconstruct` before 0002. Give it one, rather than minting a new type. Its
description in `docs/architecture.md` ("Semantic pass queued through the local coordinator")
already anticipates exactly this.

*Engine.* Go through the existing `server/inference.ts` engine selection — `ollama`, `onnx`,
`mock`. In particular the **`mock` engine must keep working**: it is what CI runs, and a
whole-scene question path that only works against a real model is untestable.

*Prompting.* `server/prompt.ts` is where prompts live. A canvas question is a different prompt
from per-frame detection and belongs there beside it, not inlined at the call site.

## Before implementation

- `server/inference.ts` — engine selection, the load-wait, `INFER_TIMEOUT_MS`.
- `server/main.ts` `POST /infer` — the multipart parse, the size guard, the error shape.
- `server/prompt.ts` — how an existing prompt is written.
- `docs/architecture.md` § World Job Types — what `semantic-pass` was always meant to be.
- **0001's recorded decision** — it says whether an 8B backbone is hostable here, which
  determines whether this is the final home for canvas questions or a stepping stone.
- `.env.example` — `OLLAMA_MODEL`, `OLLAMA_NUM_CTX`, and the KV-cache warning.

## Open questions & answers

- Q: Why extend `/infer` rather than add `/ask`? — A: Because it is the same operation — an
  image and a prompt to the configured engine — and a second route would duplicate the size
  guard, the engine wait, the timeout and the error shape. ADR 0001's whole point. (Decided in
  this ticket.)
- Q: Does the canvas fit the context window? — **OPEN until 0001 measures it.** `.env.example`
  already warns that the full window reserves ~44 GB of KV cache, so this is a real constraint,
  not a formality. If a 640×480 canvas does not fit, fall back to 320×240 and say so in the
  response rather than truncating silently.
- Q: What questions should `semantic-pass` ask? — A: Start with the ones a room can actually
  answer and a reviewer can check: describe this place; how many chairs; which room is largest.
  Store the answer as a job artifact. Do **not** build a question catalogue — that is a product
  surface and this is a pipeline stage.
- Q: Should the answer be stored on the scan? — A: As a job artifact, not as a new field on
  `ScanManifest`. An answer is a run of a model at a moment, and putting it on the scan implies
  a durability the answer does not have. (Decided in this ticket.)
- Q: What about the mock engine — what does it "see" in a canvas? — A: The same colour-blob
  detection it already does. The point of the mock path here is that the *plumbing* is
  exercised in CI, not that the answer is meaningful; assert on the shape of the response, not
  its content.

## Files impacted

Changed:
- `server/main.ts` — `/infer` accepts a question; `_runSemanticPassJob`; the dispatch branch
- `server/inference.ts` — a question-answering entry beside detection
- `server/prompt.ts` — the canvas prompt
- `src/world/manifests.ts` — `SemanticPassManifest`

New:
- `tests/unit/deno/canvas_prompt.test.ts`
- `tests/api-ask-canvas.spec.ts`

## Schema required

No new job type — `semantic-pass` finally gets a producer. One manifest:

```ts
export interface SemanticPassManifest extends PipelineManifestBase {
  tool: 'canvas-vlm';
  sessionId: string;
  /** The canvas this was asked about. */
  canvasPath: string;
  question: string;
  answer?: string;
  /**
   * The model that answered, verbatim from the engine — not the requested name.
   * `/health` once reported a model that was never pulled by trusting the
   * requested id; record what actually ran.
   */
  model?: string;
  params: { engine: string; resolution: [number, number] };
}
```

## Definition of Done

- [ ] `/infer` accepts a canvas image plus a question and returns an answer
- [ ] `semantic-pass` has a runner, writes its manifest on every path, and attaches the answer
      as a job artifact
- [ ] The `mock` engine path works end to end, so this is testable in CI
- [ ] The response and the docs state plainly that this is **not** OneCanvas and carries none of
      its accuracy claims
- [ ] The manifest records the model that actually ran, not the one requested
- [ ] A canvas too large for the context degrades to the smaller resolution and says so
- [ ] `deno task check`, `npx tsc --noEmit`, `npm run build` pass

## Tests

- [ ] Unit: the canvas prompt is assembled with the question and the honesty caveat
- [ ] Unit: the manifest is written on ok / skipped / error alike
- [ ] Unit: engine unavailable → `'skipped'` with remediation, not `'error'`
- [ ] Playwright (`api-ask-canvas.spec.ts`, `mock` engine): enqueue `semantic-pass` on a fixture
      scan with a canvas; assert the job completes, the manifest exists and the artifact carries
      an answer string
- [ ] Playwright: a scan with no canvas is `'skipped'` with a hint naming `build-canvas`

```bash
INFERENCE_MODE=mock deno task check
deno task test
npx playwright test tests/api-ask-canvas.spec.ts --project=api
```

## Acceptance Criteria

- [ ] Given a scan with a canvas, When `semantic-pass` runs, Then the job completes with an
      answer attached
- [ ] Given no canvas, Then it completes green with a hint naming `build-canvas`
- [ ] Given the mock engine, Then the whole path runs in CI without a model
- [ ] Given anywhere this feature is described, Then it does not claim OneCanvas's results

## Risks / potential issues

- **Risk (the one to watch):** this reads like OneCanvas and is not. Left alone, the distinction
  erodes and the paper's numbers get attached to it. — **Mitigation:** the caveat is a
  Definition-of-Done item in the copy *and* the docs, and `projected: 'rgb'` in the canvas
  manifest is the machine-readable version of the same statement.
- **Risk:** an un-adapted VLM may simply answer whole-room questions badly, making the feature
  underwhelming. — **Mitigation:** that is a real possible finding and worth reporting plainly
  rather than tuning prompts until a demo works. The geometry and the contract are the durable
  part; the answer quality is what the adapters exist to fix.
- **Risk:** context-window overflow surfaces as a truncated image and a confidently wrong
  answer. — **Mitigation:** the degrade-and-say-so behaviour, and 0001's measurement.
- **Risk:** `semantic-pass` already appears in the editor's job dropdown as a placeholder, so
  giving it a runner changes what an existing button does. — **Mitigation:** intended, but
  worth stating in the PR — it is the difference between a no-op and a model call.

## Subtasks

1. [ ] Add the canvas prompt to `server/prompt.ts` with its unit test
2. [ ] Extend `/infer` to take a question; keep the existing detection path untouched
3. [ ] Add `_runSemanticPassJob` and its dispatch branch; `jobResultFor` case
4. [ ] `SemanticPassManifest`; record the engine-reported model
5. [ ] Make the mock path work end to end
6. [ ] Write the honesty caveat into the response and the docs
7. [ ] Tests; `deno task check`, `npx tsc --noEmit`, `npm run build`
