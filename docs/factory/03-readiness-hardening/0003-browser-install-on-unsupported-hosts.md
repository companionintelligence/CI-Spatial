> **Type:** Infra
> **Wave:** 03-readiness-hardening
> **Branch:** `chore/playwright-browser-bootstrap`
> **Commit style:** `chore(test): summary`
> **Design:** this ticket is the spec
> **Dependencies:** `0001` (a supported Node) should land first so the script can assume it. Not a hard block.

## Goal

Make the two WebKit Playwright tiers installable on a host Playwright does not
officially support. On Ubuntu 26.04 `npx playwright install` aborts outright, so
`npm test` and `npm run test:mobile` execute **zero** tests while still exiting in a way
that reads like a normal run. A repeatable bootstrap script replaces a sequence of
undocumented manual steps.

## Non-goals

- Do not vendor any browser binary, `.deb`, or `.so` into the repository.
- Do not upgrade or change the pinned `@playwright/test` version (`1.59.0` in
  `package.json`). Version choice is a separate decision; this ticket makes the pinned
  version work on this host.
- Do not modify `playwright.config.ts`. Its `CHROMIUM_EXECUTABLE_PATH` escape hatch
  (`playwright.config.ts:30-33`) already exists and is the documented mechanism — reuse it.
- Do not change `.github/workflows/deno-ci.yml`. CI runs `deno check` + `deno task test`
  only and never installs browsers, so it is unaffected.
- Do not make this script run automatically from `postinstall`. It is an explicit,
  opt-in host-setup step.
- Do not attempt to support every unsupported distro. Target the case that exists here and
  fail loudly and legibly elsewhere.

## Pinned conventions

**ADR 0001** — no new type, env var, route, or job type. Two existing things are reused
rather than reinvented:

| Existing | Where | How used |
| --- | --- | --- |
| `CHROMIUM_EXECUTABLE_PATH` env var | `playwright.config.ts:30-33` | already the documented hatch for "install unsupported but a compatible build exists"; the script points it at a cached build rather than adding a new variable |
| `TEST_INFRA.md` | repo root | the existing home for how to run the tiers; the host-setup section goes here, not in a new doc |

Shell conventions, matched from `scripts/install-services.sh`: `#!/usr/bin/env bash`,
then a header comment block giving usage on one line and behaviour as `-` bullets.
(`scripts/wait-for-url.sh` uses `#!/bin/sh` because it runs as a systemd `ExecStartPre`;
that constraint does not apply here, so follow `install-services.sh`.)

Verified facts at `6217e0b`, from a session that got both tiers to 176 passing:

- `@playwright/test` is pinned `1.59.0`; it requires `chromium:1217`,
  `chromium-headless-shell:1217`, `webkit:2272`
  (`node_modules/playwright-core/browsers.json`).
- `npx playwright install` on this host fails with
  `Playwright does not support chromium on ubuntu26.04-x64` and installs **nothing** —
  the failure is not partial, it aborts the whole command.
- `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` (the full platform string; the bare
  `ubuntu24.04` is rejected) lets install proceed, **but** Playwright's downloader stalls
  — observed 18 MB then no progress for 40 minutes — where a plain `curl` of the same URL
  sustains ~23 MB/s. So the override alone is not sufficient.
- Direct fetch works:
  `https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2272/webkit-ubuntu-24.04.zip`
  → unzip into `~/.cache/ms-playwright/webkit-2272/` → `touch INSTALLATION_COMPLETE`.
- The unpacked WebKit then needs libraries absent on 26.04 which the bundle does not ship:
  `libicudata.so.74`, `libicui18n.so.74`, `libicuuc.so.74` (Ubuntu `libicu74`),
  `libxml2.so.2`, `libevent-2.1.so.7`, `libwoff2dec.so.1.0.2`. Those four packages are
  sufficient for the **wpe** (headless) bundle, which is the one the Playwright tiers use.
  The **gtk** (headed) bundle additionally needs `libmanette-0.2-0`; without it a
  "re-run `ldd` and die if anything is still missing" check will **always** fail on gtk.
  Either add `libmanette-0.2-0` to the package list so that check is a true invariant for
  both bundles, or scope the check to wpe and document headed-GTK as unsupported — but do
  not do both, which is the self-contradiction the first draft contained.
- Those must be placed **inside the bundle**, at
  `~/.cache/ms-playwright/webkit-2272/minibrowser-{wpe,gtk}/sys/lib/`. An external
  `LD_LIBRARY_PATH` does **not** work: the bundle's own `minibrowser-*/MiniBrowser` wrapper
  **overwrites** `LD_LIBRARY_PATH` with `${MYDIR}/lib:${MYDIR}/sys/lib` before exec.
- Chromium needs none of this — pointing `CHROMIUM_EXECUTABLE_PATH` at an already-cached
  newer `chrome-linux64/chrome` is enough, and is what the config's hatch is for.
- Verification that it worked: `~/.cache/ms-playwright/webkit-2272/minibrowser-wpe/MiniBrowser --headless --version`
  prints `WPE WebKit 2.53.0`.

## Before implementation

1. `playwright.config.ts:22-40` — `VITE_PORT`/`VITE_URL` resolution and the
   `chromiumExecutable` hatch, so the script's output matches what the config expects.
2. `scripts/install-services.sh:1-20` — the header/usage/bullet convention to match.
3. `TEST_INFRA.md:20-45` and its tier table around `:157` — where host setup belongs.
4. `.github/workflows/deno-ci.yml` — confirm no browser install happens in CI.
5. `package.json` — the `test`, `test:mobile`, `test:mock` script definitions.

## Open questions & answers

- Q: Script, docs, or both? — A: **Both.** The steps are too many and too order-sensitive
  to be a doc alone (the `sys/lib` placement in particular is non-obvious and silently
  wrong if done as `LD_LIBRARY_PATH`), and a script with no prose leaves the reader unable
  to judge whether they need it. (decided during drafting, 2026-08-17)
- Q: Where does the script live and what is it called? — A: `scripts/install-browsers.sh`,
  alongside the other host-setup scripts. It is not an npm script, because it is a
  once-per-host action, not part of the test loop. (decided during drafting, 2026-08-17)
- Q: Should it run on supported hosts too? — A: **Yes, and on those it should just delegate
  to `npx playwright install` and exit.** A script that only works on the broken case
  becomes a script nobody trusts. Detect, then branch. (decided during drafting, 2026-08-17)
- Q: Where do the four libraries come from? — A: Ubuntu 24.04 (noble) `.deb`s fetched from
  `archive.ubuntu.com` and extracted with `dpkg-deb -x` — no system install, nothing
  outside the Playwright cache is touched. (decided during drafting, 2026-08-17)
- Q: How does the script avoid becoming stale when the Playwright pin moves? — A: It must
  **read the required revisions from `node_modules/playwright-core/browsers.json`** rather
  than hardcoding `2272`/`1217`. Hardcoding is how this rots. (decided during drafting,
  2026-08-17)
- Q: Can the download URLs be recovered from Playwright's own `--dry-run` output? — A:
  Partly, and not uniformly — do not assume a fixed number of lines. `webkit` and `ffmpeg`
  print a primary `Download url:` plus fallbacks, but `chromium` and
  `chromium-headless-shell` resolve through `cftUrl()` whose mirror list is the single host
  `https://cdn.playwright.dev`, so they print exactly **one** URL and no fallbacks. Parse
  whatever is printed rather than expecting three. (found by the reuse audit, 2026-08-17)
- Q: Does anything already resolve the Playwright CLI path, or is that new? — A: It already
  exists: `scripts/test-box.mjs:41` does
  `const PLAYWRIGHT_CLI = join(root, 'node_modules', '@playwright', 'test', 'cli.js')`.
  Match that resolution rather than shelling out to `npx playwright`, and cite it as the
  precedent for why the path is exactly that. (found by the reuse audit, 2026-08-17)
- Q: Is `npm test` exiting 0 with zero tests a separate bug worth its own ticket? — OPEN.
  Playwright normally errors on no-tests-found; here the tiers failed at browser launch,
  per test. Worth confirming whether a misconfigured host can ever produce a green run with
  nothing executed — if so that is a real reporting gap. **Answer before closing;** if it
  is real, note it in the wave README as found-but-deferred rather than expanding scope.

## Files impacted

- **New:** `scripts/install-browsers.sh` — the bootstrap.
- **Changed:** `TEST_INFRA.md` — a host-setup section explaining when the script is needed,
  what it does, and the `CHROMIUM_EXECUTABLE_PATH` export the tiers then need.
- **Changed:** `README.md` — one pointer from the testing section to that section, only if
  the README does not already defer to `TEST_INFRA.md` there.

No source or workflow changes.

## Schema required

None.

## Definition of Done

- [ ] `scripts/install-browsers.sh` exists, is executable, and starts with the
      `install-services.sh` header convention.
- [ ] On a **supported** host it delegates to `npx playwright install` and exits.
- [ ] On an unsupported host it: reads the required revisions from
      `node_modules/playwright-core/browsers.json`; fetches the matching WebKit zip
      directly; unpacks to `~/.cache/ms-playwright/webkit-<rev>/`; writes
      `INSTALLATION_COMPLETE`; fetches and extracts the four Ubuntu 24.04 libraries; copies
      the `.so` files into `minibrowser-wpe/sys/lib` **and** `minibrowser-gtk/sys/lib`.
- [ ] It is idempotent — a second run is a no-op and says so.
- [ ] It verifies itself by running `MiniBrowser --headless --version` and fails loudly if
      that does not print a version.
- [ ] It never writes outside `~/.cache/ms-playwright/` and a temp dir, and never uses
      `sudo`.
- [ ] It prints the `CHROMIUM_EXECUTABLE_PATH` export the caller needs for the mock tier,
      or sets nothing and says so explicitly.
- [ ] `TEST_INFRA.md` documents when this is needed and what it does not do.
- [ ] After running it, `npm test` and `npm run test:mobile` both execute their full suites.

## Tests

No unit test — this is host bootstrap. Verification is that the tiers run.

- [ ] Run the script on this host from a cleared `~/.cache/ms-playwright/webkit-*`; it
      completes and self-verifies.
- [ ] Run it a second time; it is a no-op.
- [ ] Both WebKit tiers execute a full suite (not zero tests) and report a real count.
- [ ] `shellcheck scripts/install-browsers.sh` is clean, if shellcheck is available.

```
bash scripts/install-browsers.sh
bash scripts/install-browsers.sh                     # idempotent: expect a no-op

export PATH="$HOME/.nvm/versions/node/v26.3.0/bin:$PATH"
export CHROMIUM_EXECUTABLE_PATH=$HOME/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome
VITE_URL=https://localhost:5173 npm test             # expect a full suite, ~176 tests
VITE_URL=https://localhost:5173 npm run test:mobile  # expect a full suite, ~176 tests
```

## Acceptance Criteria

- [ ] **Given** an unsupported host with no WebKit installed, **when** the script runs,
      **then** it exits 0 and `MiniBrowser --headless --version` prints a version.
- [ ] **Given** the script has run, **when** `npm test` runs, **then** it executes the full
      desktop suite rather than failing every test at browser launch.
- [ ] **Given** a supported host, **when** the script runs, **then** it delegates to
      `npx playwright install` and adds nothing bespoke.
- [ ] **Given** the Playwright pin changes, **when** the script runs, **then** it fetches
      the revision `browsers.json` names — no hardcoded `2272`.
- [ ] **Given** a download or extraction fails, **then** the script exits non-zero with a
      message naming the step, and does not leave a half-unpacked bundle that later reads
      as installed.

## Risks / potential issues

- **Risk:** The script encodes a workaround for a specific upstream gap; a future
  Playwright may support 26.04 and make it dead weight. — **Mitigation:** The
  supported-host branch means it degrades to a thin wrapper rather than breaking; note in
  `TEST_INFRA.md` that it can be deleted once upstream supports the host.
- **Risk:** `archive.ubuntu.com` URLs and package versions drift. — **Mitigation:** Resolve
  the `.deb` filename from the pool directory listing rather than hardcoding a version, and
  fail loudly if no match is found.
- **Risk:** Writing `INSTALLATION_COMPLETE` makes Playwright trust a bundle that may be
  incomplete. — **Mitigation:** Write that marker **last**, only after the library copy and
  the `--version` self-check both succeed.
- **Risk:** The four libraries could conflict with a future WebKit build expecting newer
  sonames. — **Mitigation:** They are scoped inside the versioned bundle directory, so a
  new revision gets a fresh directory and a fresh run of the script.
- **Risk:** Copying libraries into `sys/lib` is unusual enough that a reader may "fix" it to
  `LD_LIBRARY_PATH`. — **Mitigation:** A comment at that line stating the wrapper
  overwrites `LD_LIBRARY_PATH`, so the external variable is ignored.

## Subtasks

1. [ ] Read the five locations in "Before implementation".
2. [ ] Answer the OPEN question about zero-test runs; record it here.
3. [ ] Write `scripts/install-browsers.sh`: detect support → delegate; else revision lookup
       from `browsers.json` → fetch → unpack → libraries → `sys/lib` × 2 → self-check →
       marker.
4. [ ] Make it idempotent and re-runnable; `chmod +x`.
5. [ ] Run `shellcheck` if available; fix warnings.
6. [ ] Clear `~/.cache/ms-playwright/webkit-*` and verify from scratch, then verify the
       no-op second run.
7. [ ] Run both WebKit tiers and record the test counts in the PR.
8. [ ] Write the `TEST_INFRA.md` section; add the README pointer only if needed.
9. [ ] Flip this ticket's atlas diff to `is-done` with the merged PR number.
