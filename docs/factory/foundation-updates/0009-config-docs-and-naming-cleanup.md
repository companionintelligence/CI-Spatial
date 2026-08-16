> **Type:** Docs
> **Wave:** foundation-updates
> **Branch:** `docs/config-naming-cleanup`
> **Commit style:** `docs(config): sync env-var docs, fix stale repo names, freeze protected identifiers`
> **Design:** this ticket is the spec
> **Dependencies:** None

## Goal

Three documentation-tier drifts, fixed together because they're all "the docs lie
about the system" with zero runtime risk:

1. **Env vars read in code but documented nowhere.** Neither `.env.example` nor
   `deploy/cscan.env.example` mentions: `SCANS_DIR`, `SUMMARIES_DIR`, `SESSIONS_DIR`,
   `WORLDS_DIR`, `WORLD_STRICT_AUTH` (an auth-hardening switch — the highest-risk
   omission), `LINGBOT_MAP_SCRIPT`, `DEBUG_CORS`, `PROJECTS_FILE`, `STATIC_DIR`,
   `MODEL_DIR`, `TOKENIZER_DIR`, `POINT_SPLAT_SIZE`, `SPLAT_FINISH_NODE`,
   `VITE_HOSTNAME` (the primary hostname fallback!), and test-only `BRUSH_E2E`.
2. **Stale repo names.** `README.md:184-185` still says clone
   `CI-Web-XR-Scan.git` / `cd CI-Web-XR-Scan`; `docs/CI.md:24,40` still passes
   `--repo … CI-Web-XR-Scan`. The repo is `CI-Spatial`.
3. **No "do not rename" registry.** Several identifiers *look* like stale legacy
   names but are actually load-bearing: renaming them breaks persisted user data or
   external integrations. Nothing currently warns about this.

## Non-goals

- Do not rename ANY of the protected identifiers (that's the point of item 3):
  IndexedDB `'ci-xr-scan'` (`src/scene/store.ts:26`), sessionStorage
  `'ci-xr-geo-fix'`, localStorage `'companion-scan-onboarded'`, SW
  `'companion-scan-offline-queue'`/`'companion-scan-v3'`/`'companion-scan-flush'`,
  GHCR image `ghcr.io/companionintelligence/ci-web-xr-scan`
  (`docker-publish.yml:31`), OIDC client id `'ci-web-xr-scan'` (`portal_auth.ts:57` —
  must match the IdP registration), memory-push `sourceSystem 'companion-scan'`
  (`memory_push.ts:63` — re-namespaces idempotency keys).
- Do not rename the cosmetic-safe hits either (package.json name, glTF `generator`
  string, UA string, prose) in *this* ticket — item 2 fixes only the two factually
  *wrong* references (clone URL, `--repo` flags). Cosmetic renames are a naming-
  strategy decision (is the product "Companion Scan" or "CI-Spatial"?) that needs an
  owner call first — logged as an open question, not smuggled in.
- Do not add new env vars or change any default.

## Pinned conventions

- ADR 0001: config variables are part of the shared contract — documenting them *is*
  the reuse mechanism (an undocumented var gets reinvented under a new name).
- `.env.example`'s existing style: commented-out `#VAR=value` lines with a prose
  comment above each — match it. `deploy/cscan.env.example` gets only the
  deploy-relevant subset (dirs, `WORLD_STRICT_AUTH`, `VITE_HOSTNAME`), matching its
  narrower audience.
- The do-not-rename registry lives in `CLAUDE.md` (always loaded) as a short table:
  identifier → where → what breaks.

## Before implementation

- Grep ground truth yourself; don't trust this ticket's list blindly:
  `grep -n "Deno.env.get" *.ts` (repo root) and `grep -n "process.env"
  vite.config.ts scripts/*.mjs`. The audit found `deploy/cscan.env.example`
  documents `SPLAT_FINISH_SH_ITERS` — verify whether code reads it
  (`splat_finish.ts`) or whether it's stale; fix whichever side is wrong.

## Open questions & answers

- Q: Is the product name going forward "Companion Scan" or "CI-Spatial" (affects
  package.json name, glTF generator tag, UA string)? — OPEN — owner decision;
  cosmetic renames blocked on it, tracked here so it isn't lost.
- Q: `SPLAT_FINISH_SH_ITERS` — documented but unread, or read somewhere the audit
  missed? — OPEN until the Before-implementation grep resolves it; fix accordingly.

## Files impacted

- Changed: `.env.example`, `deploy/cscan.env.example` (add missing vars)
- Changed: `README.md:184-185`, `docs/CI.md:24,40` (correct repo name)
- Changed: `CLAUDE.md` (do-not-rename registry table)

## Schema required

None.

## Definition of Done

- [ ] Every env var read by code at repo root, `vite.config.ts`, and `scripts/*.mjs`
      appears in at least one example file (or is explicitly listed as test-only).
- [ ] No doc instructs cloning or targeting `CI-Web-XR-Scan`.
- [ ] `CLAUDE.md` carries the do-not-rename registry with break-consequences.
- [ ] The `SPLAT_FINISH_SH_ITERS` question is resolved and the wrong side fixed.

## Tests

- [ ] Docs-only change: `deno task check` still passes (proves no code was touched
      accidentally).
- [ ] Manual: follow README's clone instructions verbatim on a scratch path — they
      work.

```
deno task check
git clone https://github.com/companionintelligence/CI-Spatial.git /tmp/clone-check
```

## Acceptance Criteria

- [ ] Given a new operator reading only the example env files, when they configure a
      box, then no behavior-changing variable is invisible to them
      (`WORLD_STRICT_AUTH` above all).
- [ ] Given a future contributor tempted to "clean up" `ci-xr-scan`-style names, when
      they read `CLAUDE.md`, then they know exactly which renames destroy user data.

## Risks / potential issues

- **Risk:** documenting internal vars (e.g. `STATIC_DIR`) invites operators to change
  them without understanding coupling (e.g. Docker sets it implicitly).
  — **Mitigation:** each new entry's comment states the audience ("normally set only
  by the Dockerfile/systemd unit — leave unset for dev").

## Subtasks

1. [ ] Re-grep env reads; reconcile against both example files; resolve the
       `SPLAT_FINISH_SH_ITERS` question.
2. [ ] Add missing vars with audience-appropriate comments.
3. [ ] Fix the two stale repo references.
4. [ ] Add the do-not-rename registry to `CLAUDE.md`.
