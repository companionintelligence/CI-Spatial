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

## The atlas — where a wave justifies itself

`docs/factory/atlas.html` is a self-contained page describing the system as it
actually is: every feature, data type, config variable, and connection, read from
source rather than from docs. Threaded through it is **before/after markup** showing
what each planned wave changes, plus a **Development waves** section summarizing the
waves themselves.

**The atlas is not a status report you write after the fact — it is how a wave earns
its keep.** A wave proposal is a claim that some work is worth doing; the atlas diff
is where that claim becomes checkable, because it forces the "before" to be stated in
the same terms as the rest of the system. Two things fall out of that, and both are
the point:

- **If you can't write a legible before/after, the wave probably isn't ready.** Vague
  entries ("improves consistency", "cleans up types") mean the work isn't yet pinned
  to something real. Go back to Phase 1/2 and read more code before proposing.
- **If the "before" isn't in the atlas at all, add it first.** A wave fixing something
  the atlas never described means the atlas has a gap — fill the gap, then diff it.
  That gap is itself a finding worth knowing about.

### When to update it

| Moment | What to do |
| --- | --- |
| **Proposing a wave** (Phase 3) | State which atlas entries the wave would change. This is the wave's justification — carry it into the approval gate. |
| **Finalizing a wave** (Phase 6) | Write the actual markup: `planned` diffs on every entry the wave touches, plus a wave card in the Development waves section. |
| **A ticket lands** | Flip that entry's badge `planned` → `done`, add the merged PR number, and update the wave card's progress. |
| **A wave fully lands** | Rewrite any prose the wave made false. A merged wave means the atlas's *base* description changed, not just its badges. |
| **A wave is blocked** | Mark it `blocked` and say what decision it waits on — an unexplained stall is worse than a documented one. |

### Markup vocabulary

The page is hand-written HTML with no build step and no external dependencies — edit
it directly. The classes that carry meaning:

```html
<!-- status badge: done | planned | blocked -->
<span class="status-badge planned">🔜 planned</span>

<!-- a before/after diff block; is-done (green) or is-planned (amber) -->
<div class="diff is-planned">
  <span class="was"><span class="strike">what is true today</span></span>
  <span class="now"><span class="arrow">→</span>what the wave makes true</span>
  <span class="tag"><span class="status-badge planned">🔜 planned</span> wave-name/00NN</span>
</div>

<!-- highlight a whole feature card or table row as changing -->
<div class="fcard changing">…</div>
<tr class="row-changing">…</tr>
```

Every diff block cites its wave and ticket number so a reader can go read the real
thing. **Never reproduce ticket content in the atlas** — one-line before/after and a
pointer, nothing more. The wave folders own the tickets; the atlas owns the picture.

### Rules

- One atlas, always at `docs/factory/atlas.html` — no `atlas-v2.html`, no dated
  copies. Git is the version history (ADR 0001 applies to documentation too).
- It must stay self-contained: no external scripts, styles, fonts, or images, so it
  opens correctly straight from a file path or a published artifact.
- Anything not carrying a status badge is base description — keep it true. When a
  landed wave makes a sentence false, fix the sentence.
- **A wave README must not describe an atlas gap in the present tense.** The README and
  the atlas pass happen at different moments of the same Phase 6, so "the atlas does not
  mention X" is true while you draft and false by the time you commit — you are the one
  who fills the gap. Write it as history: *"Until this wave's atlas pass, the atlas did
  not mention X."* Mark gaps the wave filled as *(gap filled)* rather than restating them
  as present fact. This is a real failure mode, caught by review on PR #118, where six
  such sentences across two wave READMEs were falsified by their own PR.

### A note on ordering, and why this rule exists

The tempting fix is to write the atlas diff before the READMEs. Don't — the diff can only
be written once the ticket breakdown is settled, and the READMEs are what settle it. The
two genuinely belong at different moments; the fix is tense, not sequence.

The deeper point generalizes past the atlas. **A planning document describes a moving
target and is committed at one instant of it.** Any sentence of the form "today the repo
has no X" is a claim with an expiry date, and the wave itself is usually what expires it.
Prefer dated or past-tense phrasing for anything the wave is about to change, and reserve
the present tense for what will still be true after the wave lands.

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
