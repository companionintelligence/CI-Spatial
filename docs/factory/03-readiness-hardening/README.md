# Wave: 03-readiness-hardening

Close the six items a full readiness review of the scan → pin → export → editor path left
open. One of them is the reason a clause of that bar does not hold today (an object you
move in the editor comes back somewhere else); three are the reason nobody noticed.

## Why one wave, and why the toolchain tickets come first

The obvious split is "product defects" (0004, 0005, 0006) and "toolchain gaps" (0001,
0002, 0003), and wave 02's own README set the precedent for separating changes with
different review profiles. This wave deliberately does not split, because the two halves
are one finding: **the WebKit tiers were executing zero tests on this host.**
`npx playwright install` aborts on Ubuntu 26.04, so `npm test` and `npm run test:mobile`
failed every test at browser launch rather than reporting "no browser". The editor
transform bug lived behind that.

So the sequencing is the argument: 0001–0003 make the suite able to run and the repo able
to say what it needs, and 0004–0006 then land against a suite that actually executes.
Splitting them into two waves would let the product fixes merge with their verification
story still broken — which is exactly how the original defects survived.

Ticket 0004 is the one that changes what the product does. The rest are the conditions
under which anyone could have known.

## Tickets

| # | Ticket | One-line goal |
|---|--------|---------------|
| 0001 | [pin-node-version](0001-pin-node-version.md) | Declare the Node the repo actually requires, so three `.mjs` scripts stop dying with a bare `ERR_UNKNOWN_FILE_EXTENSION` |
| 0002 | [document-npm-deno-node-modules-trap](0002-document-npm-deno-node-modules-trap.md) | Write down who owns `node_modules`, so a mixed npm/Deno install stops corrupting Playwright |
| 0003 | [browser-install-on-unsupported-hosts](0003-browser-install-on-unsupported-hosts.md) | A bootstrap script so the two WebKit tiers run on a host Playwright does not support |
| 0004 | [fix-editor-lod-transform-roundtrip](0004-fix-editor-lod-transform-roundtrip.md) | **An object moved in the editor comes back in the same place after a reload** |
| 0005 | [make-scan-listing-linear](0005-make-scan-listing-linear.md) | Remove the O(scans × sessions) blowup that made `GET /scans` take 120 seconds |
| 0006 | [bundle-leaflet-and-fix-loader-race](0006-bundle-leaflet-and-fix-loader-race.md) | Bundle Leaflet from npm and delete the loader race that hands `undefined` to `L.map()` |

## Execution order & parallelization

**Sequence the three toolchain tickets first (0001 → 0002 → 0003).** They are independent
of each other in content, but 0001 lands the Node floor that 0003's script and 0005's
verification both assume.

> **0003 is deferred as of 2026-08-18.** It is written against Ubuntu 26.04; the host this
> wave is being worked on is Windows 11, where Playwright supports WebKit natively and
> `npx playwright install` does not abort. Its bespoke path cannot be exercised or verified
> here, so it would ship unrun. See the host-check banner at the top of the ticket for the
> measurements and for how to re-scope it. **0001 and 0002 landed; 0004–0006 do not depend
> on 0003** — 0004's regression test is a `chromium-mock` spec, and that tier already runs.

**0004, 0005 and 0006 are then parallel by content** — they touch disjoint code:
`src/viewer/editor.ts`, `main.ts`'s listing path, and the geomap/Leaflet path respectively.

Ordering constraints come from **shared files**, not shared logic. Name them before
branching:

| Shared file | Tickets | Consequence |
|---|---|---|
| `package.json` | 0001 (`engines`), 0006 (`dependencies` + lockfile) | Land 0001 first; 0006 regenerates `package-lock.json`, so rebasing it over 0001 is cheaper than the reverse. |
| `README.md` | 0001 (Node requirement), 0002 (`npm ci`) | Adjacent edits in the same setup prose — land 0001 then 0002, or expect a trivial conflict. |
| `TEST_INFRA.md` | 0003 (host-setup section), 0006 (`:78` false claim) | Different sections; conflict is unlikely but land 0003 first since it adds structure 0006's line sits near. |
| `docs/factory/atlas.html` | **every ticket** | Each flips its own diff block to `is-done`. Expect textual conflicts if two land the same day; they are one-line resolutions. |
| `tests/e2e-suite.spec.ts` | 0006 (Test 30) | Only 0006 touches it in this wave. |

Nothing in this wave blocks on `0004`, and `0004` blocks nothing. It is the highest-value
ticket, and it does **not** wait on 0003: its own regression test is a `chromium-mock`
spec, and that tier already runs. (This paragraph used to say 0004 "can start the moment
0003 makes its verification runnable"; with 0003 deferred that reading is wrong, so it is
stated directly.)

## Prerequisites (must already be merged)

- PR #84 (`fix: eight defects on the scan → pin → export → editor path`) — merged as
  `6217e0b`. This wave was planned against that commit.
- **Re-pinned 2026-08-18 against `d4f149c`.** Thirteen fixes landed between the two (PRs
  #85–#101, from a separate readiness review), so `main.ts` and `src/viewer/viewer.ts`
  moved under 0005 and 0004 respectively. Both have been re-measured against `d4f149c` and
  carry a re-pin banner saying what shifted and why. 0004's numbers were first re-measured
  at `f8d0779`; `src/viewer/viewer.ts` is byte-identical between that and `d4f149c`, so
  they still hold. 0001, 0002 and 0006 pin files that range did not touch and were
  verified unchanged. 0003 gained a scope check against #95.
- ADR 0004 (`world-file writes are serialized per slug`) — 0005 cites `withWorldLock` as a
  thing it deliberately does **not** extend.

## Found but deferred

Real, verified, and out of scope here — recorded so they are not rediscovered as new:

- **Patches persisted before 0004 carry a level's identity, and which level depends on
  the scan.** A patch whose `targetId` is the far mesh's GLB id (e.g. `bed_001`) resolves
  through `findObjectByTargetId`, which matches `objectId`, `id`, `name` or `uuid`
  (`src/viewer/viewer.ts:2267`). Since #87 the two graph shapes diverge:
  - **Freshly exported scan** — the labelled node *is* the mesh, so `upgradeSemanticMeshes`
    moves it inside the LOD. The patch resolves to that level rather than the LOD, exactly
    as this note originally described.
  - **Optimized scan** — `quantize()` hoisted the mesh into an unnamed child, so the
    labelled node survives as a container keeping its name and `objectId`, and the LOD is
    attached *beneath* it. The patch resolves to the container, which encloses the LOD —
    so it transforms the whole object rather than one level.

  Neither is a new break, and migrating is still a one-time patch rewrite keyed on
  `scanId` — its own ticket if it ever bites. Worth knowing that a migration would have to
  handle both shapes.
- **Can a misconfigured host produce a green run with zero tests?** ~~Open.~~ **Answered,
  and yes — a near miss of it.** In the originally observed case every test failed at
  browser launch, so the run was red. But PR #101 found the adjacent failure for real: after
  #95 made service workers install in `chromium-mock`, the worker began intercepting
  `/upload-scan`, and `page.route` does not intercept service-worker-initiated requests.
  Two tests' routes silently stopped firing and they began asserting against the real
  server — passing while testing nothing they intended. Not zero *tests*, but zero
  *assertions of the intended thing*, with a green result and no warning.
  Found only by running the full suite; the spec alone still passed. So the family is
  real, and 0003 should treat "reports success having verified nothing" as a live
  possibility rather than a hypothetical.
- **A canvas click cannot reach a semantic object in a point-cloud scan.** Found while
  building 0004's regression test, and the reason that test is a Node unit test rather
  than the `chromium-mock` spec the ticket planned. `SceneEditor.pick()` raycasts and takes
  `hits[0]`, but **three.js `Raycaster` does not skip invisible objects**, so in a seeded
  test home the nearest hits are `point-cloud` `Points` ~0.12 m from the camera — and they
  are still returned after the Cloud layer is toggled off (`vis: false` in the hit list).
  The walk then finds no label and no LOD parent above a point-cloud node, so `pick()`
  returns `null` and the click selects nothing. Measured, not inferred: with the cloud
  hidden and effective visibility applied by hand, the first eligible hits are a
  `TransformControlsPlane` (3.51 m) and only then the LOD's own mesh (3.66 m) — so the
  always-attached gizmo plane is a second interceptor (`viewer.ts` attaches
  `transformControls` to the scan root on load).

  Two independent defects, both **outside 0004's scope** — it only reorders two conditions
  in the walk, and that reorder is correct and unit-tested. But note the consequence:
  **0004's own acceptance criterion "when an object is clicked, then the selected object is
  the THREE.LOD" cannot be satisfied by a click on this corpus** until these are fixed.
  A fix is probably a visibility filter plus excluding the gizmo's own helper from the pick
  raycast; it needs its own ticket, because "which things are pickable" is a product
  decision (point clouds are deliberately in the `Mesh || Points` filter today).

- **Widening the no-CDN assertion.** 0006's check is scoped to `unpkg.com` by design.
  Asserting that *no* cross-origin script host is contacted would catch the next instance
  of this class, but it is a different (and noisier) test.
- **A possible duplicate-detection issue.** The review's mobile screenshot showed two `tv`
  detections at 95% with identical descriptions at different x positions, which may mean
  the spatial resolver is not merging the same object across frames. **Unverified** — it
  was never reproduced or traced, and it may simply be two real televisions in the fixture
  scene. Worth a look before it is assumed to be a bug.

## Atlas

Per `docs/FACTORY.md` § "The atlas", this wave's entries are diffed in
`docs/factory/atlas.html`. Two of them had no "before" to diff against, so the wave adds
the description first:

- **"Multi-scan World Editor"** (`atlas.html:387`) — its `pick-to-edit` claim is currently
  true only for selection, not for persistence. → 0004.
- **"Scan storage"** (`atlas.html:411`) — gains the linearity note and the `scan_index.ts`
  chip. → 0005.
- **Geomap / Leaflet** — *gap*: the atlas describes no geomap feature and no browser→CDN
  edge in "Key integration points". The wave adds both, then diffs them. → 0006.
- **Node/toolchain requirements** — *gap*: nothing in the atlas states what the repo needs
  to build and test. Added under Ops & Tooling. → 0001, 0002, 0003.
