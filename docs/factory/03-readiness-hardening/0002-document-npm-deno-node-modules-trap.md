> **Type:** Docs
> **Wave:** 03-readiness-hardening
> **Branch:** `docs/node-modules-ownership`
> **Commit style:** `docs(tooling): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None. Independent of every other ticket in the wave; touches no code.

## Goal

Write down who owns `node_modules` in this repo, because npm and Deno both manage it and
mixing them silently corrupts the tree. The observed failure is a partially-written
`node_modules/@playwright/test` (no `package.json`, `main` resolving to `undefined`)
alongside a separate `node_modules/.deno/@playwright+test@1.59.0`, after which **every**
Playwright suite dies with an error that names the wrong cause.

## Non-goals

- Do not change `deno.json`'s `nodeModulesDir` setting. It is load-bearing — see Pinned
  conventions.
- Do not remove npm or Deno, or migrate one runtime's dependencies to the other.
- Do not add a preinstall/postinstall guard script. This is a documentation ticket; a
  guard that runs on every install to catch a rare manual mistake is not worth the
  install-time cost or the new failure mode. See Open questions.
- Do not change `.github/workflows/deno-ci.yml`. CI does not hit this — see Pinned
  conventions.
- Do not delete `node_modules` as part of any committed script.

## Pinned conventions

**ADR 0001** — no type, env var, route, or job type is added. This ticket extends an
**existing documentation section** rather than creating a new doc:
`CLAUDE.md` § "Known contradictions to watch for" (`CLAUDE.md:86`), which already holds
exactly this class of entry — two parallel implementations that must be kept in sync, and
the licence/MIT contradiction. That section is the reuse target; do not create a new
`docs/TOOLING.md`.

Verified facts at `6217e0b`:

- `deno.json:2` sets `"nodeModulesDir": "auto"`, so Deno materialises `node_modules/`
  (with its own `node_modules/.deno/` layout) for the `npm:` specifiers `main.ts` imports:
  `hono`, `hono/cors`, `hono/logger`, `onnxruntime-node`, `jimp`, `@gltf-transform/*`,
  `draco3dgltf`, `jose` (`deno.json` imports map). This is why the setting cannot simply
  be dropped.
- `deno.json:26` `allowScripts` pins `npm:onnxruntime-node`, i.e. Deno is expected to run
  that package's install script — further confirmation Deno owns a real tree here.
- `.github/workflows/deno-ci.yml:49-50` installs with **`deno install`**, not `npm ci`,
  and runs only `deno task check` + `deno task test`. CI therefore never mixes the two
  and never runs Playwright — which is exactly why this trap only bites locally.
- The symptom is misleading. Playwright reports *"You have two different versions of
  @playwright/test"* and points at a `test.describe()` call site, when the real cause is
  one **incomplete** install, not two versions. All three of `@playwright/test`,
  `playwright`, and `playwright-core` report `1.59.0` while the failure is live.
- Recovery that works: `rm -rf node_modules && npm ci`.

## Before implementation

1. `CLAUDE.md:86-100` — the "Known contradictions to watch for" section and the voice of
   its existing two entries (each states the trap, then what breaks, then the pointer).
2. `deno.json:1-30` — `nodeModulesDir`, the `imports` map, `allowScripts`.
3. `.github/workflows/deno-ci.yml:29-60` — that CI installs via `deno install`.
4. `README.md` — its setup instructions, to check whether they say `npm ci` or
   `npm install`; if they say `install`, that is part of what this ticket corrects.

## Open questions & answers

- Q: Is this docs-only, or should tooling enforce it? — A: **Docs-only.** The trap needs a
  human to run the wrong command in the wrong order; a preinstall guard would run on every
  install forever to catch it, and would itself become a thing that breaks. Revisit only if
  it recurs after documenting. (decided during drafting, 2026-08-17)
- Q: Should `nodeModulesDir` change to `"manual"` or `"none"`? — A: **No.** `main.ts`
  imports eight `npm:` specifiers and `allowScripts` expects `onnxruntime-node`'s install
  script to run; Deno needs a real tree. Changing this is a much larger change than the
  problem warrants. (decided during drafting, 2026-08-17)
- Q: Is the rule "never `npm install`" or "order matters"? — A: State it as: **use
  `npm ci`; if you have run a `deno` task since, and npm behaves oddly, `rm -rf node_modules
  && npm ci`.** `npm ci` is deterministic from the lockfile and rebuilds the tree wholesale,
  which is what makes it safe here; `npm install` mutates an existing tree in place, which
  is what corrupts it. (decided during drafting, 2026-08-17)
- Q: Does the reverse order corrupt too (npm ci, then `deno task check`)? — A: **No, the
  reverse order is safe**, and the doc says so explicitly because it is the common local
  sequence. Run on Windows 11 / Node v24.3.0 / npm 11 / Deno 2.9.5 on 2026-08-18:
  `rm -rf node_modules && npm ci` → an npm-only tree with no `node_modules/.deno`;
  `deno task check && deno task test` → 131 passed, and Deno adds its `.deno` layout
  alongside the npm one; `npx playwright test --project=api --list` → clean, 34 tests in
  7 files. (answered by experiment, 2026-08-18)
- Q: Does the original corruption reproduce? — A: **Not on this host.** The documented
  repro (`rm -rf node_modules && deno install`, then `npm install`, then a Playwright list)
  ran clean here: `npm install` exited 0, `node_modules/@playwright/test/package.json` was
  present, all three Playwright packages reported 1.59.0, and the list returned 34 tests.
  Both layouts coexisted without harm. Per this ticket's own Risks section the entry is
  therefore written as **observed once** on the reporting host, not as a reliable repro —
  the symptom and the recovery are documented, but the doc does not claim `npm install`
  always corrupts. (answered by experiment, 2026-08-18)

## Files impacted

- **Changed:** `CLAUDE.md` — a third entry under "Known contradictions to watch for".
- **Changed:** `README.md` — only if its setup step currently says `npm install`; make it
  `npm ci`.

No code, no config, no workflow changes.

## Schema required

None.

## Definition of Done

- [ ] The open question above is answered by experiment and the answer recorded in this
      file before the wording is finalised.
- [ ] `CLAUDE.md` § "Known contradictions to watch for" has an entry that states: both npm
      and Deno materialise `node_modules` (`deno.json`'s `nodeModulesDir: "auto"`); use
      `npm ci`, not `npm install`; the symptom is Playwright's misleading "two different
      versions" error; the recovery is `rm -rf node_modules && npm ci`; and CI is unaffected
      because it installs with `deno install`.
- [ ] The entry names why `nodeModulesDir` cannot just be removed (the `npm:` specifiers in
      `main.ts`), so the next reader doesn't try.
- [ ] `README.md` says `npm ci` wherever it tells a contributor to install.
- [ ] No code or workflow file is modified by this ticket.

## Tests

No automated test — this ticket changes prose. Verification is that the documented
recovery actually works, and that the claim about CI is true.

- [ ] Reproduce the corruption, confirm the documented symptom matches, and confirm the
      documented recovery fixes it.
- [ ] Confirm the reverse order (`npm ci` then `deno task check`, then a Playwright run)
      is safe — or, if it is not, document that too.
- [ ] Confirm CI is genuinely unaffected by reading `deno-ci.yml`, not by assumption.

```
# reproduce (destructive to node_modules only; safe to redo)
rm -rf node_modules && deno install
npm install
npx playwright test --project=api --list      # expect the misleading "two different versions" error

# documented recovery
rm -rf node_modules && npm ci
npx playwright test --project=api --list      # expect a clean list

# reverse-order check (answers the OPEN question)
rm -rf node_modules && npm ci
deno task check && deno task test
npx playwright test --project=api --list      # expect a clean list
```

## Acceptance Criteria

- [ ] **Given** a contributor hits Playwright's "two different versions of
      @playwright/test" error, **when** they search `CLAUDE.md`, **then** they find the
      cause and a one-line recovery.
- [ ] **Given** a contributor is about to run `npm install`, **when** they follow the
      README, **then** it tells them to run `npm ci`.
- [ ] **Given** a reader wonders whether `nodeModulesDir` can just be turned off, **then**
      the entry already answers why not.
- [ ] The entry contains no claim that was not verified by running the commands above.

## Risks / potential issues

- **Risk:** The documented rule may be wider than the real constraint — if `npm ci` after a
  Deno task is perfectly safe, telling people to avoid a normal sequence is noise.
  — **Mitigation:** The OPEN question is a gate: run the reverse-order check and document
  what is actually true.
- **Risk:** Docs drift — a future `deno.json` change could make this entry false.
  — **Mitigation:** The entry cites `deno.json:2` and the CI install step by file and line,
  so a reader can check it in seconds.
- **Risk:** Reproduction is environment-sensitive and may not trigger on a clean machine.
  — **Mitigation:** If it cannot be reproduced, say so in the PR and still document the
  observed symptom and recovery, marked as observed-once rather than as a reliable repro.
  Do not silently drop the ticket.

## Subtasks

1. [ ] Run the reproduce block; confirm or correct the symptom described above.
2. [ ] Run the reverse-order block; answer the OPEN question in this file.
3. [ ] Read the two existing entries in `CLAUDE.md:86-100` and match their voice.
4. [ ] Write the third entry.
5. [ ] Check the README's install instruction; change `npm install` → `npm ci` if present.
6. [ ] Re-read the entry against the verified facts — every file:line claim must be real.
7. [ ] Flip this ticket's atlas diff to `is-done` with the merged PR number.
