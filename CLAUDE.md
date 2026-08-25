# CLAUDE.md — CI-Spatial (Companion Scan)

## What this repo does

A browser-based AR room scanner. A phone (Safari via 8th Wall SLAM, or Chrome/Quest via
native WebXR) walks through a space; a Deno server (`server/main.ts`, `:8000`) receives
keyframes and detections; a Vite/Three.js frontend (`:5173`) renders the scan and a
multi-scan World Editor. Reconstruction runs through two independent pipelines — a
fast GLB-optimizer (the `optimize-scan` `WorldJob` type → `server/pipeline.ts`) and a slower,
higher-fidelity chain (LingBot-Map point clouds → Brush Gaussian-splat training →
splat detection/finish). Both pipelines run as `WorldJob`s through the single job
system in `server/main.ts` (`docs/adr/0003-merged-job-system.md`) — see "Hard rule: reuse,
don't duplicate" below. Tailscale is the deployment backbone: hostnames, HTTPS certs,
and CORS are all built around `*.ts.net`.

## Key commands

```bash
npm start                    # Deno API (:8000) + Vite HTTPS dev server (:5173)
deno task check              # type-check server/main.ts (do this after any server/main.ts change)
npm run typecheck:tests      # type-check tests/*.spec.ts — `tsc --noEmit` does NOT
deno task test                # Deno unit tests
npm run qr -- "/scanner.html?world=default"   # QR code for on-device testing
npm run logs:watch           # stream a phone's console over the wire (?debug=remote)
```

**`npx tsc --noEmit` covers `src/` only** — `tsconfig.json`'s `include` is `["src"]`, and
Playwright transpiles specs without type-checking them. A type error in a spec is invisible to
it, to `npm run build`, and to CI. `npm run typecheck:tests` is the one that covers
`tests/*.spec.ts`; `npm run verify` runs both, so the pre-push hook does too. Deno unit tests
under `tests/unit/deno/` stay out of it deliberately — `deno task check` and `deno task test`
already own those.

`OLLAMA_HOST` may be a full URL (`http://localhost:11434`) or a host:port bind
address such as `0.0.0.0:11434`; the inference engine normalizes the latter to an
HTTP URL before making requests.

## Hard rule: reuse, don't duplicate

This is a cohesive system organized around **things** and **places** — not a
collection of independent features. See
[ADR 0001](docs/adr/0001-reuse-existing-domain-model.md) for the full reasoning.

- **Places** — `WorldProject`, `ScanManifest` (the `src/world/types.ts` one),
  `GeoPose`/`LocalFrame`, a capture Session. Everything that represents *where*.
- **Things** — `WorldDetection`, `DetectObject`, `FurnitureItem`. Everything that
  represents *what's in a place*.

**Before adding a new type, env var, job queue, or connection, search for one that
already does the job.** This codebase has two cautionary examples of not doing that
— both since fixed, but worth knowing so a third doesn't happen:

- Two unrelated types used to both be named `ScanManifest` (`server/jobs.ts` vs
  `src/world/types.ts`) — fixed by renaming the `jobs.ts` one to `OptimizeScanManifest`.
- Two entirely separate job-queue systems used to exist side by side: `jobs.ts`'s
  `JobQueue` (only handled `optimize-scan`) and the `WorldJob` system in `main.ts`
  (ingest, lingbot-map-reconstruct, splat-train/detect/finish, memory-push). They never
  called each other. Merged into one system, `WorldJob`, per
  `docs/adr/0003-merged-job-system.md` and `docs/factory/01-merge-jobs/`: `JobQueue`
  was ported onto `WorldJob` (which gained crash recovery, single-flight execution,
  dedupe, and bounded history to match what `JobQueue` already guaranteed) and then
  retired — the class no longer exists, and `server/jobs.ts` now holds only the legacy
  `Job`/`JobStatus`/`OptimizeScanManifest` shape definitions the `/jobs` API shim and
  the on-disk manifest format still use. (Both files — and every other server-side
  Deno module — were later grouped from the repo root into `server/`, in a separate,
  unrelated repo-tidy pass.)

A third reconstruction path was added by wave 10: a **person** capture (a clip of a
person, not a walkthrough of a room) is reconstructed as an animated splat sequence.
Its GPU-class stage runs **off-box** in `subsystems/4d-capture/` because 4DAnyone needs
~44 GiB on one CUDA device and no host on the fleet has that — so `person-4d-reconstruct`
is the one `WorldJob` type that delegates rather than computing. Unconfigured, it reports
`skipped` with a hint, like every other optional GPU tool. See ADR 0006 and
`docs/pipelines/4d-person.md`.

New background job types extend `WorldJob`, not a new parallel queue. New "thing" data
extends `WorldDetection`/`DetectObject`. New "place" data extends `ScanManifest`/
`WorldProject`/`GeoPose` in `src/world/types.ts`. If you're about to define a schema
field, env var, or connection that already exists under a different name, you're
about to create this codebase's third `ScanManifest` — don't.

## Ticket workflow (Factory) — local only

- Tickets are drafted **locally only**, under `docs/factory/<wave-name>/`, one
  markdown file per ticket, from `docs/factory/TICKET_TEMPLATE.md`.
- **Do not** run `scripts/factory/factory.sh create`, `gh issue create`, or otherwise
  push a ticket to GitHub. This repo's Factory workflow has no issue board and no
  issue-comment telemetry — everything stays in the repo as files.
- Decisions that outlive a single ticket get promoted to an ADR in `docs/adr/`
  (`scripts/factory/factory.sh adr new "<title>"` — this subcommand is local-only and
  still fine to use).
- `/factory <idea>` drafts a new wave's tickets — see `.claude/commands/factory.md`
  for the full workflow, and `docs/FACTORY.md` for background.
- A ticket that touches schema, a config variable, or a client↔server connection must
  cite ADR 0001 in its Pinned conventions and state what it's reusing or extending.
- **`docs/factory/atlas.html` is the living picture of the system, and it is how a
  wave justifies itself.** Planning a wave includes stating which atlas entries it
  changes (before/after) and writing that markup; landing a ticket includes flipping
  its badge to done and fixing any sentence the change made false. A wave whose diff
  won't state legibly isn't ready to plan. Full rules: `docs/FACTORY.md` § "The
  atlas". Never copy ticket content into it — it points, it doesn't restate.

## Known contradictions to watch for

- `LICENSE.md` (a restrictive Commercial Standard License) has previously conflicted
  with a doc claiming MIT — fixed once in
  `docs/factory/foundation-updates/0001-reconcile-license-contradiction.md`, but
  don't assume every doc in the repo agrees; grep before trusting a license claim.
- Hostname resolution (`TAILSCALE_HOSTNAME`/`ALLOWED_ORIGIN_PREFIX`) must stay in sync
  between `vite.config.ts`'s `resolveHostname()` and `server/main.ts`'s copy of the same
  algorithm — they're deliberately parallel implementations (different runtimes), not
  a shared module. See
  `docs/factory/foundation-updates/0002-fix-allowed-origin-prefix-autodetect.md`.
- **Both npm and Deno materialise `node_modules`.** `deno.json:2` sets
  `"nodeModulesDir": "auto"`, so `deno install` / any `deno task` builds its own
  `node_modules/.deno/` layout for the eight `npm:` packages in its import map (hono,
  onnxruntime-node, jimp, the `@gltf-transform/*` trio, draco3dgltf, jose). Only `hono` is
  imported by `server/main.ts` itself; the rest arrive through the modules it pulls in
  (`server/inference.ts`, `server/pipeline.ts`, `server/portal_auth.ts`, and the splat/lingbot runners). That setting
  is load-bearing — it cannot simply be dropped — and `deno.json:26`'s `allowScripts`
  expects `onnxruntime-node`'s install script to run, so Deno needs a real tree.
  **Install with `npm ci`, not `npm install`.** `npm ci` rebuilds the tree wholesale from
  the lockfile; `npm install` mutates an existing tree in place, which is what was once
  observed to corrupt it. The symptom names the wrong cause: Playwright reports *"You have
  two different versions of @playwright/test"* and points at a `test.describe()` call site,
  while all three of `@playwright/test`, `playwright` and `playwright-core` report the same
  version — the real state is one **incomplete** install, not two versions. Recovery is
  `rm -rf node_modules && npm ci`. Running `npm ci` first and a `deno` task afterwards is
  safe, and is the normal local sequence. CI never hits any of this:
  `.github/workflows/deno-ci.yml:49-50` installs with `deno install` and never runs
  Playwright, which is why this only bites locally.

## Do not rename

These identifiers look like stale or inconsistent legacy names — a mix of
`ci-xr-scan`, `ci-web-xr-scan`, and `companion-scan` naming — and are tempting
"cleanup" targets. They are load-bearing. Renaming any of them silently breaks
persisted user data or an external integration instead of erroring.

| Identifier | Where it lives | What breaks if renamed |
| --- | --- | --- |
| IndexedDB database name `'ci-xr-scan'` | `src/scene/store.ts` | Orphans every existing user's persisted session data — the browser opens a fresh, empty database under the new name. |
| sessionStorage key `'ci-xr-geo-fix'` | `src/geo/geo-tracker.ts` | Breaks in-flight geo-anchoring state for any tab that already wrote the old key. |
| localStorage key `'companion-scan-onboarded'` | `src/main.ts` | Every existing user sees the onboarding flow again on next launch. |
| Service-worker cache/queue names `'companion-scan-offline-queue'`, `'companion-scan-v3'`, `'companion-scan-flush'` | `public/sw.js` (also referenced from `src/pwa.ts`) | Breaks the offline upload queue for anyone with a stale service worker still installed — queued uploads become unreachable under the new name. |
| GHCR image name `ghcr.io/companionintelligence/ci-web-xr-scan` | `.github/workflows/docker-publish.yml` | Breaks every existing deploy pointing at that image tag — pulls start 404ing. |
| OIDC client id `'ci-web-xr-scan'` | `server/portal_auth.ts` | Must exactly match the client registration in the CI-Portal identity provider — "Sign in with Companion Account" breaks until the IdP registration is updated too. |
| memory-push `sourceSystem` `'companion-scan'` | `server/memory_push.ts` | Namespaces the idempotency keys sent to CI-Server — renaming it makes every previously-pushed memory look new, so re-pushes duplicate instead of deduping. |

If one of these truly needs to change, it's a coordinated migration (data
backfill, IdP update, or image-tag redirect), not a rename — treat it as its
own ticket, not a drive-by cleanup.
