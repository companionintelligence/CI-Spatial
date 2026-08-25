> **Type:** Docs
> **Wave:** 11-panoramic-canvas
> **Branch:** `docs/panoramic-canvas`
> **Commit style:** `docs(factory): summary`
> **Design:** this ticket is the spec
> **Dependencies:** all — lands last, and rewrites whatever the wave made false

## Goal

Record what outlives the wave: an ADR for the canvas contract, a pipeline doc, and the
end-of-wave truth pass over the atlas.

## What is already done, and what this adds

Per `docs/FACTORY.md`, the `planned` diffs and the wave card are written at wave *finalization*
(Phase 6), not here — and they were, when this wave was drafted. Already in the atlas: the
`11-panoramic-canvas` wave card, `planned` diffs on the entries the wave touches, and the config
group.

**This ticket is the other end of that**: flip those badges to done, rewrite the base prose the
wave made false, and write the ADR and pipeline doc that only exist once the decisions have been
executed rather than proposed.

## Non-goals

- Do not restate ticket content in the atlas. `docs/FACTORY.md`: *"**Never reproduce ticket
  content in the atlas** — one-line before/after and a pointer, nothing more."*
- Do not create `atlas-v2.html` or a dated copy. One atlas, git is the history.
- Do not add external assets to the atlas — it must open from a `file://` path with no network.
- Do not write the OneCanvas adapter ticket. That is the deliberately-undrafted 0008.

## Pinned conventions

**ADR numbering.** The next number is **0008** — `docs/adr/` holds `0000` through `0007` once
this wave's own ADR lands... which is circular, so state it plainly: **this wave's ADR is
0007**, claimed at drafting time when `0006` was the highest. **Claim it explicitly in the
commit** — ADR 0003 records two concurrent waves racing for `0002` and having to renumber. Check
`ls docs/adr/` immediately before merging.

**ADR structure** — `docs/adr/0000-adr-template.md`: **Context** ("Keep it factual; describe the
situation, not the answer"), **Decision** ("stated in the active voice: 'We will …'"),
**Consequences** ("Note what would cause us to revisit this ADR"). ADRs are immutable —
supersede, never edit.

**Atlas markup**, from `docs/FACTORY.md`: `status-badge` classes `done` / `planned` /
`underway` / `blocked`; `diff is-done` / `is-planned` blocks with `was` / `now` / `tag`;
`fcard changing` and `row-changing` for entries that change. Badge *text* need not match the
class — wave 09 uses `🔜 pending device`, and this wave has an equivalent state.

**The tense rule**, which this wave will trip if unwatched:

> "**A wave README must not describe an atlas gap in the present tense.** … 'the atlas does not
> mention X' is true while you draft and false by the time you commit — you are the one who
> fills the gap. … This is a real failure mode, caught by review on PR #118, where six such
> sentences across two wave READMEs were falsified by their own PR."

**Pipeline doc structure** mirrors `docs/pipelines/splat-train.md`: Architecture / Files /
Environment variables / Setup.

## Before implementation

- `docs/adr/0000-adr-template.md`, and ADR 0005 as a style model — its "Applicability beyond
  calibration" clause is the shape to imitate for a generalising rule.
- `docs/adr/0006-*.md` — the wave-10 ADR, whose contract-first structure this one parallels.
- `docs/FACTORY.md` § "The atlas", in full.
- `docs/pipelines/splat-train.md` and `docs/pipelines/4d-person.md`.
- `docs/architecture.md` — the reconstruction-pipeline description, which gains a third path.

## Open questions & answers

- Q: What does the ADR actually decide, beyond "we built a canvas"? — A: Three things that will
  otherwise be re-litigated: that **the canvas contract is independent of what is projected onto
  it** (RGB now, features later), which is what makes the densifier-equivalent swappable; that
  **the origin is a parameter**, because situated reasoning needs it and retrofitting it later
  would touch every consumer; and that **`depth-reconstruct` was implemented rather than
  replaced**, which is the ADR-0001 outcome and worth recording as a precedent for the next
  declared-but-unimplemented job type.
- Q: Should the ADR state the licence position, as ADR 0006 did for GVHMR? — A: Yes, and it is a
  different answer: OneCanvas's project page is CC BY-SA 4.0 and **the repo states no code
  licence at all**. Share-alike on code would be disqualifying against this repo's commercial
  `LICENSE.md`. Record it as an open constraint with an explicit trigger — *check the licence
  the moment the code appears, before building anything against it* — rather than as a decision.
- Q: Does `docs/architecture.md`'s "two independent pipelines" framing survive? — A: No. It was
  already made false by wave 10's third path; this wave adds a fourth surface (a canvas is not a
  reconstruction — it is a *view* of one). Rewrite the framing rather than appending to it.
- Q: Which atlas badge for work that is complete but whose framework has not shipped? — A:
  `planned`-class with honest text, following wave 09's `🔜 pending device` and wave 10's
  `🔜 pending GPU host`. Here: **`🔜 pending upstream code`**.

## Files impacted

New:
- `docs/adr/0007-the-panoramic-canvas-is-a-scan-artifact.md`
- `docs/pipelines/panoramic-canvas.md`

Changed:
- `docs/adr/README.md` — index the new ADR
- `docs/factory/atlas.html` — badges, base prose, the wave card's progress
- `docs/architecture.md` — the pipeline framing, the new job types and layers
- `docs/roadmap.md` — one entry, status only (that doc owns status and nothing else)
- `docs/product/UX_FLOW.md` — if 0006 has not already updated it
- `CLAUDE.md` — one sentence, as wave 10 added

## Schema required

None.

## Definition of Done

- [ ] ADR 0007 exists, follows the template's three sections, and states all three decisions plus
      the licence constraint
- [ ] `docs/adr/README.md` indexes it
- [ ] `docs/pipelines/panoramic-canvas.md` mirrors `splat-train.md`'s structure and documents
      every new env var **and** the operational properties: canvas artifacts accumulate per
      origin, depth adds a PNG per selected keyframe, and a canvas question is a model call
- [ ] Every `11-panoramic-canvas` atlas diff is flipped `planned` → `done` with its PR number,
      **except** anything genuinely gated on the unreleased code, which keeps
      `🔜 pending upstream code`
- [ ] The wave card's progress segments and count match reality
- [ ] Base prose the wave falsified is rewritten, not merely badged — at minimum
      `architecture.md`'s pipeline framing and the atlas's `depth-reconstruct` /
      `'depth'`-layer entries, which described them as having no producer
- [ ] No present-tense description of a gap this wave itself fills, in any file it touches
- [ ] The atlas still opens from a `file://` path with no network

## Tests

Docs ticket — verification is review and grep.

- [ ] Grep: every `CANVAS_*` / depth env var read by code appears in `.env.example` **and** the
      pipeline doc
- [ ] Grep the atlas for `11-panoramic-canvas` — every diff cites a real ticket file
- [ ] `ls docs/adr/` matches `docs/adr/README.md`'s index
- [ ] Open the atlas offline from `file://`; confirm it renders and that tag counts balance
- [ ] Confirm nothing still describes `depth-reconstruct` as unimplemented

```bash
ls docs/adr/ && grep -c "adr/000" docs/adr/README.md
grep -rn "CANVAS_\|DEPTH_" .env.example docs/pipelines/panoramic-canvas.md server/ | sort
grep -o "11-panoramic-canvas/[0-9]\{4\}" docs/factory/atlas.html | sort -u
grep -rn "no producer\|not implemented" docs/factory/atlas.html | grep -i depth
```

## Acceptance Criteria

- [ ] Given a reader who knows nothing of this wave, When they read ADR 0007, Then they can say
      why the canvas contract is independent of what is projected onto it
- [ ] Given an operator, When they read the pipeline doc, Then they can run the whole chain
      without reading a ticket
- [ ] Given the atlas after this wave lands, Then no sentence contradicts the shipped system,
      and nothing claims a verification nobody performed

## Risks / potential issues

- **Risk:** the atlas pass is last and so most likely to be skipped — and `CLAUDE.md` is explicit
  that a landed ticket the atlas still shows as planned is how the atlas stops being
  trustworthy. — **Mitigation:** it is its own ticket with a specific Definition of Done, rather
  than a checklist item at the bottom of someone else's.
- **Risk:** recording the licence position could read as legal advice or as a settled decision.
  — **Mitigation:** state the facts (page licence, absent code licence, what share-alike would
  mean here) and name it unresolved with an owner trigger. Do not characterise what is
  permitted.
- **Risk:** ADR 0007's number is claimed by a concurrent wave, as happened to 0002/0003. —
  **Mitigation:** claim it in the branch name and first commit; re-check `ls docs/adr/` before
  merging.
- **Risk:** rewriting `architecture.md`'s pipeline framing touches a doc other waves also edit.
  — **Mitigation:** it is one paragraph, and it is already false — leaving it is the worse
  option.

## Subtasks

1. [ ] Check `ls docs/adr/`; claim 0007 in the branch name; write the ADR
2. [ ] Index it in `docs/adr/README.md`
3. [ ] Write `docs/pipelines/panoramic-canvas.md`
4. [ ] Confirm the env vars are documented in both places
5. [ ] Atlas: flip this wave's badges, keeping upstream-gated ones pending
6. [ ] Atlas: update the wave card's segments and count
7. [ ] Atlas + `architecture.md`: rewrite the prose the wave falsified
8. [ ] `roadmap.md`, `UX_FLOW.md`, `CLAUDE.md`
9. [ ] Run the grep checks; open the atlas offline
