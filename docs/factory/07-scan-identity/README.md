# Wave: 07-scan-identity

Four tickets on one question the system currently cannot answer: **which scan is this?**

They are one wave because they are one failure. A scan's identity is derived from the
capture session, a capture session is one browser tab, and a browser tab produces many
uploads. So every autosave in a walkthrough collides onto a single id, and every
subsystem keyed by that id — the viewer, edit-patch replay, memory-push idempotency,
job GC — silently resolves to whichever scan it happened to find first.

Nothing errors. That is the whole problem.

## The evidence

`worlds/default.json` right now holds four distinct GLBs:

```
scan-session-1787174216556 → 1787174311700_autosave-room-scan-…21-18-33.glb   (8 detections)
scan-session-1787174216556 → 1787174371857_autosave-room-scan-…21-19-32.glb  (10 detections)
scan-session-1787174216556 → 1787174954604_autosave-room-scan-…21-29-15.glb  (16 detections)
scan-session-1787175480232 → 1787175480232_autosave-room-scan-…21-38-01.glb  (16 detections)
```

Four files, one id. The viewer keys `loadedScans` by `scanId` and calls
`worldGroup.remove(previous.root)` when a second scan claims an id already in the map,
so three of those four are discarded during load. The HUD reads **"1 scan loaded"**.

That was observed on a Galaxy Tab S8 Ultra on 2026-08-19, in the same session that found
the WebXR user-activation bug. Nobody had noticed it because the count it reports is
plausible — one walkthrough, one scan, one number.

## What each ticket stops being silently wrong

| # | The claim | The reality |
|---|---|---|
| 0001 | four uploaded scans are in the world | Three are dropped at load. `scanId` is derived from a tab-lifetime session id, so the four are indistinguishable. Edit patches replay onto the wrong one, memory-push collapses all four onto one idempotency key, and job GC keeps jobs alive because a sibling still matches. |
| 0002 | keyframe-dependent jobs are ready to run | Two session-id namespaces exist — `session-*` minted client-side, `sess-*` minted server-side — and the validating regex accepts both. Client ids resolve to directories that were never created, so every keyframe lookup returns empty and `jobFailureReason` passes a preflight it was written to fail. |
| 0003 | the GLB records where its contents came from | `sessionId` is written at scene level only. `captureIndex` is dropped entirely at export. The inspector's one provenance row reads `sourceScan` while the exporter writes `sourceScanIds`, so it has never rendered. |
| 0004 | optimization preserves what the exporter wrote | Only `label` extras are covered by a test. `quantize()` already hoists meshes out of labelled nodes — measured 8 of 8 → 0 of 8 — and nothing yet guards provenance against the same fate, or against `dedup()` collapsing identical geometry *across* sessions. |

0001 and 0003 compound: without a unique scan id there is nothing correct to stamp onto
a node, and without node-level provenance a future merged GLB cannot be taken apart again.

## Why this order

**0001 first, because every other ticket needs a correct id to write down.** It is also
the only one that fixes visible data loss today, so it carries the wave on its own if the
rest slips. It is the largest of the four, and most of it is the migration: existing
worlds must be rewritten and `EditPatch.scanId` remapped off ids that used to mean four
things at once.

**0002 alongside it.** Independent in principle — it touches session identity, not scan
identity — but both edit `main.ts`, so they want sequencing rather than parallel branches.
It also fixes a diagnostic failure worth having before the later waves depend on keyframes:
today a keyframe job passes preflight and then fails inside the runner, which is the least
useful place for it to fail.

**0003 third**, once there is a stable `scanId` and a single `sessionId` to stamp.

**0004 last**, because it is the regression test for 0003 and cannot be written before it.
It is also the ticket that makes the deferred merged-GLB work in a later wave possible at
all: `@gltf-transform/functions` already ships `mergeDocuments`, and `export-world` is
already a declared placeholder job type, but merging is only reversible if provenance
survives the optimize pass.

## Tickets

| # | Ticket | One-line goal | Status |
|---|--------|---------------|--------|
| 0001 | [unique-scan-id-per-upload](0001-unique-scan-id-per-upload.md) | **Stop discarding three scans out of four** — derive `scanId` from the uploaded GLB, and migrate the worlds that already collided | ✅ landed |
| 0002 | [one-session-identity](0002-one-session-identity.md) | Reconcile the two rival session-id namespaces, and set the `glbFilename` backlink on every path that ends a session — not just manual export |
| 0003 | [node-level-glb-provenance](0003-node-level-glb-provenance.md) | Put session/scan/capture identity on every node, and fix the `sourceScanIds`/`sourceScan` mismatch that has blanked the inspector since it was written |
| 0004 | [pipeline-preserves-provenance](0004-pipeline-preserves-provenance.md) | Prove provenance survives `dedup`/`prune`/`quantize`/`draco` — the test that currently exists only for `label` |

0001 and 0002 both edit `main.ts`; land them in order rather than in parallel. 0003 is
client-side (`src/export/gltf.ts`) and 0004 is server-side (`pipeline.ts`), but 0004
tests what 0003 writes, so it follows.

## Running the 0001 migration

New uploads are correct the moment 0001 lands — `scanIdFor()` derives from the filename.
Worlds already on disk need one explicit pass, **with the server stopped**:

```bash
deno task migrate-scan-ids
```

`world_lock.ts` is in-process only (ADR 0004), so it cannot exclude a separate server
process writing the same `WORLDS_DIR`; the script says so on every run. It reads
`WORLDS_DIR` (default `./worlds`), rewrites each `<slug>.json` in place, and is
idempotent — a second run reports nothing to do and leaves every file byte-identical.

Two things it cannot do silently:

- **Ambiguous references.** A patch or job that named an id which used to mean four scans
  is re-pointed at the *newest scan of that session* — a guess, since nothing in the data
  records which one the user meant. Every such remap is logged by patch/job id, candidate
  count, and chosen scan. Review them if an edit looks misplaced.
- **Already-pushed memories.** `memory_push` sends `scanId` as `source_id`, and
  idempotency is `(source_system, source_id)`. Re-pushing under the new ids creates *new*
  CI-Server events rather than updating the old one, which stays behind describing
  whichever scan won the collision. Judged acceptable: that event is already wrong. If it
  needs removing, that is a manual CI-Server cleanup. `sourceSystem` `'companion-scan'`
  does not change (CLAUDE.md do-not-rename) — only the id value moves.

## Atlas diff

- **`ScanManifest.scanId`** — today derived from the capture session id, so every autosave
  in one walkthrough collides onto one id → unique per uploaded GLB, with existing worlds
  backfilled (0001).
- **World & viewer scan loading** — today the viewer silently drops all but one scan when
  ids collide, reporting "1 scan loaded" for four files on disk → every uploaded scan loads
  and toggles independently (0001).
- **Session identity** — today two namespaces never reconcile, so keyframe lookups return
  empty and keyframe jobs fail inside the runner instead of at preflight → one identity,
  honest preflight failure (0002).
- **GLB provenance** — *(gap filled: no "before" existed in the atlas; this wave's atlas
  pass added the description before diffing it.)* Today `sessionId` is scene-level only
  and `captureIndex` is dropped at export → per-node provenance (0003).
- **Optimize pipeline** — today only `label` extras are covered by a regression test →
  provenance extras covered too, including the cross-session `dedup()` case (0004).

## Successor

Wave 08 (`08-places-and-things`) is the reason this wave exists. It builds Project-as-place,
cross-session object correspondence, and a timeline scrubber — none of which can be correct
while two scans of the same room are indistinguishable. 08 does not start until this wave
lands.
