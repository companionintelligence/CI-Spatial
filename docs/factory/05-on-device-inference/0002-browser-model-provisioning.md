> **Type:** Frontend
> **Wave:** 05-on-device-inference
> **Branch:** `feat/browser-model-provisioning`
> **Commit style:** `feat(inference): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0001 (not technically, but sequencing the wave keeps one variable moving
> at a time)

## Goal

Get ~2.2 GB of LFM2.5-VL weights onto a phone once, keep them there, and be honest about it
while it happens. This is the ticket most likely to decide whether on-device inference is
practical at all — which is why it lands before the runtime work.

## Measured 2026-08-18 — provisioning is practical

The go/no-go measurement was taken on the Lume Pad 2 before any design work:

| | |
|---|---|
| Origin quota | **10.04 GB** (a desktop smoke run reported 41 GB — do not use that figure) |
| Currently used | 0.04 GB (43.7 MB caches, 3.4 MB IndexedDB) |
| Model on disk | **2.2 GB** — 22% of quota |
| Throughput over the tailnet | **21.6 MB/s** (32 MB range request) |
| Projected full transfer | **~104 s** |
| `navigator.storage.persist()` | returned **true** — persistence is grantable |

Two corrections to the record, both of which change this ticket:

1. **The model is 2.2 GB, not ~2.2 GB.** Both README.md:190 and `download_models.py`'s own
   comment understate it by 47%. `decoder_q4.onnx_data` alone is 1.13 GiB.
2. **Eviction is not the blocker it looked like.** `persist()` is granted on this device, so
   the weights can be made non-evictable. That converts the hardest open question into a
   one-line call — but it must actually be *made*, and its failure handled, since grant is
   heuristic on Android and not guaranteed elsewhere.

At ~104 s over a warm tailnet this is a viable feature. Plan for far worse on a cold or
remote link, and make the transfer resumable rather than assuming two minutes.

## The situation

`download_models.py` populates `public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/`, and its
docstring already says it provisions *"for both browser and Deno server paths"*. Vite serves
`public/`, so `/models/...` is reachable from the phone today. `src/inference/webgpu.worker.ts`
is already configured for exactly this:

```js
env.allowLocalModels = true
env.localModelPath = '/models/'
env.allowRemoteModels = false     // no HuggingFace Hub requests at runtime
```

So the *serving* half is arguably done. What does not exist is everything that makes 2.2 GB
survivable on a phone:

- **Nothing caches it deliberately.** Left to HTTP caching, a re-download is one eviction
  away and the user silently pays 2.2 GB again. `persist()` is grantable (measured above) but
  is never actually called.
- **Nothing verifies it.** A truncated transfer would be handed to `onnxruntime-web` as a
  broken session.
- **Nothing is resumable.** ~104 s is the warm-tailnet best case; a cold or remote link makes
  an all-or-nothing transfer a poor bet.
- **Quota is not shared fairly.** 2.2 GB is 22% of the device's 10.04 GB, and
  `checkStorageQuota` (`src/main.ts:386`) does not know model weights exist, so weights and
  irreplaceable scan data compete unmanaged.

## Non-goals

- Do not implement the WebGPU runtime. That is 0003.
- Do not change `download_models.py`'s server-side behaviour or `MODEL_DIR`.
- Do not rename any service-worker cache — `companion-scan-v3`,
  `companion-scan-offline-queue`, `companion-scan-flush` are load-bearing per CLAUDE.md's
  `Do not rename` table. If the service worker is used, **add** a cache; do not repurpose.
- Do not enable `allowRemoteModels`. Fetching from the Hub at runtime would send a request
  off-device the moment the user selects "no data leaves your phone", which is the exact
  contradiction wave 04 ticket 0004 exists to prevent.
- Do not make the model a build-time asset. 2.2 GB does not belong in `vite build` output or
  the Docker image.

## Open questions & answers

Nearly all of this ticket is undecided. That is the honest state, and the reason it is
sequenced early.

- Q: What caches the weights — the Cache API directly, the existing service worker, IndexedDB,
  or Transformers.js's own browser cache? — **OPEN.** The service worker already owns offline
  behaviour and would be the ADR 0001 answer, but its caches are load-bearing and it was
  written for small assets and an upload queue, not 2.2 GB blobs. Evaluate before choosing.
- Q: What is the actual quota, and can the model be evicted? — A: **10.04 GB quota; 2.2 GB
  model; `persist()` granted.** Eviction is avoidable. Remaining sub-question: what happens
  when persistence is *refused* (a weaker device, or a browser that declines the heuristic).
  (Measured 2026-08-18.)
- Q: How long does the transfer take? — A: **21.6 MB/s, ~104 s for 2.2 GB** on a warm
  tailnet. Practical. Still design for resumability — this is the best case, not the typical
  one. (Measured 2026-08-18.)
- Q: Is the download resumable? — OPEN, and follows from the previous answer. A
  non-resumable 2.2 GB transfer to a phone is a poor bet.
- Q: Per-file or single-archive? The three ONNX files plus tokenizer/config are separate
  today, which makes per-file progress and resume natural, and matches the driver's
  `createSession(name)` port from 0001. Leaning per-file. **Confirm against the chosen cache.**
- Q: What happens when the model is absent and the user selects on-device? — OPEN. It must
  not be the current behaviour (throw, destroy the capture). Probably an explicit
  "download the on-device model (2.2 GB)" action rather than an implicit fetch on first
  capture.

## Pinned conventions

**ADR 0001** — this adds a storage concern, so it states what it reuses. Verified at
`b314055`:

| Existing | Where | How used |
| --- | --- | --- |
| `download_models.py` | repo root | unchanged; already provisions for both paths |
| `public/models/` + Vite static serving | `vite.config.ts` | reused as the transport; no new endpoint |
| `env.localModelPath = '/models/'` | `src/inference/webgpu.worker.ts:44` | unchanged — the worker already points at the right place |
| `checkStorageQuota(store, overlay)` | `src/main.ts:386` | **reused**, not reimplemented; it must account for model weights alongside scan data |
| `public/sw.js` caches | `public/sw.js` | if used, **add** a cache; never rename or repurpose the three existing names |
| worker `progress` messages | `webgpu.worker.ts:59-80`, `router.ts` `onProgress` | reused for download progress — the protocol already exists and reports `{stage, pct}` |
| overlay progress UI | `src/main.ts` `setProgress` | reused; no second progress surface |

No new type or route unless the quota answer forces one.

## Before implementation

- `download_models.py` — exactly which files, and their sizes
- `src/inference/webgpu.worker.ts:38-50` — the `env` configuration already in place
- `public/sw.js` — cache names, versioning, and whether it can carry large blobs
- `src/main.ts` `checkStorageQuota` — the existing quota contract
- `src/pwa.ts` — how the service worker is registered and updated
- CLAUDE.md `Do not rename` — before touching any cache name

## Files impacted

Cannot be listed responsibly until the caching question is answered. Certain to touch:
- `src/inference/webgpu.worker.ts` or a new provisioning module
- `src/main.ts` — quota accounting and the download affordance

Likely, depending on the answer:
- `public/sw.js`, `src/pwa.ts`
- `README.md` — the download step is currently documented as server-only

## Schema required

Deferred to the caching decision. Constraints that hold regardless:

- A cache entry must be verifiable, so a partial or corrupt download is detected rather than
  handed to `onnxruntime-web` as a broken session
- It must be enumerable, so the UI can report what is present and let the user reclaim space
- It must not silently compete with scan data for quota without the user knowing

## Definition of Done

- [ ] Quota, throughput and eviction behaviour measured on a Lume Pad 2 and written down
- [ ] The weights are cached deliberately, surviving reloads
- [ ] Progress is reported through the existing worker progress protocol
- [ ] Absent weights produce an explicit affordance, never a thrown capture
- [ ] A partial or corrupt download is detected, not loaded
- [ ] Quota accounting covers model weights alongside scan data
- [ ] `npx tsc --noEmit` and `npm run verify` pass

## Tests

- [ ] Manual, on-device: cold provision, measure wall-clock, confirm survival across reload
- [ ] Manual: interrupt mid-download; confirm no corrupt cache entry is used
- [ ] Manual: fill storage and confirm the failure is reported, not silent
- [ ] `npm run verify`

## Acceptance Criteria

- [ ] Given a phone that has never downloaded the model, When the user opts in, Then they see
      honest progress and a size figure before it starts
- [ ] Given a provisioned phone, When the app reloads, Then the model is not re-downloaded
- [ ] Given insufficient storage, Then the user is told, and scan data is not silently evicted
- [ ] Given the model is absent, When on-device is selected, Then no capture is thrown away

## Risks / potential issues

- **Risk: this may be impractical, and that is a real outcome.** 2.2 GB to a phone over a
  tailnet, held against an unknown quota, may not be a sensible product. — **Mitigation:**
  Measure before building. If the numbers are bad, say so and stop — wave 04 ticket 0004's
  gate is already in place, and a documented "not viable on this device class" is a
  legitimate result of this wave.
- **Risk:** Model weights evict user scan data. — **Mitigation:** Quota accounting is in the
  Definition of Done. Scans are irreplaceable; weights are re-downloadable. Any eviction
  policy must prefer dropping weights.
- **Risk:** Touching `public/sw.js` breaks the offline upload queue for anyone with a stale
  worker installed — CLAUDE.md flags exactly this. — **Mitigation:** Additive only. Prefer a
  separate cache to extending the existing ones.
- **Risk:** A corrupt cached file produces a confusing runtime failure in 0003. —
  **Mitigation:** Verification is in the Definition of Done, not deferred to the next ticket.

## Subtasks

1. [x] Measure quota, throughput and eviction — done 2026-08-18; **continue**
2. [ ] Choose the caching mechanism against those numbers
3. [ ] Implement provisioning with verification
4. [ ] Wire progress through the existing worker protocol and overlay
5. [ ] Add the explicit download affordance and the absent-model path
6. [ ] Extend quota accounting to cover weights
7. [ ] Document the browser download path in `README.md`
8. [ ] Re-verify on-device
