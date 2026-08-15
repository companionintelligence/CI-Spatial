#!/usr/bin/env bash
# factory.test.sh — regression suite for factory.sh's landing verification.
#
# Plain bash: no bats, no jq, no gh auth. Builds a throwaway git repo whose origin/main
# holds commit A and whose side branch feat/parent holds stranded commit B, then puts a
# `gh` STUB on PATH that returns post---jq plaintext — so factory.sh's real queries run
# unmodified. The stub's match arms ARE the pinned contract factory.sh depends on.
#
# Run: bash scripts/factory/factory.test.sh
set -euo pipefail

FACTORY_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/factory.sh"
[[ -f "$FACTORY_SH" ]] || { echo "cannot find factory.sh next to this test"; exit 1; }

fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; echo "      $2"; fails=$(( fails + 1 )); }

# Explicit template: BSD/macOS mktemp REQUIRES one (`mktemp -d` alone is a usage error
# there), while GNU/Git Bash accept both. This suite must run on all three.
work="$(mktemp -d "${TMPDIR:-/tmp}/factory-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# --- fixture repo: origin/main = A; feat/parent = A + B (B never merged to main) ------
bare="$work/origin.git"
repo="$work/repo"
git init --quiet --bare "$bare"
git init --quiet "$repo"
cd "$repo"
git config user.email t@t.test
git config user.name Test
git remote add origin "$bare"

echo a > a.txt; git add a.txt; git commit --quiet -m A
SHA_A="$(git rev-parse HEAD)"
git branch -M main
git push --quiet origin main

git checkout --quiet -b feat/parent
echo b > b.txt; git add b.txt; git commit --quiet -m B
SHA_B="$(git rev-parse HEAD)"
git push --quiet origin feat/parent
git checkout --quiet main
git fetch --quiet origin

# --- gh stub -------------------------------------------------------------------------
stub="$work/bin"
mkdir -p "$stub"
cat > "$stub/gh" <<'STUB'
#!/usr/bin/env bash
# Pattern-match argv; emit what the real `gh ... --jq ...` would emit (plaintext).
set -uo pipefail
case "$1 ${2:-}" in
  "repo view")
    echo "test/repo" ;;
  "api repos/test/repo/issues/7/timeline"|"api repos/test/repo/issues/8/timeline")
    # $GH_STUB_PRS: space-separated PR numbers this issue cross-references.
    for n in ${GH_STUB_PRS:-}; do echo "$n"; done ;;
  "pr view")
    if [[ "${3:-}" == "--json" ]]; then
      # Bare `pr view --json baseRefName` → current-branch resolution (finish's check).
      [[ -n "${GH_STUB_BRANCH_BASE:-}" ]] || exit 1
      echo "$GH_STUB_BRANCH_BASE"
    elif [[ "$*" == *closingIssuesReferences* ]]; then
      # `pr view <n> --repo ... --json closingIssuesReferences --jq ...` (closed_issues_for_pr).
      # $GH_STUB_CLOSES_<n>: space-separated issue numbers PR <n> formally closes.
      # Unset/empty (the default) mirrors PR #26/#63/#68's real behavior: mentions many
      # issues, formally closes none.
      var="GH_STUB_CLOSES_$3"
      eval "nums=\${$var:-}"
      for x in $nums; do echo "$x"; done
    else
      # `pr view <n> --repo ... --json state,baseRefName,mergeCommit`
      var="GH_STUB_PR_${3:-0}"
      # PR number is $3 when called as: pr view <n> --repo ...
      var="GH_STUB_PR_$3"
      eval "out=\${$var:-}"
      [[ -n "$out" ]] || exit 1
      echo "$out"
    fi ;;
  "issue comment")
    # Log the posted body so the trailer can be regex-checked, as cmd_report does.
    body=""
    while [[ $# -gt 0 ]]; do [[ "$1" == "--body" ]] && body="$2"; shift; done
    printf '%s\n' "$body" >> "${GH_STUB_COMMENT_LOG:-/dev/null}" ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$stub/gh"
export PATH="$stub:$PATH"
export FACTORY_REPO="test/repo"
export FACTORY_DEFAULT_BRANCH="main"

run() { set +e; out="$(bash "$FACTORY_SH" "$@" 2>&1)"; rc=$?; set -e; }

# --- cases ---------------------------------------------------------------------------

# 1. Landed: merged PR whose merge SHA is on origin/main, confirmed via a real closing
#    keyword (GH_STUB_CLOSES_10) — the STRONG case, not just a bare cross-reference.
GH_STUB_PRS="10" GH_STUB_PR_10="MERGED main $SHA_A" GH_STUB_CLOSES_10="7" run verify 7
if [[ $rc -eq 0 ]] && [[ "$out" == *"LANDED"* ]] && [[ "$out" == *"landed"* ]]; then
  pass "verify: merged onto main + closing keyword → LANDED, exit 0"
else fail "verify: merged onto main + closing keyword → LANDED, exit 0" "rc=$rc out=$out"; fi

# 2. Stranded: the #41–#44 shape — a genuinely closing PR merged into a parent branch,
#    never on main.
GH_STUB_PRS="11" GH_STUB_PR_11="MERGED feat/parent $SHA_B" GH_STUB_CLOSES_11="7" run verify 7
if [[ $rc -eq 1 ]] && [[ "$out" == *"STRANDED"* ]] && [[ "$out" == *"STACKED MERGE"* ]] \
   && [[ "$out" == *"git cherry origin/main $SHA_B"* ]]; then
  pass "verify: merged onto a parent branch → STRANDED + recovery recipe, exit 1"
else fail "verify: merged onto a parent branch → STRANDED + recovery recipe, exit 1" "rc=$rc out=$out"; fi

# 3. Unknown merge object on a genuinely closing PR → fail closed, never a false LANDED.
GH_STUB_PRS="12" GH_STUB_PR_12="MERGED main 0123456789abcdef0123456789abcdef01234567" \
  GH_STUB_CLOSES_12="7" run verify 7
if [[ $rc -eq 1 ]] && [[ "$out" == *"not found locally"* ]]; then
  pass "verify: unknown merge sha → 'not found locally', exit 1"
else fail "verify: unknown merge sha → 'not found locally', exit 1" "rc=$rc out=$out"; fi

# 3b. Mention-only (no closing keyword): the PR #26/#63/#68 false-positive shape. A
#     merged, landed PR that never formally closes the issue must NOT report LANDED —
#     and must not report STRANDED either, since that reads as "definitely not done"
#     when the truth is "unknown, go read it" (this is also the shape issue #60/PR #81
#     had before it was closed by hand: indistinguishable from here, by design).
GH_STUB_PRS="20" GH_STUB_PR_20="MERGED main $SHA_A" run verify 7
if [[ $rc -eq 2 ]] && [[ "$out" == *"UNVERIFIED"* ]] && [[ "$out" == *"PR #20"* ]] \
   && [[ "$out" != *"factory: LANDED"* ]] && [[ "$out" != *"factory: STRANDED"* ]]; then
  pass "verify: mention-only PR (no closing keyword) → UNVERIFIED, exit 2, never LANDED/STRANDED"
else fail "verify: mention-only PR (no closing keyword) → UNVERIFIED, exit 2, never LANDED/STRANDED" "rc=$rc out=$out"; fi

# 3c. Mention-only AND not itself on main: its own stacked/stranded status is irrelevant
#     to THIS issue (it may not be about this issue at all) — must not escalate to a
#     false STRANDED-with-recovery-recipe.
GH_STUB_PRS="21" GH_STUB_PR_21="MERGED feat/parent $SHA_B" run verify 7
if [[ $rc -eq 2 ]] && [[ "$out" == *"UNVERIFIED"* ]] \
   && [[ "$out" != *"factory: STRANDED"* ]] && [[ "$out" != *"git cherry"* ]]; then
  pass "verify: mention-only PR that's also unlanded → still UNVERIFIED, never a false STRANDED"
else fail "verify: mention-only PR that's also unlanded → still UNVERIFIED, never a false STRANDED" "rc=$rc out=$out"; fi

# 3d. A confirmed closing PR outweighs an additional unrelated mention: LANDED wins
#     regardless of how many weak cross-references also happen to exist.
GH_STUB_PRS="22 23" GH_STUB_PR_22="MERGED main $SHA_A" GH_STUB_CLOSES_22="7" \
  GH_STUB_PR_23="MERGED main $SHA_A" run verify 7
if [[ $rc -eq 0 ]] && [[ "$out" == *"factory: LANDED"* ]]; then
  pass "verify: one confirmed closing PR outweighs an additional weak mention → LANDED"
else fail "verify: one confirmed closing PR outweighs an additional weak mention → LANDED" "rc=$rc out=$out"; fi

# 4. No PRs reference the issue.
GH_STUB_PRS="" run verify 7
if [[ $rc -eq 1 ]] && [[ "$out" == *"no PRs reference issue #7"* ]]; then
  pass "verify: no linked PRs → STRANDED, exit 1"
else fail "verify: no linked PRs → STRANDED, exit 1" "rc=$rc out=$out"; fi

# 5. --pr skips timeline discovery (GH_STUB_PRS deliberately points elsewhere).
GH_STUB_PRS="99" GH_STUB_PR_13="MERGED main $SHA_A" run verify 7 --pr 13
if [[ $rc -eq 0 ]] && [[ "$out" == *"PR #13"* ]] && [[ "$out" != *"PR #99"* ]]; then
  pass "verify --pr <n>: checks only the named PR"
else fail "verify --pr <n>: checks only the named PR" "rc=$rc out=$out"; fi

# 6. Stacked BUT landed (parent merged later): advisory warning, still exit 0.
GH_STUB_PRS="14" GH_STUB_PR_14="MERGED feat/parent $SHA_A" GH_STUB_CLOSES_14="7" run verify 7
if [[ $rc -eq 0 ]] && [[ "$out" == *"LANDED"* ]] && [[ "$out" == *"STACKED MERGE"* ]]; then
  pass "verify: stacked base but content on main → warns, exit 0"
else fail "verify: stacked base but content on main → warns, exit 0" "rc=$rc out=$out"; fi

# 7. Non-merged PRs are ignored, and an issue with only open PRs is STRANDED.
GH_STUB_PRS="15" GH_STUB_PR_15="OPEN main -" run verify 7
if [[ $rc -eq 1 ]] && [[ "$out" == *"not merged, ignored"* ]] && [[ "$out" == *"no MERGED PR"* ]]; then
  pass "verify: open PR only → ignored + STRANDED, exit 1"
else fail "verify: open PR only → ignored + STRANDED, exit 1" "rc=$rc out=$out"; fi

# 8. finish on a stacked branch: warns on stderr, still posts an intact trailer.
log="$work/comments.log"; : > "$log"
GH_STUB_BRANCH_BASE="feat/parent" GH_STUB_COMMENT_LOG="$log" \
  run finish 7 --model m --in 1 --out 1
trailer="$(grep -oE 'factory-metrics: v=1 issue=[0-9]+' "$log" || true)"
if [[ $rc -eq 0 ]] && [[ "$out" == *"stacked PRs are forbidden"* ]] \
   && [[ "$out" == *"gh pr edit --base main"* ]] && [[ "$trailer" == "factory-metrics: v=1 issue=7" ]]; then
  pass "finish: stacked base → stderr warning, comment + trailer intact"
else fail "finish: stacked base → stderr warning, comment + trailer intact" "rc=$rc trailer='$trailer' out=$out"; fi

# 9. finish on main: no warning.
log2="$work/comments2.log"; : > "$log2"
GH_STUB_BRANCH_BASE="main" GH_STUB_COMMENT_LOG="$log2" run finish 7 --model m --in 1 --out 1
if [[ $rc -eq 0 ]] && [[ "$out" != *"stacked"* ]]; then
  pass "finish: base=main → no warning"
else fail "finish: base=main → no warning" "rc=$rc out=$out"; fi

# 10. finish with no resolvable PR: silent skip, never a die.
log3="$work/comments3.log"; : > "$log3"
GH_STUB_COMMENT_LOG="$log3" run finish 7 --model m --in 1 --out 1
if [[ $rc -eq 0 ]] && [[ "$out" != *"stacked"* ]]; then
  pass "finish: no PR for branch → silent skip"
else fail "finish: no PR for branch → silent skip" "rc=$rc out=$out"; fi

# 11. The unknown-subcommand die lists verify.
run bogus-subcommand
if [[ $rc -eq 1 ]] && [[ "$out" == *"verify"* ]]; then
  pass "dispatch: unknown subcommand message lists verify"
else fail "dispatch: unknown subcommand message lists verify" "rc=$rc out=$out"; fi

# 12. --pr with no value dies cleanly. Pre-fix this was a bare `shift 2` → non-zero →
#     silent `set -e` death: exit 1 with no message at all.
run verify 7 --pr
if [[ $rc -eq 1 ]] && [[ "$out" == *"--pr requires a PR number"* ]]; then
  pass "verify --pr with no value: clean die with usage"
else fail "verify --pr with no value: clean die with usage" "rc=$rc out=$out"; fi

# 13. FACTORY_DEFAULT_BRANCH is honoured — no hardcoded 'main'.
git checkout --quiet -b trunk main
git push --quiet origin trunk
git fetch --quiet origin
FACTORY_DEFAULT_BRANCH="trunk" GH_STUB_PRS="16" GH_STUB_PR_16="MERGED trunk $SHA_A" \
  GH_STUB_CLOSES_16="8" run verify 8
if [[ $rc -eq 0 ]] && [[ "$out" == *"origin/trunk"* ]] && [[ "$out" != *"STACKED"* ]]; then
  pass "verify: honours FACTORY_DEFAULT_BRANCH=trunk"
else fail "verify: honours FACTORY_DEFAULT_BRANCH=trunk" "rc=$rc out=$out"; fi

echo
if [[ $fails -gt 0 ]]; then echo "$fails case(s) failed"; exit 1; fi
echo "all factory landing-verification cases passed"
