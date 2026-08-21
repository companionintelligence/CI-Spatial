---
name: Factory ticket
about: A commit-recipe unit of work for the Factory project. One ticket = one atomic, testable change an LLM can execute without guessing.
title: "[Factory] Reconcile README license claim with LICENSE.md"
labels: factory
---

> **Type:** Docs
> **Phase:** Foundation hardening — post-setup review findings
> **Branch:** `docs/license-readme-reconcile`
> **Commit style:** `docs(license): reconcile README license claim with LICENSE.md`
> **Design:** this ticket is the spec
> **Dependencies:** None

## Goal

`README.md`'s `## License` section says **MIT**. `LICENSE.md` is actually a fully
specified, restrictive **Commercial Standard License** (`CI-Commercial-1.0`, ©
2019–2026 LifeScope INC, DBA Companion Intelligence). Make the README accurately
describe the license that governs the repo, so nobody — an external contributor, a
partner doing due diligence, an LLM agent reading the repo cold — walks away believing
this code is MIT-licensed when it is not.

## Non-goals

- Do not decide *which* license CI-Spatial should actually carry. `LICENSE.md` is
  treated as authoritative here only because it is the fully-specified legal document
  (identifier, version, effective date, copyright holder) versus README's bare
  unqualified word "MIT" — but whether that's the *intended* license, or whether
  `LICENSE.md` was pasted in from a template by mistake and MIT was actually meant, is
  a business/legal call this ticket cannot make. See Open questions.
- Do not modify `LICENSE.md` itself.
- Do not add a third license file, SPDX header sweep across source files, or any
  license-compliance tooling — this ticket is a one-file doc correction, not a
  licensing audit.

## Pinned conventions

- `README.md`'s `## License` heading is the sole license statement in the repo's
  entry-point docs — keep the fix scoped to that section; don't relocate it.
- Match `LICENSE.md`'s own naming for the license: "Commercial Standard License
  (CI-Commercial-1.0)" — don't paraphrase it as something softer like "proprietary" or
  "all rights reserved."

## Before implementation

- Read `README.md`'s `## License` section (currently the single word "MIT").
- Read `LICENSE.md` in full, at minimum its header block (License Identifier, Version,
  Effective Date, Product Name, Copyright line) and enough of the body to summarize
  accurately — don't just quote the header and ignore what the license actually grants
  or restricts.

## Open questions & answers

- Q: Is `LICENSE.md`'s Commercial Standard License the license this repo is actually
  meant to carry, or was it pasted in by mistake while MIT was intended? — OPEN. Route
  to whoever owns licensing/legal at LifeScope INC before this repo is shared
  externally; this ticket fixes the provable inconsistency (docs disagree) without
  presuming the answer.
- Q: Should the README point at `LICENSE.md` with a link/summary, or reproduce the
  license name only? — A: link + one-line summary, so the README stays short but
  correct even if `LICENSE.md`'s terms are later revised (decided by ticket author,
  2026-08-15).

## Files impacted

- Changed: `README.md` (`## License` section only)

## Schema required

None.

## Definition of Done

- [x] `README.md`'s `## License` section no longer says "MIT."
- [x] It correctly names the license ("Commercial Standard License, CI-Commercial-1.0")
      and links to `LICENSE.md`.
- [x] It does not claim to resolve the open question of which license is *intended* —
      that stays flagged for a human owner (e.g. a one-line note or a `TODO` addressed
      to whoever owns licensing).

## Tests

- [x] Manual read-through: `README.md`'s License section and `LICENSE.md`'s header no
      longer contradict each other.

```
grep -A2 '^## License' README.md
head -10 LICENSE.md
```

## Acceptance Criteria

- [x] Given a fresh clone, when a reader opens `README.md` and then `LICENSE.md`, then
      the two describe the same license — no reader can come away believing this repo
      is MIT-licensed.
- [x] Given the same read, when the reader looks for who to ask about the license
      choice, then the README points them somewhere (even just "contact
      licensing@lifescope" placeholder text) rather than leaving it silently unresolved.

## Risks / potential issues

- **Risk:** Fixing the README to match `LICENSE.md` could be read as "cementing" a
  restrictive commercial license the org never intended, if MIT was actually the goal
  and `LICENSE.md` is the mistake. — **Mitigation:** the Open Questions section above
  routes this to a human explicitly; the Definition of Done requires the fix to flag
  the ambiguity rather than silently resolve it.
- **Risk:** This repo may already be referenced externally (e.g. a public README badge,
  a partner doc) claiming MIT. — **Mitigation:** out of scope for this ticket, but worth
  a follow-up ticket once licensing confirms the intended terms.

## Subtasks

1. [x] Replace the `## License` section body in `README.md` with an accurate statement
       naming the Commercial Standard License and linking to `LICENSE.md`.
2. [x] Add a short note (in the same section, or as a code comment/TODO) flagging the
       MIT-vs-commercial discrepancy for whoever owns licensing to resolve.
3. [x] Confirm no other doc in the repo (`docs/*.md`) repeats the "MIT" claim. — checked
       via `grep -riIw MIT` across all `*.md`; only hits are the fixed README section
       (mentioning MIT solely to say it's wrong) and this ticket file itself.

---
<!--
Working-model protocol (do not remove):
• On START, the working model comments: model name + UTC start time.
• On COMPLETE, the working model comments: total token count.
Use scripts/factory/factory.sh start|finish to post these automatically.
-->
