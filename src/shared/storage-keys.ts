/**
 * Central declarations for every browser-storage key this app uses:
 * localStorage keys, a sessionStorage key, IndexedDB database names, and the
 * service worker's Cache Storage bucket name + Background Sync tag.
 *
 * ADR 0001 (docs/adr/0001-reuse-existing-domain-model.md), "reuse, don't
 * duplicate": one declaration per key, everything else imports it. Before
 * this file existed, each of these was a per-file literal, re-typed again in
 * Playwright tests — the reuse violation this module fixes.
 *
 * EVERY VALUE BELOW IS FROZEN FOREVER. They name persisted user data
 * (IndexedDB scan sessions, the offline upload queue, FTUE onboarding
 * state, in-flight geo state) or a service-worker contract. Renaming any of
 * them silently orphans existing users' data under the old key instead of
 * erroring — see each constant's comment for the specific consequence, and
 * CLAUDE.md's "Do not rename" registry for the subset already documented
 * there (the IndexedDB DB name, the geo-fix session key, the onboarding
 * key, and the service-worker cache/queue/sync names all appear in both
 * places).
 *
 * `public/sw.js` and `public/test-fixtures/xr8-mock.js` cannot import this
 * module — both are classic (non-module) scripts loaded via a plain
 * `<script>` tag / `navigator.serviceWorker.register()`. They keep their own
 * literals plus a comment pointing back here; `sync.test.ts` (repo root)
 * reads them as text and asserts the literals haven't drifted from this
 * file.
 *
 * Runtime-agnostic: safe to import from src/ (Vite/browser) and tests/
 * (Playwright, already TypeScript). Not imported by Deno server code —
 * these are all browser-only storage keys.
 */

/**
 * localStorage key: arms the remote-log relay (installRemoteLog) when set
 * to '1' (or via `?debug=remote`). Read by src/debug/remote-log.ts.
 * Not persisted user data, but renaming it breaks remote-debugging for
 * anyone who already has the old key set — their console output silently
 * stops forwarding until they notice and re-arm under the new name.
 */
export const REMOTE_LOG_KEY = 'remote-log'

/**
 * localStorage key: the user's saved inference-path preference
 * ('server' | 'webgpu'). Read/written by src/inference/router.ts.
 * Renaming it silently resets every existing user back to the default
 * server path on next load — not destructive, but a surprising regression
 * of a saved preference.
 */
export const INFER_MODE_KEY = 'infer-mode'

/**
 * localStorage key: marks the FTUE onboarding overlay as already shown.
 * Read/written by src/main.ts. Do not rename — every existing user would
 * see the onboarding flow again on next launch. (CLAUDE.md "Do not
 * rename".)
 */
export const ONBOARDING_KEY = 'companion-scan-onboarded'

/**
 * sessionStorage key: caches the most recent GeoTracker fix so a page
 * reload mid-session doesn't lose GPS/compass state. Read/written by
 * src/geo/geo-tracker.ts (there as `SESSION_KEY`). Do not rename — breaks
 * in-flight geo-anchoring state for any tab that already wrote the old key.
 * (CLAUDE.md "Do not rename".)
 */
export const GEO_FIX_SESSION_KEY = 'ci-xr-geo-fix'

/**
 * sessionStorage key: selected place for this scanner tab. A missing value
 * means "decide later" and exports use projectId:null.
 */
export const PLACE_SELECTION_SESSION_KEY = 'ci-xr-place-selection'

/**
 * IndexedDB database name for the scan-session store (detections keyed by
 * sessionId). Read/written by src/scene/store.ts. Do not rename — orphans
 * every existing user's persisted session data, since the browser opens a
 * fresh, empty database under the new name instead of finding the old one.
 * (CLAUDE.md "Do not rename".)
 */
export const SCAN_DB_NAME = 'ci-xr-scan'

/**
 * IndexedDB database name for the service worker's offline upload queue
 * (queued POST/PUT/PATCH requests awaiting network). Declared here for
 * src/pwa.ts and Playwright tests; public/sw.js keeps its own literal
 * (classic script, cannot import) — see the pointer comment there and
 * sync.test.ts. Do not rename — breaks the offline upload queue for anyone
 * with a stale service worker still installed; queued uploads become
 * unreachable under the new name. (CLAUDE.md "Do not rename".)
 */
export const OFFLINE_QUEUE_DB_NAME = 'companion-scan-offline-queue'

/**
 * Cache Storage bucket name for the service worker's app-shell cache.
 * public/sw.js keeps its own literal (classic script, cannot import);
 * sync.test.ts asserts it matches this constant. Grouped with the queue DB
 * name and sync tag in CLAUDE.md's "Do not rename" registry: renaming
 * breaks the offline upload queue for anyone with a stale service worker
 * still installed, the same way renaming the queue DB name does.
 */
export const SW_CACHE_NAME = 'companion-scan-v3'

/**
 * Background Sync tag used to flush the offline upload queue once
 * connectivity returns. Must stay byte-identical between public/sw.js
 * (registers it in `registerFlushSync()` and listens for it in the `sync`
 * event handler) and src/pwa.ts (also registers it, as a fallback trigger
 * alongside the `online` event listener). src/pwa.ts imports this constant;
 * public/sw.js keeps its own literal (classic script, cannot import) plus a
 * pointer comment, and sync.test.ts asserts all occurrences agree. Do not
 * rename — breaks the offline upload queue for anyone with a stale service
 * worker still installed. (CLAUDE.md "Do not rename".)
 */
export const SW_SYNC_TAG = 'companion-scan-flush'

/**
 * IndexedDB database name for the on-device model-weight cache — wave 05
 * ticket 0002 (docs/factory/05-on-device-inference/0002-browser-model-provisioning.md).
 * Read/written by src/inference/model-provisioning.ts. Brand new as of that
 * ticket, so nothing depends on the old name yet, but treat it as frozen the
 * same way as every other entry in this file from here on: renaming it later
 * would orphan a phone's already-downloaded 2.2 GB of weights under the old
 * database, forcing a silent, unannounced re-download.
 */
export const MODEL_CACHE_DB_NAME = 'companion-scan-model-cache'
