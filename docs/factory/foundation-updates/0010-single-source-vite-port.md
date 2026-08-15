> **Type:** Refactor
> **Wave:** foundation-updates
> **Branch:** `refactor/single-source-vite-port`
> **Commit style:** `refactor(config): single source of truth for the Vite port`
> **Design:** this ticket is the spec — extend the pattern 0002 established for hostnames
> **Dependencies:** 0006 (both edit `main.ts` — land 0006 first)

## Goal

The Vite port `5173` is magic-numbered independently in at least six code sites:
`main.ts:1457` (`viteBaseUrlFromEnv`, plus the `:5173` fallback at 1461-1462),
`scripts/qr.mjs:17`, `scripts/house-links.mjs:36`, `scripts/logs-watch.mjs:19`,
`playwright.config.ts:21-22`, and per-spec literals in `tests/*.spec.ts`. Only
`scripts/video-stage.mjs:45` is parameterized. Ticket 0002 unified *hostname*
resolution between the Deno and Node sides; this ticket does the same for the port:
one env var (`VITE_PORT`, default `5173`), read by every site that needs it.

## Non-goals

- Do not change the default — `5173` stays; behavior with no env vars set is
  byte-identical (share links, QR URLs, test base URLs all unchanged).
- Do not touch the Deno API port (`PORT`, default 8000) — already a single env var.
- Do not remove the hardcoded `liambook.capybara-ulmer.ts.net` *hostname* fallback in
  `main.ts:1461` or the tests — hostname policy is 0002's settled territory
  (resolution order + last-resort fallback). Only the port number moves to the
  constant. (Switching tests to resolve the hostname dynamically already works via
  the existing `VITE_URL` env var — note it in test comments, don't rework the specs.)
- Do not introduce a config file — an env var with a default matches every existing
  config knob in this repo.

## Pinned conventions

- ADR 0001: one variable, reused — this is the literal case the ADR names ("before
  adding a new config env var, search for an existing one": there is none for the
  Vite port; `VITE_PORT` becomes it, and the six magic numbers become its readers).
- 0002's precedent: Deno side reads `Deno.env.get`, Node side reads `process.env`,
  same variable name, same default, deliberately parallel one-liners (a shared module
  across Deno/Node isn't warranted for one integer — same judgment 0002 recorded for
  the hostname algorithm).
- `vite.config.ts` must also *serve* on the variable (`server.port` /
  `preview.port`) so the value is actually authoritative, not just advertised.
  Today `preview.port: 5173, strictPort: true` is hardcoded there too.
- Document `VITE_PORT` in `.env.example` (coordinate with 0009, which edits the same
  file — trivial merge either order).

## Before implementation

- Every site listed in Goal, plus `vite.config.ts`'s `server`/`preview` blocks and
  `deploy/systemd/cscan-web.service` (documents `:5173` in comments — update prose).
- `scripts/video-stage.mjs:45`'s existing `VIDEO_PORT` param — leave it (isolated
  staging port, intentionally separate), but add a comment distinguishing it.

## Open questions & answers

- Q: Should Playwright specs read `VITE_PORT` individually, or keep deriving
  everything from the existing `VITE_URL` override? — A: Derive from `VITE_URL` where
  it exists (already the established test override); only `playwright.config.ts`'s
  default construction uses `VITE_PORT` (decided by ticket author, 2026-08-15).

## Files impacted

- Changed: `vite.config.ts`, `main.ts`, `scripts/qr.mjs`, `scripts/house-links.mjs`,
  `scripts/logs-watch.mjs`, `playwright.config.ts`, `.env.example`
- Changed (comments/prose only): `tests/*.spec.ts` where the literal remains via
  `VITE_URL` default, `deploy/systemd/cscan-web.service`

## Schema required

None — one new optional env var `VITE_PORT` (default `5173`), documented in
`.env.example`. Extends the existing config surface per ADR 0001.

## Definition of Done

- [ ] `grep -rn "5173" --include="*.ts" --include="*.mjs"` finds only: the single
      default in each runtime's one-liner (`vite.config.ts`, `main.ts`), test files
      deriving via `VITE_URL`, and docs.
- [ ] With `VITE_PORT` unset: `npm start`, `npm run qr`, share links, and
      `npm run test:mock` behave byte-identically to before.
- [ ] With `VITE_PORT=5273`: Vite serves on 5273, share links and QR URLs say 5273.

## Tests

- [ ] `deno task check` passes.
- [ ] `npm run test:mock` passes with `VITE_PORT` unset.
- [ ] Manual: `VITE_PORT=5273 npm start` → confirm the served port, then
      `curl localhost:8000/worlds/default/share` shows `:5273` links.

```
deno task check
npm run test:mock
VITE_PORT=5273 npm start   # manual spot-check, then stop
```

## Acceptance Criteria

- [ ] Given two instances on one box (the `test-box.mjs` isolation case), when the
      second sets `VITE_PORT`+`PORT`+`API_TARGET`, then no hardcoded 5173 leaks into
      its share links or QR output.

## Risks / potential issues

- **Risk:** `strictPort: true` + an occupied 5173 previously failed fast; keeping
  strictPort with a variable port preserves that — but if someone sets `VITE_PORT` to
  an occupied port the failure message now depends on the env var. — **Mitigation:**
  keep `strictPort`; the failure is still immediate and explicit.
- **Risk:** merge overlap with 0006 in `main.ts` and 0009 in `.env.example`.
  — **Mitigation:** dependency ordering declared (after 0006); the `.env.example`
  overlap with 0009 is append-only in both tickets.

## Subtasks

1. [ ] Add the `VITE_PORT` read (+ default) to `vite.config.ts` (serve side) and
       `main.ts` (`viteBaseUrlFromEnv`).
2. [ ] Swap the three scripts' literals to the same read.
3. [ ] Update `playwright.config.ts` default construction; leave `VITE_URL` as the
       spec-level override.
4. [ ] Document in `.env.example`; update service-unit prose.
5. [ ] Run verification including the `VITE_PORT=5273` spot-check.
