> **Type:** Frontend
> **Wave:** 04-capture-path-truthfulness
> **Branch:** `fix/gate-webgpu-toggle`
> **Commit style:** `fix(inference): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None. Superseded by wave 05, which delivers the real capability and
> un-gates the control.

**Status: implemented 2026-08-19.** Both open questions resolved below.

## Goal

Stop offering an inference engine that throws on every capture, **without deleting it**.
The WebGPU path is being built properly in wave 05 (`05-on-device-inference`); this ticket
only stops the product claiming a capability it does not yet have, and leaves every line of
the intended architecture in place.

**This is explicitly not a removal.** An earlier draft proposed retiring the toggle. That
was rejected: on-device inference is strategic for a product whose own tagline is *"Private
spatial memory for places you own"*, and deleting a control you intend to re-add is churn,
not progress. The decision was to port. See wave 05.

## The defect, precisely

`src/inference/webgpu.worker.ts:84`:

```js
pipelinePromise = call('image-text-to-text', 'LiquidAI/LFM2.5-VL-1.6B-ONNX', pipelineOpts)
```

Every capture with the toggle set to WebGPU produces:

```
Error: Unsupported pipeline: image-text-to-text. Must be one of [text-classification, ...]
    at InferenceRouter.handleWorkerMessage (src/inference/router.ts:139)
```

**`image-text-to-text` is not a registered pipeline task in any released Transformers.js.**
Verified 2026-08-18:

| Version | Registered tasks | `image-text-to-text` |
|---|---|---|
| 3.8.1 (installed) | 50 | absent; all 5 occurrences in the web build are JSDoc comments |
| 4.2.0 (latest) | 23, in `src/pipelines/index.js` | the string does not appear in the module at all |

This is not a version pin to bump — the `pipeline()` API has never exposed this task. Wave
05 replaces the call with a hand-rolled driver rather than waiting on upstream.

There is a **second, independent** blocker worth recording: the worker sets
`env.localModelPath = '/models/'` and `env.allowRemoteModels = false`, so it can only load
from `public/models/` — which `download_models.py` populates, which is documented as
optional (README.md:190-199), and which is absent on a checkout that never ran it. Even a
correct pipeline call would fail there. Wave 05 ticket 0002 owns that.

Two aggravating factors that make gating urgent rather than cosmetic:

- **It fails hard rather than degrading.** `InferenceRouter` falls back to the server on
  *timeout* (`src/inference/router.ts:130-132`); the `error` branch (`:158-165`) simply
  rejects. Selecting WebGPU turns capture off entirely.
- **It takes the capture with it.** The throw happens before any persistence, so the frame
  is destroyed — see ticket 0003. Six captures, zero retained, observed 2026-08-18.

## Why gate rather than silently fall back

The tempting one-line fix is to make the `error` branch fall back to the server the way the
`timeout` branch does. Captures would start working immediately.

**Do not do this.** The toggle's label is `'On-device — no data leaves your phone'`
(`src/ui/panel.ts:268`). A silent server fallback would ship the image off-device while the
UI insists it did not. For a performance toggle that would be fine; for a privacy claim it
is the worst available outcome — worse than the current hard failure, because it is
undetectable.

Any fallback policy is deferred to wave 05 ticket 0004, where it can be decided against a
path that actually works.

## Non-goals

- **Do not delete `src/inference/webgpu.worker.ts`, the toggle code, or the router's worker
  branch.** Wave 05 builds on all three. Only reachability changes.
- Do not upgrade `@huggingface/transformers`. It would not help.
- Do not implement any part of the port here. That is wave 05.
- Do not change the server inference path or `INFERENCE_MODE`.
- Do not repurpose the toggle's position in the panel for another control — it comes back.

## Pinned conventions

**ADR 0001** — this changes reachability of a client-side path; it states what it touches
rather than what it adds. Verified at `489cdcd`:

| Existing | Where | How used |
| --- | --- | --- |
| `_aiWebGPUBtn` toggle | `src/ui/panel.ts:205-207, 263-265` | hidden or disabled, **not deleted** |
| the `infer-mode` localStorage key | documented at README.md:148 | **must not be renamed** — CLAUDE.md's rename discipline applies; a stored `webgpu` value must resolve safely |
| `InferenceRouter` | `src/inference/router.ts` | server path unchanged; the worker branch becomes unreachable, not removed |
| `router.hasWebGPU` | `src/main.ts` catch copy | the `'try WebGPU in the panel'` suggestion must go while gated, or the HUD advises something unavailable |
| `src/inference/webgpu.worker.ts` | | untouched except a header comment recording both blockers and pointing at wave 05 |

No new type, route or connection.

## Before implementation

- `src/inference/webgpu.worker.ts:38-90` — `env` configuration and the pipeline construction
- `src/inference/router.ts:110-166` — worker selection, and the timeout-only fallback
- `src/ui/panel.ts:200-270` — the AI-engine toggle row and its active-state styling
- `src/main.ts` catch block — the `router.hasWebGPU` branch
- `README.md:148` — documents the `infer-mode` localStorage opt-in; needs the same caveat

## Open questions & answers

- Q: Upgrade the dependency instead? — A: No. 4.2.0 registers 23 tasks and this is not one.
  Wave 05 hand-rolls the driver. (Verified 2026-08-18.)
- Q: Hide the control, or show it disabled with an explanation? — A: **Hidden.** Decided by
  the product owner: focus is 8th Wall and server only, so the control is not built at all
  while gated. The AI-engine row keeps its Server button, which still communicates which
  engine is running. (Decided 2026-08-19.)
- Q: What happens to a user whose `infer-mode` is already `webgpu`? — A: It resolves to the
  server path at read time and is **never rewritten**. `init()` computes
  `saved === 'webgpu' && this.hasWebGPU`, which is now false, so the worker is not spawned;
  and `setMode('webgpu')` returns before its `localStorage.setItem`, so nothing overwrites
  the stored value. Verified in the built app: after reloading a profile with
  `infer-mode = webgpu`, the stored value is still `webgpu`, no control renders, and no
  worker resource is fetched. (Verified 2026-08-19.)

## How it was gated

A single build-time constant, `WEBGPU_INFERENCE_ENABLED` in `src/inference/router.ts`,
read from `import.meta.env.VITE_ENABLE_WEBGPU_INFERENCE` and defaulting to off. Vite folds
it to a literal `false` at build time — neither the flag name nor `import.meta.env` appears
in the output bundle.

The gate is applied inside the existing `hasWebGPU` getter rather than at each call site,
because every route into the worker already funnels through it: `init()`, `setMode()`, and
the HUD failure copy at `src/main.ts:407`. One `return false` closes all three, so the
"no code path dispatches to the worker" requirement holds structurally rather than by
enumeration. `setMode` gained one extra guard so it cannot persist a preference the app
cannot honour.

`src/ui/panel.ts` simply does not construct `_aiWebGPUBtn` while gated. Every consumer was
already null-guarded, so no other panel code changed.

## Files impacted

Changed:
- `src/ui/panel.ts` — gate the toggle
- `src/main.ts` — drop the `router.hasWebGPU` failure-copy branch while gated
- `src/inference/router.ts` — make the worker branch unreachable
- `src/inference/webgpu.worker.ts` — header comment only
- `README.md` — caveat the `infer-mode` opt-in at :148
- `docs/factory/atlas.html` — entry at `:353`

## Schema required

None. The `infer-mode` localStorage key keeps its name and its stored value; only its
interpretation changes while gated.

## Definition of Done

- [x] WebGPU cannot be selected as an inference engine from the UI
- [x] No code path dispatches a capture to `webgpu.worker.ts`
- [x] A stored `infer-mode` of `webgpu` resolves to `server` **without being overwritten**
- [x] The HUD failure copy no longer suggests WebGPU — `router.hasWebGPU` is false, so the
      `src/main.ts:407` ternary drops the suggestion without a separate edit
- [x] `webgpu.worker.ts` carries a header naming both blockers and pointing at wave 05
- [x] `atlas.html:433` describes the path as gated, not working — the `docs/atlas-post-wave-04`
      branch named below never existed/merged; landed directly on `main` instead (2026-08-24,
      `fix/gate-webgpu-toggle-atlas-readme`), which also bumped the wave card to 4/5
- [x] `README.md:534` (the second, duplicate mention this ticket's own PR #128 missed) no
      longer advertises the opt-in as available; the first mention at `:179` already didn't
- [x] `npx tsc --noEmit` and `npm run verify` pass (21 tests, 0 failures)

## Tests

- [x] Manual: the AI-engine row offers no selectable WebGPU option
- [x] Manual: a profile with `infer-mode = webgpu` loads via the server path
- [x] Manual: that profile's stored value is still `webgpu` afterwards
- [x] `npm run verify`

```
npx tsc --noEmit
npm run verify
```

## Acceptance Criteria

- [x] Given a fresh load, When the panel is opened, Then no control offers a working
      on-device engine — verified in the built app: no button matches /webgpu/i
- [ ] Given a stored `webgpu` preference, When the user captures, Then it succeeds via the
      server rather than throwing — **partially verified.** Routing confirmed: the profile
      loads on the server path, no control renders, no worker resource is fetched, and the
      stored value survives. An end-to-end capture was NOT exercised, because Ollama was not
      running on the test host. Re-check when the stack is live.
- [x] Given any capture, Then `Unsupported pipeline: image-text-to-text` cannot appear —
      structural: the worker is never spawned, confirmed by zero worker resources loaded
- [ ] Given wave 05 lands, Then un-gating is a reversal of this ticket, not a rewrite —
      cannot be verified until wave 05 ticket 0004 runs

## Risks / potential issues

- **Risk:** Gating reads as feature removal to anyone who does not read the ticket. —
  **Mitigation:** Say plainly in the commit message, the atlas entry and the worker header
  that this is temporary, and name wave 05.
- **Risk:** The stored preference is overwritten rather than reinterpreted, losing the
  user's intent before wave 05 can honour it. — **Mitigation:** The third open question;
  resolve at read time, never write.
- **Risk:** Someone re-adds `pipeline('image-text-to-text', ...)` unaware of the finding. —
  **Mitigation:** The worker header comment records the version evidence.
- **Risk:** Wave 05 stalls and the gate becomes permanent by neglect — arriving at the
  removal this ticket was rewritten to avoid, by drift rather than decision. —
  **Mitigation:** Nothing in code prevents this. Worth an explicit revisit date if wave 05
  is not scheduled.

## Subtasks

1. [x] Answer both open questions — especially the `infer-mode` read path
2. [x] Make the worker branch unreachable in `InferenceRouter`
3. [x] Gate the toggle in `src/ui/panel.ts` — not built at all while gated
4. [x] Remove the `router.hasWebGPU` branch from the `src/main.ts` failure copy — **no edit
       was needed.** Gating inside `hasWebGPU` makes the existing ternary evaluate to the
       empty string, so the suggestion disappears without touching `main.ts`. Left as-is
       deliberately: wave 05 restores the branch by lifting the gate, with no diff to revert.
5. [x] Resolve a stored `webgpu` preference to `server` at read time, without rewriting it
6. [x] Add the explanatory header to `webgpu.worker.ts`
7. [x] Update `atlas.html:433` and `README.md:179` — done here in PR #128. A second,
       duplicate WebGPU mention at `README.md:534` and the wave-card summary at
       `atlas.html:312` were missed by #128 and closed out separately, 2026-08-24, on
       `fix/gate-webgpu-toggle-atlas-readme` (the `docs/atlas-post-wave-04` branch this
       subtask originally named never existed).
8. [x] Run `npm run verify` — 21 tests, 0 failures
