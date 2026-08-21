<!--
Factory ticket template — CI-Spatial

One ticket = one atomic, testable change an LLM can execute without guessing. Copy
this file into docs/factory/<wave-name>/NNNN-slug.md (four-digit, zero-padded,
sequential within the wave) and fill every section. A good Factory ticket reads like a
git commit recipe: exact files, exact schema, exact constraints, exact verification
commands. Anything left to interpretation is a bug in the ticket. Use "None" / "N/A"
where a section genuinely doesn't apply — don't delete headings.

This repo drafts tickets LOCALLY ONLY. Do not run `scripts/factory/factory.sh create`
or otherwise push this as a GitHub issue — see CLAUDE.md and docs/FACTORY.md for the
current policy.

If this ticket touches a schema, config variable, or a client<->server connection,
read docs/adr/0001-reuse-existing-domain-model.md first and cite it in Pinned
conventions, stating which existing type/queue/route you are extending (or what you
searched before concluding nothing exists to reuse).

There's no GitHub issue thread for this ticket. Log every open question and decision
directly in "Open questions & answers" below as you go, and check off Definition of
Done / Tests / Acceptance Criteria / Subtasks boxes in this file as each is completed.
-->

> **Type:** <!-- Backend / Frontend / Docs / Infra / Refactor / ... -->
> **Wave:** <!-- this ticket's wave folder name -->
> **Branch:** `type/short-scope`
> **Commit style:** `type(scope): summary`
> **Design:** <!-- link to design doc, or "this ticket is the spec" -->
> **Dependencies:** <!-- other tickets in this or another wave, or "None" -->

## Goal

<!-- One or two sentences: the outcome and why. -->

## Non-goals

<!-- Explicit fences so the model doesn't build adjacent things. Be concrete. -->

- Do not …
- Do not …

## Pinned conventions

<!-- Exact, verified conventions this change must match (naming, types, FK behavior,
     enum/constraint approach, id generation, timestamps). Pin values; don't say
     "match convention" without stating what it is. Write "N/A" if none.

     If schema, config, or a client<->server connection is touched: cite
     docs/adr/0001-reuse-existing-domain-model.md and state which existing
     type/queue/route this extends, or what was searched before concluding nothing
     exists to reuse. -->

## Before implementation

<!-- The exact files/patterns to read first so the model matches reality. -->

## Open questions & answers

<!-- Log every open question and its resolution here — this is the ticket's audit
     trail; there's no issue thread. Unresolved questions must be answered BEFORE
     coding starts.
     Format:
     - Q: … — A: … (decided by <who>, <date>)
     - Q: … — OPEN
-->

- Q:  — A:

## Files impacted

<!-- New: … / Changed: … — real paths. -->

## Schema required

<!-- Exact fields/types/constraints/indexes, or "None". Include defaults, nullability,
     and which existing type this extends (see Pinned conventions / ADR 0001) — a new
     type is only correct when nothing existing covers this. -->

## Definition of Done

- [ ]
- [ ]

## Tests

<!-- The exact tests (as checkboxes) plus the verification commands that must pass. -->

- [ ]
- [ ]

```
# verification commands
```

## Acceptance Criteria

<!-- Observable, verifiable checks. Given/When/Then where useful. -->

- [ ]
- [ ]

## Risks / potential issues

<!-- Known risks, edge cases, sharp edges, and their mitigation or a note to watch.
     Be honest about what could go wrong or bite later. Write "None known" only if true. -->

- **Risk:**  — **Mitigation:**

## Subtasks

<!-- Atomic, ordered steps. Keeps the work reviewable. -->

1. [ ]
2. [ ]
