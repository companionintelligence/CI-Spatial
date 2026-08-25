> **Type:** Tooling
> **Wave:** 06-detection-ground-truth
> **Branch:** `feat/retarget-eval-harness`
> **Commit style:** `feat(eval): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0001 (a corpus worth pointing at)

> ## Status: PARTIAL 2026-08-25 — tooling retargeted and verified; real-corpus scores blocked on 0001
>
> Everything this ticket asked for in code and docs is done and verified: `CV_CORPUS`
> selects the corpus (env var, following the `SERVER_URL` precedent), defaulting to
> `real` (`test-data/real/`); `bench:models` picks the corpus per candidate (`mock` ->
> synthetic, everything else -> real, overridable); a non-mock engine scored against the
> synthetic corpus gets a loud warning and an `outOfDistributionWarning` field in
> `report.json`; the corpus name appears in every summary line of console output and in
> `report.json`; `npm run verify` passes.
>
> **What's blocked:** ticket 0001 shipped the real corpus *scaffolded* — schema, policy,
> `test-data/real/README.md` — but with **0 photographs** (`expected.json` is `[]`); that
> is a physical/human step ("Manual step remaining" in `test-data/real/README.md`), not
> something this ticket can perform. So the two Tests that need real photographs
> (`qwen3-vl:4b` / `moondream:latest` scored on `test-data/real/`) and the Acceptance
> Criterion that depends on them ("two models of very different quality... the better one
> ranks higher") are **not run** — `eval-cv.mjs` correctly refuses to score an empty
> corpus (see below) rather than report a misleading 0%. The mechanism itself is verified
> instead using the synthetic corpus as a stand-in dataset: `mock` (100%) outranks
> `moondream:latest` (0%) in a real `bench:models` run, proving the corpus-per-candidate
> selection, scoring, and ranking all work; only the *discriminating* real-photograph data
> is missing.
>
> **Reopen (flip this back to in-progress) once `test-data/real/expected.json` is
> populated** — run `npm run bench:models` for real, record the `qwen3-vl:4b` vs
> `moondream:latest` gap, and tick the remaining boxes below.

## Goal

Make `eval:cv` and `bench:models` score against the real corpus, keep the synthetic one for
the job it is actually good at, and stop the README claiming a harness ranks models when it
cannot.

## The defect

`README.md:148` says the Ollama model is chosen with `npm run bench:models`.
`scripts/bench-models.mjs` scores candidates *"on the generated CV corpus via
scripts/eval-cv.mjs"* (`:3-4`). That corpus is coloured rectangles.

So the documented model-selection procedure ranks vision models on images no vision model
can interpret. Measured 2026-08-18: a working driver scores 0.0%, identical to a model that
fabricates every detection. **The procedure cannot distinguish them**, which is how
`moondream:latest` became the default and wrote invented objects into 219 scans.

`eval-cv.mjs:10-11` states the intent plainly — *"real VLMs get an honest precision/recall/
IoU report on the same fixed corpus"* — and that sentence is the bug. It is not honest; it
is out-of-distribution.

## The fix, in three parts

**1. Corpus selection.** `eval-cv.mjs` takes a corpus path (default: the real one from
0001), so both fixtures run through one scorer. `SERVER_URL` already works this way
(`eval-cv.mjs:23`) — follow that precedent rather than inventing new configuration.

**2. `bench:models` points at the real corpus.** It is the model-selection tool; it must
score on images that discriminate. Its `BENCH_MODELS=mock` baseline (`bench-models.mjs:7`)
should keep using the *synthetic* corpus, since that is where mock scores ~1.0 — meaning
bench needs to select the corpus per candidate, or document that the mock baseline is run
separately.

**3. The synthetic corpus is relabelled, in docs, as what it is:** a deterministic pipeline
regression fixture for the mock engine. Not a model benchmark. It stays, it keeps running,
it stops being cited as evidence about VLMs.

## Non-goals

- Do not change the scoring maths. Greedy IoU matching, precision/recall/mean-IoU/label
  accuracy (`eval-cv.mjs:13-14`) are all fine — they were fed the wrong images.
- Do not delete `test-data/cv/` or `generate-cv-images.mjs`.
- Do not add CI gating. That is 0003.
- Do not change `INFERENCE_MODE` or any engine behaviour. This ticket touches tooling and
  docs only.
- Do not rename `eval:cv` or `bench:models`. Both are documented and in muscle memory;
  renaming buys nothing.

## Pinned conventions

**ADR 0001** — tooling and docs; states what it reuses. Verified at `6492d81`:

| Existing | Where | How used |
| --- | --- | --- |
| `SERVER_URL` env override | `scripts/eval-cv.mjs:23` | the precedent the corpus selector follows — env var with a sensible default, not a new config file |
| scoring + matching | `scripts/eval-cv.mjs:13-14, 59-80` | unchanged |
| `expected.json` schema | both corpora | unchanged; 0001 matched it deliberately so one scorer serves both |
| `scripts/bench-models.mjs` | repo | retargeted, not rewritten |
| `report.json` output | `test-data/cv/report.json` | same shape; written beside whichever corpus ran |
| `npm run gen:test-data` | `package.json` | unchanged — it regenerates the synthetic corpus, which still exists |

No new type, no new config format.

## Before implementation

- `scripts/eval-cv.mjs` in full — it is short, and `:23`'s env pattern is the model to copy
- `scripts/bench-models.mjs:1-30` — how candidates are scored and what the mock baseline is
- `README.md:148, 423` — the two places the harness's purpose is described
- `docs/README.md:8`, `../../product/UX_FLOW.md:227` — other places the inference modes are explained
- 0001's corpus layout and any `acceptableLabels` addition

## Open questions & answers

- Q: Env var or CLI flag for corpus selection? — A: Env var, following `SERVER_URL` at
  `eval-cv.mjs:23`. The script is invoked from npm scripts where env prefixes are already the
  idiom. (Decided 2026-08-18.)
- Q: Which corpus is the default? — **Decided: real** (`CV_CORPUS=real`, `test-data/real/`),
  because the failure this wave exists to prevent is someone running the default and
  believing the number. The mock baseline opts in explicitly (`CV_CORPUS=synthetic`, or
  automatically when the candidate is `mock` — see next answer). (Decided 2026-08-25.)
- Q: Does `bench:models` need per-candidate corpus selection, or is running the mock baseline
  separately acceptable? — **Decided: per-candidate, automatic.** The `mock` candidate
  always scores against `synthetic` (where it scores ~1.0); every other candidate scores
  against `real`. `CV_CORPUS` overrides this for *all* candidates in one invocation when
  someone deliberately wants that (e.g. comparing several VLMs on the synthetic corpus on
  purpose — `eval-cv.mjs`'s warning still fires). This lets `BENCH_MODELS=mock,<vlm>` run in
  one invocation without misconfiguration risk, which "run the mock baseline separately"
  would not guarantee. (Decided 2026-08-25.)
- Q: Should `eval-cv.mjs` refuse to score a VLM against the synthetic corpus outright? —
  **Decided: warn, don't refuse** (as this ticket originally leaned) — the mock path
  legitimately needs to run non-mock engines against the synthetic corpus during
  development/debugging, and a hard block would need an escape hatch people would always
  pass anyway. Separately, `eval-cv.mjs` *does* refuse outright when a corpus's
  `expected.json` is missing or empty (0 entries) — that is not "out of distribution", it is
  "nothing to score", and reporting a 0% in that case would be exactly the kind of
  misleading number this wave exists to eliminate. This is why the real corpus's current
  empty state (0001 not finished) produces a clear error, not a silent 0%. (Decided
  2026-08-25.)

## Files impacted

Changed:
- `scripts/eval-cv.mjs` — corpus selection
- `scripts/bench-models.mjs` — target the discriminating corpus
- `README.md:148, 423` — stop claiming the synthetic corpus ranks models
- `docs/README.md`, `../../product/UX_FLOW.md` — same claim, other locations
- `package.json` — script wiring if a second npm entry point is warranted

## Schema required

None. `expected.json` and `report.json` keep their shapes.

## Definition of Done

- [x] `eval-cv.mjs` runs against either corpus, selected by env var, defaulting per the
      resolved open question — `CV_CORPUS`, default `real`; `scripts/lib/cv-corpus.mjs`
- [x] `bench:models` scores candidates on the discriminating corpus — per-candidate
      selection, real by default (see resolved Open questions)
- [x] The mock engine still scores ~1.0 on the synthetic corpus — verified: precision
      100.0%, recall 100.0%, meanIoU 0.944, labelAcc 100.0%
- [x] Every doc that describes the harness says which corpus does which job — `README.md`,
      `docs/testing/TEST_INFRA.md`, `docs/testing/user-test-suite.md`; `docs/README.md` and
      `docs/product/UX_FLOW.md` checked and did not carry the false claim
- [x] Running a VLM against the synthetic corpus warns that the result is not meaningful —
      verified with `moondream:latest`
- [x] `npm run verify` passes — verified (296 passed, 0 failed)

## Tests

- [ ] `qwen3-vl:4b` on the real corpus — materially above zero — **not run; `test-data/real/`
      has 0 images, see Status banner**
- [ ] `moondream:latest` on the real corpus — near zero, and clearly separated — **not run,
      same reason**
- [x] mock on the synthetic corpus — still ~1.0 — verified: precision 100.0%, recall 100.0%,
      meanIoU 0.944, labelAcc 100.0%
- [x] A VLM on the synthetic corpus — still 0.0%, but now with a warning explaining why —
      verified with `moondream:latest`: precision/recall/labelAcc 0.0%,
      `outOfDistributionWarning` present in `report.json`, warning printed before and after
      the run

## Acceptance Criteria

- [ ] Given `npm run bench:models`, When two models of very different quality are compared,
      Then the better one ranks higher — **mechanism verified, not the real scenario**: with
      `CV_CORPUS=synthetic` forced (the only populated corpus available), `BENCH_MODELS=mock,
      moondream:latest` ranks `mock` (100%) above `moondream:latest` (0%) in
      `test-data/bench-summary.json` and the printed table. The actual scenario — two real
      VLMs on the real corpus — is blocked on 0001.
- [ ] Given the README's instructions followed literally, Then the resulting choice is sound
      — **blocked**: the README now says correctly that `bench:models` can't rank models
      until the real corpus is populated (see Status banner), so there is no "resulting
      choice" to evaluate yet
- [x] Given the mock regression path, Then it is unaffected — verified (~1.0, unchanged
      scoring maths)
- [x] Given a 0.0% VLM result on the synthetic corpus, Then the output explains that this is
      expected and not a model verdict — verified

## Risks / potential issues

- **Risk:** Defaulting to the real corpus slows every invocation (~10 min vs seconds). —
  **Mitigation:** Real is the correct default for a *model selection* tool. The mock
  regression path stays fast because it opts into the synthetic corpus.
- **Risk:** Two corpora invites running the wrong one and misreading the number. —
  **Mitigation:** The warning requirement, and naming the corpus in `report.json` and in
  every line of console output.
- **Risk:** The docs claim survives in a file nobody greps. — **Mitigation:** Files impacted
  lists four known locations; grep for `bench:models` and `eval:cv` before closing.

## Subtasks

1. [x] Resolve the default-corpus and `bench:models` questions — see resolved Open questions
2. [x] Add corpus selection to `eval-cv.mjs`, following the `SERVER_URL` pattern —
       `CV_CORPUS`, shared resolution in `scripts/lib/cv-corpus.mjs`
3. [x] Retarget `bench-models.mjs` — per-candidate corpus selection
4. [x] Add the out-of-distribution warning
5. [x] Name the corpus in console output and `report.json`
6. [x] Fix every doc that describes what the harness measures
7. [ ] Verify the known-good / known-bad separation and the mock baseline together — **mock
       baseline verified; known-good/known-bad separation only demonstrated with the
       synthetic corpus as a stand-in (mock vs. moondream:latest) since the real corpus has
       no images yet — not the real verification this subtask asks for. Blocked on 0001.**
