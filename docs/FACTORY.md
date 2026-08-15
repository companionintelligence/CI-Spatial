# Factory — idea → local tickets, organized in waves

Factory turns a rough feature idea into small, commit-recipe tickets, drafted **locally
as markdown files** and organized into a wave folder under `docs/factory/<wave-name>/`.
This repo's Factory workflow does not use a GitHub issue board or issue-comment
telemetry — everything stays in the repo as files, reviewable in the same PR as the
code it describes.

- **`/factory` command** (`.claude/commands/factory.md`) — interactive: interview →
  break the idea into tickets → draft each as a file in a new wave folder.
- **Ticket template** (`docs/factory/TICKET_TEMPLATE.md`) — the ticket structure.
- **Helper CLI** (`scripts/factory/factory.sh`) — the `adr` subcommand (scaffold an
  ADR) is the one still used under this repo's policy. `create`/`start`/`finish`/
  `verify`/`question`/`decision`/`report` talk to GitHub issues and are **not used
  here** — see "What's unused" below.
- **ADRs** (`docs/adr/`) — decisions that outlive a single ticket. See
  [ADR 0001](adr/0001-reuse-existing-domain-model.md) for this repo's standing rule on
  reusing existing schema/config/connections instead of duplicating them.

## Ticket structure

A Factory ticket reads like a **git commit recipe**: exact files, exact schema, exact
constraints, exact verification commands. Anything left to interpretation is a bug in
the ticket. Sections: metadata (Type/Wave/Branch/Commit/Design/Dependencies), Goal,
Non-goals, Pinned conventions, Before implementation, Open questions & answers, Files
impacted, Schema required, Definition of Done, Tests, Acceptance Criteria, Risks /
potential issues, Subtasks. Use `None`/`N/A` where a section doesn't apply — don't drop
headings. Best practices are the default; when a ticket deviates, it says why.

If a ticket touches schema, a config variable, or a client↔server connection, its
**Pinned conventions** section must cite [ADR 0001](adr/0001-reuse-existing-domain-model.md)
and state which existing type/queue/route it extends (or what was searched before
concluding nothing exists to reuse).

## Waves

A **wave** is one batch of related tickets drafted together, living at
`docs/factory/<wave-name>/`. Each ticket is its own numbered file
(`0001-slug.md`, `0002-slug.md`, ...) within the wave folder. There is no separate
"drafts" staging area — the wave folder is the finished artifact once its tickets are
approved.

The first wave, `docs/factory/foundation-updates/`, holds the two tickets from the
initial post-setup review (license doc reconciliation, Tailscale hostname
auto-detection) — both already implemented and merged.

## Recording the reasoning trail

Since there's no GitHub issue thread, the reasoning trail lives **in the ticket file
itself**:

- Log every open question and its resolution in the ticket's **Open questions &
  answers** section as you go.
- Check off **Definition of Done** / **Tests** / **Acceptance Criteria** /
  **Subtasks** boxes directly in the file as each is completed.
- Promote a decision that outlives its ticket to an ADR:
  `scripts/factory/factory.sh adr new "<title>"`.

## What's unused (and why)

`scripts/factory/factory.sh` was originally built around a GitHub-issue workflow:
`create` (open an issue + add it to a project board), `start`/`finish` (issue comments
+ a machine-readable telemetry trailer), `question`/`decision` (issue comments),
`verify` (prove via git that an issue's merged PR landed on the default branch),
`report` (roll up telemetry trailers across issues into `.factory/metrics.csv`, viewed
via `scripts/factory/dashboard.html`).

None of that applies here — this repo does not create Factory tickets as GitHub
issues, so there's nothing for `start`/`finish`/`verify`/`question`/`decision`/
`report` to act on. They're left in the CLI (in case policy changes later) but are not
part of this repo's actual workflow. **`adr`** is the one subcommand still in active
use, since ADRs are plain local files regardless of the issue-board question.

## Configuration

`scripts/factory/factory.sh` derives repo/owner/branch from `gh` and `git` when its
GitHub-issue subcommands are invoked — which, per the policy above, they aren't in
this repo. `.factory/config.example` documents the available overrides
(`FACTORY_PROJECT`, `FACTORY_LABEL`, `FACTORY_REPO`, `FACTORY_OWNER`,
`FACTORY_ADR_DIR`, `FACTORY_OUT`, `FACTORY_DEFAULT_BRANCH`) for reference; only
`FACTORY_ADR_DIR` and `FACTORY_OUT` are relevant under current policy.

## Usage

```
/factory add bulk-tagging to the world editor's object list
```

The command interviews you, proposes a ticket breakdown and a wave name, drafts each
ticket under `docs/factory/<wave-name>/`, and stops there — it never creates a GitHub
issue.
