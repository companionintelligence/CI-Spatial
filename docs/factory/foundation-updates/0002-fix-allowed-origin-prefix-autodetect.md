---
name: Factory ticket
about: A commit-recipe unit of work for the Factory project. One ticket = one atomic, testable change an LLM can execute without guessing.
title: "[Factory] main.ts: auto-detect Tailscale hostname instead of a hardcoded fallback"
labels: factory
---

> **Type:** Backend
> **Phase:** Foundation hardening — post-setup review findings
> **Branch:** `fix/allowed-origin-prefix-autodetect`
> **Commit style:** `fix(server): auto-detect tailscale hostname for ALLOWED_ORIGIN_PREFIX`
> **Design:** this ticket is the spec — port `vite.config.ts`'s existing algorithm
> **Dependencies:** None

## Goal

`main.ts` computes `ALLOWED_ORIGIN_PREFIX` from a raw `Deno.env.get('TAILSCALE_HOSTNAME')`
read, falling straight through to the hardcoded historical default
(`https://liambook.capybara-ulmer.ts.net`) whenever that env var isn't explicitly set —
even on a machine where Tailscale is installed, running, and perfectly capable of
reporting its own hostname. `vite.config.ts` already solves this correctly with
`resolveHostname()`, which shells out to `tailscale status --json` before giving up.
Port that same resolution order into `main.ts` so both halves of the app agree on the
server's own hostname without an operator having to set `TAILSCALE_HOSTNAME` by hand.

**Confirmed live, not theoretical:** running `npm start` on `everxr-01` (no
`TAILSCALE_HOSTNAME` set) produced `[vite] Hostname: everxr-01.capybara-ulmer.ts.net
(via tailscale cli)` from the Vite process and `[server] CORS origin prefix:
https://liambook.capybara-ulmer.ts.net` from the Deno process, in the same boot, on the
same machine — the two processes disagreed about their own address.

## Non-goals

- Do not attempt a single shared module imported by both `vite.config.ts` (Node) and
  `main.ts` (Deno) in this ticket — the subprocess-spawn and directory-listing APIs
  differ per runtime (`node:child_process` vs `Deno.Command`, `node:fs` vs
  `Deno.readDir`/`Deno.cwd()`), and unifying them is a larger refactor than this fix
  needs. Port the same *algorithm*, twice, deliberately in parallel.
- Do not change CORS behavior itself (`isAllowedOrigin()` in `main.ts`) — it already
  independently trusts any `*.ts.net` origin regardless of `ALLOWED_ORIGIN_PREFIX`, RFC1918
  ranges, and the Tailscale CGNAT range (`100.64.0.0/10`). This bug is harmless for CORS;
  it only mis-sets the prefix used for **share-link generation** (`viteBaseUrlFromEnv()`
  → `shareLinks()`). Don't touch the CORS allowlist logic.
- Do not remove the hardcoded fallback constant — it stays as the last resort when
  Tailscale isn't installed/running and no cert file exists, matching
  `vite.config.ts`'s own behavior.

## Pinned conventions

Match `vite.config.ts`'s `resolveHostname()` (`vite.config.ts:18-42`) exactly — same
precedence order, same inputs, same fallback:

1. `TAILSCALE_HOSTNAME` (or `VITE_HOSTNAME`) env var — first hit wins.
2. `tailscale status --json` → `Self.DNSName`, trailing dot stripped. Try binary names
   `tailscale` then `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, each with a
   3000ms timeout; on any failure (not installed, not running, timeout), fall through.
3. A `<hostname>.ts.net.crt` file in the current working directory (left by
   `tailscale cert`) — strip the `.crt` suffix.
4. Historical hardcoded default: `liambook.capybara-ulmer.ts.net` (same constant name,
   `FALLBACK_HOSTNAME`, as `vite.config.ts:8`).

`ALLOWED_ORIGIN_PREFIX`'s own precedence is unchanged and must stay outermost: an
explicit `ALLOWED_ORIGIN_PREFIX` env var still wins over everything above (`main.ts:70`).

## Before implementation

- Read `vite.config.ts:1-45` (`resolveHostname()` in full — the function this ticket
  ports).
- Read `main.ts:65-71` (current naive resolution) and `main.ts:1413-1423`
  (`viteBaseUrlFromEnv()`, the function that consumes `ALLOWED_ORIGIN_PREFIX` /
  `TAILSCALE_HOSTNAME` to build share links — this is the concrete downstream breakage,
  not just a log-line cosmetic issue).
- Note `main.ts:113` already uses top-level `await Deno.mkdir(...)` at module scope —
  the same pattern this ticket needs for an async `tailscale status --json` call.

## Open questions & answers

- Q: Should the resolved hostname source (env / tailscale cli / cert file / default) be
  logged the same way `vite.config.ts:45` logs it (`[vite] Hostname: X (via Y)`)? — A:
  Yes — add an equivalent `[server] Hostname: X (via Y)` log; it costs nothing and would
  have made this exact bug obvious at boot instead of requiring a manual diff between
  two log lines (decided by ticket author, 2026-08-15).

## Files impacted

- Changed: `main.ts` (lines `65-71`, and the misleading comment at `67-68` that already
  claims this is "shared with vite.config.ts" when it currently isn't)

## Schema required

None — no data model changes, only a boot-time hostname-resolution helper.

## Definition of Done

- [x] `main.ts` no longer relies solely on `Deno.env.get('TAILSCALE_HOSTNAME')` before
      falling back to the hardcoded default — it attempts `tailscale status --json` and
      the `.ts.net.crt` file scan first, matching `vite.config.ts`'s order.
- [x] The comment above the resolution logic accurately describes the new (actually
      shared-in-spirit) behavior instead of asserting a sharing that doesn't exist.
- [x] Starting `npm start` on a Tailscale-connected machine with no `TAILSCALE_HOSTNAME`
      env var set produces matching hostnames in `[vite] Hostname: ...` and the new
      `[server] Hostname: ...` log lines. Verified live on `everxr-01`: both now log
      `everxr-01.capybara-ulmer.ts.net (via tailscale cli)`.
- [x] `GET /worlds/:slug/share` (via `shareLinks()` → `viteBaseUrlFromEnv()`) returns
      links pointing at the real auto-detected host in that same scenario, not
      `liambook.capybara-ulmer.ts.net`. Verified: all four role links now read
      `https://everxr-01.capybara-ulmer.ts.net:5173/...`.

## Tests

- [x] Live boot test: on a tailnet-connected machine, unset `TAILSCALE_HOSTNAME`, run
      `npm start`, confirm the Vite and server hostname logs match. — Confirmed on
      `everxr-01`: both `[vite] Hostname:` and `[server] Hostname:` logged
      `everxr-01.capybara-ulmer.ts.net (via tailscale cli)`.
- [x] Regression test: with `TAILSCALE_HOSTNAME` explicitly set, confirm it still wins
      outright (no change to existing env-var precedence). — Confirmed:
      `TAILSCALE_HOSTNAME=explicit-test.example.ts.net` produced
      `[server] Hostname: explicit-test.example.ts.net (via env)`.
- [x] Fallback test: with Tailscale not running/not installed, no env var set, and no
      `*.ts.net.crt` in the repo root, confirm `main.ts` still falls back to
      `liambook.capybara-ulmer.ts.net` rather than crashing or hanging. — Confirmed: run
      from an empty temp cwd with Tailscale stripped from `PATH` produced
      `[server] Hostname: liambook.capybara-ulmer.ts.net (via default)` and the server
      still booted normally.

```
# regression check — env var still wins
TAILSCALE_HOSTNAME=explicit-test.example.ts.net npm run server &
sleep 2 && curl -s http://localhost:8000/health >/dev/null && echo OK

# live check — auto-detect matches vite (run from repo root, tailscale running)
npm start
# compare the two hostname log lines by eye
```

## Acceptance Criteria

- [x] Given a machine with Tailscale installed and connected, and no
      `TAILSCALE_HOSTNAME`/`ALLOWED_ORIGIN_PREFIX` env vars set, when `main.ts` boots,
      then it resolves the same hostname `vite.config.ts` resolves for the same
      process tree.
- [x] Given that same boot, when a share link is generated for any world, then its
      origin matches the machine's real reachable Tailscale hostname.
- [x] Given `TAILSCALE_HOSTNAME` explicitly set, when `main.ts` boots, then that value
      is used unconditionally (auto-detection is never consulted). Confirmed via the
      `(via env)` source tag — the resolver returns before ever touching
      `tailscale status`.

## Risks / potential issues

- **Risk:** `Deno.Command` is inherently async; the current `ALLOWED_ORIGIN_PREFIX`
  constant is computed synchronously at module load, before the `Hono` app and its
  routes are constructed. — **Mitigation:** use a top-level `await` for the hostname
  resolution (Deno supports this; `main.ts:113` already does it for `Deno.mkdir`),
  resolving once at boot before the CORS middleware is registered.
- **Risk:** the two implementations (Node in `vite.config.ts`, Deno in `main.ts`) are
  necessarily separate files and can drift apart again later. — **Mitigation:** the new
  `[server] Hostname: ...` boot log (see Open Questions) makes any future drift visible
  on every single boot, not just discoverable by manually diffing two log lines like
  this ticket's own discovery required.
- **Risk:** `tailscale status --json`'s 3000ms timeout adds boot latency on machines
  without Tailscale running. — **Mitigation:** this mirrors `vite.config.ts`'s existing
  accepted behavior exactly; not a new regression, and the timeout only applies when no
  env var is already set.

## Subtasks

1. [x] Port `resolveHostname()` from `vite.config.ts:18-42` into `main.ts`, using
       `Deno.Command` for the `tailscale status --json` call (with an equivalent
       ~3000ms timeout, via `AbortController`) and `Deno.readDir(Deno.cwd())` for the
       `.ts.net.crt` file scan.
2. [x] Replace `main.ts:69-71`'s naive computation with a call to the new resolver,
       preserving the existing outer precedence (`ALLOWED_ORIGIN_PREFIX` env var wins
       outright over everything).
3. [x] Add the `[server] Hostname: X (via Y)` boot log alongside the existing
       `[server] CORS origin prefix: ...` log.
4. [x] Fix the stale comment at `main.ts:67-68`.
5. [x] Manually verify on a real tailnet machine (`everxr-01`) that the Vite and
       server hostname logs now agree, and that a freshly generated share link resolves
       to the real host. `deno task check` also passes with no type errors.

---
<!--
Working-model protocol (do not remove):
• On START, the working model comments: model name + UTC start time.
• On COMPLETE, the working model comments: total token count.
Use scripts/factory/factory.sh start|finish to post these automatically.
-->
