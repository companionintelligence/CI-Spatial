> **Type:** Frontend
> **Wave:** 04-capture-path-truthfulness
> **Branch:** `fix/retire-webgpu-toggle`
> **Commit style:** `fix(inference): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None

## Goal

Remove a privacy claim the code cannot honour. The WebGPU / on-device inference toggle
offers "On-device — no data leaves your phone" and then throws on every capture, because it
asks Transformers.js for a pipeline task that does not exist in any released version.

## The defect, precisely

`src/inference/webgpu.worker.ts:84`:

```js
pipelinePromise = call('image-text-to-text', 'LiquidAI/LFM2.5-VL-1.6B-ONNX', pipelineOpts)
```

Every capture with the toggle set to WebGPU produces:

```
Error: Unsupported pipeline: image-text-to-text. Must be one of [text-classification,
token-classification, question-answering, fill-mask, summarization, translation,
text2text-generation, text-generation, zero-shot-classification, audio-classification,
zero-shot-audio-classification, automatic-speech-recognition, text-to-audio, image-to-text,
image-classification, image-segmentation, background-removal, zero-shot-image-classification,
object-detection, zero-shot-object-detection, document-question-answering, image-to-image,
depth-estimation, feature-extraction, image-feature-extraction]
    at InferenceRouter.handleWorkerMessage (src/inference/router.ts:139)
```

**This is not a version-pin problem, and upgrading will not fix it.** Verified 2026-08-18:

| Version | Registered pipeline tasks | `image-text-to-text` |
|---|---|---|
| 3.8.1 (installed) | 50 | absent from the registry; all 5 occurrences in the web build are JSDoc comments |
| 4.2.0 (latest release) | 23, in `src/pipelines/index.js` | the string does not appear in the module at all |

So the task has never been part of the `pipeline()` API. This code path has never run, on
any device, in any configuration.

Two aggravating factors:

- **It fails hard rather than degrading.** `InferenceRouter` falls back to the server on
  *timeout* (`src/inference/router.ts:130-132`), but the `error` branch
  (`:158-165`) simply rejects. Selecting WebGPU therefore turns capture off entirely rather
  than quietly using the server.
- **It takes the capture with it.** Because the throw happens before any persistence, all
  six test captures were destroyed — see ticket 0003. That is a separate defect, but this
  toggle is the most reliable way to trigger it.

## Why removal, not repair

LFM2.5-VL is a vision-language model. The closest supported task, `image-to-text`, is
captioning — it cannot return the bounded, structured JSON `SPATIAL_DETECTION_PROMPT`
requires. There is no supported `pipeline()` task that does this job.

The route that *would* work already exists in this repo. `inference.ts` drives LFM2.5-VL by
hand: a 3-stage `embed_tokens` / `embed_images` / `decoder` autoregressive loop with a
manually managed KV cache, running on onnxruntime-node (this is what `atlas.html:351`
describes). Porting that driver to onnxruntime-web with the WebGPU execution provider is the
real on-device path. It is a substantial piece of work, it is not a bug fix, and it should
not be smuggled into a ticket whose job is to stop the product lying about what it does.

So: this ticket removes the false claim. A follow-up wave can add the real capability.

## Non-goals

- Do not upgrade `@huggingface/transformers`. It would not help, and it would churn the
  bundle for nothing. (If it is upgraded for other reasons, that is a separate ticket.)
- Do not port the ONNX driver to the browser here. That is the follow-up, and it is large.
- Do not delete `src/inference/webgpu.worker.ts` outright. Leaving it in place, unreferenced
  and documented as non-functional, keeps the intended architecture legible for whoever does
  the port. Deleting the toggle's *reachability* is the goal, not erasing the attempt.
- Do not change the server inference path or `INFERENCE_MODE`.
- Do not repurpose the toggle for something else (e.g. a quality switch). An unrelated
  control in the same position would confuse anyone who used the old one.

## Pinned conventions

**ADR 0001** — this removes a client-side path; it states what it touches rather than what
it adds. Verified at `489cdcd`:

| Existing | Where | How used |
| --- | --- | --- |
| `_aiWebGPUBtn` toggle | `src/ui/panel.ts:205-207, 263-265` | the control to remove or disable |
| `InferenceRouter` | `src/inference/router.ts` | keeps its server path unchanged; only the worker branch becomes unreachable |
| `router.hasWebGPU` | referenced in `src/main.ts` catch copy (`'try WebGPU in the panel'`) | **must** be removed with the toggle, or the HUD will advise a control that no longer exists |
| `src/inference/webgpu.worker.ts` | | retained, unreferenced, with a header comment stating why |
| `atlas.html:353` | | rewritten — see the wave README's atlas diff |

No new type, route or connection.

## Before implementation

- `src/inference/webgpu.worker.ts:70-95` — the pipeline construction that cannot succeed
- `src/inference/router.ts:110-166` — how the worker is selected and how its errors are
  handled; note the timeout-only fallback
- `src/ui/panel.ts:200-270` — the AI-engine toggle row and its active-state styling
- `src/main.ts` catch block — the `router.hasWebGPU` branch of the failure copy
- `docs/factory/atlas.html:353`

## Open questions & answers

- Q: Upgrade the dependency instead? — A: No. 4.2.0, the latest release, registers 23 tasks
  and `image-text-to-text` is not among them. No released version supports this call.
  (Verified against the published `src/pipelines/index.js`, 2026-08-18.)
- Q: Remove the toggle, or disable it with an explanatory tooltip? — OPEN. Removal is
  honest and simple. A disabled control with "on-device inference coming" preserves the
  product intent and warns anyone who remembers the toggle. Slight preference for removal,
  because a disabled control still implies the feature is nearly ready — and it is not.
  **Decide before coding.**
- Q: Does anything persist a user's `webgpu` engine preference, such that an existing user
  returns to a dead setting? — OPEN. Check for a stored preference key before removing; if
  one exists it needs a migration to `server`, and CLAUDE.md's `Do not rename` discipline
  applies to any storage key found.

## Files impacted

Changed:
- `src/ui/panel.ts` — remove or disable the toggle
- `src/main.ts` — remove the `router.hasWebGPU` failure-copy branch
- `src/inference/router.ts` — make the worker branch unreachable
- `src/inference/webgpu.worker.ts` — header comment only
- `docs/factory/atlas.html` — entry at `:353`

## Schema required

None, unless the second open question finds a persisted engine preference — in which case a
one-way migration of `webgpu` to `server`, reusing the existing key rather than renaming it.

## Definition of Done

- [ ] The WebGPU engine cannot be selected from the UI
- [ ] No code path can dispatch a capture to `webgpu.worker.ts`
- [ ] The HUD failure copy no longer suggests WebGPU
- [ ] Any persisted `webgpu` preference resolves to `server` rather than a dead path
- [ ] `webgpu.worker.ts` carries a header stating it is unreferenced, why, and what the real
      on-device route is
- [ ] `atlas.html:353` describes reality
- [ ] `npx tsc --noEmit` and `npm run verify` pass

## Tests

- [ ] Manual: the AI-engine row offers no reachable WebGPU option
- [ ] Manual: captures succeed via the server path with no regression
- [ ] Manual: a profile with a stored `webgpu` preference loads and captures successfully
- [ ] `npm run verify`

```
npx tsc --noEmit
npm run verify
```

## Acceptance Criteria

- [ ] Given a fresh load, When the panel is opened, Then no control offers on-device
      inference
- [ ] Given a user whose stored preference was `webgpu`, When they capture, Then it succeeds
      via the server rather than throwing
- [ ] Given any capture, Then `Unsupported pipeline: image-text-to-text` cannot appear

## Risks / potential issues

- **Risk:** Removing a privacy-framed feature is a product regression in appearance, even
  though nothing working is lost. — **Mitigation:** Nothing working is lost — it has never
  functioned. Say so plainly in the commit message and the atlas entry, and reference the
  follow-up.
- **Risk:** Someone later re-adds `pipeline('image-text-to-text', ...)` unaware of this. —
  **Mitigation:** That is precisely why `webgpu.worker.ts` stays, with a header comment
  recording the finding and the version evidence.
- **Risk:** A stored preference is missed and an existing user lands on a removed engine. —
  **Mitigation:** The second open question; must be checked, not assumed.

## Subtasks

1. [ ] Answer both open questions — especially whether a preference is persisted
2. [ ] Make the worker branch unreachable in `InferenceRouter`
3. [ ] Remove or disable the toggle in `src/ui/panel.ts`
4. [ ] Remove the `router.hasWebGPU` branch from the `src/main.ts` failure copy
5. [ ] Migrate any persisted `webgpu` preference to `server`
6. [ ] Add the explanatory header to `webgpu.worker.ts`
7. [ ] Rewrite `atlas.html:353`
8. [ ] Run `npm run verify`
