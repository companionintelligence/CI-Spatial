---
description: Turn a feature idea into commit-recipe Factory tickets, drafted locally as a wave under docs/factory/.
argument-hint: [rough feature idea]
allowed-tools: Bash(scripts/factory/factory.sh:*), Bash(git:*), Bash(grep:*), Bash(find:*), Read, Write
---

You are running the **Factory ticket workflow**. Turn a rough feature idea into a set
of small, atomic, testable tickets — each written like a **git commit recipe** an LLM
can execute without guessing — drafted as markdown files under a new wave folder,
`docs/factory/<wave-name>/`.

**This repo's Factory workflow is local-only.** Tickets are never created as GitHub
issues. Do not run `scripts/factory/factory.sh create`, `gh issue create`, or
`gh issue edit`. The wave folder of markdown files *is* the deliverable.

The feature idea (may be empty): **$ARGUMENTS**

Guiding principles:
- **Reduce interpretation.** Exact files, exact schema, exact constraints, exact
  verification commands. If a section could be read two ways, tighten it.
- **Reuse, don't duplicate.** Before pinning a new type, env var, job type, or
  connection, search for one that already does the job. See
  [ADR 0001](../../docs/adr/0001-reuse-existing-domain-model.md) and `CLAUDE.md` —
  this repo already has two real cases (a duplicated `ScanManifest` type, two
  separate job-queue systems) of skipping this search. Every ticket that touches
  schema/config/connections must cite ADR 0001 and say what it's reusing or
  extending.
- **Default to best practices** in every recommendation and every generated ticket.
- **Record the reasoning trail in the ticket itself.** Every question raised and
  every decision made goes in the ticket's "Open questions & answers" section —
  there's no issue-comment thread to also post it to.

Do not skip the approval gates.

## Phase 1 — Frame the idea

If `$ARGUMENTS` is empty, ask the user for the feature idea in one sentence and wait.

Read repo context so tickets are grounded in reality: `CLAUDE.md`, the README, `docs/adr/`
(prior decisions — always check whether one already governs this area), and the actual
code areas the idea touches.

## Phase 2 — Interview (one focused batch)

Ask a **single batch** of 3–6 tailored questions covering the gaps that would otherwise
make tickets vague: scope & non-goals; data/schema; user-facing surface; edge cases &
constraints; dependencies & sequencing; rough ticket count. Wait for answers; at most one
short follow-up batch.

## Phase 3 — Propose the breakdown (APPROVAL GATE)

Present a numbered list: each ticket's **title** + one-line **goal** + **type**. Prefer
several small, independently-mergeable tickets over one big one. Note ordering / `blocked by`.
Also propose the **wave name** (a short kebab-case slug for this batch of work — the
folder will be `docs/factory/<wave-name>/`). Get explicit approval before proceeding.

## Phase 4 — Pin conventions (inspect before drafting)

For each area a ticket touches, **read the real code and pin exact conventions** — never
write "match existing convention" without stating what it is. Probe the repo for its own
patterns:

- **Reuse first (ADR 0001):** does an existing type in `src/world/types.ts`, an
  existing `WorldJobType`, an existing route in `main.ts`, or an existing env var
  already cover this? Search before pinning something new. State what you searched.
- **Naming & structure:** how modules/files/tests are named and laid out
  (`src/<subsystem>/`, `*.test.ts` alongside the file it tests).
- **Data layer:** this repo has no schema library (no Zod/io-ts) — types are
  hand-written TypeScript interfaces in `src/world/types.ts`, validated (where
  validated at all) with ad-hoc type guards in `main.ts`. Match that; don't introduce
  a validation library for one ticket.
- **Server routes:** Hono handlers in `main.ts`, CORS via the existing
  `isAllowedOrigin()` allowlist (don't add a parallel allowlist), config read via
  `Deno.env.get('X') ?? <default>` at module scope.
- **Client/server split:** browser code under `src/`, imports `type`-only from
  `src/world/types.ts` where possible; server-only logic stays in the root-level
  `.ts` files (`main.ts`, `jobs.ts`, `pipeline.ts`, `splat_*.ts`, `lingbot_map.ts`).
- **Tests:** Deno tests (`*.test.ts`, run via `deno task test`) for server/pipeline
  code; Playwright (`tests/`) for browser flows.
- **Prior decisions:** anything in `docs/adr/` that constrains the choice — cite the
  ADR id, don't just paraphrase it.

Write the pinned values into each ticket so the working model has nothing to invent.

## Phase 5 — Draft full ticket bodies

For each approved ticket, write a body mirroring `docs/factory/TICKET_TEMPLATE.md`:

```
> Type / Wave / Branch / Commit style / Design / Dependencies
## Goal
## Non-goals
## Pinned conventions          (cite ADR 0001 if schema/config/connections are touched)
## Before implementation
## Open questions & answers   (Q: … — A: … / OPEN; unresolved ones answered before coding)
## Files impacted             (New: … / Changed: …)
## Schema required            (exact fields, defaults, nullability, constraints, indexes;
                                state which existing type this extends, or "new — see
                                Pinned conventions for what was searched")
## Definition of Done
## Tests                      (checkbox cases + verification commands that must pass)
## Acceptance Criteria        (checkboxes)
## Risks / potential issues   (known risks + mitigations; be honest about sharp edges)
## Subtasks                   (atomic, ordered)
```

Rules:
- **Non-goals**, **Open questions & answers**, and **Risks / potential issues** are
  mandatory. Fence off adjacent work the model might add; capture every assumption as a Q
  (answered or OPEN) and every sharp edge as a Risk.
- **Branch** `type/short-scope`; **Commit** `type(scope): summary`.
- **Files impacted** lists real, verified paths (New vs Changed).
- **Tests** are checkboxes and include exact verification commands.
- Default to best practices; when you deviate, say why in Risks or Open questions.

Write each body to `docs/factory/<wave-name>/NNNN-slug.md` (four-digit, zero-padded,
sequential within the wave — start at `0001`). Show the user the drafts as an
**APPROVAL GATE**.

## Phase 6 — Finalize the wave

No GitHub issues are created. Once the drafts are approved, the wave folder
(`docs/factory/<wave-name>/`) *is* the finished deliverable. Confirm the folder
contains one file per approved ticket and nothing else pending.

If any ticket's decision will outlive it (i.e. it should govern future tickets too),
promote it to an ADR now: `scripts/factory/factory.sh adr new "<title>"`, then link
the new ADR from the ticket's Pinned conventions.

## Phase 7 — Report

Summarize: a table of `ticket file — title — one-line goal`, plus any `blocked by`
relationships within the wave. State the wave folder path.

---

## Working-model protocol (for whoever IMPLEMENTS a ticket)

There is no GitHub issue thread and no telemetry trailer in this repo's workflow.
Instead:

- Log every question hit and decision made directly in the ticket file's
  **Open questions & answers** section as you go — that section *is* the audit trail.
- As you complete each item, check its box in **Definition of Done** / **Tests** /
  **Acceptance Criteria** / **Subtasks** directly in the ticket file. A ticket with
  unchecked boxes is not done.
- If a decision made while implementing should govern future work, promote it:
  `scripts/factory/factory.sh adr new "<title>"`.
