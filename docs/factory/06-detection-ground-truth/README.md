# Wave: 06-detection-ground-truth

**Nothing in this repo can tell whether object detection works.**

That is not a figure of speech. Measured 2026-08-18: the LFM2.5-VL ONNX driver — which
correctly identified a mug, two keyboards, a monitor, a tripod and a sheet of handwritten
paper on a real photograph — scores **0.0% precision, 0.0% recall, 0.0% label accuracy,
0.000 mean IoU** on `npm run eval:cv`, across all 16 corpus images.

`README.md:148` tells you to choose your inference model with `npm run bench:models`, which
ranks candidates on that corpus.

## How this happened

`scripts/generate-cv-images.mjs:7` builds the corpus as *"furniture drawn as solid
palette-coloured rectangles (the colours the mock [detector] expects)"*. It is a fixture for
the deterministic mock CV engine, and for that job it is good — the mock scores ~1.0 and the
corpus is a genuine pipeline regression test.

It is not, and cannot be, a test of whether a vision model sees things. Given
`cv-00-studio-a.jpg`, whose ground truth is `lamp` + `shelf`, the working driver answers:

```json
[{"label":"chair","description":"wooden dining chair, brown"},
 {"label":"wall","description":"grey wall background"}]
```

Which is a correct description of a brown rectangle against a grey background. The corpus
paints a *lamp* as a coloured rectangle; no vision model will ever call that a lamp.

`eval-cv.mjs:10-11` states the intent — *"real VLMs get an honest precision/recall/IoU
report on the same fixed corpus"* — but a photo-trained model shown synthetic rectangles is
out of distribution, and its score measures nothing.

## What this cost

Wave 04 ticket 0001 documents a captioner shipping as the detection default and writing
fabricated objects into 219 of 254 stored scans. It was found by a human noticing that the
same bounding box appeared in every detection — not by any tool in this repo.

Both the fabricating model and the working one score 0.0% here. **The harness cannot tell
them apart.** Any model selected via `bench:models` is selected by noise, and the model
default that wave 04 changed was changed on the strength of four ad-hoc measurements run by
hand, with nothing to stop the next swap regressing it.

Wave 05 makes this sharper: it adds a *second* inference runtime, and 0001's oracle — "the
detections must be identical before and after" — is worthless against a 0.0% baseline, since
any mistake that also scores 0.0% passes.

## The second half: you cannot re-evaluate the past

You improved the model today. You cannot re-run it over the 219 fabricated scans, because
the frames were never kept — the capture is discarded unless inference succeeds (wave 04
ticket 0003). Every future model change has the same problem, and every real capture that
could have seeded a corpus is already gone.

That is why this wave is evaluation **and** retention. A corpus assembled from synthetic
images can only ever test the mock; a corpus assembled from real captures tests the product.

## Tickets

| # | Ticket | One-line goal |
|---|--------|---------------|
| 0001 | [real-photograph-corpus](0001-real-photograph-corpus.md) | A corpus of real photographs with human-verified ground truth, that a working model can actually score on |
| 0002 | [retarget-eval-and-bench](0002-retarget-eval-and-bench.md) | Point `eval:cv` and `bench:models` at it; keep the synthetic corpus for the mock, and stop claiming it ranks VLMs |
| 0003 | [detection-regression-gate](0003-detection-regression-gate.md) | Make a model or prompt change that drops the score fail loudly, before it reaches a scan |

## Dependency on wave 04

**Ticket 0001 is much cheaper after wave 04 ticket 0003 lands.** That ticket persists the
captured frame before inference; once it has, the corpus can be seeded from real captures
taken during ordinary use rather than staged by hand. 0001 is written to work either way —
hand-shot photographs are a valid start — but the durable version of this wave depends on
retention, which is why 04-0003 is not duplicated here.

## Why this before wave 05, arguably

Wave 05 is the more interesting work. This is the work that makes wave 05 checkable: its
0001 needs an oracle, its 0003 needs a way to confirm the browser runtime agrees with the
server, and its 0004 needs a basis for saying on-device inference is good enough to offer.
All three currently have nothing to measure against.

Sequencing is a judgement call, not a technical constraint — the two waves touch disjoint
files and can run in parallel. But if wave 05 lands first, it lands unverifiable.

## Atlas diff

- **`atlas.html:350`** — wave 04 ticket 0001 already revises this entry for the model
  default and the salvage trade-off. This wave adds what the detection path is measured
  against, since "how do you know it works" is currently unanswered anywhere in the atlas.
- A **new entry is likely warranted** for the evaluation corpus and regression gate — it is
  a real subsystem with its own scripts, fixtures and CI surface, and nothing in the atlas
  describes how detection quality is assessed today. Write it when 0002 settles what the
  harness actually becomes; do not pre-write it.
