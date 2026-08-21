> **Type:** Tooling
> **Wave:** 06-detection-ground-truth
> **Branch:** `feat/detection-regression-gate`
> **Commit style:** `feat(eval): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0001 (a corpus), 0002 (a harness pointed at it)

## Goal

Make a change that degrades detection fail loudly, before it reaches a user's scan. A corpus
nobody runs is a corpus that does not exist.

## Why a gate rather than "remember to run it"

Wave 04 ticket 0001's defect had every opportunity to be caught. The model default sat in
`inference.ts` in plain sight, the evaluation harness existed, the corpus existed, and the
README told people to use it. None of that helped, because nothing *ran* at a moment when
the answer would have blocked anything.

The specific change that would have caught it — swapping the default `OLLAMA_MODEL` — is a
one-line edit that passes `deno task check`, `npx tsc --noEmit`, every unit test, and CI.
It still does today. This ticket closes that.

## What triggers the gate

The inputs that determine detection quality, and nothing else:

| Input | Where |
| --- | --- |
| the default model | `inference.ts:146` |
| the vision-model fallback list | `inference.ts:188` |
| the request options, including `num_ctx` | `inference.ts` Ollama payload |
| the prompt | `src/inference/prompt.ts` |
| the parser and its defaults | `src/inference/prompt.ts` — `parseDetections`, `coerceDetection` |
| the capture encoding | `src/capture/capture.ts:21-23` |

A change to any of these should require a corpus run. A change elsewhere should not — the
run is minutes long and gating everything on it would guarantee it gets bypassed.

## The hard constraint: CI has no model

`.github/workflows/deno-ci.yml` installs with `deno install` and has no Ollama, no GPU and
no 2.2 GB of ONNX weights. A corpus run against a real VLM **cannot execute in CI as it
stands**, and pretending otherwise produces a gate that is disabled within a week.

This is the ticket's central design problem, and it is unresolved — see Open questions. The
honest options:

1. **A recorded score, checked in, and a documented pre-merge step.** No CI execution; the
   gate is a human one, but the score is version-controlled so a regression is visible in the
   diff. Weakest enforcement, zero infrastructure.
2. **A self-hosted runner with a GPU and models.** Real enforcement, real operational cost,
   and this is a small project.
3. **Gate on the mock engine in CI, and require the real corpus locally** for changes
   touching the inputs above. CI catches pipeline breakage; humans catch quality regressions.
   Probably the pragmatic answer.

Option 1 has a property worth weighing: a checked-in score file makes the model swap in wave
04 ticket 0001 *visible in review* — the diff would have shown the number moving, or not
moving, which is itself informative.

## Non-goals

- Do not gate all of CI on a model run. It cannot work today and would be disabled.
- Do not change scoring, the corpus, or the harness. 0001 and 0002 own those.
- Do not add a self-hosted runner in this ticket. If option 2 is chosen, that is
  infrastructure work with its own ticket.
- Do not gate on an absolute score. The threshold is "not worse than recorded", not "above
  0.8" — an absolute bar invites tuning the corpus to clear it.
- Do not block on `description` quality. Free text; not scored (0001).

## Pinned conventions

**ADR 0001** — CI and tooling; states what it reuses. Verified at `6492d81`:

| Existing | Where | How used |
| --- | --- | --- |
| `report.json` | `test-data/cv/report.json` | **reused** as the score artefact; the recorded baseline is a committed copy, not a new format |
| `scripts/eval-cv.mjs` | | invoked, not modified |
| `STRICT=1` | `scripts/eval-cv.mjs:24` | already exists — check whether it is the natural home for gate behaviour before adding a flag |
| `npm run verify` | `package.json` | the existing aggregate gate; the corpus run joins it or is deliberately excluded, but is not a parallel concept |
| `.github/workflows/deno-ci.yml` | | extended only if a CI-executable check is chosen |
| mock engine baseline | `INFERENCE_MODE=mock` | the CI-executable half under option 3 |

Note `STRICT=1` already exists in `eval-cv.mjs` — **read what it does before designing
anything**; the gate may already be half-built.

## Before implementation

- `scripts/eval-cv.mjs:24` — what `STRICT` currently does
- `.github/workflows/deno-ci.yml:40-60` — what CI can actually run
- `package.json` `verify` — the existing aggregate gate
- CLAUDE.md — CI installs with `deno install` and never runs Playwright; the same class of
  constraint applies here
- 0002's corpus-selection mechanism

## Open questions & answers

- Q: Which enforcement option? — **OPEN, and the substance of this ticket.** Leaning option 3
  (mock in CI, real corpus locally for detection-input changes), with option 1's committed
  score file as the review-visible artefact. **Decide before coding.**
- Q: What tolerance counts as a regression? — OPEN. Model output varies run to run even at
  `temperature: 0.1`. A threshold too tight produces flapping; too loose misses real
  regressions. Needs several runs of the same model on the final corpus to establish variance
  before a number can be chosen.
- Q: Does `STRICT=1` already do this? — OPEN. Read it first; the answer may shrink the ticket.
- Q: How is "this change touches detection inputs" detected — a path-based CI filter, a
  CODEOWNERS-style rule, or documentation? — OPEN. Path filters on the files listed above are
  mechanical and reliable; documentation alone is what failed last time.

## Files impacted

Changed:
- `scripts/eval-cv.mjs` — gate behaviour, if `STRICT` does not already cover it
- `.github/workflows/deno-ci.yml` — the CI-executable portion
- `package.json` — script wiring
- `CONTRIBUTING`-equivalent docs — the pre-merge step, if the gate is partly human

Added:
- a committed baseline score artefact

## Schema required

None beyond a committed `report.json`-shaped baseline. Reuses the existing shape.

## Definition of Done

- [ ] Changing the default model without re-running the corpus fails, or is visible in review
- [ ] The baseline score is committed and its provenance recorded (model, corpus, date)
- [ ] CI runs whatever portion is genuinely executable without a GPU or models
- [ ] The tolerance is derived from measured run-to-run variance, not guessed
- [ ] The pre-merge step, if any, is documented where a contributor will meet it
- [ ] `npm run verify` passes

## Tests

- [ ] Simulate the wave 04 defect: set `OLLAMA_MODEL=moondream:latest` and confirm the gate
      catches it. **This is the ticket's acceptance test** — if it does not catch the exact
      regression that motivated the wave, it is not finished.
- [ ] Confirm an unrelated change does not trigger a corpus run
- [ ] Confirm the mock CI path still passes

## Acceptance Criteria

- [ ] Given a change to the default model that degrades detection, Then it is caught before
      merge
- [ ] Given a change unrelated to detection, Then no model run is required
- [ ] Given CI without Ollama or a GPU, Then the pipeline still passes on a good change
- [ ] Given the baseline, Then a reviewer can see the score and when it was taken

## Risks / potential issues

- **Risk: a gate that cannot run in CI becomes a gate nobody runs.** This is the likeliest
  failure and it is exactly how the original defect survived. — **Mitigation:** Prefer the
  option with the lowest operational cost that still surfaces the number *in review*. A
  committed score in a diff is weak enforcement but has no maintenance burden and cannot
  silently stop working.
- **Risk:** Run-to-run variance causes flapping and the gate is disabled. — **Mitigation:**
  Tolerance derived from measured variance; explicitly in the Definition of Done.
- **Risk:** The baseline is regenerated to make a regression pass. — **Mitigation:** The
  baseline is committed, so regenerating it is a visible diff. Social, not technical, and
  worth stating as such.
- **Risk:** The gate is scoped so broadly it slows unrelated work. — **Mitigation:** The
  trigger table above is deliberately narrow.

## Subtasks

1. [ ] Read what `STRICT=1` already does
2. [ ] Establish run-to-run variance on the final corpus
3. [ ] Choose the enforcement option
4. [ ] Commit a baseline with recorded provenance
5. [ ] Implement the gate and its trigger scope
6. [ ] **Verify it catches `OLLAMA_MODEL=moondream:latest`**
7. [ ] Document the pre-merge step where contributors will meet it
