> **Type:** Tooling
> **Wave:** 06-detection-ground-truth
> **Branch:** `feat/retarget-eval-harness`
> **Commit style:** `feat(eval): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0001 (a corpus worth pointing at)

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
- Q: Which corpus is the default? — Leaning **real**, because the failure this wave exists to
  prevent is someone running the default and believing the number. The mock baseline then
  opts in explicitly. **Confirm against `bench:models`'s mock-baseline flow before deciding.**
- Q: Does `bench:models` need per-candidate corpus selection, or is running the mock baseline
  separately acceptable? — OPEN. Depends on how `BENCH_MODELS=mock` is actually used in
  practice; ask before adding machinery.
- Q: Should `eval-cv.mjs` refuse to score a VLM against the synthetic corpus outright? —
  OPEN. A loud warning is probably better than a refusal — the mock path legitimately needs
  it, and a hard block would need an escape hatch that people would then always pass.

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

- [ ] `eval-cv.mjs` runs against either corpus, selected by env var, defaulting per the
      resolved open question
- [ ] `bench:models` scores candidates on the discriminating corpus
- [ ] The mock engine still scores ~1.0 on the synthetic corpus
- [ ] Every doc that describes the harness says which corpus does which job
- [ ] Running a VLM against the synthetic corpus warns that the result is not meaningful
- [ ] `npm run verify` passes

## Tests

- [ ] `qwen3-vl:4b` on the real corpus — materially above zero
- [ ] `moondream:latest` on the real corpus — near zero, and clearly separated
- [ ] mock on the synthetic corpus — still ~1.0
- [ ] A VLM on the synthetic corpus — still 0.0%, but now with a warning explaining why

## Acceptance Criteria

- [ ] Given `npm run bench:models`, When two models of very different quality are compared,
      Then the better one ranks higher
- [ ] Given the README's instructions followed literally, Then the resulting choice is sound
- [ ] Given the mock regression path, Then it is unaffected
- [ ] Given a 0.0% VLM result on the synthetic corpus, Then the output explains that this is
      expected and not a model verdict

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

1. [ ] Resolve the default-corpus and `bench:models` questions
2. [ ] Add corpus selection to `eval-cv.mjs`, following the `SERVER_URL` pattern
3. [ ] Retarget `bench-models.mjs`
4. [ ] Add the out-of-distribution warning
5. [ ] Name the corpus in console output and `report.json`
6. [ ] Fix every doc that describes what the harness measures
7. [ ] Verify the known-good / known-bad separation and the mock baseline together
