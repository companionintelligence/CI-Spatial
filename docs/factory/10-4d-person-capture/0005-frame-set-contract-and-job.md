> **Type:** Backend
> **Wave:** 10-4d-person-capture
> **Branch:** `feat/person-4d-job`
> **Commit style:** `feat(server): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0004 (a stored clip to process)

## Goal

Define the contract between capture and processing — the **posed multi-view frame set** — and add
the single `WorldJob` type that hands a take to the processing subsystem and ingests what comes
back. This is the ticket that makes 4DAnyone swappable: everything upstream and downstream talks
to the contract, never to 4DAnyone.

## The contract, and why it is the whole design

Both capture paths converge here:

```
1 clip  → subsystem runs 4DAnyone (densify)  ─┐
                                              ├─→ per-timestep posed multi-view frame sets
N clips → subsystem uses the real cameras    ─┘         → Brush per timestep → frame-NNNN.sog
```

A frame set is exactly what `server/splat/splat_train_dataset.ts` already builds for Brush: N
posed images at one instant. That is not a coincidence to exploit later — it is the reason this
shape was chosen, and it is what lets a deformable 4DGS trainer replace the per-timestep Brush
step later without touching capture or playback.

## Non-goals

- Do not run 4DAnyone, Brush, or any GPU work in this process. This ticket submits, polls, and
  ingests. The work is 0006's.
- Do not enqueue N per-timestep jobs through the `WorldJobPump`. See Pinned conventions — the
  pump is globally single-flight and this would wedge the box for hours.
- Do not build the viewer layer. 0007 owns rendering; this ticket only writes the artifacts and
  the manifest it reads.
- Do not add a second job queue, a worker registry, or a scheduler. `WorldJob` is the job system
  (ADR 0003).
- Do not make the server hard-fail when no subsystem is configured. See the skip contract below.

## Pinned conventions

**ADR 0001** — touches schema, config, and a client↔server connection.

*Job system.* Extends `WorldJob` (ADR 0003), which is the only job system — `JobQueue` was
retired and `server/jobs.ts` now holds only the legacy `Job`/`OptimizeScanManifest` shapes the
`/jobs` shim uses. **One new type: `'person-4d-reconstruct'`.** The twelve edit sites, verified:

| # | Site | Note |
| --- | --- | --- |
| 1 | `src/world/types.ts:21-36` | add to `WorldJobType` |
| 2 | `server/main.ts:1263` | `WORLD_JOB_TYPES` — a hand-maintained `Set`, **not** derived from the union; `POST /worlds/:slug/jobs` rejects anything absent from it |
| 3 | `server/main.ts:2266-2282` | `workerId` ternary in `_dispatchWorldJob` |
| 4 | `server/main.ts:2286-2325` | the dispatch branch |
| 5 | `server/main.ts:3294` | `jobResultFor()` — **exhaustive switch; `deno check` fails without a case** |
| 6 | `server/main.ts:3334` | `jobArtifactsFor()` — has a `default`, so optional |
| 7 | `server/main.ts:3248` | `jobFailureReason()` — the "requires a selected scan" list |
| 8 | `server/main.ts:3209` | `KEYFRAME_JOB_TYPES` — **do not add**; this job needs a clip, not keyframes |
| 9 | `server/main.ts:3270` | `applyCompletedJobToWorld()` — flip scan status |
| 10 | `server/main.ts:650, 661` | mime table + artifact route regex for the new suffixes |
| 11 | `server/main.ts:1280` | `DEFAULT_WORKER_CAPABILITIES` (cosmetic) |
| 12 | new `server/person4d/person_4d.ts` | the driver |

*Manifest.* Extend `PipelineManifestBase` in `src/world/manifests.ts` — **not** in the driver
file — and re-export from `src/world/types.ts:545-551`. This is ADR 0002 and it is not a style
preference: `tsc --noEmit` type-checks a file's *entire* body once it enters the program, so a
browser file type-importing from a Deno driver drags `Deno.*` into the frontend program (30+
"Cannot find name 'Deno'" errors, which is why `manifests.ts` exists at all). `deno check`
passing is **not** evidence this is safe — `npm run build` is the gate.

*Driver contract.* Copy `server/splat/splat_train.ts`'s shape exactly: export
`runPerson4D(opts): Promise<Person4DResult>`; resolve every knob as
`opts.x ?? Deno.env.get('X') ?? DEFAULT` in one `resolveParams()`; keep a **pure**
`buildRequest()` so it unit-tests without network; accept a `_fetch?`/`_spawn?` injection point;
**always** write the manifest on every path including skip and error; never throw into the
server.

*The skip contract is load-bearing.* An unconfigured or unreachable subsystem is
`status: 'skipped'` → `WorldJob` **`'completed'`** with a `remediation` string — not `'failed'`.
This is the established "the server never breaks because a GPU tool isn't installed" behaviour
(`BRUSH_BIN`, `SPLAT_DETECT_PYTHON`, `LINGBOT_MAP_*`, `SENSENOVA_DIR` all do this). `memory-push`
is the sole exception that hard-fails, and it is not the model here.

*Env naming*, following `<TOOL>_<KNOB>`: `FDANYONE_HOST`, `FDANYONE_TOKEN`,
`FDANYONE_VIEWS_PER_LAYER`, `FDANYONE_TIMESTEP_FPS`, `FDANYONE_POLL_MS`. Document all of them in
`.env.example` — note that most splat/Brush vars are currently *undocumented* there, which is a
gap to not reproduce.

*Idempotence is mandatory.* `recoverStuckWorldJobs` (`server/world/world_job_pump.ts:144`)
requeues **every** `processing`/`queued` job unconditionally on boot — requeue-always is
type-agnostic by design (ADR 0003). So a re-run must resume by take id rather than resubmit
blindly, or a crash mid-job silently doubles a 25-minute GPU charge.

*Progress.* Today it is `0` on create, `0.35` on dispatch, `1` at terminal — three values, and
job logs are never persisted. A multi-minute remote job wants better, and the mechanism is
throttled mid-run `commitWorldJob` calls. Each one takes the per-slug world lock and rewrites the
whole world JSON (ADR 0004), so throttle to ~5% steps — **never per frame**.

## Before implementation

- `server/splat/splat_train.ts` — the whole file. It is the template: `resolveParams`,
  `buildBrushArgs`, `isRunnable` gate, the ok/skipped/error triad, the manifest-always rule.
- `server/main.ts:2647-2749` — `_runSplatTrainJob`, the runner-glue archetype, including
  `claimSessionJob()` / `commitWorldJob()` and the auto-chain to `splat-finish`.
- `server/main.ts:3111-3153` — `claimJobScan()` vs `claimSessionJob()`, and why `keyframePreflight()`
  runs **outside** the world lock (ADR 0004 forbids I/O in a mutator).
- `server/world/world_job_pump.ts` — single-flight, dedupe (`worldJobTarget()`), bounded history,
  `recoverStuckWorldJobs`.
- `src/world/manifests.ts` — the envelope and its header explaining ADR 0002.
- `server/exec_probe.ts` — `isRunnable()`. Do not write another probe; its header records the
  Windows bug that made every splat job silently skip.
- `docs/adr/0003-merged-job-system.md`, `docs/adr/0004-world-file-writes-are-serialized-per-slug.md`.

## Open questions & answers

- Q: One job, or one job per timestep? — A: **One.** The pump is *globally* single-flight —
  "`splat-train` holds the box's one GPU regardless of which world asked" (ADR 0003) — with no
  priority, cancellation, or timeout. A 5 s clip at 5 fps is ~24 timesteps; even at 3 min each
  that is over an hour during which no `optimize-scan` from any upload can run. One job that
  delegates a sequence is the only shape that keeps the appliance responsive. (Decided in this
  ticket.)
- Q: Push or poll the subsystem? — A: **Poll.** A callback would need the subsystem to reach the
  appliance, which inverts the tailnet trust direction and adds an inbound endpoint to
  authenticate. Poll at `FDANYONE_POLL_MS` (default 15 s — adopted; a job runs 10–30 min so this
  is cheap). (Decided in this ticket.)
- Q: The job blocks the pump while polling for 25 minutes. Is that acceptable? — A: It is the
  same guarantee `splat-train` already has, and the alternative — releasing and re-acquiring —
  needs a resumable job state the system does not have. Accepted, and it is precisely why the
  *work* is off-box: the appliance holds one slot, not a GPU. State it in the pipeline doc so
  operators know a person job pauses other reconstruction. (Decided in this ticket.)
- Q: How does the job survive a server restart mid-poll? — A: `recoverStuckWorldJobs` requeues
  it; the driver first asks the subsystem whether a job for this `takeId` already exists and
  re-attaches instead of resubmitting. This is the "idempotent or add a type-specific branch"
  requirement from ADR 0003, discharged by re-attachment. (Decided in this ticket.)
- Q: What if the take has clips with mismatched or absent sync (0002)? — A: The driver passes the
  `TakeSync` records through and lets the subsystem decide, because the usable-subset question
  needs the decoded clips. The driver's only rule: a take whose members are all `'unsynced'` and
  number more than one must **not** be silently treated as synchronised — pass the truth along.
  (Decided in this ticket.)
- Q: Should a solo clip and an N-clip take be different job types? — A: No. They differ only in
  what the subsystem does internally, and the artifact is identical. Two types would duplicate
  every one of the twelve edit sites above for no behavioural difference. (Decided in this ticket.)
- Q: Where do the output `.sog` frames live? — A: Under `$SCANS_DIR/<base>.4d/frame-NNNNN.sog`, a
  directory sibling to the existing flat `<base>.splat.ply` artifacts. A directory rather than
  hundreds of flat files, because the existing artifact route is a suffix allowlist over a flat
  `SCANS_DIR` and would otherwise need a per-frame regex. This means the serve route needs one
  extra path segment — the only structural change to that route. (Decided in this ticket.)

## Files impacted

New:
- `server/person4d/person_4d.ts` — the driver
- `tests/unit/deno/person_4d.test.ts`
- `tests/api-person-capture.spec.ts` (one consolidated spec for the whole wave, rather than one per ticket)

Changed:
- `src/world/types.ts` — `WorldJobType`, `LayerType`, manifest re-export
- `src/world/manifests.ts` — `Person4DManifest`
- `server/main.ts` — the twelve edit sites above
- `.env.example` — the `FDANYONE_*` group

## Schema required

```ts
// src/world/types.ts
export type WorldJobType = … | 'person-4d-reconstruct'
export type LayerType    = … | 'splat4d'
```

```ts
// src/world/manifests.ts — extends the shared envelope, per ADR 0001/0002
/** The posed multi-view frame set is the contract between capture and processing.
 *  Both the 1-clip (4DAnyone densify) and N-clip (real cameras) paths produce it,
 *  which is what makes the densifier swappable. */
export interface Person4DManifest extends PipelineManifestBase {
  tool: '4d-capture'
  takeId: string
  /** How the views were obtained. 'densified' means 4DAnyone stood in for cameras. */
  viewSource: 'densified' | 'multi-camera'
  /** Real clips in the take. 1 ⇒ densified path by construction. */
  clipCount: number
  /** Views per timestep fed to the trainer — real or synthesized. */
  viewCount?: number
  /** Timesteps trained. Sequence length. */
  frameCount?: number
  /** Playback rate of the sequence, distinct from the source clip's fps. */
  fps?: number
  durationMs?: number
  /** Directory under SCANS_DIR holding frame-NNNNN.sog, when status is 'ok'. */
  sequenceDir?: string
  /** Worst residual across members at slice time, carried through from TakeSync.
   *  Absent when the take was unsynced — never defaulted to 0 (ADR 0005 rule 3). */
  syncResidualMs?: number
  params: {
    host: string
    viewsPerLayer: number
    timestepFps: number
  }
}
```

Re-export from `src/world/types.ts:545-551` alongside the splat manifests.

## Definition of Done

- [x] `'person-4d-reconstruct'` is dispatchable via `POST /worlds/:slug/jobs` and handled at all
      twelve sites; `deno check` passes (proving `jobResultFor`'s exhaustive switch is complete)
- [x] With `FDANYONE_HOST` unset, the job completes as **`'completed'`** carrying a `remediation`
      string — never `'failed'`, and never an exception into the server
- [x] With a reachable subsystem, the driver submits, polls, ingests the sequence, and writes
      `<base>.4d-capture.manifest.json` on every path
- [x] A restart mid-job re-attaches to the existing remote job by `takeId` rather than
      resubmitting
- [x] Progress advances in throttled steps, not per frame, and not more often than ~5%
- [x] `.sog` frames under `<base>.4d/` are servable
- [x] `.env.example` documents every `FDANYONE_*` var
- [x] `deno task check`, `npx tsc --noEmit`, `npm run build` all pass — the last one is the real
      ADR 0002 gate

## Tests

- [x] Unit (`person_4d.test.ts`): `resolveParams` override precedence — explicit opt beats env
      beats default
- [x] Unit: `buildRequest()` assembles a stable payload from a take without touching the network
- [x] Unit: **`FDANYONE_HOST` unset → `status: 'skipped'` with a `remediation` string**, and a
      manifest is still written (the fallback the coordinator relies on)
- [x] Unit: a subsystem 5xx → `status: 'error'`, manifest written, no throw
- [x] Unit: re-attachment — given a remote job already existing for a `takeId`, the driver
      attaches rather than submitting a second one
- [x] Unit: dedupe — two `person-4d-reconstruct` jobs for the same scan collapse to one via
      `findDuplicateWorldJob`
- [x] Playwright (`api-person-capture.spec.ts`): enqueue against a stubbed subsystem (0006's stub
      mode), observe `world-job-update` frames on `/events`, and confirm the completed job's
      artifacts
- [x] Playwright: a `.sog` frame under `<base>.4d/` is served with the right mime and a traversal
      attempt is rejected

```bash
deno task check
deno task test
npx tsc --noEmit
npm run build
npx playwright test tests/api-person-capture.spec.ts --project=api
```

## Acceptance Criteria

- [x] Given no `FDANYONE_HOST`, When a person-4d job is enqueued, Then it completes green with a
      remediation hint and the server keeps serving other jobs
- [x] Given a stub subsystem, When a take with one clip is processed, Then the manifest records
      `viewSource: 'densified'` and `clipCount: 1`
- [x] Given a stub subsystem, When a take with three clips is processed, Then the manifest
      records `viewSource: 'multi-camera'` and `clipCount: 3`
- [x] Given an unsynced multi-clip take, When the manifest is written, Then `syncResidualMs` is
      **absent** rather than `0`
- [x] Given the server is restarted while a job is polling, When it boots, Then the job requeues
      and re-attaches to the same remote job rather than starting a second one
- [x] Given a completed job, When the scan is loaded, Then a `splat4d` layer entry is present in
      its `layerIndex`

## Risks / potential issues

- **Risk:** One person job holds the global pump slot for 10–30 minutes, blocking every
  `optimize-scan` on the box. — **Mitigation:** inherent to the current job system and accepted
  here; documented in `docs/pipelines/4d-person.md` so it is an operator-known property rather
  than a mystery stall. Priority lanes are a job-system change, not this wave's.
- **Risk:** Requeue-always plus a paid remote GPU is a real cost bug — a crash loop could
  resubmit repeatedly. — **Mitigation:** re-attachment by `takeId` is a Definition-of-Done item
  and has its own unit test; make the subsystem's submit endpoint idempotent on `takeId` too, so
  correctness does not depend on only one side behaving.
- **Risk:** Adding a directory under a flat `SCANS_DIR` weakens the suffix-allowlist assumption
  the artifact route is built on. — **Mitigation:** one extra path segment with the same
  traversal guard, plus an explicit traversal test; do not generalise the route beyond that.
- **Risk:** Hundreds of `.sog` files per take makes `GET /scans` slower — the same class of
  problem `server/scan_index.ts`'s header records (2,900 files → 120 s). — **Mitigation:** the
  sequence lives in a subdirectory the scan sweep does not descend into; assert that in a test.
- **Risk:** The twelve edit sites are scattered across ~4,500 lines of `server/main.ts`, and
  `WORLD_JOB_TYPES` is hand-maintained and already drifts from the union (`'optimize-scan'` is
  deliberately absent). Missing a site fails at runtime, not compile time. — **Mitigation:** the
  table above is the checklist; `jobResultFor`'s exhaustive switch catches the most important
  omission at `deno check` time.

## Subtasks

1. [x] Add `Person4DManifest` to `src/world/manifests.ts`; re-export from `types.ts`
2. [x] Add `'person-4d-reconstruct'` and `'splat4d'` to their unions
3. [x] Write `server/person4d/person_4d.ts` with `resolveParams`/`buildRequest` pure and tested
4. [x] Implement submit → poll → re-attach → ingest, with manifest-always on every path
5. [x] Walk the twelve-site table; confirm `deno check` catches the exhaustive switch
6. [x] Add `_runPerson4DJob` glue beside `_runSplatTrainJob`, using `claimJobScan()`
7. [x] Add throttled progress commits (~5% steps)
8. [x] Serve `<base>.4d/frame-NNNNN.sog` with the traversal guard
9. [x] Document the `FDANYONE_*` group in `.env.example`
10. [x] Unit + Playwright tests; `deno task check`, `npx tsc --noEmit`, **`npm run build`**
