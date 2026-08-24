# A real captured scan, as a committed fixture

**Status:** assessment only. Nothing here has been captured, and this branch adds
no geometry. The question asked was what it would take and whether the capture
path still works end to end — not to produce a scan by other means.

## Why this exists

The repo contains no real captured geometry.

- `worlds/default.json` is a 985 KB manifest describing **253 scans across 37
  sessions**, every one of which points at `/scans/<file>.glb`. `.gitignore:56`
  ignores `scans/`, so none of those GLBs were ever committed. The manifest is
  an orphan: it describes a world whose geometry does not exist in the checkout.
- The only tracked `.glb` files are `public/resources/dom-tablet-{button,frame}.glb`,
  which are UI furniture for the in-app tablet, not scans.
- Everything the product film shows is `?mock=xr8`. All 12 shots in
  `video/storyboard.json` set that flag. `public/test-fixtures/xr8-mock.js` says
  plainly what it is in its own header: *"a scripted camera glides through a
  synthetic 6×6 m room, emitting SLAM poses, world feature points, and a fake
  camera feed that shows CV-palette-coloured furniture"*. The world feature
  points come from an LCG seeded at `xr8-mock.js:75` — the point cloud is
  generated, not measured.

So the film is honest about the scan being thin — the SPARSE badge and
"COVERAGE — Low, keep scanning" are the product correctly reporting a thin map —
but what it is being thin *about* is a cartoon.

## Does the capture path work end to end today?

**On the evidence in the repo: yes, it has worked, and recently.** I did not run
it — that needs a phone and a GPU box, neither of which I have here — so this is
inference from recorded outcomes, not an observation.

`worlds/default.json` carries 87 job records from the real sessions, and the
completions cover every stage of the pipeline:

| Job type | completed | failed | queued / processing |
|---|---|---|---|
| `ingest` | 1 | 0 | 0 |
| `merge-points` | 10 | 0 | 6 |
| `extract-layers` | 6 | 1 | 9 |
| `semantic-pass` | 5 | 5 | 28 |
| `align-scan` | 0 | 10 | 6 |

Every one of the 16 failures is the same operator-precondition error, not an
algorithmic one:

```
align-scan requires a selected scan.      (x10)
semantic-pass requires a selected scan.   (x5)
extract-layers requires a selected scan.  (x1)
```

That is a job enqueued with nothing selected in the UI. `align-scan` has never
succeeded in this record, but it has also never been given an input, so its
state is untested rather than broken.

The capture half is likewise real: 253 autosave GLBs written at ~8-second
intervals on 2026-06-11, each with a `geoPose` resolved to a street address, a
`pointCount`, a `detectionCount` and a `qualitySummary`. Jobs continued to run
against that world as late as 2026-07-07.

Nothing needs downloading first: the 8th Wall OSS engine is **committed**
(`public/xr.js`, plus `xr-slam.js` / `xr-face.js`, ~1 MB), despite `index.html:27`
still telling you to fetch it from 8th.io/xrjs.

## What a real scan would actually take

### The rig

- **A phone.** iPhone/Safari runs the 8th Wall SLAM scanner; Android/Chrome runs
  the native WebXR scanner and needs ARCore. Either is fine.
- **A server the phone can reach over Tailscale**, with a CA-trusted cert —
  `tailscale cert <machine>.<tailnet>.ts.net`. Safari will not grant camera and
  motion on a self-signed origin, so this is not optional.
- **A Linux box with a GPU** for the inference half: Deno API on `:8000`, the web
  bundle on `:5173`, Ollama as a system service on GPU0, and the LingBot-Map
  torch worker spawned per job on GPU1. `../operations/DEPLOY.md` has the systemd setup;
  `scripts/install-services.sh` does it.
- **A room.** Ordinary furniture, even lighting, no large mirrors or glass — the
  quality pass explicitly scores `lowLightFrames` and `reflectiveWarnings`.

### The capture

`DEVICE_TESTING.md` Checklist A is already the exact protocol, and it ends
where a fixture would begin: choose the target **Place** and optional **Area**,
calibrate, then *export GLB → file lands in `scans/` on the box*, and open
`/editor?project=default` on desktop to verify the new scan appears in that
Place. Walk the room slowly, let the
point count climb, toggle auto-capture and keyframe streaming, then export.

Budget an afternoon, most of it standing up the box rather than walking the room.

### The part that needs care

The existing real data is a warning about what a casual walk produces. Across
those 253 autosaves:

- **median `pointCount` is 0** — most autosaves captured nothing at all
- mean 186, and the single best scan in the entire record is **3,203 points**
- 7 scans are already flagged `needs-rescan`, 12 `needs-review`
- the best `qualitySummary` present scores coverage **0.72 — "Good - review gaps"**

A fixture that replaces the cartoon has to look better than the cartoon on
camera. That means one deliberate, dense, consolidated scan of one room — not an
autosave stream. Expect several attempts.

### Committing it

Three things have to change, and they are the reason this is a decision rather
than a chore:

1. **`.gitignore:56` ignores `scans/`.** A fixture needs a deliberate exception
   (`!scans/fixtures/`) or its own directory outside that rule.
2. **Size.** A room-scale GLB after the Draco + LOD optimisation job is a few MB;
   the accompanying `.json` metadata and keyframes add more. That is a permanent
   addition to every clone. Git LFS is worth considering before, not after.
3. **The manifest has to point at it.** `worlds/default.json` currently names 253
   files that do not exist. A fixture world should be a new, small, self-consistent
   manifest — not a patch on this one.

## Two things worth fixing regardless of the fixture

Found while establishing the above. Neither is caused by this branch and neither
is fixed on it.

### `worlds/default.json` contains live share tokens

The committed manifest carries its `members` array verbatim, including the
bearer tokens:

```json
{ "memberId": "owner-…", "role": "owner", "token": "owner-98025f99-…", "expiresAt": null }
```

`main.ts:1452` (`activeMemberForToken`) authorises purely on string equality with
that value. There are owner, editor, commenter, and viewer
tokens, all with `expiresAt: null` and no `revokedAt`. Anyone with the repo has
the owner link for any deployment seeded from this default world. These are
minted per world by `createWorldMembers()` (`main.ts:1263`), so they should never
have been committed at all.

### It also contains a home address

Every one of the 253 scans carries a real `geoPose`, including
`lat`/`lng` to seven decimal places and a resolved street address of a private
residence, repeated 253 times. Whatever happens to the tokens, this file should
not ship as the default world.

Both point the same way: `worlds/default.json` should be regenerated as an empty
or fixture world, and the real one kept out of the repo.
