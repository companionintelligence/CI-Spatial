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

- Q: Which enforcement option? — **Decided: option 3** (mock engine in CI, real corpus
  locally for detection-input changes), with option 1's committed score file
  (`test-data/real/baseline.json`, a checked-in copy of `report.json` — same shape, not a
  new format) as the review-visible artefact. Implemented as: a CI-executable path filter
  (`scripts/check-detection-gate.mjs`) that requires `baseline.json` to move alongside any
  trigger-file change, plus a CI-executable mock/synthetic-corpus regression run
  (`scripts/ci-mock-gate.mjs`, wired into `.github/workflows/deno-ci.yml`'s new
  `detection-gate` job), plus a documented local pre-merge step
  (`docs/testing/TEST_INFRA.md` § "Detection regression gate") for the real-corpus
  comparison, which needs Ollama and cannot run in CI.
- Q: What tolerance counts as a regression? — **Not fully decided — blocked, see "Manual
  step remaining."** `scripts/lib/detection-gate.mjs`'s `BASELINE_TOLERANCE` (±0.05 on
  precision/recall/meanIoU) ships as an explicitly-labelled placeholder, not a measured
  figure — establishing it needs several runs of the same model against a *populated* real
  corpus, and that corpus has 0 photographs as of this writing. It is deliberately tight
  (produces false positives — an unnecessary rerun — before false negatives) so a wrong
  guess fails safe.
- Q: Does `STRICT=1` already do this? — **Answered: no, not as shipped, but it was the right
  flag to extend rather than replace.** It gated on fixed absolute thresholds (0.9/0.9/0.75)
  — exactly the "absolute bar" this ticket's Non-goals rule out for a quality gate, though
  it's a reasonable check for the deterministic mock corpus, which is why that behaviour is
  kept as the fallback path when no baseline is committed. `STRICT=1` now means "compare to
  the committed baseline if one exists for this corpus, else fall back to the original fixed
  thresholds" — same flag, extended meaning, per the pinned-conventions note to check this
  before adding a new one.
- Q: How is "this change touches detection inputs" detected? — **Decided: a path-based CI
  filter** (`scripts/check-detection-gate.mjs`, `TRIGGER_FILES` in
  `scripts/lib/detection-gate.mjs`), per the ticket's own lean. It warns rather than fails
  while the real corpus is unpopulated (see Manual step remaining) — hard-failing every
  detection-input change on a corpus nobody can populate from a repo checkout would be
  exactly the kind of gate that gets disabled, which is the risk this ticket exists to avoid.
  It becomes a hard failure automatically, no code change needed, once `test-data/real/` has
  at least one verified photograph.

## Manual step remaining

**Establishing the tolerance from measured run-to-run variance (Subtask 2), and running
the literal acceptance test — `OLLAMA_MODEL=moondream:latest` against the *populated* real
corpus (Subtask 6) — cannot be done from this change.** Both need a real, populated
`test-data/real/` corpus, and it has 0 photographs: ticket 0001's manual/physical step (a
camera, staged objects, a human writing ground truth) is not done. This is the same
blocker 0001 itself documents, one ticket downstream.

What this change does instead, so the acceptance test is not simply skipped:
- `tests/unit/node/detection_gate.test.ts` exercises `compareToBaseline()` against numbers
  shaped like the actual wave 04 defect — a working-model-shaped baseline vs. a
  moondream-shaped near-zero run (`GOOD_BASELINE` and the "wave 04 shape" test) — and
  confirms it is flagged. This verifies the gate's *comparison logic* is correct; it is not
  a substitute for the live run, and is labelled as such in the test file's header.
- `BASELINE_TOLERANCE` ships as an explicitly-commented placeholder
  (`scripts/lib/detection-gate.mjs`), not a measured value.
- The path-filter check (`scripts/check-detection-gate.mjs`) detects the corpus's empty
  state and warns instead of hard-failing, so this gap doesn't silently block every future
  detection-input PR — see the "How is 'touches detection inputs' detected" answer above.

To finish once `test-data/real/` is populated (0001's step):
1. Run `CV_CORPUS=real STRICT=1 npm run eval:cv` against `qwen3-vl:4b` several times; record
   the spread of precision/recall/meanIoU.
2. Set `BASELINE_TOLERANCE` in `scripts/lib/detection-gate.mjs` from that spread, citing the
   measurement in the comment that currently marks it provisional.
3. Run `npm run accept:detection-baseline` to commit the first real `baseline.json`.
4. Run `OLLAMA_MODEL=moondream:latest CV_CORPUS=real STRICT=1 npm run eval:cv` and confirm
   it now fails against that baseline — the ticket's literal acceptance test.
5. Check off this ticket's Definition of Done / Tests / Acceptance Criteria boxes below and
   flip the atlas entry (`docs/factory/atlas.html`, "Detection evaluation & regression
   gate") from pending to done.

## Files impacted

Changed:
- `scripts/eval-cv.mjs` — `STRICT=1` now compares against a committed baseline when one
  exists for the scored corpus, falling back to the original fixed thresholds otherwise
- `.github/workflows/deno-ci.yml` — new `detection-gate` job: path filter + mock-engine run
- `package.json` — `check:detection-gate`, `accept:detection-baseline`, `gate:mock` scripts;
  `test:detection-gate` added to `verify`
- `docs/testing/TEST_INFRA.md` — "Detection regression gate" section: what triggers it, the
  two enforcement halves, the local pre-merge command sequence
- `docs/factory/atlas.html` — new "Detection evaluation & regression gate" entry under
  Inference & Jobs

Added:
- `scripts/lib/detection-gate.mjs` — `TRIGGER_FILES`, `BASELINE_TOLERANCE`,
  `compareToBaseline()`, `triggeredFiles()` — shared by every script below
- `scripts/check-detection-gate.mjs` — the CI-executable path-filter check
- `scripts/accept-detection-baseline.mjs` — promotes a fresh `report.json` to
  `baseline.json`
- `scripts/ci-mock-gate.mjs` — the CI-executable mock-engine pipeline regression run
- `tests/unit/node/detection_gate.test.ts` — unit coverage for the comparison/path-filter
  logic, including the wave-04-shaped mechanism check (see Manual step remaining)
- a committed baseline score artefact — **not added**; see Manual step remaining. The
  mechanism (`baseline.json`, same shape as `report.json`) is built and wired, but no real
  score exists yet to commit, since the real corpus has 0 photographs.

## Schema required

None beyond a committed `report.json`-shaped baseline. Reuses the existing shape.

## Definition of Done

- [x] Changing the default model without re-running the corpus fails, or is visible in
      review — mechanically enforced by `scripts/check-detection-gate.mjs` once the real
      corpus is populated; warns (visible in the CI job log) until then
- [ ] The baseline score is committed and its provenance recorded (model, corpus, date) —
      **blocked, see Manual step remaining**: the mechanism exists, no real score does yet
- [x] CI runs whatever portion is genuinely executable without a GPU or models — the
      `detection-gate` job (path filter + mock-engine run)
- [ ] The tolerance is derived from measured run-to-run variance, not guessed — **blocked,
      see Manual step remaining**: ships as an explicitly-labelled placeholder
- [x] The pre-merge step, if any, is documented where a contributor will meet it —
      `docs/testing/TEST_INFRA.md` § "Detection regression gate"
- [x] `npm run verify` passes

## Tests

- [ ] Simulate the wave 04 defect: set `OLLAMA_MODEL=moondream:latest` and confirm the gate
      catches it. **This is the ticket's acceptance test** — if it does not catch the exact
      regression that motivated the wave, it is not finished. **Blocked, see Manual step
      remaining** — the real corpus has 0 photographs, so this cannot run for real yet.
      `tests/unit/node/detection_gate.test.ts` verifies the comparison logic against
      wave-04-shaped numbers as a mechanism-level substitute; it is not this test.
- [x] Confirm an unrelated change does not trigger a corpus run — verified locally
      (`check-detection-gate.mjs` against a diff touching only unrelated files exits 0
      immediately) and by `triggeredFiles()`'s unit coverage
- [x] Confirm the mock CI path still passes — verified locally: `npm run gate:mock` starts
      the mock-engine server, scores the synthetic corpus, exits 0

## Acceptance Criteria

- [ ] Given a change to the default model that degrades detection, Then it is caught before
      merge — mechanism built (path filter + baseline comparison); **not end-to-end verified
      against a real degrading change, see Manual step remaining**
- [x] Given a change unrelated to detection, Then no model run is required
- [x] Given CI without Ollama or a GPU, Then the pipeline still passes on a good change
- [ ] Given the baseline, Then a reviewer can see the score and when it was taken —
      `baseline.json` carries `engine`/`evaluatedAt` (report.json's existing provenance
      fields) and `accept-detection-baseline.mjs` prints the score delta on promotion; **no
      baseline exists yet to point to, see Manual step remaining**

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

1. [x] Read what `STRICT=1` already does
2. [ ] Establish run-to-run variance on the final corpus — **blocked, see Manual step
       remaining**
3. [x] Choose the enforcement option
4. [ ] Commit a baseline with recorded provenance — **blocked, see Manual step remaining**
5. [x] Implement the gate and its trigger scope
6. [ ] **Verify it catches `OLLAMA_MODEL=moondream:latest`** — **blocked, see Manual step
       remaining**; mechanism-level substitute in `tests/unit/node/detection_gate.test.ts`
7. [x] Document the pre-merge step where contributors will meet it
