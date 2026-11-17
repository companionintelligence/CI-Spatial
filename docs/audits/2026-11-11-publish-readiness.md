# Publish readiness: CI-Spatial (Companion Scan), 2026-11-11

Scope: every server, client, AR, viewer, native-shell, build, legal and tooling area (16 areas). Method: one mapper per area, two independent finders per area (correctness; security, privacy and UX), adversarial skeptics for every blocker, high and medium candidate, then a completeness critic. The audit was read-only: no tests, no type checks and no HTTP requests were run.

Numbers: 306 candidate findings, 122 kept after verification (20 blocker, 61 high, 38 medium, 3 low), 184 refuted. The synthesis agent failed (its prompt was too large), so the synthesis below was written by hand from the verified findings and the critic's corrections. Finding IDs (F1 to F122) refer to the kept list in the appendix.

## 1. Verdict

| Platform | Verdict | Why |
| --- | --- | --- |
| Web | Not ready | The server is open by default. Anonymous reads, writes and delete-all are reachable. No privacy policy or consent step. The licence blocks paid use. The public site has no backend. |
| iOS (Capacitor) | Not ready | Every web blocker applies. No ARKit provider. No PrivacyInfo.xcprivacy. Shell links point to a route the bundle lacks. The session token sits in WebView storage and in URLs. 8th Wall in the WebView is unverified on device. |
| Android (Capacitor) | Not ready | Every web blocker applies. The release resources step fails (colour values undefined). versionCode is fixed at 1. Backup is enabled. No ARCore provider. One device of AR evidence, and it is the XREAL Beam Pro. |

Two facts are still unknown and change the verdicts: the hosting topology (tailnet-only or public) and whether production runs with sign-in. The critic's first two follow-ups settle the second.

## 2. Blockers (20 kept)

**A. Open by default (10).** F1, F2, F9, F10, F17, F27, F37, F38, F45, F103. Without sign-in or SCAN_REQUIRE_AUTH, the server binds 0.0.0.0 and accepts anonymous reads of sessions, clips and world data, anonymous world writes, anonymous /infer and job queueing, and an unauthenticated `DELETE /scans?confirm=delete-all`. Root cause is one default. Decision 1.

**B. Privacy and consent with no policy (7).** F39, F46, F52, F70, F89, F104, F111. Precise location and street address leave the device with no disclosure. Person and room-stream capture start without consent. No privacy policy, no PrivacyInfo.xcprivacy and no store data-safety answers exist. Decisions 4 and 5.

**C. Licence (1).** F102. The bundled public/xr.js carries a PolyForm Noncommercial restriction. The critic narrows it: the restriction applies only where a product is offered for a fee and its value derives substantially from the engine. A free beta may be allowed. A paid or commercial listing needs permission or a different engine. This needs counsel, not a code change. Decision 3.

**D. Person capture (1).** F118. The GVHMR model stage is non-commercial and runs off-box, not in the image. Hide person capture in store builds until it is licensed or replaced. Decision 6.

**E. 8th Wall marker placement (1).** F51. The resolver maps bbox centres through a cover crop, but the 8th Wall camera fit defaults to contain. Markers land off-target under contain. This is the likely cause of the alignment you saw. Fixed in wave 1 (package C). Needs a phone re-test.

## 3. Wave 1: fixes made in this pass

Seven packages, each with disjoint file ownership, each implemented by one agent and then reviewed by a second agent against the same findings. Section 11 has the outcome.

| Package | Scope | Findings |
| --- | --- | --- |
| A | Server request hygiene: token-free logs, body caps, client-log limiter, CORS allowlist, projects registry safety, range span cap, prune guard, label-only positions, session-id collisions | F4, F5, F7, F8, F11, F13, F16, F18, F20, F21, F24, F26, F30 (logging half), F35, F40, F43, F44, F91, F110 |
| A2 | Job runners: subprocess deadlines and kills, migration backups, SenseNova bash lookup, LingBot quality verdict | F12, F23, F25, F29, F32, F33, F36 |
| B | Scanner UI: tappable export links, shell links, escaped HTML sinks, double-tap recorder, live-scan reset on clear, confirmed history delete, zero-pose captures, 8th Wall load message, accurate captions | F30 (caption half), F49, F55, F57, F59, F61, F65, F66, F69, F71, F72, F73, F74, F75, F76, F77, F78, F90, F94, F100 |
| C | AR and capture accuracy: per-provider coordinate contract, keyframe tracking gate, keyframe state machine, camera-denial verdict, WebXR session end, WebGPU adapter check, GLB size estimates, shell camera copy | F47, F48, F50, F51, F58, F63, F64, F68 |
| D | Viewer: visible save failures, stale world loads, orbit-drag clicks, picking through point clouds, truthful revocation copy | F79, F80, F82, F84, F85, F88 |
| E | Geolocation and shell: address cleared across Places, Android colour resources, compare-and-clear shell token, signed-out status copy | F93, F99, F101, F117 |
| F | osmo-ble developer tool: stop motors before disconnect, one motion interlock, no token to arbitrary hosts | F119, F120, F121, F122 |

Not changed in wave 1: anything that depends on a decision in section 7, and anything that needs a device, Xcode or the Android SDK to verify.

## 4. High and medium findings left for later

Each is in the appendix with its status. The main groups:

- Privacy and consent copy and flows (F22, F62, F113, F116): depend on decisions 4 and 5.
- Data deletion (F56): needs a server cascade for a scan and for a Place, plus a single IndexedDB transaction.
- Native shell (F95, F96, F97, F98, F106, F92): need plugins (Keychain, Keystore, Filesystem, Share), a model-delivery decision, and native AR.
- Viewer performance (F83, F86) and CSP (F87): untested, and a CSP can break inline scripts, so it needs its own change.
- Thing matching (F28, F31, F54): changes stored label and placement semantics, so it needs a migration decision.
- Handedness (F53): the compass convention was derived by hand and has not been checked on a device.
- AR session wiring (F60): main.ts end, restart and resume handling. Only the provider-side part is in wave 1.
- Test health (F108, F109, F105): pinning models, the lingbot gate, and running as root in the container.

## 5. Real problems the kept list dropped

The critic found these in the maps or the code. None is in the kept list, so none is in a wave package unless noted.

- Errors look like an empty library: server/main.ts:735-737 returns `[]` with status 200 on any listing error.
- Offline scan uploads can be evicted: public/sw.js:81-82 caps the queue at 24 items and 24 hours. The comment at :72 calls eviction "real data loss".
- Placeholder jobs report success: server/main.ts:3365-3392 marks some job types completed without doing their work.
- A merge retry can leave scans pointing at a deleted source: server/main.ts:5915 and :5977.
- The timeout chain can reach about 75 s on the server, while the client aborts at 70 s (src/inference/server.ts:17).
- The public web site has no backend: docs/operations/DEPLOY.md:95-99. A public web release needs a deployed API, which conflicts with tailnet-only hosting (decision 2).
- The Docker image does not reproduce on-device inference: a clean checkout has no ORT WASM (Dockerfile:11 and :27, package.json:45).
- The pre-push gate is opt-in (.githooks), and both CI workflows are manual only (deno-ci.yml:34, docker-publish.yml:24).
- Forwarded-host trust feeds share links (server/main.ts:2970-2977). Ollama model substitution has no vision check (src/shared/ollama-model.ts:67).

## 6. Corrections to kept findings (from the critic)

- F41 is not reproduced. The write routes check authorization first. POST /worlds is the exception, and it is F10.
- F28 misstates the server rule. The server merge radius is 0.75 m (server/thing_match.ts:3). The 0.4 m figure is the client dedup radius (src/spatial/resolver.ts:27).
- F47 is half stale. Point accumulation is already gated (src/main.ts:1521-1522). The keyframe path was not, and wave 1 fixes it.
- F84 is half refuted. Gizmo drags are already excluded (src/viewer/viewer.ts:367). Orbit-drag clicks remain, and wave 1 fixes them.
- F95 overstates. A pagehide teardown exists (src/main.ts:1364). What is missing is native lifecycle code.
- F96 is conditional. public/models is not in this checkout, and the size figures disagree (1.5 GB and 2.2 GB).
- F102 is overstated. See blocker C.
- F118 runs off-box. See blocker D.
- F119 to F122 are developer-tool risks on the operator box, not shipped-product blockers. Wave 1 fixes them anyway, because they can move a gimbal.
- F59 was unverified: capture waits 2.5 s and then continues. Wave 1 checks the path before it changes anything.
- F32 is confirmed: Deno.stat does no PATH lookup.
- F13, F20 and F91 are confirmed: the pinned Hono logger writes the full URL, query included.
- F3, F19 and F40 are confirmed: Hono's literal `use('/worlds')` guards only the exact path, so world reads stay anonymous with sign-in on.
- F82 is confirmed: no code path sets revokedAt, so the caption was false.
- Duplicates inflate the blocker count: F73/F76, F72/F77, F7/F110, F92/F106, and the root-cause groups in section 2.

## 7. Decisions needed from you

1. **Auth posture (blocks web and both shells).** Recommendation: fail closed. Refuse to listen on a non-loopback address without sign-in or an explicit ALLOW_ANONYMOUS=1. Your phone-test environment would set that flag, so testing keeps working.
2. **Hosting.** Recommendation: a tailnet-only beta first. Store builds need a reachable server, so decide before the store step. A public API needs decision 1 as well.
3. **Licence (public/xr.js).** Options: written permission covering store distribution; replace the engine (WebXR on Android Chrome, native ARKit and ARCore in the shells); or keep to a free, non-commercial beta. Recommendation: get counsel's view now, and do not submit a paid listing until it is settled.
4. **Privacy defaults.** Recommendation: a policy at a stable URL. Save on device by default, with uploads as an opt-in. Location as an explicit step with "Scan without location". Consent before person capture, plus a short bystander notice. These defaults change what the app uploads, so confirm them.
5. **Person capture in store builds.** Recommendation: hide it until the model stage is licensed or replaced.
6. **Store accounts and bundle ID.** The bundle ID com.companionintelligence.scan is provisional. The Apple Developer and Google Play accounts are yours to create.
7. **AR backend order.** Recommendation: the first store build uses WebView with 8th Wall, plus WebXR on Android Chrome, both verified on named devices. ARKit (needs macOS) and ARCore (needs the Android SDK) follow as Capacitor plugins.
8. **Minimum OS.** iOS 16.4 is set. Android minSdk is not set. Choose it against the devices you test on (the Android test device runs Android 14).
9. **Subsystems.** Recommendation: osmo-ble and 4d-capture stay out of the apps. The Docker image and the shells already exclude them.
10. **Repo history.** Five real-camera PNGs in public/real-camera-artifacts show a home interior and a legible street address. They are tracked and served from the built site. Removing them from history needs a force-push (git filter-repo). Look at them first.
11. **Browser specs.** No Playwright spec ran in this audit or in wave 1. Recommendation: run them on an isolated instance (a separate port and data directory), never against the phone-test services.

## 8. Native AR: ARKit and ARCore

- Present: none. No ARKit or ARCore provider or dependency exists. The grep hits are comments, tests and docs (F92, F106, confirmed).
- The shell's AR is the 8th Wall engine inside a WebView, and it is unverified on device. WebXR does not run inside the shell (mobile/README.md:10).
- The contract already exists: src/ar/ defines the pose, tracking-status and hit-test interface. A native backend implements that interface and nothing else.
- Smallest honest path: one Capacitor plugin per platform. Swift ARSession on iOS and Kotlin ARCore Session on Android. Each streams camera pose, tracking state and hit-test results to the web scanner over a message bridge. The web scanner gates its AR path on the bridge. Each plugin is verified on named devices and recorded in docs/operations/AR_DEVICE_SUPPORT.md. The audit estimates this at effort L.
- Cannot be built here: no Xcode or macOS, and no Android SDK, Gradle or adb on this machine.

## 9. UI consolidation

- The synthesis that would have proposed the control merges and the icon map did not complete. The scanner map says the icon plan is a proposal and was not verified on a rendered page.
- Wave 1 changes the controls that are broken rather than redesigning them: export links become tappable, glyph buttons get names, the tripod sheet gets 44 px targets and focus handling, and status copy is shortened.
- The concise icon-led pass you asked for is a separate follow-up. It needs one owner for index.html and src/ui/icons.ts, and it can be verified by type checks and reading only, because no browser run is allowed yet (decision 11). Check it on your phone.

## 10. Test and verification status

- The audit ran no tests. The newest recorded baseline is 2026-11-02: 43 passed, 30 failed, 2 flaky, 32 skipped and 15 not run (docs/audits/2026-11-02-companion-scan-review.md).
- No test covers the route-guard matrix. Nothing in tests/ references WORLD_STRICT_AUTH, denyUnlessWorldRole, SCAN_REQUIRE_AUTH or sessionGuard.
- The verify chain in package.json is not run in CI. CI never runs Playwright (CLAUDE.md, deno-ci.yml).
- Wave 1 adds unit tests for its changes. Section 11 says which checks ran and what they returned.

## 11. Fix waves and final checks

Ten fix waves ran after the audit. Each wave split the work into packages with disjoint file ownership, gave each package one implementer, and gave each package one adversarial reviewer. Each review found real problems in the previous wave's work, and the next wave fixed them. Nothing is committed: every change is in the working tree.

| Wave | Scope | What the reviews found |
| --- | --- | --- |
| 1 | 7 packages; 67 findings fixed, 9 partly fixed | 17 blocking: unbounded bodies and logs, a WebGPU check that disabled the on-device toggle, an osmo-ble token regression, a camera verdict that claimed a permission problem, overlay writes into a new Place |
| 2 | 7 packages | A LingBot timeout erasing a degenerate verdict, reload copy hidden under the start screen, a GLB object id change that would orphan saved edits, store erase races |
| 3 | 8 packages | Cross-tab erase in the store, arc invalidation order in osmo-ble, the pairing trigger cap |
| 4 | 9 packages, including the icon-led UI pass | Rename treated as erase (frames deleted), a test gate broken by a reset reorder, viewer copy that promised a sign-in the server does not use |
| 5 | 9 packages | A rename followed by an erase; stale test pins |
| 6 | 3 packages | Lost updates from a channel-free re-key; a stale tab could overwrite renamed rows |
| 7 | 3 packages | Capture id reuse after Clear; start-screen words over budget with the boot help line |
| 8 | 3 packages | Capture-row writes not gated on the move; the summary count after Clear; the boot caveat dropped |
| 9 | 2 packages | Two writable scanner pages on one origin: fixed with a Web Locks writer role and a read-only store mode |
| 10 | 1 package, plus a lead fix | Upload and tripod wiring ran before the role decision; read-only tripod clears; the PWA queue flush; three broken test anchors |

### Final checks on the final working tree

- `npx tsc --noEmit`: exit 0.
- `npm run typecheck:tests`: exit 0.
- `deno task check`: exit 0.
- `deno task test`: 956 passed, 0 failed, 7 ignored.
- `npm run test:wave` (all wave-tagged node tests): 441 passed, 0 failed.
- `npm run verify` (the project's full gate): exit 0. Across 42 node test files, 1,124 passed and 0 failed, with no "not ok" lines. The Deno suite passed 956, and the LingBot Python tests passed 10 of 10.
- `npm run build`: exit 0. The viewer bundle is 5.1 MB (1.8 MB gzipped).
- Services restarted: `cscan-server` is healthy with the model ready, and `cscan-web` is serving on port 5173.

### Not verified

- **Browser behaviour.** The Playwright specs were not run, as instructed. Nothing was checked in a browser or on a phone: the start screen at 320 to 430 px, the rail captions, the Details button, the read-only notice, or the 8th Wall marker alignment.
- **Native shells.** There is no Xcode and no Android SDK on this machine, so the Capacitor shells were not built.
- **Store across real browsers.** The store tests use a hand-written IndexedDB fake.
- **osmo-ble.** No hardware was used.

### Known residual items (not fixed)

- Browsers without the Web Locks API run every page as a writer. A reloaded page may briefly see the old page's lock. Neither case was checked in a browser.
- A read-only tab boots with an empty scanner, and it cannot Clear or delete sessions. Saving a drawer edit after a load on a read-only tab resolves silently, because the store refuses it.
- A frame written by a tab that has not yet heard of another tab's erase can stay under the erased id until the next erase or open.
- A writable page may release earlier sessions' frames under the byte budget. The single-writer lock covers the cross-page case, but there is no per-session lease.
- The 1.5 GB default photo cap is read into memory by the upload route. Streaming is needed before this is a store build.
- The viewer bundle is 5.1 MB (1.8 MB gzipped). Code splitting is needed before a store listing.
- The start screen is near its 142-word ceiling on native-advertised devices. A browser check is needed.
- Some Playwright specs still use older labels. They were updated only where a change was named, and none was run.
- Export summary and the glTF scan name still read the empty erased session id.

Section 7 still has eleven open decisions. The most recent one is whether a second scanner tab should stay read-only, which is the current behaviour, or take over the writer role.


## Appendix: kept findings

Generated from the audit's kept list. Status reflects wave 1, the first implementer pass. Review-driven fixes in waves 2 to 10 are summarised in section 11. Items marked "decision" wait on section 7. Items marked "follow-up" are real but were not in any fix package.

| ID | Severity | Platforms | Finding | Location | Status |
|---|---|---|---|---|---|
| F1 | blocker | server, web, ios, android | Open by default: no sign-in gate unless configured, and the server binds all interfaces | server/main.ts:383 | decision (section 7) |
| F2 | blocker | server, web, ios, android | World share links hand out every role token, and world writes accept anonymous callers while WORLD_STRICT_AUTH is unset | server/main.ts:5289 | decision (section 7) |
| F9 | blocker | server, web, ios, android | Every world and project write is anonymous by default, including jobs that push to CI-Server and drive GPU work | server/main.ts:5394 | decision (section 7) |
| F10 | blocker | server, web, ios, android | Tokenless writes are accepted by default, and POST /worlds has no auth | server/main.ts:3063 | decision (section 7) |
| F17 | blocker | server, web, ios, android | Default config leaves every data and write route open to any caller | server/main.ts:383 | decision (section 7) |
| F27 | blocker | server, web, ios, android | Anonymous /infer and world-job writes are open by default | server/main.ts:383 | decision (section 7) |
| F37 | blocker | server, web | Anonymous callers can edit, comment on and queue jobs in any world when strict is off | server/main.ts:5304 | decision (section 7) |
| F38 | blocker | server, web, ios, android | Open by default: no gate unless a switch is set, plain HTTP on all interfaces, and SCAN_REQUIRE_AUTH does not close world routes | server/main.ts:383 | decision (section 7) |
| F39 | blocker | ios, android, web, server | Precise location, addresses and emails leave the phone and the box with no in-app disclosure | src/geo/geo-tracker.ts:51 | decision (section 7) |
| F45 | blocker | server, web, ios, android | Capture sessions and person clips are readable without sign-in by default | server/main.ts:383 | decision (section 7) |
| F46 | blocker | web, ios, android | Person and room-stream capture start with no consent or disclosure | src/main.ts:1190 | decision (section 7) |
| F51 | blocker | 8thwall, ios, android | Resolver maps bbox centres with window cover-crop, which misplaces 8th Wall hit tests and ray fallbacks under its default contain fit | src/spatial/resolver.ts:313 | fixed in wave 1 (C) |
| F52 | blocker | web, ios, android | Location and street address leave the device with no disclosure, consent step or privacy policy | src/main.ts:502 | decision (section 7) |
| F70 | blocker | ios, android | No privacy policy, privacy manifest or data-safety disclosure before submission | src/geo/geo-tracker.ts:51 | decision (section 7) |
| F89 | blocker | ios, android, web | No privacy policy, no privacy manifest, and undisclosed location, map and font data flows | mobile/README.md:91 | decision (section 7) |
| F102 | blocker | web, container, ios, android | Niantic XR Engine binaries ship in every artefact under a licence that bars paid use | public/xr.js:11 | decision (section 7) |
| F103 | blocker | container, web, ios, android | Anonymous, unauthenticated API by default in the shipped container, with a developer tailnet fallback | server/main.ts:227 | decision (section 7) |
| F104 | blocker | ios, android, web | No privacy policy, privacy manifest or data-disclosure answers exist for the iOS or Android builds | mobile/README.md:91 | decision (section 7) |
| F111 | blocker | ios, android, web | No privacy policy, no store privacy declarations, and no in-app privacy link | mobile/README.md:90 | decision (section 7) |
| F118 | blocker | ios, android, web | Person capture ships with a non-commercial model stage and no bystander consent step | subsystems/4d-capture/README.md:55 | decision (section 7) |
| F3 | high | server, web, ios, android | With sign-in on, world reads, comments, patches and jobs stay anonymous, contradicting the sign-in promise | server/main.ts:391 | decision (section 7) |
| F4 | high | server, web, ios, android | Upload routes have no byte cap, chunked bodies skip the Content-Length checks, and the /client-logs limiter trusts a header the client sets | server/main.ts:651 | fixed in wave 1 (A) |
| F11 | high | server, web, ios, android | Project registry is overwritten on read error, and one partial PUT breaks every /projects route | server/main.ts:5673 | fixed in wave 1 (A) |
| F12 | high | server | No timeouts, cancel path or watchdog in the single-flight job path | server/person4d/person_4d.ts:209 | partly fixed in wave 1: Not done, all in main.ts or needing it: cancel route; sweeper for 'processing' jobs not matching the pump's in-flight id; retry with backoff on failWorldJob and claim writes; SIGTERM handling. Also needs main.ts to pass onDeadline and to thread the signal into the runners. Output-progress watchdog not done (wall-clock budgets only). Memory-push is not a wedge source of its own: its HTTP calls already carry AbortSignal.timeout (memory_push.ts:196, :989), and it is covered by the pump deadline. |
| F13 | high | server, web, ios, android | Bearer tokens in URLs are written to server logs by the request logger | server/main.ts:354 | fixed in wave 1 (A) |
| F14 | high | server, web, ios, android | Capture sessions, RGB keyframes and job payloads are readable anonymously by default | server/main.ts:1994 | decision (section 7) |
| F15 | high | ios, android, web, server | Person capture has no consent gate, and delete leaves keyframes and clips on disk | server/main.ts:887 | decision (section 7) |
| F18 | high | server, web, ios, android | Places registry is silently replaced by a default-only file after any read error | server/main.ts:5669 | fixed in wave 1 (A) |
| F19 | high | server, web, ios, android | World reads return GPS and scan data to anonymous callers, even with sign-in on | server/main.ts:5279 | decision (section 7) |
| F20 | high | server, web, ios, android | Capability tokens are written to server logs and browser history, and they never expire or revoke | server/main.ts:354 | fixed in wave 1 (A) |
| F21 | high | server | Anonymous upload routes buffer unlimited bodies, and the log rate limit trusts a spoofable header | server/main.ts:636 | fixed in wave 1 (A) |
| F22 | high | web, ios, android, server | Person capture records identifiable people with no consent step and keeps the clip indefinitely | index.html:3044 | decision (section 7) |
| F28 | high | server, web | Thing matching merges distinct same-label objects 0.4 to 0.75 m apart, and the Things inventory is built from those merged things | server/thing_match.ts:55 | follow-up |
| F29 | high | server | No WorldJob subprocess has a timeout or kill, and one hang blocks every world job until restart | server/world/world_job_pump.ts:66 | partly fixed in wave 1: The pump deadline alone kills no child. The abort reaches a runner only once main.ts passes the signal down. The /infer ONNX backlog (stamp enqueue time, skip calls already answered with 504) is in main.ts and inference.ts, not owned. Severity not changed; the skeptic rated it high-overstated. |
| F30 | high | web, ios, android | Server mode sends room photos with no disclosure, and logs what the model says | src/ui/panel.ts:356 | fixed in wave 1 (A, B) |
| F33 | high | all | LingBot ok has no quality verdict, so a collapsed reconstruction reads as success | server/lingbot-map/lingbot_map.ts:247 | partly fixed in wave 1: Consumers in main.ts (the detection input and the cloud route) were not checked or changed; main.ts is not owned. Thresholds are untuned by design, so the verdict is conservative rather than calibrated. |
| F34 | high | server | Sign-in is off by default, so person clips, scans and destructive routes are open to any client that reaches port 8000 | server/main.ts:383 | decision (section 7) |
| F35 | high | server | Upload routes have no body cap when Content-Length is absent, and keyframe posts append without limit | server/main.ts:993 | fixed in wave 1 (A) |
| F36 | high | server | No timeout or output cap on pipeline subprocesses or person-4D fetches, so one hung job stalls every world | server/world/world_job_pump.ts:55 | partly fixed in wave 1: Output is still buffered whole by output(); the capped log file is a separate change. The node spawns in main.ts (about lines 1564 and 1880) are unbounded and need the same helper in main.ts. The fresh=1 single-flight and per-client rate limit are in main.ts's route. |
| F40 | high | server | SCAN_REQUIRE_AUTH=1 does not gate world write routes | server/main.ts:227 | fixed in wave 1 (A) |
| F41 | high | server | World routes write a new world file before checking authorization | server/main.ts:5281 | not reproduced (critic) |
| F42 | high | server, web, ios, android | Anonymous callers can read scan locations and world geometry, and create world files for any slug | server/main.ts:2106 | decision (section 7) |
| F47 | high | 8thwall, ios-safari, android-chrome | Keyframes, pose history and auto-capture accept LIMITED or INITIALIZING poses that the point cloud rejects | src/ar/eighthwall.ts:1005 | fixed in wave 1 (C) |
| F53 | high | webxr, 8thwall | Compass frames use a left-handed ENU convention and the wrong camera-yaw sign for right-handed WebXR and 8th Wall sessions, mirroring east and west | src/world/geo.ts:194 | follow-up |
| F54 | high | webxr, 8thwall | Hit-test misses are stored as ordinary detections at a fixed 2 m depth, and later real hits cannot correct them | src/spatial/resolver.ts:421 | follow-up |
| F55 | high | web, ios, android | Server report text is set as innerHTML, and model labels reach it unescaped | src/main.ts:4295 | fixed in wave 1 (B) |
| F56 | high | web, ios, android | Deleting does not delete: Place photos are orphaned, most server data has no delete route, and deleted sessions return | src/project/project-store.ts:150 | follow-up |
| F57 | high | web, ios, android | Destructive one-tap controls have glyph-only names, and session delete has no confirmation | src/ui/history.ts:129 | fixed in wave 1 (B) |
| F59 | high | web (8th Wall), web (WebXR) | Capture before tracking stores a zero pose and places detections at the origin | src/main.ts:724 | fixed in wave 1 (B) |
| F60 | high | web-8thwall, web-webxr, ios, android | AR session has no teardown, restart, end or resume handling | src/main.ts:343 | follow-up |
| F61 | high | web, ios, android | Server output is injected into innerHTML without escaping, giving script execution in the app origin | src/main.ts:4295 | fixed in wave 1 (B) |
| F62 | high | web, ios, android | No privacy policy, consent step or data disclosure before camera and person capture | src/main.ts:1190 | decision (section 7) |
| F66 | high | web, ios, android | On-device note says no data leaves the phone, but every capture autosaves a scan upload | src/ui/panel.ts:356 | fixed in wave 1 (B) |
| F67 | high | web, ios, android | /infer and upload routes are unauthenticated unless sign-in or SCAN_REQUIRE_AUTH is set | server/main.ts:383 | decision (section 7) |
| F71 | high | ios, android, web, shell | Clear this scan, delete and load do not reset the live point cloud, so the next export uploads the cleared scan | src/ui/panel.ts:204 | fixed in wave 1 (B) |
| F72 | high | ios, android, web, shell | History delete removes a whole session on one tap, with no confirm and no error handling | src/ui/history.ts:133 | fixed in wave 1 (B) |
| F73 | high | ios, android, web, shell | HUD Download .glb and View in 3D links cannot be tapped | index.html:731 | fixed in wave 1 (B) |
| F74 | high | ios, android, web, shell | A second tap on Record a person starts a second recorder and orphans the first, which keeps recording | src/main.ts:1191 | fixed in wave 1 (B) |
| F75 | high | web, ios, android | Area names, scan results and map popups are inserted as raw HTML | src/main.ts:2068 | fixed in wave 1 (B) |
| F76 | high | web, ios, android | HUD View in 3D and Download .glb links cannot be tapped | index.html:731 | fixed in wave 1 (B) |
| F77 | high | web, ios, android | Session history delete removes a whole session on one tap with no confirmation | src/ui/history.ts:138 | fixed in wave 1 (B) |
| F79 | high | desktop-web | Patch saves fail silently, so tags, notes and transforms look applied and vanish on reload | src/viewer/viewer.ts:4386 | fixed in wave 1 (D) |
| F80 | high | desktop-web | Switching Places lets in-flight scan loads and stale world responses write into the new Place | src/viewer/viewer.ts:686 | fixed in wave 1 (D) |
| F81 | high | web, ios, android | Anonymous reads expose Place geolocation, review notes and job history | server/main.ts:5282 | decision (section 7) |
| F82 | high | web, ios, android | Share links never expire or revoke, but the QR caption says they can be revoked | src/viewer/viewer.ts:3579 | fixed in wave 1 (D) |
| F90 | high | ios, android | Shell links to /editor go to a route the bundle does not contain | index.html:2894 | fixed in wave 1 (B) |
| F91 | high | ios, android | Shell session token and OIDC codes are written to the server access log | server/main.ts:354 | fixed in wave 1 (A) |
| F92 | high | ios, android | No ARKit or ARCore backend exists; shell AR is the 8th Wall engine in a WebView and unverified | mobile/android/app/build.gradle:54 | decision (section 7) |
| F93 | high | android, ios | Android release likely fails on undefined colour resources; version codes are fixed and signing is silent | mobile/android/app/src/main/res/values/styles.xml:7 | partly fixed in wave 1: Remaining parts are outside this package or cannot be verified here. versionCode 1 and versionName '1.0' in build.gradle, and iOS CURRENT_PROJECT_VERSION = 1, need a CI counter or build argument. Signing needs bundleRelease to fail when keystore.properties is missing. The package says not to change versionCode or signing, and build.gradle is not an owned file. The headline 'release fails on undefined colours' is not reproduced: no Android SDK here, so processReleaseResources was not run. The skeptic note calls 'high' overstated; severity was not changed by me. |
| F105 | high | container | Container runs as root with broad Deno permissions and anonymous delete by default, and falls back to a developer's tailnet host | Dockerfile:35 | follow-up |
| F106 | high | ios, android | Native shells have no ARKit or ARCore backend and no store-ready version numbers | mobile/README.md:43 | decision (section 7) |
| F107 | high | web, container | Real-device screenshots with a home interior and a legible address, plus test pages, ship in the public bundle | public/real-camera-artifacts/beam-pro-1-after-tags.png:1 | decision (section 7) |
| F112 | high | server, web, ios, android | Scan API is open by default, and DELETE /scans?confirm=delete-all wipes all scans with no auth | server/main.ts:909 | decision (section 7) |
| F113 | high | web, ios, android | Every manual export and autosave uploads the scan with GPS, altitude and street address, with no consent step | src/main.ts:977 | decision (section 7) |
| F114 | high | web, server | Interior photos and a street-address screenshot are tracked in git and served from the built site | public/real-camera-artifacts/beam-pro-1-scan-camera.png:1 | decision (section 7) |
| F115 | high | web, docker, server | Scan and world data is open by default: no auth gate on data routes, unauthenticated delete-all, uncapped uploads | server/main.ts:383 | decision (section 7) |
| F116 | high | web, ios, android | Precise location and street address leave the device with no in-app disclosure; location is requested at boot | src/geo/geo-tracker.ts:92 | decision (section 7) |
| F119 | high | osmo-ble backend, osmo-ble web (backend mode), osmo-ble web (direct Web Bluetooth) | Disconnect and unpair drop the BLE link without stopping a latched gimbal | subsystems/osmo-ble/server/backend.mjs:989 | fixed in wave 1 (F) |
| F120 | high | osmo-ble backend | Motion interlock has holes: move-to and both test probes are ungated, and setMode and raw pass during a scan | subsystems/osmo-ble/server/backend.mjs:1088 | fixed in wave 1 (F) |
| F121 | high | osmo-ble backend | Stored phone tokens go to any host whose first DNS label matches a device, and to any URL when ANDROID_MCP_TOKEN is set | subsystems/osmo-ble/protocol/device_registry.mjs:192 | fixed in wave 1 (F) |
| F122 | high | server, web | Scan interlock is bypassed by move-to, raw, mode and test-probe routes, and disconnect leaves motors latched | subsystems/osmo-ble/server/backend.mjs:1088 | fixed in wave 1 (F) |
| F5 | medium | server, web, ios, android | Uploads and ingests buffer whole bodies before any cap; open-ended Range reads load the rest of a clip into memory | server/main.ts:636 | fixed in wave 1 (A) |
| F6 | medium | server, web, ios, android | Silent frame loss and duplication: walkthroughs stop at 300 frames, keyframes past index 1999 are refused, and retried keyframes append twice | scripts/ingest-video.mjs:59 | follow-up |
| F7 | medium | web, ios, android | Credentialed CORS trusts every *.ts.net origin, and the wildcard on GLB and splat responses bypasses the allowlist | server/origin.ts:33 | fixed in wave 1 (A) |
| F8 | medium | server, web, ios, android | Video ingest derives the session id from the upload's mtime, so two uploads in the same second share a session and overwrite each other | server/main.ts:1538 | fixed in wave 1 (A) |
| F16 | medium | server, web, ios, android | Label-only legacy scans get fabricated Thing positions up to about 1.9 km away | server/main.ts:3556 | fixed in wave 1 (A) |
| F23 | medium | server, web, ios, android | Subprocess runners have no timeout, so one hung child stops every queued job | server/world/world_job_pump.ts:66 | partly fixed in wave 1: optimize-scan in a Worker or subprocess, and the GLB size cap before readFile, are in main.ts (about line 4613), which this package may not edit. |
| F24 | medium | server, web | Prune guard counts scans from every Place, so one Place's manifest rows can be pruned | server/main.ts:2783 | fixed in wave 1 (A) |
| F25 | medium | server | migrate_scan_ids nulls session links when the sessions directory is missing, with no backup | server/migrations/migrate_scan_ids.ts:322 | partly fixed in wave 1: Dry-run as the default would change the CLI from write-by-default to a flag. The package guidance did not ask for it, so it is left as a decision (see followUps). Requiring an explicit SESSIONS_DIR is not done: the CLI now prints the resolved path, and its default matches main.ts. |
| F26 | medium | server | Places API accepts any body; a bad record breaks the registry, and a read error silently replaces it | server/main.ts:5794 | fixed in wave 1 (A) |
| F31 | medium | server, web | Thing labels are canonicalised by first word while capture labels use the last word, so the inventory shows wrong names | server/thing_match.ts:37 | follow-up |
| F32 | medium | server | SenseNova cannot start on Linux defaults, and recon3d and single-image tasks see only the opening frames | server/sensenova_vision.ts:50 | partly fixed in wave 1: Frame sampling (sessionImages takes the first N sorted names) is left alone: the even-spacing fix is more than one line, as the package guidance requires. The exact change is in followUps. The 400 for unknown task names needs a route in main.ts. main.ts:3966-3968 stores a skipped SenseNova result as 'completed'; that is a main.ts decision. |
| F43 | medium | server, web | /client-logs buffers unbounded bodies and never evicts rate-limit keys | server/main.ts:574 | fixed in wave 1 (A) |
| F44 | medium | server, web, ios, android | Range requests for bytes=0- allocate and return the whole clip | server/http_range.ts:163 | fixed in wave 1 (A) |
| F48 | medium | 8thwall, webxr, ios-safari, android-chrome | Keyframe streamer's active flag is false during start, stop and rotation, so a second session can open and cleanup is incomplete | src/capture/keyframes.ts:127 | fixed in wave 1 (C) |
| F49 | medium | web, ios, android | Tripod sheet is an aria-modal dialog with no focus handling and 36-40 px buttons | src/main.ts:3142 | fixed in wave 1 (B) |
| F50 | medium | ios, android | Camera-denied copy points to a per-site setting the native shell does not have | src/capture/sweep-cadence.ts:550 | fixed in wave 1 (C) |
| F58 | medium | web, ios, android | GLB detection boxes carry fabricated metric sizes with no estimate flag, and the viewer prints them in metres | src/export/gltf.ts:328 | fixed in wave 1 (C) |
| F63 | medium | iOS Safari (8th Wall), Android Chrome (8th Wall) | A denied or never-answered camera prompt on 8th Wall produces no verdict and blames the lens | src/ar/eighthwall.ts:638 | fixed in wave 1 (C) |
| F64 | medium | Android Chrome (WebXR with ARCore), WebXR headsets | WebXR session end and failed starts are never torn down, so the page keeps reporting tracking | src/ar/webxr.ts:622 | fixed in wave 1 (C) |
| F65 | medium | iOS Safari, Android Chrome | A 20 s wait for the 8th Wall engine falls back to a false 'AR not available' on slow links | src/main.ts:641 | fixed in wave 1 (B) |
| F68 | medium | web, android, ios | WebGPU gate checks navigator.gpu presence, not a usable adapter | src/inference/router.ts:96 | fixed in wave 1 (C) |
| F69 | medium | web, ios, android | After reload the panel shows Server while on-device is active | src/main.ts:559 | fixed in wave 1 (B) |
| F78 | medium | ios, android, web | Side-panel label edits are wiped by any capture or tap | src/ui/panel.ts:462 | fixed in wave 1 (B) |
| F83 | medium | desktop-web | World load waits for every scan GLB before framing, and no request has a timeout | src/viewer/viewer.ts:722 | follow-up |
| F84 | medium | desktop-web | The canvas click handler runs pick and measure after every orbit or gizmo drag | src/viewer/viewer.ts:366 | fixed in wave 1 (D) |
| F85 | medium | desktop-web | Clicking a semantic object behind a point cloud or the gizmo clears the selection instead of picking it | src/viewer/editor.ts:189 | fixed in wave 1 (D) |
| F86 | medium | desktop-web | Point-cloud LOD is keyed to the whole cloud's centre, so large scans lose detail next to the camera | src/viewer/viewer.ts:505 | follow-up |
| F87 | medium | web, ios, android | No CSP, framing or referrer policy on any served page | viewer.html:4 | follow-up |
| F88 | medium | web, ios, android | Failed saves are silent, and 'Save Tags' reports success for one object | src/viewer/viewer.ts:4386 | fixed in wave 1 (D) |
| F94 | medium | ios, android, web | 'View in 3D' after export is hard-wired to world=default, which usually excludes the Place scan just exported | index.html:2950 | fixed in wave 1 (B) |
| F95 | medium | android, ios | Android Back and app suspension skip the unsaved-scan guard, and the shell has no pause or resume handling | src/main.ts:1385 | follow-up |
| F96 | medium | ios, android | On-device model paths are root-relative, so the shell reaches the bundle rather than the server, and a normal build can embed about 2.2 GB | src/inference/model-provisioning.ts:84 | follow-up |
| F97 | medium | ios, android | Shell keeps the 7-day token in WebView localStorage, with no CSP and Android auto-backup on | src/shared/shell-sign-in.ts:122 | follow-up |
| F98 | medium | ios, android | Shell export puts the 7-day token in a download href; Android Back can drop an unsaved scan | src/main.ts:1923 | follow-up |
| F108 | medium | web, container | Detection models are fetched without a pinned revision or checksum, and no real-corpus baseline is committed | download_models.py:42 | follow-up |
| F109 | medium | server | LingBot-Map PLY-to-GLB test is wired to no gate, so the point-cloud sidecar path is ungated | package.json:13 | follow-up |
| F110 | medium | web, container | CORS trusts every *.ts.net host, and the scan file routes send a wildcard origin | server/origin.ts:33 | fixed in wave 1 (A) |
| F117 | medium | web, ios, android | Reverse geocoding can attach the previous room's address to a new scan and sends every new location to OpenStreetMap | src/geo/geo-tracker.ts:143 | partly fixed in wave 1: The in-app disclosure of the OpenStreetMap lookup needs copy in files I do not own and a product or privacy decision on wording. 'Use a coarser lookup key or a self-hosted geocoder' is a privacy and provider decision, which the package rules out. The lookup still sends six-decimal coordinates on each new cell, unchanged. |
| F99 | low | ios, android | Token save failure is reported as success, and a stale 401 can erase a token that a newer sign-in just stored | src/shared/shell-sign-in.ts:122 | fixed in wave 1 (E) |
| F100 | low | ios, android | Reference-photo fallback fetches a root-relative URL, so it fails silently in the shell | src/main.ts:1630 | fixed in wave 1 (B) |
| F101 | low | ios, android | Signed-out shell reports Companion Memory as 'Status unavailable' because /memory/status is session-guarded | src/ui/ftue-status.ts:72 | fixed in wave 1 (E) |
