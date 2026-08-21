> **Type:** Frontend
> **Wave:** 05-on-device-inference
> **Branch:** `feat/ungate-on-device-inference`
> **Commit style:** `feat(inference): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0003 (a working on-device path). Reverses wave 04 ticket 0004.

## Goal

Give the control back, and settle what happens when on-device inference fails — the question
wave 04 deliberately deferred rather than answering against a path that could not run.

## What this reverses

Wave 04 ticket 0004 gated the toggle because it threw on every capture. It changed
reachability only: `src/inference/webgpu.worker.ts`, the toggle in `src/ui/panel.ts`, the
router's worker branch and the `infer-mode` localStorage value were all left intact,
specifically so this ticket is a reversal rather than a rewrite.

That includes the stored preference. Wave 04 required a stored `webgpu` to resolve to
`server` **at read time without being overwritten** — so a user who selected on-device before
any of this gets it back automatically here.

## The real question: what happens on failure

Today `InferenceRouter` falls back to the server on *timeout* (`src/inference/router.ts:130-132`)
and rejects on *error* (`:158-165`). Neither is right once on-device genuinely works, and the
naive fix is actively harmful.

**A silent server fallback is not acceptable.** The control says `'On-device — no data leaves
your phone'` (`src/ui/panel.ts:268`). Quietly sending the image to the server when the local
path stumbles would ship data off-device while the UI insists it did not. That is worse than
failing, because it is undetectable — and this is a privacy claim, not a performance hint.

Note the existing timeout fallback already has this property today. It has simply never fired
on a path that ran. **This ticket must fix that too**, not just the error branch.

Options, to be decided:

| Option | Honest? | Cost |
| --- | --- | --- |
| Fail the capture, tell the user, keep the frame (per wave 04 ticket 0003) | Yes | A lost detection; the user retries or switches |
| Ask before falling back ("on-device failed — use the server?") | Yes | A prompt mid-capture, which is intrusive during scanning |
| Fall back and *say so* — persist a per-detection flag recording which engine ran | Yes | Needs schema and UI to surface it |
| Fall back silently | **No** | — |

The third is the most interesting, because "which engine produced this detection" is
arguably worth recording regardless — it makes a mixed-provenance scan legible, and it is
the kind of thing that would have shortened wave 04's investigation considerably.

## Non-goals

- Do not change the driver, the port, or the provisioning from 0001-0003.
- Do not make on-device the default. It is opt-in; latency and provisioning cost make that
  the right default even when it works.
- Do not remove the server path or the `INFERENCE_MODE` server-side selection.
- Do not silently re-enable on a device that cannot run it — an unusable control that
  reappears is the same class of dishonesty this wave is fixing.

## Pinned conventions

**ADR 0001** — this may add persisted state (engine provenance), so it states what it would
extend. Verified at `b314055`:

| Existing | Where | How used |
| --- | --- | --- |
| `_aiWebGPUBtn` toggle | `src/ui/panel.ts:205-207, 263-265` | un-gated; the control wave 04 preserved |
| `infer-mode` localStorage key | README.md:148 | reused with its original meaning restored; **never renamed** |
| `InferenceRouter` fallback logic | `src/inference/router.ts:130-132, 158-165` | **both** branches revised under one policy |
| `WorldDetection` / `RawDetection` | `src/world/types.ts`, `src/inference/prompt.ts` | if provenance is recorded, it **extends** these — ADR 0001 forbids a parallel record |
| capture record | wave 04 ticket 0003 | if that landed, provenance belongs on it rather than a new store |
| HUD failure copy | `src/main.ts` catch block | the `router.hasWebGPU` branch is restored, and gains on-device-specific cases |

## Before implementation

- wave 04 ticket 0004 — precisely what was gated, so this is a clean reversal
- `src/inference/router.ts:110-166` — both fallback branches
- `src/ui/panel.ts:200-270` — the toggle and its note text
- `src/main.ts` catch block — failure copy
- 0003's measured latency and memory figures — they determine how the control is presented
- wave 04 ticket 0003 — whether a capture record exists to hang provenance on

## Open questions & answers

- Q: What is the fallback policy? — **OPEN, and the substance of this ticket.** Constraint:
  never silently contradict the privacy claim. Leaning "fail honestly and keep the frame",
  with recorded provenance if wave 04 ticket 0003 has landed.
- Q: Should provenance be persisted per detection? — OPEN. Valuable beyond this ticket — a
  scan mixing server and on-device detections is otherwise opaque, and wave 04 would have
  been diagnosed faster with it. Must extend existing types per ADR 0001, not add a parallel
  record.
- Q: How is the control presented on a device that cannot run it — missing, or disabled with
  a reason? — OPEN. Depends on 0003's capability check. Disabled-with-reason is more useful
  than absent, provided the reason is specific ("this browser has no WebGPU" /
  "model not downloaded").
- Q: Does the toggle expose the provisioning state from 0002? — OPEN. Probably yes:
  "On-device (2.2 GB download required)" is more honest than a control that silently
  triggers a large transfer.

## Files impacted

Changed:
- `src/ui/panel.ts` — un-gate, and present capability/provisioning state
- `src/inference/router.ts` — unified fallback policy across both branches
- `src/main.ts` — restored and extended failure copy
- `README.md:148` — the opt-in is real again
- `docs/factory/atlas.html:353` — describes what shipped

Possibly:
- `src/world/types.ts` / `src/inference/prompt.ts` — provenance, if adopted

## Schema required

Only if provenance is adopted. In that case: a single field on the existing detection or
capture record naming the engine that produced it. Extends existing types; no new store, no
new database, no rename.

## Definition of Done

- [ ] The toggle is selectable again where the device supports it
- [ ] A stored `webgpu` preference from before wave 04's gate is honoured
- [ ] **No path sends an image to the server while the UI claims on-device** — including the
      pre-existing timeout fallback
- [ ] A device that cannot run on-device inference says so specifically
- [ ] The failure path preserves the capture (with wave 04 ticket 0003) rather than losing it
- [ ] `atlas.html:353` and `README.md:148` describe what shipped
- [ ] `npx tsc --noEmit` and `npm run verify` pass

## Tests

- [ ] On-device: select on-device, capture, confirm no server request in the network panel
- [ ] Force a local failure; confirm the behaviour matches the chosen policy and that no
      image is uploaded without the user knowing
- [ ] A profile with a pre-gate `webgpu` preference returns to on-device
- [ ] A device without WebGPU shows a specific reason
- [ ] `npm run verify`

## Acceptance Criteria

- [ ] Given a capable, provisioned device, When the user selects on-device and captures,
      Then inference runs locally and nothing leaves the device
- [ ] Given on-device inference fails, Then the user learns it failed and the image is not
      uploaded without their knowledge
- [ ] Given an incapable device, Then the control explains why rather than failing on use
- [ ] Given the wave 04 gate, Then this ticket reverses it rather than reimplementing it

## Risks / potential issues

- **Risk:** The fallback policy is decided for convenience and reintroduces the silent-upload
  problem. — **Mitigation:** It is the Definition of Done's emphasised item, and it covers
  the pre-existing timeout branch, not only the new one.
- **Risk:** On-device is slow enough that users enable it, get frustrated, and disable it —
  having paid 2.2 GB. — **Mitigation:** Surface 0003's measured latency at the point of
  choice, alongside the download size.
- **Risk:** Provenance is added as a parallel record rather than extending existing types. —
  **Mitigation:** Called out in Pinned conventions; ADR 0001 governs.
- **Risk:** The gate is reversed before 0003's device measurements justify it. —
  **Mitigation:** Dependency is explicit; 0003's figures are Before-implementation reading.

## Subtasks

1. [ ] Decide the fallback policy against the constraint that it must never lie
2. [ ] Decide whether provenance is persisted, and if so extend existing types
3. [ ] Apply the policy to **both** router branches
4. [ ] Un-gate the toggle; restore the `infer-mode` interpretation
5. [ ] Present capability and provisioning state on the control
6. [ ] Restore and extend the HUD failure copy
7. [ ] Update `atlas.html:353` and `README.md:148`
8. [ ] Verify on-device, including the network-panel check
