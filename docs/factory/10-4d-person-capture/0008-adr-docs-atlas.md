> **Type:** Docs
> **Wave:** 10-4d-person-capture
> **Branch:** `docs/4d-person-capture`
> **Commit style:** `docs(factory): summary`
> **Design:** this ticket is the spec
> **Dependencies:** all — lands last, and rewrites whatever the wave made false

## Goal

Record the decisions this wave made where they outlive it: an ADR for the capture-rig and
subsystem boundary, a pipeline doc mirroring `splat-train.md`, and the **end-of-wave truth pass**
over `docs/factory/atlas.html`.

## What is already done, and what this ticket adds

Per `docs/FACTORY.md`, the `planned` diffs and the wave card are written at wave *finalization*
(Phase 6), not here — and they were, when this wave was drafted on 2026-08-24. Already in the
atlas: the `10-4d-person-capture` wave card, `planned` diffs on the Person capture, WebRTC
relay, and Video/photo ingest cards, on the `LayerType` and `WorldJob` schema rows, and a new
**4D person capture** config group. The stale `#waves` dek was corrected in the same pass.

**This ticket is the other end of that**: flip those badges to done, rewrite the base prose the
wave made false, and write the ADR and pipeline doc that only exist once the decisions have been
executed rather than proposed.

## Non-goals

- Do not restate ticket content in the atlas. `docs/FACTORY.md`: *"**Never reproduce ticket
  content in the atlas** — one-line before/after and a pointer, nothing more."*
- Do not resolve the licensing question. This ticket **records** it precisely; deciding whether
  4DAnyone can ship in a commercial product is a business decision, not a docs task.
- Do not create `atlas-v2.html` or a dated copy. One atlas, always at the same path; git is the
  history (ADR 0001 applies to documentation too).
- Do not add external assets to the atlas. It must stay self-contained so it opens from a file
  path or a published artifact.

## Pinned conventions

**ADR numbering.** The next number is **0006** — `docs/adr/` currently holds `0000` (template)
through `0005`. **Claim it explicitly in the commit**: ADR 0003 records two concurrent waves
racing for `0002` and having to renumber. There is no ADR 0006 or 0007 today; note that the
"0007" sometimes cited in a ground-anchor context is *ticket*
`docs/factory/09-ground-anchor-calibration/0007-reference-photos.md`, not an ADR.

**ADR structure** — `docs/adr/0000-adr-template.md`: **Context** ("What forces are at play …
Keep it factual; describe the situation, not the answer"), **Decision** ("stated in the active
voice: 'We will …'"), **Consequences** ("What becomes easier or harder… Note what would cause us
to revisit this ADR"). ADRs are immutable — supersede, never edit history.

**Also fix `docs/adr/README.md`.** Its index lists 0001–0004 and omits 0005. Adding 0006 without
fixing that leaves the index wrong in two places.

**Atlas markup vocabulary**, from `docs/FACTORY.md`:

```html
<span class="status-badge planned">🔜 planned</span>

<div class="diff is-planned">
  <span class="was"><span class="strike">what is true today</span></span>
  <span class="now"><span class="arrow">→</span>what the wave makes true</span>
  <span class="tag"><span class="status-badge planned">🔜 planned</span> wave-name/00NN</span>
</div>

<div class="fcard changing">…</div>
<tr class="row-changing">…</tr>
```

Badge classes: `done` / `planned` / `underway` / `blocked`. Badge *text* need not match the class
— wave 09 uses `<span class="status-badge planned">🔜 pending device</span>`, which is the right
pattern for this wave's unrun-until-hardware items. Inline code is `<code class="v">…</code>`.
Wave cards carry a `<div class="wave-progress">` with one `<span class="seg"></span>` per ticket.

**Tense rule — this wave will trip it if unwatched.** From `docs/FACTORY.md`:

> "**A wave README must not describe an atlas gap in the present tense.** The README and the
> atlas pass happen at different moments of the same Phase 6, so 'the atlas does not mention X'
> is true while you draft and false by the time you commit — you are the one who fills the gap.
> … This is a real failure mode, caught by review on PR #118, where six such sentences across two
> wave READMEs were falsified by their own PR."

This wave's README already uses the past-tense form (*"Until this wave's atlas pass, the atlas
described capture as exclusively place-shaped…"*). Keep it that way, and apply the same discipline
to the ADR and the pipeline doc.

**Pipeline doc structure** mirrors `docs/pipelines/splat-train.md`: Architecture / Files /
Environment variables / Setup. Note that most `BRUSH_*` and `SPLAT_DETECT_*` vars are documented
*there* rather than in `.env.example` — this wave documents `FDANYONE_*` in **both**, since the
undocumented-env gap is a known wart not worth reproducing.

**Doc ownership boundaries.** `docs/roadmap.md` owns status and timelines *and only that*;
`docs/architecture.md` owns system design; `PLACE_SCAN_DESIGN.md` is the current product contract
and supersedes product-facing uses of "world" as the top-level noun.

## Before implementation

- `docs/adr/0000-adr-template.md`, `docs/adr/README.md`, and ADR 0005 as a style model — its
  "Applicability beyond calibration" clause is the shape to imitate for a generalising rule.
- `docs/FACTORY.md` § "The atlas" in full.
- `docs/factory/atlas.html` — sections `#f-capture`, `#f-rtc`, `#f-recon`, `#f-server`,
  `#schema`, `#config`, `#waves`; and the `#connections` inline SVG.
- `docs/pipelines/splat-train.md` — section structure and the environment-variable table.
- `docs/architecture.md` § "The 4D Map Data Model (framing)" — it already defines "4D" for this
  repo as *a time-series of posed observations composed into one anchored frame*. This wave adds
  a genuinely time-varying **asset**, which is a different sense of the word; reconcile the two
  explicitly rather than letting them collide.
- `docs/factory/09-ground-anchor-calibration/HANDOFF.md` — the stale-badge note to fix.

## Open questions & answers

- Q: Does this wave need its own ADR at all, or is it just tickets? — A: It needs one. Two
  decisions outlive the wave: that a person capture is a *calibrated multi-client take* reusing
  ADR 0005's frame rather than a new calibration mechanism, and that GPU-class inference lives
  behind a subsystem boundary with a skip contract. Both will be re-litigated by the next
  feature that wants a GPU if they are only recorded in ticket bodies. (Decided in this ticket.)
- Q: Should the ADR state the licence position, or is that a separate document? — A: State it in
  the ADR, in Consequences, as a named constraint on productization with the revisit trigger
  being a commercially-licensed replacement for GVHMR. `CLAUDE.md` already warns that this repo
  has had a licence contradiction before (`LICENSE.md` vs a doc claiming MIT) and says to grep
  rather than trust — so an unrecorded licence constraint is exactly the failure mode to avoid.
  (Decided in this ticket.)
- Q: `docs/architecture.md` already uses "4D" to mean a time-series of scans. Does `splat4d`
  conflict? — A: Yes, and the fix is naming both senses explicitly in the ADR: **4D-the-map** (a
  place observed repeatedly over time, the existing sense) and **4D-the-asset** (one capture whose
  content moves, this wave's sense). They are compatible — an asset sits inside the map — but an
  unnamed collision is how a vocabulary rots. (Decided in this ticket.)
- Q: Which atlas badge for work that is complete in code but unverifiable without hardware? — A:
  `planned`-class with honest text, following wave 09's `🔜 pending device`. Here:
  `🔜 pending GPU host`. Marking it `done` would claim a verification nobody performed — the same
  defect ADR 0005 rule 3 is about. (Decided in this ticket.)
- Q: Should `docs/roadmap.md` gain a person-capture entry? — A: Yes, under **Exploratory**, and
  *only* status — roadmap.md owns status and nothing else. The capability description belongs in
  `architecture.md` and the pipeline doc. (Decided in this ticket.)

## Files impacted

New:
- `docs/adr/0006-person-capture-is-a-calibrated-take-and-densification-is-a-subsystem.md`
- `docs/pipelines/4d-person.md`

Changed:
- `docs/adr/README.md` — add 0005 (missing) and 0006
- `docs/factory/atlas.html` — the diffs, the wave card, and the two stale items
- `docs/factory/09-ground-anchor-calibration/HANDOFF.md` — clear the stale-badge note once fixed
- `docs/architecture.md` — the two senses of 4D; the new job type and layer
- `docs/roadmap.md` — one Exploratory entry
- `docs/product/UX_FLOW.md` — if 0007 has not already corrected lines 274/403
- `.env.example` — confirm the full `FDANYONE_*` group is documented
- `CLAUDE.md` — the repo overview describes two reconstruction pipelines; there is now a third
  path and a `subsystems/` boundary worth one sentence

## Schema required

None.

## Definition of Done

- [x] ADR 0006 exists, follows the template's three sections, and states both decisions plus the
      licence constraint and the two senses of "4D"
- [x] `docs/adr/README.md` lists 0005 **and** 0006
- [x] `docs/pipelines/4d-person.md` mirrors `splat-train.md`'s structure, documents every
      `FDANYONE_*` var, and states the operational properties operators need: a person job holds
      the global pump slot; sequence disk footprint; where clips travel
- [x] Every `10-4d-person-capture` diff badge is flipped `planned` → `done` with its merged PR
      number, **except** those genuinely gated on hardware, which keep `🔜 pending GPU host`
- [x] The wave card's progress segments and `N / 8 done` count match reality
- [x] Base prose the wave falsified is rewritten — not merely badged. At minimum: the AR Capture
      dek, the RTC card's "captures the AR canvas" description, and the Video/photo ingest card's
      "auto-enqueues LingBot-Map reconstruction" (no longer true in person mode)
- [x] Wave 09's stale badge noted in its `HANDOFF.md` is fixed and the note cleared
- [x] No present-tense description of a gap this wave itself fills, in any file it touches
- [x] The atlas remains self-contained — no external scripts, styles, fonts, or images
- [x] Every sentence the wave made false is corrected, not just badged

## Tests

Docs ticket — verification is review and grep, not a runner.

- [x] Grep: no remaining reference to a "4DAnyone" path that implies it runs on the appliance
- [x] Grep: every `FDANYONE_*` var read by code appears in `.env.example` **and** the pipeline doc
- [x] Grep the atlas for `10-4d-person-capture` — every diff block cites a real ticket file
- [x] Open `docs/factory/atlas.html` from a `file://` path with the network disabled; confirm it
      renders fully (proves self-containment)
- [x] Confirm ticket counts in the wave card match the files in the wave folder
- [x] Confirm `docs/adr/README.md`'s index matches `ls docs/adr/`

```bash
ls docs/adr/ && grep -c "adr/000" docs/adr/README.md
grep -rn "FDANYONE_" .env.example docs/pipelines/4d-person.md server/ | sort
grep -o "10-4d-person-capture/[0-9]\{4\}" docs/factory/atlas.html | sort -u
```

## Acceptance Criteria

- [x] Given a reader who knows nothing of this wave, When they read ADR 0006, Then they can say
      why person capture reuses ADR 0005's frame and why the GPU work is not on the appliance
- [x] Given an operator setting up a GPU host, When they read `docs/pipelines/4d-person.md`,
      Then they can configure it without reading any ticket
- [x] Given the atlas, When a reader looks at the capture section, Then the person-capture entry
      is present and its badge honestly reflects that the 4DAnyone path is unverified
- [x] Given the wave fully lands, When a reader reads the atlas's base prose, Then no sentence
      contradicts the shipped system

## Risks / potential issues

- **Risk:** The badge-flipping pass is done last, so it is the step most likely to be skipped —
  and `CLAUDE.md` is explicit that a landed ticket the atlas still shows as planned is how the
  atlas stops being trustworthy. — **Mitigation:** it is a ticket rather than a checklist item on
  someone else's ticket, which is the point; and its Definition of Done is specific enough to
  review against.
- **Risk:** Recording the licence constraint in an ADR could read as legal advice or as a
  decision that has been made. — **Mitigation:** state the facts (which components, which
  licences, which are mandatory stages) and name the constraint as unresolved with an explicit
  owner-decision trigger. Do not characterise what is permitted.
- **Risk:** ADR 0006's number is claimed by a concurrent wave, as happened to 0002/0003. —
  **Mitigation:** claim it in the branch name and the first commit, and check `ls docs/adr/`
  immediately before merging.
- **Risk:** Documenting "4D" twice deepens rather than resolves the vocabulary collision. —
  **Mitigation:** name both senses in one place (the ADR) and cross-reference from
  `architecture.md`, rather than defining each independently where they are used.

## Subtasks

1. [x] Check `ls docs/adr/`, claim 0006 in the branch name, and write the ADR
2. [x] Fix `docs/adr/README.md`'s index (0005 is missing today)
3. [x] Write `docs/pipelines/4d-person.md` mirroring `splat-train.md`
4. [x] Confirm the `FDANYONE_*` group is complete in `.env.example`
5. [x] Atlas: flip this wave's badges to done with PR numbers; keep hardware-gated ones pending
6. [x] Atlas: update the wave card's progress segments and done count
7. [x] Atlas: rewrite the base prose the wave falsified; fix wave 09's stale badge and clear the
       `HANDOFF.md` note
8. [x] Update `architecture.md`, `roadmap.md`, `UX_FLOW.md`, and `CLAUDE.md`
9. [x] Run the grep checks; open the atlas offline from `file://` to confirm self-containment
