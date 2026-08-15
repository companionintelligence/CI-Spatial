#!/usr/bin/env bash
#
# factory.sh — repo-agnostic CLI for the Factory ticket workflow + execution telemetry.
#
# Subcommands:
#   create    Create a GitHub issue from a body file, label it, add it to the board.
#   start     Comment: model name + UTC start time (marks work begun).
#   finish    Comment: completion + a machine-readable `factory-metrics:` trailer.
#   verify    Prove in git that an issue's merged PRs landed on the default branch.
#   question  Comment: an open question (interpretation signal).
#   decision  Comment: a resolved decision (Q + A + who).
#   adr       Scaffold a new Architecture Decision Record under docs/adr/.
#   report    Parse trailers across all Factory issues -> .factory/metrics.csv + summary.
#   help      Show this header.
#
# Config: sourced from <repo-root>/.factory/config if present. Env vars override.
#   FACTORY_PROJECT  project board title   (default: "Factory")
#   FACTORY_LABEL    ticket label          (default: "factory")
#   FACTORY_REPO     owner/repo            (default: derived via gh)
#   FACTORY_OWNER    project owner login   (default: derived via gh)
#   FACTORY_ADR_DIR  ADR directory         (default: "docs/adr")
#   FACTORY_OUT      metrics output dir    (default: ".factory")
#   FACTORY_DEFAULT_BRANCH  base for file diffs (default: auto-detected)
#
# Requires: gh (authenticated) and git. JSON parsed via gh's built-in `--jq`.
set -euo pipefail

die() { echo "factory: $*" >&2; exit 1; }
require_gh()  { command -v gh  >/dev/null 2>&1 || die "gh CLI not found: https://cli.github.com/"; }
require_git() { command -v git >/dev/null 2>&1 || die "git not found"; }

require_git
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
[[ -f "$ROOT/.factory/config" ]] && . "$ROOT/.factory/config"

FACTORY_PROJECT="${FACTORY_PROJECT:-Factory}"
FACTORY_LABEL="${FACTORY_LABEL:-factory}"
FACTORY_ADR_DIR="${FACTORY_ADR_DIR:-docs/adr}"
FACTORY_OUT="${FACTORY_OUT:-.factory}"

repo()  { if [[ -n "${FACTORY_REPO:-}" ]]; then echo "$FACTORY_REPO"; else gh repo view --json nameWithOwner --jq .nameWithOwner; fi; }
owner() { if [[ -n "${FACTORY_OWNER:-}" ]]; then echo "$FACTORY_OWNER"; else gh repo view --json owner --jq .owner.login; fi; }
now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

to_epoch() {
  date -u -d "$1" +%s 2>/dev/null \
    || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null \
    || echo ""
}

default_branch() {
  if [[ -n "${FACTORY_DEFAULT_BRANCH:-}" ]]; then echo "$FACTORY_DEFAULT_BRANCH"; return; fi
  local b
  b="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')" || true
  [[ -z "$b" ]] && for c in main master; do git show-ref --verify --quiet "refs/heads/$c" && b="$c" && break; done
  echo "${b:-main}"
}

project_number() {
  gh project list --owner "$(owner)" --format json \
    --jq ".projects[] | select(.title==\"$FACTORY_PROJECT\") | .number" 2>/dev/null | head -n1
}

cmd_create() {
  local title="" body_file="" labels="$FACTORY_LABEL"
  while [[ $# -gt 0 ]]; do case "$1" in
    --title) title="$2"; shift 2 ;;
    --body-file) body_file="$2"; shift 2 ;;
    --labels) labels="$FACTORY_LABEL,$2"; shift 2 ;;
    *) die "create: unknown arg '$1'" ;;
  esac; done
  [[ -n "$title" ]]     || die "create: --title required"
  [[ -f "$body_file" ]] || die "create: --body-file must exist"
  local r; r="$(repo)"
  IFS=',' read -ra L <<< "$labels"
  for l in "${L[@]}"; do l="$(echo "$l" | xargs)"; [[ -z "$l" ]] && continue
    gh label create "$l" --repo "$r" --color BFD4F2 --force >/dev/null 2>&1 || true; done
  local url; url="$(gh issue create --repo "$r" --title "$title" --body-file "$body_file" --label "$labels")"
  local number="${url##*/}"
  local pn; pn="$(project_number || true)"
  if [[ -n "$pn" ]]; then
    gh project item-add "$pn" --owner "$(owner)" --url "$url" >/dev/null 2>&1 \
      && echo "factory: added #$number to '$FACTORY_PROJECT'" >&2 \
      || echo "factory: WARN could not add #$number to '$FACTORY_PROJECT'" >&2
  else
    echo "factory: WARN project '$FACTORY_PROJECT' not found — issue created, not boarded." >&2
  fi
  printf '%s\t%s\n' "$number" "$url"
}

cmd_start() {
  local number="${1:-}" model="${2:-}"
  [[ -n "$number" && -n "$model" ]] || die "start: usage: factory.sh start <issue> <model-name>"
  gh issue comment "$number" --repo "$(repo)" \
    --body "$(printf '🤖 **Ticket started**\n\n- **Model:** `%s`\n- **Started:** %s' "$model" "$(now_utc)")"
}

started_at() {
  gh issue view "$1" --repo "$(repo)" --json comments \
    --jq '[.comments[] | select(.body|test("Ticket started")) | .createdAt] | last // empty' 2>/dev/null || true
}
count_clarifications() {
  gh issue view "$1" --repo "$(repo)" --json comments \
    --jq '[.comments[] | select(.body|test("Open question|Decision"))] | length' 2>/dev/null || echo 0
}
count_reopens() {
  gh api "repos/$(repo)/issues/$1/timeline" --paginate \
    --jq '[.[] | select(.event=="reopened")] | length' 2>/dev/null | awk '{s+=$1} END{print s+0}'
}
count_files() {
  local base out; base="$(default_branch)"
  out="$(git diff --name-only "origin/$base...HEAD" 2>/dev/null \
        || git diff --name-only "$base...HEAD" 2>/dev/null || true)"
  printf '%s' "$out" | awk 'NF{c++} END{print c+0}'
}

cmd_finish() {
  local number="${1:-}"; shift || true
  [[ -n "$number" ]] || die "finish: usage: factory.sh finish <issue> --model M --in N --out N [--turns N] [--first-pass yes|no] [--type T] [--files N] [--wall-s N]"
  local model="" tin="" tout="" turns="" first="na" type="" files="" wall=""
  while [[ $# -gt 0 ]]; do case "$1" in
    --model) model="$2"; shift 2 ;;
    --in) tin="$2"; shift 2 ;;
    --out) tout="$2"; shift 2 ;;
    --turns) turns="$2"; shift 2 ;;
    --first-pass) first="$2"; shift 2 ;;
    --type) type="$2"; shift 2 ;;
    --files) files="$2"; shift 2 ;;
    --wall-s) wall="$2"; shift 2 ;;
    *) die "finish: unknown arg '$1'" ;;
  esac; done

  [[ -n "$model" ]] || die "finish: --model is required"
  [[ -n "$tin" ]]   || die "finish: --in is required"
  [[ -n "$tout" ]]  || die "finish: --out is required"
  [[ "$tin"  =~ ^[0-9]+$ ]] || die "finish: --in must be a non-negative integer, got '$tin'"
  [[ "$tout" =~ ^[0-9]+$ ]] || die "finish: --out must be a non-negative integer, got '$tout'"

  warn_if_stacked

  [[ -z "$files" ]] && files="$(count_files)"
  local clar reopens; clar="$(count_clarifications "$number")"; reopens="$(count_reopens "$number")"
  if [[ -z "$wall" ]]; then
    local s; s="$(started_at "$number")"
    if [[ -n "$s" ]]; then
      local es en; es="$(to_epoch "$s")"; en="$(to_epoch "$(now_utc)")"
      [[ -n "$es" && -n "$en" ]] && wall=$(( en - es ))
    fi
  fi
  local total=""; [[ -n "$tin" && -n "$tout" ]] && total=$(( tin + tout ))

  local trailer
  trailer="$(printf 'factory-metrics: v=1 issue=%s type="%s" model="%s" tokens_in=%s tokens_out=%s tokens_total=%s wall_s=%s turns=%s files=%s first_pass=%s clarifications=%s reopens=%s' \
    "$number" "$type" "$model" "$tin" "$tout" "$total" "$wall" "$turns" "$files" "$first" "$clar" "$reopens")"

  gh issue comment "$number" --repo "$(repo)" --body "$(printf \
'✅ **Ticket completed**\n\n- **Model:** `%s`\n- **Tokens:** in %s / out %s / total %s\n- **Wall-clock:** %ss  •  **Turns:** %s  •  **Files:** %s\n- **CI first-pass:** %s  •  **Clarifications:** %s  •  **Reopens:** %s\n- **Finished:** %s\n\n```\n%s\n```' \
    "${model:-?}" "${tin:-?}" "${tout:-?}" "${total:-?}" "${wall:-?}" "${turns:-?}" "${files:-?}" \
    "$first" "$clar" "$reopens" "$(now_utc)" "$trailer")"
}

# Every PR that cross-references an issue (same-repo PRs only) — a CANDIDATE list, not
# proof. This discovery step is intentionally broad: any PR that so much as mentions
# `#N` anywhere in its title/body/commits shows up, which is exactly why PR #26 (the
# 24-ticket backlog scaffold, listing #2–#25), #63 (bug-ticket drafts #51–62 + ADRs), and
# #68 (this very verify subcommand's own PR, demoed against #25) all cross-reference
# dozens of issues while implementing none of them. `cmd_verify` treats these candidates
# as WEAK evidence and confirms each one against `closed_issues_for_pr` (GitHub's
# keyword-driven linkage) before trusting it — see that function's comment and
# `cmd_verify`'s doc comment for the full two-tier design.
linked_prs_for_issue() {
  local r; r="$(repo)"
  gh api "repos/$r/issues/$1/timeline" --paginate --jq \
    ".[] | select(.event==\"cross-referenced\")
         | select(.source.issue.pull_request != null)
         | select(.source.issue.repository.full_name==\"$r\")
         | .source.issue.number" 2>/dev/null | sort -un
}

# The issues a PR's merge FORMALLY closes, per GitHub's own keyword-driven linkage
# (Closes/Fixes/Resolves #N in the PR body) — populated ONLY from that syntax, never from
# a bare mention. This is the STRONG signal `linked_prs_for_issue`'s broad cross-reference
# scan cannot provide on its own.
#
# Verified empirically 2026-07-19: sweeping every currently-open issue with `verify`
# reported LANDED for #15–19, #21–25, #29, #31, and #62 — thirteen genuinely unimplemented
# tickets, every one a false positive traced to PR #26, #63, or #68 (see
# `linked_prs_for_issue`'s comment). None of those three PRs' `closingIssuesReferences`
# list the issues they merely mention — confirmed via `gh pr view 26/63/68 --json
# closingIssuesReferences`, all empty except #68 → #61 (its own real ticket) — which is
# exactly why this check works where the broad scan alone does not.
closed_issues_for_pr() {
  gh pr view "$1" --repo "$(repo)" --json closingIssuesReferences \
    --jq '.closingIssuesReferences[].number' 2>/dev/null | sort -un
}

# Advisory only, called from finish: the current branch's PR must target the default
# branch. Never dies — finish's job is posting telemetry, and losing the trailer costs
# more than a missed warning. `verify` is the hard gate.
warn_if_stacked() {
  local base cur
  base="$(default_branch)"
  cur="$(gh pr view --json baseRefName --jq .baseRefName 2>/dev/null || true)"
  [[ -z "$cur" ]] && return 0             # no PR for this branch / detached HEAD — silent skip
  [[ "$cur" == "$base" ]] && return 0
  echo "factory: WARN this branch's PR targets '$cur', not '$base'." >&2
  echo "factory: WARN stacked PRs are forbidden — 'Closes #N' will NOT close the issue and the work will strand." >&2
  echo "factory: WARN fix before merging:  gh pr edit --base $base" >&2
}

# Prove IN GIT that an issue's work reached the default branch.
#
#   exit 0  LANDED      — at least one STRONG (keyword-confirmed) merged PR's commit is
#                         an ancestor of origin/<default>.
#   exit 1  STRANDED    — no PR references the issue at all; or a strong PR is merged but
#                         not on the default branch; or a merge commit is unreadable or
#                         missing locally. Fails closed.
#   exit 2  UNVERIFIED  — every merged, ancestor-eligible candidate is WEAK: discovered by
#                         `linked_prs_for_issue`'s broad cross-reference scan (the PR's
#                         title/body/commits mention `#N` in SOME form), but its
#                         `closingIssuesReferences` never names this issue, so there is no
#                         recognized closing keyword. The tool cannot tell "the real fix,
#                         missing a keyword" apart from "an unrelated bulk PR that happens
#                         to mention this number" (PR #26/#63/#68's shape, confirmed
#                         2026-07-19 across #15-19/21-25/29/31/62) — only reading the PR's
#                         diff can. Treat UNVERIFIED as "go read it", never as either
#                         verdict.
#
# KNOWN GAP this does NOT close: exit 1 (STRANDED) is also returned when a genuinely
# closing PR never mentions the issue number AT ALL — no cross-reference exists to
# discover, weak or strong, so `linked_prs_for_issue` finds nothing. Issue #60 is this
# exact shape: PR #81 fixed it correctly, but its title and body never once contain the
# text "#60" (confirmed empirically — `gh pr view 81 --json body` has zero matches, and
# issue #60's own timeline has zero `cross-referenced` events), so it was never a
# candidate for either LANDED or UNVERIFIED; it stayed STRANDED until closed by hand after
# a manual symbol check. A closing-keyword check can only strengthen a signal that a
# broader discovery step already found — it cannot invent a reference that was never
# written. Closing this gap needs a different signal entirely (e.g. matching a ticket's
# own `**Branch:**` metadata line against merged PR head-branch names) — out of scope
# here; flagged as a follow-up.
#
# `--pr <n>` names the PR explicitly, bypassing discovery entirely: the caller already
# vouches for the PR-issue mapping, so it skips the strong/weak check and behaves as
# before (ancestry alone gates LANDED/STRANDED, exit 0/1 only — UNVERIFIED cannot occur).
cmd_verify() {
  local number="${1:-}"; shift || true
  local only_pr=""
  while [[ $# -gt 0 ]]; do case "$1" in
    # Validate before shifting: a bare `shift 2` with one arg left is non-zero, which
    # under `set -e` kills the script silently — no usage, no message, just exit 1.
    --pr) [[ -n "${2:-}" ]] || die "verify: --pr requires a PR number"; only_pr="$2"; shift 2 ;;
    *) die "verify: unknown arg '$1'" ;;
  esac; done
  [[ -n "$number" ]] || die "verify: usage: factory.sh verify <issue> [--pr <n>]"

  local base; base="$(default_branch)"
  git fetch origin "$base" --quiet 2>/dev/null \
    || echo "factory: WARN could not fetch origin/$base — verdict may be stale" >&2

  local prs auto=1
  if [[ -n "$only_pr" ]]; then prs="$only_pr"; auto=0; else prs="$(linked_prs_for_issue "$number")"; fi

  if [[ -z "$prs" ]]; then
    echo "factory: STRANDED — no PRs reference issue #$number"
    return 1
  fi

  local merged=0 bad=0 bad_shas="" strong=0 weak=0 weak_prs=""
  local pr info state pr_base oid short sha landed note is_strong
  for pr in $prs; do
    info="$(gh pr view "$pr" --repo "$(repo)" --json state,baseRefName,mergeCommit \
              --jq '[.state, .baseRefName, (.mergeCommit.oid // "-")] | join(" ")' 2>/dev/null || true)"
    if [[ -z "$info" ]]; then
      echo "  PR #$pr  UNREADABLE — counted not landed"
      bad=$(( bad + 1 )); continue
    fi
    read -r state pr_base oid <<<"$info"

    if [[ "$state" != "MERGED" ]]; then
      echo "  PR #$pr  $state  base=$pr_base  — not merged, ignored"
      continue
    fi
    merged=$(( merged + 1 ))
    short="${oid:0:8}"

    # `--is-ancestor` exits 1 for "no" BY DESIGN — it must stay inside a guard, or
    # `set -e` kills the script mid-loop and every stranded PR reports as a pass.
    landed=0
    if [[ "$oid" == "-" ]] || ! git cat-file -e "$oid" 2>/dev/null; then
      note="merge commit not found locally — fetch and re-run"
    elif git merge-base --is-ancestor "$oid" "origin/$base" 2>/dev/null; then
      landed=1; note="landed"
    else
      note="NOT an ancestor of origin/$base"
    fi

    # `--pr` explicit mode skips this: the caller already vouches for the mapping.
    # Discovery mode confirms it against GitHub's own keyword-driven linkage — a
    # candidate that merely mentions the issue must not silently count as proof.
    is_strong=1
    if [[ "$auto" -eq 1 ]]; then
      if closed_issues_for_pr "$pr" | grep -qxF "$number"; then is_strong=1; else is_strong=0; fi
    fi

    if [[ "$is_strong" -eq 1 ]]; then
      echo "  PR #$pr  MERGED  base=$pr_base  sha=$short  — $note"
      if [[ "$landed" -eq 1 ]]; then strong=$(( strong + 1 )); else bad=$(( bad + 1 )); bad_shas="$bad_shas $oid"; fi
    else
      echo "  PR #$pr  MERGED  base=$pr_base  sha=$short  — $note (mention only — no closing keyword for #$number)"
      weak=$(( weak + 1 )); weak_prs="$weak_prs $pr"
    fi

    # Advisory regardless of the landing verdict: the content may have reached the
    # default branch via a later parent merge, but the process was still wrong.
    if [[ "$pr_base" != "$base" ]]; then
      echo "  PR #$pr  STACKED MERGE — merged into '$pr_base', not '$base'. Stacked PRs are forbidden."
    fi
  done

  if [[ "$merged" -eq 0 ]]; then
    echo "factory: STRANDED — no MERGED PR references issue #$number"
    return 1
  fi
  if [[ "$strong" -gt 0 ]]; then
    # One confirmed, landed closing PR is enough — an unrelated weak mention, landed or
    # not, doesn't invalidate a landing that already reached origin/$base another way.
    echo "factory: LANDED — issue #$number: $strong confirmed merged PR(s) are ancestors of origin/$base"
    return 0
  fi
  if [[ "$bad" -gt 0 ]]; then
    echo "factory: STRANDED — issue #$number: $bad merged PR(s) not on origin/$base"
    echo "  A 'recovered by PR #N' claim is not proof — the 2026-07-16 recovery MISSED"
    echo "  three intermediate commits. Confirm each SHA by hand:"
    for sha in $bad_shas; do echo "    git cherry origin/$base $sha"; done
    echo "    # then grep the default branch for this ticket's symbols, excluding docs/"
    echo "    # (drafts under docs/factory/drafts/ quote symbol names verbatim):"
    echo "    #   git grep -n '<symbol>' \"origin/$base\" -- ':!docs/'"
    echo "  Note: git cherry compares patch-ids, so a rebased or reformatted commit can"
    echo "  report '+' while its behavior IS on $base. Confirm by symbol, not patch-id."
    return 1
  fi
  # merged > 0, bad == 0, strong == 0: every merged, ancestor-eligible candidate only
  # MENTIONS this issue — cross-referenced, never formally closed. See the exit-2 note
  # in this function's doc comment; this is the #62 / #26-#63-#68 shape (NOT #60's — #60
  # never had a candidate to weigh in the first place, see the "KNOWN GAP" note above).
  echo "factory: UNVERIFIED — issue #$number: $weak merged PR(s) mention this issue with no"
  echo "  recognized closing keyword (Closes/Fixes/Resolves #$number) — cannot confirm any"
  echo "  of them implement it. Read each PR's diff/title against this ticket's Definition"
  echo "  of Done before treating this as landed OR stranded:"
  for pr in $weak_prs; do echo "    gh pr view $pr"; done
  echo "  If one genuinely implements it, GitHub cannot retroactively link an already-"
  echo "  merged PR — close the issue by hand, citing the PR and a symbol grep on"
  echo "  origin/$base (same recipe issue #60 used). If none do, leave the issue open."
  return 2
}

cmd_question() {
  local number="${1:-}"; shift || true; local text="${*:-}"
  [[ -n "$number" && -n "$text" ]] || die "question: usage: factory.sh question <issue> <text...>"
  gh issue comment "$number" --repo "$(repo)" \
    --body "$(printf '❓ **Open question**\n\n%s\n\n_raised %s_' "$text" "$(now_utc)")"
}
cmd_decision() {
  local number="${1:-}"; shift || true; local q="" a="" by=""
  while [[ $# -gt 0 ]]; do case "$1" in
    --q) q="$2"; shift 2 ;; --a) a="$2"; shift 2 ;; --by) by="$2"; shift 2 ;;
    *) die "decision: unknown arg '$1'" ;;
  esac; done
  [[ -n "$number" && -n "$q" && -n "$a" ]] || die "decision: usage: factory.sh decision <issue> --q Q --a A [--by who]"
  local who=""; [[ -n "$by" ]] && who=" by \`$by\`"
  gh issue comment "$number" --repo "$(repo)" \
    --body "$(printf '🧭 **Decision**\n\n- **Q:** %s\n- **A:** %s\n\n_decided%s at %s_' "$q" "$a" "$who" "$(now_utc)")"
}

cmd_adr() {
  [[ "${1:-}" == "new" ]] || die "adr: usage: factory.sh adr new \"<title>\" [--issue N]"
  shift; local title="${1:-}"; shift || true; local issue=""
  while [[ $# -gt 0 ]]; do case "$1" in --issue) issue="$2"; shift 2 ;; *) shift ;; esac; done
  [[ -n "$title" ]] || die "adr: title required"
  local dir="$ROOT/$FACTORY_ADR_DIR"; mkdir -p "$dir"
  local max; max="$(ls "$dir" 2>/dev/null | grep -oE '^[0-9]{4}' | sort -n | tail -1)"
  local n; n="$(printf '%04d' "$((10#${max:-0} + 1))")"
  local slug; slug="$(echo "$title" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\+/-/g; s/^-//; s/-$//')"
  local f="$dir/${n}-${slug}.md"
  { echo "# ${n}. ${title}"; echo; echo "- **Status:** Proposed"; echo "- **Date:** $(date -u +%Y-%m-%d)"
    [[ -n "$issue" ]] && echo "- **Related issue:** #${issue}"; echo
    echo "## Context"; echo; echo "<!-- What forces are at play? Why is a decision needed? -->"; echo
    echo "## Decision"; echo; echo "<!-- The change we're making. -->"; echo
    echo "## Consequences"; echo; echo "<!-- Trade-offs, follow-ups, what becomes easier/harder. -->"; } > "$f"
  echo "$f"
}

field() { echo "$2" | grep -oE "$1=(\"[^\"]*\"|[^ ]*)" | head -1 | sed "s/^$1=//; s/^\"//; s/\"$//"; }
csv_safe() { printf '%s' "$1" | tr ',\n' ';;'; }

cmd_report() {
  local out="$ROOT/$FACTORY_OUT"; mkdir -p "$out"
  local csv="$out/metrics.csv"; local r; r="$(repo)"
  echo "issue,type,model,tokens_in,tokens_out,tokens_total,wall_s,turns,files,first_pass,clarifications,reopens,state,created_at,closed_at,title" > "$csv"
  local nums
  nums="$(gh issue list --repo "$r" --label "$FACTORY_LABEL" --state all --limit 1000 --json number --jq '.[].number')"
  local n
  for n in $nums; do
    local state created closed title raw_trailer meta
    meta="$(gh issue view "$n" --repo "$r" --json state,createdAt,closedAt,title,comments \
        --jq '[.state, .createdAt, (.closedAt // ""), (.title|gsub(",";";")|gsub("\n";" ")), ([.comments[].body | select(test("factory-metrics:"))] | last // "")] | join("")')"
    IFS=$'\037' read -r state created closed title raw_trailer <<< "$meta"
    local trailer
    trailer="$(grep -oE 'factory-metrics:.*' <<< "$raw_trailer" || true)"
    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
      "$n" "$(csv_safe "$(field type "$trailer")")" "$(csv_safe "$(field model "$trailer")")" \
      "$(field tokens_in "$trailer")" "$(field tokens_out "$trailer")" "$(field tokens_total "$trailer")" \
      "$(field wall_s "$trailer")" "$(field turns "$trailer")" "$(field files "$trailer")" \
      "$(field first_pass "$trailer")" "$(field clarifications "$trailer")" "$(field reopens "$trailer")" \
      "$state" "$created" "$closed" "$title" >> "$csv"
  done
  echo "factory: wrote $csv"
  awk -F, 'NR>1{
    n++; if($10=="yes")fp++; if($10=="yes"||$10=="no")fpd++;
    if($12+0>0)rw++; if($7!=""){wsum+=$7; wn++}
  } END{
    printf "  tickets:                %d\n", n;
    if(fpd>0) printf "  CI first-pass rate:     %d%% (%d/%d)\n", (fp*100/fpd), fp, fpd;
    if(n>0)   printf "  tickets with rework:    %d%% (%d/%d)\n", (rw*100/n), rw, n;
    if(wn>0)  printf "  avg wall-clock:         %ds\n", (wsum/wn);
  }' "$csv"
}

sub="${1:-help}"; shift || true
case "$sub" in
  create)   require_gh; cmd_create "$@" ;;
  start)    require_gh; cmd_start "$@" ;;
  finish)   require_gh; cmd_finish "$@" ;;
  verify)   require_gh; cmd_verify "$@" ;;
  question) require_gh; cmd_question "$@" ;;
  decision) require_gh; cmd_decision "$@" ;;
  adr)      cmd_adr "$@" ;;
  report)   require_gh; cmd_report "$@" ;;
  help|-h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0" ;;
  *) die "unknown subcommand '$sub' (create|start|finish|verify|question|decision|adr|report|help)" ;;
esac
