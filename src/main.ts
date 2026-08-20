/**
 * main.ts — application entry point.
 *
 * Boot sequence:
 *   1. Open IndexedDB store
 *   2. Mount UI (overlay + panel)
 *   3. Detect AR runtime (8th Wall OSS binary → WebXR fallback)
 *   4. Init inference router (WebGPU worker or Deno server path)
 *   5. Start AR session
 *   6. Wire capture button → infer → resolve → store → UI update loop
 *   7. Wire auto-capture toggle → pose-delta-based automated capture
 */
import { createEighthWallProvider } from './ar/eighthwall'
import { createWebXRProvider, WebXRProvider, isImmersiveARSupported } from './ar/webxr'
import type { ARProvider, Pose } from './ar/provider'
import { RoomScanner } from './ar/scanner'
import { PointCloud } from './scene/pointcloud'
import { CaptureModule } from './capture/capture'
import { AutoCapture } from './capture/auto-capture'
import { KeyframeStreamer } from './capture/keyframes'
import { ScanQualityMonitor, isFrameUnusable } from './capture/quality-monitor'
import type { FrameQuality } from './capture/quality-monitor'
import { InferenceRouter } from './inference/router'
import { InferServerError } from './inference/server'
import { resolveDetections, mergeDetections } from './spatial/resolver'
import { DetectionStore } from './scene/store'
import { ProjectStore } from './project/project-store'
import { AROverlay } from './ui/overlay'
import { SidePanel, type ExportOutcome } from './ui/panel'
import { SessionHistory } from './ui/history'
import { exportToGLB } from './export/gltf'
import { exportSessionSummary } from './export/summary'
import { GeoTracker, type GeoFix } from './geo/geo-tracker'
import { RtcBroadcaster } from './rtc/broadcaster'
import { registerPWA } from './pwa'
import { installRemoteLog } from './debug/remote-log'
import { iconLabel } from './ui/icons'
import { ONBOARDING_KEY } from './shared/storage-keys'
import * as THREE from 'three'

const CAPTURE_FRAME_TIMEOUT_MS = 8000
const TRACKING_WAIT_MS = 2500

// One-time HUD notices — module-level so repeated triggers stay quiet
let quotaWarningShown = false
let decimationNoticeShown = false

// Last verdict state written to the HUD, so the 750 ms scanner tick only
// touches the DOM when the verdict or its recommendation actually changes.
let lastVerdictKey: string | null = null

async function main() {
  const searchParams = new URLSearchParams(location.search)
  // Onboarding is skipped under mocks (so scan-flow tests don't stall on it) and
  // when explicitly disabled with ?onboarding=0. ?onboarding=1 forces it on even
  // under a mock runtime, so the FTUE overlay can be exercised in tests.
  const skipOnboarding = searchParams.get('onboarding') === '1'
    ? false
    : searchParams.has('mock') || searchParams.get('onboarding') === '0'

  // Remote log mirror — inert unless armed via ?debug=remote or localStorage
  installRemoteLog()

  // Walkthrough-video upload — a server-side path that needs no AR runtime or
  // secure context, so wire it before the isSecureContext bail-out below.
  wireVideoUpload()

  // Camera, WebXR, and IndexedDB all need a secure context; fail fast with
  // actionable guidance instead of a cascade of cryptic permission errors.
  if (!window.isSecureContext) {
    console.warn(`[main] Secure context (HTTPS) required. To test locally: tailscale cert ${location.hostname}`)
    const statusEl = document.getElementById('status-text')
    if (statusEl) statusEl.textContent = `This page must be opened over a secure HTTPS link — ask for the correct link`
    setStartButtonState('unavailable', 'Needs a secure (HTTPS) link')
    return
  }

  registerPWA()

  const canvas = document.getElementById('camerafeed') as HTMLCanvasElement
  const overlay = setupStatusOverlay()

  // ── 0. Start-AR gesture gate ────────────────────────────────────────────────
  // Wired here, at the top of the boot, even though AR itself only starts in
  // section 5. #start-ar-btn is in the static markup and paints in ~250ms,
  // while everything between here and section 5 is awaited work the button
  // does not need — IndexedDB stores, and above all the inference router's
  // model load. Registering the listener down there meant a tap in that
  // window (~6.5s, measured on a mobile-emulated run) reached no listener at
  // all: no feedback, start screen still up, nothing started.
  //
  // The handler is still the user gesture itself — a tap is never replayed or
  // synthesized later, only allowed to arrive earlier — so iOS Safari's rule
  // that DeviceOrientation/DeviceMotion requestPermission() be called
  // synchronously inside a real click handler still holds.
  //
  // A first-run visitor can't tap through the onboarding overlay to get here:
  // it covers the start screen and is dismissed before section 4b returns.
  const startBtn = document.getElementById('start-ar-btn') as HTMLButtonElement | null
  let startPressed = false
  const startArPressed = new Promise<void>((resolve) => {
    startBtn?.addEventListener('click', async () => {
      startPressed = true
      // ↓ Initiate BEFORE any await — this preserves the user-gesture context in Safari
      type PermAPI = { requestPermission?(): Promise<string> }
      const p1 = (DeviceOrientationEvent as unknown as PermAPI).requestPermission?.()
      const p2 = (DeviceMotionEvent as unknown as PermAPI).requestPermission?.()

      // Hide the start screen immediately
      document.getElementById('start-screen')?.remove()
      // Tapped before the boot reached section 5: say so, rather than leaving
      // the last boot status (e.g. "AI: WebGPU") on screen as if nothing happened.
      overlay.setStatus('Starting AR…')

      // Denial RESOLVES with the string 'denied' — it does not reject. The
      // promise rejects only when requestPermission() was called outside a
      // user gesture. Catching alone therefore never fired on the one case it
      // was written for: the user tapped "Don't Allow" and landed in a session
      // that never tracks, staring at "Move camera to initialise tracking…"
      // forever with nothing to explain it.
      //
      // On platforms without the API (Android, desktop) both are undefined,
      // there is nothing to grant, and the banner must stay down.
      const permissionChecks = [p1, p2].filter((p): p is Promise<string> => p !== undefined)
      const denialNotice = 'Enable motion & orientation access in Settings → Safari → Motion & Orientation Access.'
      try {
        const outcomes = await Promise.all(permissionChecks)
        const refused = outcomes.filter((outcome) => outcome !== 'granted')
        if (refused.length > 0) {
          console.warn(`[main] Motion/orientation permission ${refused.join('/')} — SLAM will not track`)
          showPermissionBanner(denialNotice)
        }
      } catch (err) {
        // A rejection is the other failure: requestPermission() reached outside
        // a genuine gesture, or the API itself errored. The user still ends up
        // without motion access, so they get the same guidance.
        console.warn('[main] Motion/orientation permission request failed — SLAM may not track', err)
        showPermissionBanner(denialNotice)
      }
      resolve()
    }, { once: true })
  })
  // The button ships `disabled aria-busy="true"` with a "Preparing…" line in
  // index.html, so it never advertises itself as pressable before this point —
  // the gap is now only the ~50ms until this line runs, plus the case where
  // the bundle never loads at all, where staying disabled is the honest state.
  // Enabling here rather than at section 5 is the whole fix: the handler above
  // is live, so the tap has somewhere to land.
  setStartButtonState('ready')

  // ── 1. Store + scan accumulators ────────────────────────────────────────────
  const store = new DetectionStore()
  await store.open()
  // Continue the last scan rather than silently starting empty. Without this a
  // reload lost every pin — the restore method existed but nothing called it,
  // so the only way back to a scan was the history drawer. Announced rather
  // than silent, so a resumed scan is never mistaken for a fresh one; "Clear
  // session" in the panel is the way to start over.
  const resumed = await store.resumeLatestSession()
  if (resumed > 0) {
    overlay.setStatus(`Resumed last scan — ${resumed} object${resumed === 1 ? '' : 's'}`)
  }
  void checkStorageQuota(store, overlay)
  const projectStore = new ProjectStore()
  await projectStore.open()
  const qualityMonitor = new ScanQualityMonitor()
  const geoTracker = new GeoTracker()
  const pointCloud = new PointCloud(0.05)   // 5 cm voxel deduplication grid
  const poseHistory: Pose[] = []
  const scanner = new RoomScanner()
  let captureCount = 0    // total captures this session, inferred or not
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
  let autoSaveInFlight = false
  let autoSaveQueued = false
  let captureInFlight = false
  let latestKeyframeCount = 0

  // Start geo tracker early (GPS needs time to acquire a fix)
  // Wire geo indicator chip immediately when first fix arrives
  geoTracker.onUpdate = (fix) => updateGeoIndicator(fix)
  void geoTracker.start().then((fix) => {
    if (fix) updateGeoIndicator(fix)
    if (fix?.address) overlay.setStatus(fix.address)
  })

  // ── 2. Inference router & early UI mounting (prevents test timeouts) ───────
  const router = new InferenceRouter()

  // Assigned once the AR provider exists; the export callback below runs on
  // user action, long after assignment.
  let keyframes: KeyframeStreamer | null = null

  const panel = new SidePanel(
    store,
    async () => {
      const { outcome, uploadedFilename } = await exportManualScan()
      // Nothing was written on a cancel or a failure, so there is no scan for
      // a fresh keyframe session to be linked against.
      if (outcome !== 'cancelled' && outcome !== 'failed' && keyframes?.active) {
        void keyframes.rotate({
          glbFilename: uploadedFilename,
          pointCount: pointCloud.count,
          detectionCount: store.detections.size,
          poseCount: poseHistory.length,
          qualitySummary: currentQualitySummary(),
        })
      }
      return outcome
    },
    () => exportSessionSummary({ store, pointCloud, poseHistory, captureCount, geoFix: geoTracker.snapshot() ?? undefined }),
    (action) => requestServerProcessing(action, store),
    (mode) => {
      router.setMode(mode)
      overlay.setStatus(`AI: ${mode === 'server' ? 'Server' : 'WebGPU'}`)
    },
    router.path,
  )
  panel.mount()

  const history = new SessionHistory(store)
  history.mount()

  // Deliberately no saveSnapshot() here. Persisting at boot wrote an empty
  // record on every page load, so the history drawer filled with "0 objects"
  // rows that buried the real scans. The first capture persists; until then
  // there is nothing worth storing.
  void checkStorageQuota(store, overlay)

  document.getElementById('history-btn')?.addEventListener('click', () => {
    void initDrawerGeoMap(geoTracker.snapshot())
  })

  await router.init(
    (stage, pct) => { overlay.setProgress(pct, stage) },
    (mode) => {
      overlay.setStatus(`AI: ${mode === 'server' ? 'Server' : 'WebGPU'}`)
      panel.updateInferMode(mode)
    },
  )
  overlay.setStatus(`AI: ${router.path === 'server' ? 'Server' : 'WebGPU'}`)

  // ── 3. AR runtime detection ────────────────────────────────────────────────
  let provider: ARProvider
  let use8thWall = false

  // Forced runtime: /webxr.html redirects here with ?ar=webxr — used in
  // WebXR-capable iOS browsers (e.g. HelloXR) where the native WebXR session
  // beats the 8th Wall SLAM fallback.  ?ar=8thwall forces the inverse.
  const forcedMode = searchParams.get('ar')

  // Test hook: ?mock=webxr installs the iwer emulation runtime (Meta's
  // immersive-web-emulator engine) so WebXR flows run in headless browsers.
  if (searchParams.get('mock') === 'webxr') {
    const emulation = await import('./test/webxr-emulation')
    await emulation.installWebXREmulation()
  }

  // XR8 global is set by xr.js (8th Wall OSS engine binary in public/xr.js).
  // If it's not present after a grace timeout we fall back to WebXR.
  // index.html skips loading xr.js entirely when ?ar=webxr is set.
  const xr8Available = forcedMode === 'webxr' ? false : await waitForXR8(3000)

  if (xr8Available) {
    try {
      provider = await createEighthWallProvider()
      use8thWall = true
      overlay.setStatus('8th Wall ready')
    } catch (e) {
      console.warn('[main] 8th Wall init failed, falling back to WebXR:', e)
      provider = await createWebXRProvider()
    }
  } else {
    try {
      provider = await createWebXRProvider()
      overlay.setStatus(forcedMode === 'webxr' ? 'WebXR ready (native AR session)' : 'WebXR ready')
    } catch (e) {
      overlay.setStatus(forcedMode === 'webxr'
        ? 'WebXR not available — on iOS open this page in HelloXR'
        : 'AR not available on this device')
      showArHelp()
      console.error('[main] No AR runtime available:', e)
      return
    }
  }
  // Only offer the WebXR toggle when it would actually work — no point
  // sending desktop/unsupported-browser users to a dead-end landing page.
  const webxrSupported = use8thWall ? await isImmersiveARSupported() : true
  updateXrModeLink(use8thWall, webxrSupported)

  // ── 4. AR Overlay & Capture setup ──────────────────────────────────────────
  keyframes = new KeyframeStreamer(provider)
  const arOverlay = new AROverlay(store, use8thWall, provider)
  const capture = new CaptureModule(provider)
  const asyncHitTest = !use8thWall && provider instanceof WebXRProvider
    ? (x: number, y: number) => (provider as WebXRProvider).hitTestAsync(x, y)
    : undefined

  // Shared capture handler used by both the manual button and auto-capture
  async function doCapture() {
    if (captureInFlight) {
      overlay.setStatus('Capture already processing...')
      return
    }

    captureInFlight = true
    setCaptureBusy(true)

    if (!provider.isTracking()) {
      overlay.setStatus('Tracking warming up...')
      const trackingReady = await waitForTracking(provider, TRACKING_WAIT_MS)
      if (!trackingReady) {
        overlay.setStatus('Capturing without stable tracking...')
      }
    }
    overlay.setStatus('Capturing next frame...')
    // Named before the try so the catch can reach them: the frame is stored by
    // then, and the failure path's job is to mark that record and decide whether
    // its image is worth holding — not to mourn it.
    let pendingCaptureId: string | null = null
    let frameQuality: Promise<FrameQuality> | null = null
    try {
      const { blob, pose, timestamp } = await capture.capture(CAPTURE_FRAME_TIMEOUT_MS)
      console.log(`[main] Captured blob: ${blob.size} bytes, type=${blob.type}, pose=`, pose)

      // Store the frame BEFORE anything is asked of it. The photograph is the
      // unrepeatable half of a capture — the user had to be standing there — and
      // inference is the cheap, retryable half. Ordered the other way round, a
      // failed detection took the frame, the pose and the timestamp down with it.
      // See docs/factory/04-capture-path-truthfulness/0003.
      //
      // captureCount advances here rather than after a successful inference, so a
      // capture whose detection fails still owns its index and the next capture
      // cannot collide with it.
      const captureIndex = ++captureCount
      pendingCaptureId = store.captureIdFor(captureIndex)
      // Not awaited: the write stays off the shutter's critical path, which
      // already has no flash, haptic or sound to cover latency
      // (docs/UI_MANUAL.md:169-176). It is reconciled before the detections land.
      const capturePersisted = store.putCapture({ captureIndex, timestamp, pose, blob })

      overlay.setStatus('Analysing…')

      // Show indeterminate analysis progress bar
      const progFill = document.getElementById('progress-bar-fill')
      const progWrap = document.getElementById('progress-bar-wrap')
      if (progFill) progFill.classList.add('analyzing')
      if (progWrap) progWrap.classList.add('visible')

      // Async frame quality analysis (non-blocking — updates overlay on next
      // tick). The promise is kept, not discarded, because the failure path below
      // needs its verdict to decide whether this frame is worth retaining.
      frameQuality = qualityMonitor.analyseFrame(blob)
      void frameQuality.then(({ lowLight, reflective }) => {
        updateQualityOverlay(qualityMonitor.tick(provider, pointCloud))
        if (lowLight)   overlay.setStatus('⚠ Low light — add more lighting')
        if (reflective) overlay.setStatus('⚠ Reflective surface detected')
      })

      const rawDets = await router.infer(blob)

      // Hide analysis bar once inference completes
      if (progFill) progFill.classList.remove('analyzing')
      if (progWrap) progWrap.classList.remove('visible')

      overlay.setStatus(`${rawDets.length} object${rawDets.length === 1 ? '' : 's'} detected`)

      // Snapshot a Three.js camera from the current SLAM pose for frustum raycasting.
      // This gives the resolver a proper projection matrix at the moment of capture.
      let captureCamera: THREE.PerspectiveCamera | undefined
      if (provider.isTracking()) {
        const p = provider.getPose()
        captureCamera = new THREE.PerspectiveCamera(
          provider.getCameraFovY(), provider.getCameraAspect(), 0.01, 1000,
        )
        captureCamera.position.set(p.position.x, p.position.y, p.position.z)
        captureCamera.quaternion.set(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w)
        captureCamera.updateMatrixWorld(true)
      }

      const worldDets = await resolveDetections(rawDets, timestamp, {
        provider,
        asyncHitTest,
        cameraPose: pose,
        captureCamera,
        pointCloud,
      })
      console.log(`[main] World detections (${worldDets.length}):`, JSON.stringify(worldDets))

      // Tag each resolved detection with the index its frame was stored under
      for (const wd of worldDets) wd.captureIndex = captureIndex

      // Build thumbnail map keyed by label (best-effort). Each object gets the
      // frame cropped to ITS OWN box — handing every row the same whole-frame
      // thumbnail (which is what this did) made the review panel look like a
      // list of duplicate images rather than a list of objects.
      const thumbMap = new Map<string, string>()
      const captureKeys = new Set<string>()
      for (const wd of worldDets) {
        const key = `${wd.label}:${bucket(wd.worldPos)}`
        captureKeys.add(key)
        if (thumbMap.has(key)) continue
        thumbMap.set(key, await capture.captureDetectionThumbnail(blob, wd.bbox))
      }

      const merged = mergeDetections(store.detections, worldDets)
      await store.upsert(merged, thumbMap)

      showInferDialog(worldDets)

      // Attach the detections to the record that already holds the frame, so the
      // success path ends with exactly one record per capture rather than two.
      await capturePersisted
      await store.attachDetections(pendingCaptureId, [...captureKeys])

      await store.saveSnapshot()
      void checkStorageQuota(store, overlay)
      queueAutoSave()
      overlay.setStatus(
        `${store.detections.size} object${store.detections.size === 1 ? '' : 's'} · ${pointCloud.count} pts`,
      )
    } catch (e) {
      clearAnalysisProgress()
      // The frame is already stored. Record why its inference failed and keep
      // it — that is what makes a failure cost a label instead of the
      // photograph. Null only when capture.capture() itself threw, in which
      // case there is no frame to keep. Status is set synchronously, so the
      // record is correct before the HUD copy below runs.
      if (pendingCaptureId) {
        const id = pendingCaptureId
        void store.markCaptureFailed(id, e instanceof Error ? e.message : String(e))
        // Retaining the frame is only worth it when the frame is the good half of
        // the capture. A server or engine error leaves a perfectly readable
        // photograph that re-inference can still use; a frame the quality monitor
        // flagged will read no better on a second pass, so its image goes and only
        // the record stays. This is correlation, not proven cause — a dark frame
        // captured during a server outage is discarded too. That is the intended
        // trade: an unreadable frame is not worth 140 KB of a user's quota.
        if (frameQuality) {
          void frameQuality
            .then((q) => (isFrameUnusable(q) ? store.discardFrame(id, 'quality') : undefined))
            .catch(() => { /* frame could not be analysed — doubt keeps the photograph */ })
        }
      }
      if (e instanceof InferServerError) {
        // Server-path inference failures carry a typed code — map each to
        // actionable HUD guidance instead of a generic "failed" message.
        switch (e.code) {
          case 'timeout':
            overlay.setStatus('Server took too long — try again or move closer')
            break
          case 'network':
            overlay.setStatus(navigator.onLine ? 'Server unreachable — is Tailscale connected?' : 'You are offline')
            break
          case 'model-loading':
            overlay.setStatus('Model warming up — retry in a few seconds')
            break
          case 'model-failed':
          case 'unavailable':
            overlay.setStatus(`Server inference unavailable${router.hasWebGPU ? ' — try WebGPU in the panel' : ''}`)
            break
          default:
            overlay.setStatus('Capture failed — try again')
        }
      } else {
        const message = e instanceof Error ? e.message : String(e)
        const name = e instanceof Error ? e.name : ''

        if (name === 'NotAllowedError' || message.includes('NotAllowedError')) {
          overlay.setStatus('Camera access denied — check browser settings')
        } else if (message.includes('Timed out')) {
          // Check if the timeout is actually due to denied camera permission
          let denied = false
          try {
            if (navigator.permissions) {
              const camPerm = await navigator.permissions.query({ name: 'camera' as PermissionName })
              if (camPerm.state === 'denied') denied = true
            }
          } catch { /* permissions API may not support camera query */ }
          overlay.setStatus(denied
            ? 'Camera access denied — check browser settings'
            : 'Camera frame timed out — tap once more')
        } else if (name === 'TypeError' || message.includes('NetworkError') || message.includes('Failed to fetch') || message.includes('network')) {
          overlay.setStatus('Inference requires network — switch to WebGPU in settings for offline use')
        } else {
          overlay.setStatus('Capture failed — try again')
        }
      }
      console.error('[capture]', e)
    } finally {
      clearAnalysisProgress()
      overlay.setProgress(null)
      captureInFlight = false
      setCaptureBusy(false)
    }
  }

  /**
   * Export on the user's command, reporting what actually happened.
   *
   * Returns the outcome instead of swallowing it. This used to catch its own
   * errors and return undefined, so SidePanel's `await this.onExport()` never
   * threw and the button read "Exported" for every path through here —
   * cancelled, upload-failed, and export-threw included. Its "Export failed"
   * branch was unreachable code.
   */
  async function exportManualScan(): Promise<{ outcome: ExportOutcome; uploadedFilename?: string }> {
    const summary = currentQualitySummary()
    if (summary.status === 'needs-rescan') {
      const ok = confirm('Scan quality is low. Review recommendations before exporting. Export anyway?')
      if (!ok) {
        overlay.setStatus('Export cancelled')
        setAutosaveStatus('Export cancelled')
        return { outcome: 'cancelled' }
      }
    }

    setAutosaveStatus('Exporting scan...')
    overlay.setStatus('Exporting scan...')
    try {
      const result = await exportToGLB(
        { store, pointCloud, poseHistory, geoFix: geoTracker.snapshot() ?? undefined, qualitySummary: currentQualitySummary() },
        { download: true, upload: true, filenamePrefix: 'room-scan', autoSaved: false },
      )
      if (result.upload === 'uploaded' && result.uploadedFilename) {
        overlay.setStatus('Scan exported & synced ✓')
        setAutosaveStatus(`Scan exported & synced ✓ ${shortName(result.uploadedFilename)}`)

        // Reveal the "View in 3D" link next to status — only now is there
        // something on the server for that link to open.
        const link = document.getElementById('export-view-link')
        if (link) {
          link.style.display = 'inline-block'
        }
        return { outcome: 'exported', uploadedFilename: result.uploadedFilename }
      }

      if (result.upload === 'queued-offline') {
        // Not a failure: the service worker holds it and replays on reconnect.
        // Calling this "server sync failed" sent people hunting for a problem
        // that did not exist.
        overlay.setStatus('Scan saved — will sync when back online')
        setAutosaveStatus('Scan saved — will sync when back online')
        return { outcome: 'queued' }
      }

      // Downloaded, but the server refused it. The file is on the device.
      overlay.setStatus('Scan saved locally — server sync failed')
      setAutosaveStatus('Scan saved locally — server sync failed')
      return { outcome: 'local-only' }
    } catch (error) {
      overlay.setStatus('Export failed — try again')
      setAutosaveStatus('Export failed — try again')
      console.error('[export]', error)
      return { outcome: 'failed' }
    }
  }

  function queueAutoSave(): void {
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
    setAutosaveStatus('Autosave queued')
    autoSaveTimer = setTimeout(() => {
      void runAutoSave()
    }, 1200)
  }

  async function runAutoSave(): Promise<void> {
    if (autoSaveInFlight) {
      autoSaveQueued = true
      return
    }
    autoSaveInFlight = true
    autoSaveQueued = false
    setAutosaveStatus('Saving scan...')
    try {
      await store.saveSnapshot()
      void checkStorageQuota(store, overlay)
      if (pointCloud.count === 0 && store.detections.size === 0 && poseHistory.length === 0) {
        setAutosaveStatus('Autosaved locally')
        return
      }
      const result = await exportToGLB(
        { store, pointCloud, poseHistory, geoFix: geoTracker.snapshot() ?? undefined, qualitySummary: currentQualitySummary() },
        { download: false, upload: true, filenamePrefix: 'autosave-room-scan', autoSaved: true },
      )
      const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      setAutosaveStatus(result.uploadedFilename ? `Autosaved ${shortName(result.uploadedFilename)} · ${time}` : `Autosaved locally · ${time}`)
    } catch (error) {
      setAutosaveStatus('Autosave failed')
      console.error('[autosave]', error)
    } finally {
      autoSaveInFlight = false
      if (autoSaveQueued) queueAutoSave()
    }
  }

  arOverlay.mount(doCapture)

  // ── Auto-capture ───────────────────────────────────────────────────────────
  const autoCapture = new AutoCapture(provider, doCapture)
  autoCapture.onStatusChange = (status) => {
    const btn = document.getElementById('auto-capture-btn') as HTMLButtonElement | null
    if (!btn) return
    btn.classList.toggle('active', status.enabled)
    btn.title = status.enabled
      ? `Auto-capture ON · ${status.captureCount} captures`
      : 'Enable auto-capture'
    const countEl = document.getElementById('auto-capture-count')
    if (countEl) countEl.textContent = status.enabled ? `${status.captureCount}` : ''
    // Visual: pulse the capture button ring when in-flight
    const captureBtn = document.getElementById('capture-btn')
    if (captureBtn) captureBtn.classList.toggle('auto-busy', status.inFlight)
  }

  const autoCaptureBtn = document.getElementById('auto-capture-btn')
  autoCaptureBtn?.addEventListener('click', () => {
    autoCapture.toggle()
    if (autoCapture.enabled) {
      overlay.setStatus('Auto-capture ON — move camera to scan')
    } else {
      overlay.setStatus(`Auto-capture OFF · ${autoCapture.captureCount} auto captures`)
    }
  })

  // ── Keyframe streaming — pose-tagged frames to the server during the scan ──
  const kfStreamer = keyframes
  kfStreamer.onStatus = (s) => {
    latestKeyframeCount = s.sent
    const btn = document.getElementById('stream-btn') as HTMLButtonElement | null
    if (!btn) return
    btn.classList.toggle('active', s.active)
    btn.title = s.active
      ? `Streaming keyframes · ${s.sent} sent${s.offline ? ' · OFFLINE' : ''}`
      : 'Stream keyframes to server'
    const countEl = document.getElementById('stream-count')
    if (countEl) countEl.textContent = s.active ? `${s.sent}` : ''
  }

  document.getElementById('stream-btn')?.addEventListener('click', () => {
    if (kfStreamer.active) {
      void kfStreamer.stop({
        pointCount: pointCloud.count,
        detectionCount: store.detections.size,
        poseCount: poseHistory.length,
        qualitySummary: currentQualitySummary(),
      })
      overlay.setStatus('Keyframe streaming OFF')
    } else {
      kfStreamer.start()
        .then(() => overlay.setStatus('Streaming keyframes — walk the room'))
        .catch((e) => {
          overlay.setStatus('Keyframe session failed — server offline?')
          console.warn('[keyframes]', e)
        })
    }
  })

  // ── 4b. Onboarding overlay — show once on first visit ────────────────────────
  const ONBOARD_KEY = ONBOARDING_KEY

  function runOnboarding(_isReplay = false): Promise<void> {
    return new Promise<void>((resolve) => {
      const ob = document.getElementById('onboarding-overlay')
      if (!ob) { resolve(); return }
      ob.classList.add('visible')

      const steps = ob.querySelectorAll<HTMLElement>('.onboard-step')
      const dots = ob.querySelectorAll<HTMLElement>('.onboard-dot')
      const nextBtn = document.getElementById('onboard-next-btn') as HTMLButtonElement
      const skipBtn = document.getElementById('onboard-skip') as HTMLButtonElement
      let current = 0

      function goToStep(n: number) {
        steps.forEach((s, i) => s.classList.toggle('active', i === n))
        dots.forEach((d, i) => d.classList.toggle('active', i === n))
        nextBtn.textContent = n === steps.length - 1 ? 'Get Started' : 'Next'
        current = n
      }

      goToStep(0)

      function cleanupAndFinish() {
        localStorage.setItem(ONBOARD_KEY, '1')
        ob!.classList.remove('visible')
        // Clean up listeners by cloning the buttons to discard dynamic event listeners
        const newNextBtn = nextBtn.cloneNode(true)
        const newSkipBtn = skipBtn.cloneNode(true)
        nextBtn.parentNode?.replaceChild(newNextBtn, nextBtn)
        skipBtn.parentNode?.replaceChild(newSkipBtn, skipBtn)
        resolve()
      }

      nextBtn.addEventListener('click', () => {
        if (current < steps.length - 1) {
          goToStep(current + 1)
        } else {
          cleanupAndFinish()
        }
      })
      skipBtn.addEventListener('click', cleanupAndFinish)
    })
  }

  if (!skipOnboarding && !localStorage.getItem(ONBOARD_KEY)) {
    await runOnboarding(false)
  }

  // Show help button during scanning; re-show onboarding on tap
  const helpBtn = document.getElementById('help-btn')
  if (helpBtn) {
    helpBtn.classList.add('visible')
    helpBtn.addEventListener('click', () => {
      void runOnboarding(true)
    })
  }

  // Menu button opens side panel and scrolls to export section
  const finishScanBtn = document.getElementById('finish-scan-btn')
  if (finishScanBtn) {
    finishScanBtn.addEventListener('click', () => {
      panel.setOpen(true)
      const footer = document.getElementById('panel-footer')
      if (footer) {
        footer.scrollIntoView({ behavior: 'smooth' })
      }
    })
  }

  // Best-effort teardown when the tab goes away. pagehide is the only
  // teardown event that fires reliably on iOS Safari (beforeunload does not) —
  // stop streams and finalize the keyframe session, fire-and-forget.
  //
  // The broadcaster is only constructed further down (after the AR provider has
  // started), so it is reached through this nullable ref rather than the `const`
  // binding: the handler is armed here, but a pagehide during onboarding or while
  // the camera permission prompt is up would otherwise hit the const's temporal
  // dead zone and abort the whole teardown — losing the keyframe-session finalize.
  let rtc: RtcBroadcaster | null = null

  // Each step is isolated: a teardown is best-effort, so one failing resource
  // must not skip the ones after it (finalizing the session matters most).
  window.addEventListener('pagehide', () => {
    try { if (rtc?.isRunning) rtc.stop() } catch (e) { console.warn('[teardown] rtc', e) }
    try { if (autoCapture.enabled) autoCapture.disable() } catch (e) { console.warn('[teardown] autoCapture', e) }
    try {
      if (kfStreamer.active) {
        void kfStreamer.stop({
          pointCount: pointCloud.count,
          detectionCount: store.detections.size,
          poseCount: poseHistory.length,
          qualitySummary: currentQualitySummary(),
        })
      }
    } catch (e) { console.warn('[teardown] keyframes', e) }
  })

  // Confirmation guards when navigating away from an active scan session
  function hasUnsavedData(): boolean {
    return pointCloud.count > 0 || store.detections.size > 0 || poseHistory.length > 0
  }

  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedData()) {
      e.preventDefault()
      e.returnValue = 'Leave scan? Unsaved progress will be lost.'
      return 'Leave scan? Unsaved progress will be lost.'
    }
  })

  // Guard action rail navigation links
  const navLinks = ['xr-mode-link', 'viewer-link']
  navLinks.forEach((id) => {
    const link = document.getElementById(id)
    if (link) {
      link.addEventListener('click', (e) => {
        if (hasUnsavedData()) {
          const ok = confirm('Leave scan? Unsaved progress will be lost.')
          if (!ok) {
            e.preventDefault()
          }
        }
      })
    }
  })

  // Expose test hooks for E2E validation
  if (typeof (window as any).__playwright_hooks === 'undefined') {
    (window as any).__playwright_hooks = {
      simulateScanData: () => {
        poseHistory.push({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } })
      },
      clearScanData: () => {
        poseHistory.length = 0
      }
    }
  }

  // ── 5. Start AR — the section-0 gesture gate resolves when the user taps ─────
  // The listener lives at the top of main() (see there for why); all that is
  // left here is to prompt, if they haven't already tapped, and wait.
  if (!startPressed) overlay.setStatus('Press Start AR to begin')
  await startArPressed

  overlay.setStatus('Starting AR…')
  try {
    await provider.start(canvas)
  } catch (e) {
    console.error('[main] AR provider start failed:', e)
    showPermissionBanner('Camera access denied. Please check your browser or OS permission settings and allow camera access.')
  }
  overlay.setStatus('Move camera to initialise tracking…')

  // ── WebRTC live-feed broadcaster (optional) ───────────────────────────────
  // The live-feed room is a rendezvous key, and both halves have to name it
  // the same way or they never meet. The editor uses the world it is viewing
  // (viewer.ts: `query.get('world') || 'default'`) while this side was
  // hardcoded to 'default', so opening any share link for a non-default world
  // left the editor on "Waiting for phone…" forever with no error.
  //
  // Not the same thing as where scans land: uploads are parked in the default
  // world on purpose (ADR 0003, "these have no world association"), which is
  // why the "View in 3D" links still point there.
  const liveFeedRoom = searchParams.get('world') || 'default'
  const broadcaster = new RtcBroadcaster(liveFeedRoom)
  rtc = broadcaster   // hand it to the pagehide teardown armed above
  broadcaster.onStatus = ({ state, message }) => {
    const btn = document.getElementById('rtc-stream-btn') as HTMLButtonElement | null
    if (btn) {
      // Only show the badge while actively streaming
      btn.style.display = state === 'streaming' ? 'flex' : 'none'
    }
    if (state === 'error') overlay.setStatus(`RTC: ${message}`)
  }
  const streamBtn = document.getElementById('rtc-stream-btn') as HTMLButtonElement | null
  streamBtn?.addEventListener('click', () => {
    // Clicking the LIVE badge stops the stream
    broadcaster.stop()
  })

  // Wire the panel "Start Live Stream" button
  if (panel.streamButton) {
    panel.streamButton.addEventListener('click', () => {
      if (broadcaster.isRunning) {
        broadcaster.stop()
        panel.streamButton!.innerHTML = iconLabel('broadcast', 'Start Live Stream', { size: '15px' })
      } else {
        void broadcaster.start(canvas)
        panel.streamButton!.innerHTML = iconLabel('broadcast', 'Stop Stream', { size: '15px' })
      }
    })
  }

  overlay.setProgress(null)

  // Mirror detection updates to the desktop viewer over the RTC data channel.
  // Snapshots are small (≤ ~50 objects), so a throttled full sync is simpler
  // and more robust than per-mutation deltas.
  let detSyncTimer: ReturnType<typeof setTimeout> | null = null
  store.subscribe(() => {
    if (detSyncTimer) return
    detSyncTimer = setTimeout(() => {
      detSyncTimer = null
      broadcaster.sendJson({
        t: 'dets',
        items: [...store.detections.values()].map((d) => ({
          label: d.label,
          confidence: d.confidence,
          pos: [d.worldPos.x, d.worldPos.y, d.worldPos.z],
        })),
      })
    }, 1000)
  })

  // ── 6. Continuous SLAM point-cloud accumulation ──────────────────────────────
  scanner.start(provider, (frame) => {
    const inserted = pointCloud.add(frame.points)
    const added = inserted.length
    if (frame.points.length > 0) poseHistory.push(frame.pose)

    // Live geometry to the viewer — no-ops unless the stream is running
    broadcaster.sendPoints(inserted)
    broadcaster.sendJson({
      t: 'pose',
      p: [frame.pose.position.x, frame.pose.position.y, frame.pose.position.z],
      q: [frame.pose.rotation.x, frame.pose.rotation.y, frame.pose.rotation.z, frame.pose.rotation.w],
    })

    if (added > 0) {
      const statsEl = document.getElementById('scan-stats')
      if (statsEl) statsEl.textContent = `${pointCloud.count} pts`
      // First points arriving means SLAM has locked — update status once
      if (pointCloud.count === added) {
        overlay.setStatus('Tracking — tap to capture')
      }
    }
    // One-time notice when the voxel grid starts dropping points to cap memory
    if (!decimationNoticeShown && pointCloud.decimations > 0) {
      decimationNoticeShown = true
      overlay.setStatus('Point cloud thinned to save memory')
    }
    // Update quality overlay on every scanner tick
    const snap = qualityMonitor.tick(provider, pointCloud)
    updateQualityOverlay(snap)
    updateVerdictUI()
    if (snap.trackingLost) overlay.setStatus('Tracking lost — move slowly')
    else if (snap.driftRisk === 'high') overlay.setStatus('⚠ Moving too fast — slow down')
  })
  console.log('[main] Room scanner started')

  function currentQualitySummary() {
    return qualityMonitor.summary({
      pointCount: pointCloud.count,
      detectionCount: store.detections.size,
      poseCount: poseHistory.length,
      keyframeCount: latestKeyframeCount,
    })
  }

  function updateVerdictUI(): void {
    const summary = currentQualitySummary()
    const hintText = summary.status !== 'ready' && summary.recommendations.length > 0
      ? `⚠ ${summary.recommendations[0]}`
      : ''

    // Runs on every 750 ms scanner tick, and both targets are announced to
    // screen readers — rewriting them unchanged re-announces the same sentence
    // twice a second. Bail unless something actually moved.
    const key = `${summary.status}|${hintText}`
    if (key === lastVerdictKey) return
    lastVerdictKey = key

    const chip = document.getElementById('verdict-chip')
    if (chip) {
      chip.textContent = summary.status === 'ready'
        ? '✓ Ready'
        : summary.status === 'needs-review'
          ? '⚠ Review'
          : 'Sparse'

      // Style details dynamically
      chip.style.background = summary.status === 'ready'
        ? 'rgba(74,222,128,0.25)'
        : summary.status === 'needs-review'
          ? 'rgba(255,152,0,0.25)'
          : 'rgba(239,112,112,0.25)'
      chip.style.color = summary.status === 'ready'
        ? '#4ade80'
        : summary.status === 'needs-review'
          ? '#ffb74d'
          : '#ef7070'
    }

    // The recommendation belongs beside the verdict, not in #status-text.
    // Written there, this tick overwrote every transient message within 750 ms:
    // the typed inference-error ladder, "Camera access denied", "Export failed",
    // "Scan exported & synced ✓", the low-light and reflection warnings. Every
    // carefully-worded failure string in this file was unreadable in practice,
    // because scan quality is persistent state and was competing for a line
    // that reports events.
    const hint = document.getElementById('verdict-hint')
    if (hint) {
      hint.textContent = hintText
      hint.style.display = hintText ? 'block' : 'none'
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupStatusOverlay() {
  return {
    setStatus(text: string) {
      const el = document.getElementById('status-text')
      if (el) el.textContent = text
    },
    setProgress(pct: number | null, label?: string) {
      const wrap = document.getElementById('progress-bar-wrap')
      const fill = document.getElementById('progress-bar-fill')
      const statusEl = document.getElementById('status-text')
      if (!wrap || !fill) return
      if (pct === null) {
        wrap.classList.remove('visible')
      } else {
        wrap.classList.add('visible')
        fill.style.width = `${Math.round(pct * 100)}%`
        if (label && statusEl) statusEl.textContent = label
      }
    },
  }
}

function setAutosaveStatus(text: string): void {
  const el = document.getElementById('autosave-status')
  if (el) el.textContent = text
}

/** One-time HUD warning when IndexedDB usage crosses 80 % of the browser quota. */
async function checkStorageQuota(store: DetectionStore, overlay: ReturnType<typeof setupStatusOverlay>): Promise<void> {
  if (quotaWarningShown) return
  const q = await store.quotaStatus()
  if (q && q.quota > 0 && q.usage / q.quota > 0.8) {
    quotaWarningShown = true
    overlay.setStatus('Storage nearly full — old sessions may not save')
  }
}

/**
 * Move #start-ar-btn out of its initial "preparing" state.
 *
 * The button paints from index.html's static markup within ~250 ms, and its
 * click handler is attached at the top of main() (section 0) — so 'ready'
 * follows almost immediately, and a tap from then on is honoured even though
 * AR itself only starts in section 5. The markup ships
 * `disabled aria-busy="true"` with a "Preparing…" line to cover the gap that
 * remains: the ~50 ms until section 0 runs, and the case where the bundle
 * never loads at all, where staying disabled is the honest state. This is the
 * only thing that clears it.
 *
 * The handler can't move any later than a real gesture — the iOS
 * motion-permission request must run synchronously inside the click, so an
 * early tap can never be buffered and replayed. Attaching early is what makes
 * the tap land somewhere instead of vanishing with no feedback.
 *
 * 'unavailable' is terminal: the boot paths that give up (insecure context, no
 * AR runtime, a crash in main()) call it so the card stops advertising a wait
 * that will never end.
 */
function setStartButtonState(state: 'ready' | 'unavailable', label?: string): void {
  const btn = document.getElementById('start-ar-btn') as HTMLButtonElement | null
  if (!btn) return
  btn.disabled = state !== 'ready'
  btn.removeAttribute('aria-busy')   // no longer booting, either way

  const status = btn.querySelector<HTMLElement>('.start-path-status')
  if (status && state === 'unavailable') {
    status.textContent = label ?? 'Not available on this device'
  }
}

/**
 * Fills and reveals the #ar-help hint on the start screen when no AR runtime
 * is available — per-platform guidance for getting a working session.
 */
function showArHelp(): void {
  setStartButtonState('unavailable')
  const ua = navigator.userAgent
  const isIOS = /iPhone|iPad|iPod/i.test(ua)
  const plain = isIOS
    ? 'Open in Safari for 8th Wall SLAM, or install HelloXR for native WebXR'
    : /Android/i.test(ua)
      ? 'Use Chrome 90+ with Google Play Services for AR'
      : 'Open this URL on a phone: ' + location.origin

  const el = document.getElementById('ar-help')
  if (!el) {
    // #ar-help lives inside #start-screen, and a Start AR tap removes that
    // screen — which, now that a tap is honoured during boot (section 0), can
    // happen before AR runtime detection has failed. Fall back to the
    // permission banner, a sibling of the start screen that survives it, so
    // "no AR runtime" can never end as a blank screen with no explanation.
    showPermissionBanner(`AR is not available on this device. ${plain}`)
    return
  }

  if (isIOS) {
    el.innerHTML = 'Open in Safari for 8th Wall SLAM, or install '
      + '<a href="https://apps.apple.com/us/app/helloxr/id6757726359" style="color:var(--ci-accent);">HelloXR</a>'
      + ' for native WebXR'
  } else {
    el.textContent = plain
  }
  el.hidden = false
}

/**
 * Wire the "or upload a walkthrough video" secondary action on the start
 * screen. POSTs the chosen file to /ingest-video (multipart) with a simple
 * upload-% readout, then reveals the "open the 3D editor" link on success.
 * Deliberately isolated from the AR start flow: it neither removes the start
 * screen nor touches the onboarding/insecure-context paths.
 */
function wireVideoUpload(): void {
  const input = document.getElementById('upload-video-input') as HTMLInputElement | null
  const progress = document.getElementById('upload-video-progress')
  const openLink = document.getElementById('upload-video-open') as HTMLAnchorElement | null
  const btn = document.getElementById('upload-video-btn')
  if (!input) return

  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    if (btn) btn.setAttribute('aria-disabled', 'true')
    if (openLink) openLink.hidden = true
    if (progress) progress.textContent = 'Uploading… 0%'

    const form = new FormData()
    form.append('video', file, file.name)
    form.append('name', file.name.replace(/\.[^.]+$/, ''))

    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/ingest-video')
    xhr.upload.addEventListener('progress', (e) => {
      if (!progress || !e.lengthComputable) return
      progress.textContent = `Uploading… ${Math.round((e.loaded / e.total) * 100)}%`
    })
    xhr.addEventListener('load', () => {
      if (btn) btn.removeAttribute('aria-disabled')
      if (xhr.status >= 200 && xhr.status < 300) {
        let frameCount: number | undefined
        try { frameCount = (JSON.parse(xhr.responseText) as { frameCount?: number }).frameCount } catch { /* ignore */ }
        if (progress) {
          progress.textContent = frameCount
            ? `Uploaded — ${frameCount} keyframes extracted.`
            : 'Uploaded — processing started.'
        }
        if (openLink) openLink.hidden = false
      } else {
        let message = `Upload failed (${xhr.status})`
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string; maxBytes?: number }
          if (body.error) message = `Upload failed: ${body.error}`
          if (xhr.status === 413 && body.maxBytes) message += ` (max ${(body.maxBytes / 1e6).toFixed(0)} MB)`
        } catch { /* keep default */ }
        if (progress) progress.textContent = message
      }
      input.value = ''
    })
    xhr.addEventListener('error', () => {
      if (btn) btn.removeAttribute('aria-disabled')
      if (progress) progress.textContent = 'Upload failed — check your connection.'
      input.value = ''
    })
    xhr.send(form)
  })
}

function setCaptureBusy(busy: boolean): void {
  const btn = document.getElementById('capture-btn') as HTMLButtonElement | null
  if (!btn) return
  btn.classList.toggle('busy', busy)
  btn.disabled = busy
  btn.style.pointerEvents = busy ? 'none' : ''
  btn.setAttribute('aria-busy', String(busy))
  btn.setAttribute('aria-disabled', String(busy))
}

function clearAnalysisProgress(): void {
  document.getElementById('progress-bar-fill')?.classList.remove('analyzing')
  document.getElementById('progress-bar-wrap')?.classList.remove('visible')
}

function waitForTracking(provider: ARProvider, timeoutMs: number): Promise<boolean> {
  if (provider.isTracking()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const started = performance.now()
    const tick = () => {
      if (provider.isTracking()) {
        resolve(true)
        return
      }
      if (performance.now() - started >= timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}

function shortName(filename: string): string {
  return filename.replace(/^\d+_/, '').replace(/\.glb$/, '')
}

function updateQualityOverlay(snap: import('./capture/quality-monitor').QualitySnapshot): void {
  const overlay = document.getElementById('quality-overlay')
  if (!overlay) return

  const coverageFill = overlay.querySelector<HTMLElement>('#quality-coverage-fill')
  const coverageText = overlay.querySelector<HTMLElement>('#quality-coverage-text')
  const driftBadge   = overlay.querySelector<HTMLElement>('#quality-drift-badge')
  const lightBadge   = overlay.querySelector<HTMLElement>('#quality-light-badge')
  const reflBadge    = overlay.querySelector<HTMLElement>('#quality-refl-badge')
  const missingText  = overlay.querySelector<HTMLElement>('#quality-missing')

  if (coverageFill) {
    const pct = Math.round(snap.coverageScore * 100)
    coverageFill.style.width = `${pct}%`
    coverageFill.style.background = pct >= 80 ? '#4ade80' : pct >= 50 ? '#ffa726' : '#ef7070'
  }
  if (coverageText) coverageText.textContent = snap.coverageText

  if (driftBadge) {
    driftBadge.style.display = snap.driftRisk !== 'low' ? 'flex' : 'none'
    driftBadge.textContent = snap.driftRisk === 'high' ? '⚡ Fast' : '↗ Speed'
  }
  if (lightBadge) lightBadge.style.display = snap.lowLight ? 'flex' : 'none'
  if (reflBadge)  reflBadge.style.display  = snap.reflectiveSurface ? 'flex' : 'none'
  if (missingText) {
    missingText.style.display = snap.missingAreas > 0 ? 'block' : 'none'
    missingText.textContent = `${snap.missingAreas} area${snap.missingAreas === 1 ? '' : 's'} missing`
  }

  overlay.style.display = 'flex'
}

function waitForXR8(timeoutMs: number): Promise<boolean> {  return new Promise((resolve) => {
    if (typeof (window as unknown as Record<string, unknown>)['XR8'] !== 'undefined') {
      resolve(true)
      return
    }
    const timer = setTimeout(() => {
      window.removeEventListener('xrloaded', onLoaded)
      resolve(false)
    }, timeoutMs)
    function onLoaded() {
      clearTimeout(timer)
      resolve(true)
    }
    window.addEventListener('xrloaded', onLoaded, { once: true })
  })
}

/**
 * Points the runtime-switch nav button at the other AR engine. 8th Wall is
 * the default; the WebXR toggle is only shown when this browser can actually
 * run an `immersive-ar` session (`webxrSupported`) — otherwise it's hidden
 * rather than sending the user to a dead-end landing page. A WebXR session
 * always links back to the 8th Wall scanner.
 */
function updateXrModeLink(use8thWall: boolean, webxrSupported: boolean): void {
  const link = document.getElementById('xr-mode-link') as HTMLAnchorElement | null
  if (!link) return
  if (use8thWall) {
    if (!webxrSupported) {
      link.style.display = 'none'
      return
    }
    link.style.display = ''
    link.href = '/?ar=webxr'
    link.title = 'Switch to WebXR scanner'
    link.setAttribute('aria-label', 'Switch to WebXR scanner')
    link.classList.remove('active')
  } else {
    link.style.display = ''
    link.href = '/'
    link.title = 'WebXR mode active — switch back to 8th Wall scanner'
    link.setAttribute('aria-label', 'Switch to 8th Wall scanner')
    link.classList.add('active')
  }
}

function bucket(p: { x: number; y: number; z: number }): string {
  return `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`
}

let _inferDialogTimer: ReturnType<typeof setTimeout> | null = null

function showInferDialog(dets: Array<{ label: string; description: string; confidence: number; worldPos: { x: number; y: number; z: number } }>): void {
  const dialog = document.getElementById('infer-dialog')
  const body   = document.getElementById('infer-dialog-body')
  const close  = document.getElementById('infer-dialog-close')
  if (!dialog || !body) return

  if (!close?.dataset['bound']) {
    close?.addEventListener('click', () => hideInferDialog())
    if (close) close.dataset['bound'] = '1'
  }

  // Tap-to-dismiss: clicking anywhere on the dialog dismisses it
  if (!dialog.dataset['tapBound']) {
    dialog.addEventListener('click', (e) => {
      // Don't dismiss if user is scrolling the body content
      if (e.target === body || body.contains(e.target as Node)) return
      hideInferDialog()
    })
    dialog.dataset['tapBound'] = '1'
  }

  if (dets.length === 0) return

  // `label` and `description` come straight from the inference engine. A real VLM
  // (ollama/onnx) can emit angle brackets or stray markup, so they are set as text
  // nodes rather than interpolated into innerHTML — otherwise a reply containing
  // markup renders as a broken/blank row instead of the text the model returned.
  body.replaceChildren()
  for (const d of dets) {
    const p = d.worldPos

    const row = document.createElement('div')
    row.style.cssText = 'display:flex;flex-direction:column;gap:2px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);'

    const head = document.createElement('div')
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
    const label = document.createElement('span')
    label.style.cssText = 'color:#fff;font-size:13px;font-weight:700;'
    label.textContent = d.label
    const conf = document.createElement('span')
    conf.style.cssText = 'color:rgba(255,255,255,0.4);font-size:11px;font-family:monospace;'
    conf.textContent = `${Math.round(d.confidence * 100)}%`
    head.append(label, conf)

    const desc = document.createElement('p')
    desc.style.cssText = 'color:rgba(255,255,255,0.55);font-size:12px;line-height:1.4;margin:0;'
    desc.textContent = d.description

    const pos = document.createElement('span')
    pos.style.cssText = 'color:rgba(255,255,255,0.25);font-size:10px;font-family:monospace;'
    pos.textContent = `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`

    row.append(head, desc, pos)
    body.appendChild(row)
  }

  // Add a "tap to dismiss" hint at the bottom
  const hint = document.createElement('div')
  hint.style.cssText = 'text-align:center;padding:6px 0 2px;color:rgba(255,255,255,0.25);font-size:10px;'
  hint.textContent = 'tap to dismiss'
  body.appendChild(hint)

  dialog.classList.add('visible')

  if (_inferDialogTimer) clearTimeout(_inferDialogTimer)
  _inferDialogTimer = setTimeout(() => hideInferDialog(), 4000)
}

function hideInferDialog(): void {
  document.getElementById('infer-dialog')?.classList.remove('visible')
  if (_inferDialogTimer) { clearTimeout(_inferDialogTimer); _inferDialogTimer = null }
}

/**
 * Send a request to the server's /process-scan endpoint.
 * Deliberately does not resolve or pass a filename: /scans lists every scan on
 * the server with no session scoping, so guessing the target from list[0] here
 * (the previous approach) meant "most recently uploaded by anyone" — one user
 * could trigger processing on, and see the result for, another session's scan.
 * sessionId alone lets the server's own findFilenameBySessionId() resolve the
 * scan that actually belongs to this session.
 */
async function requestServerProcessing(action: string, store: DetectionStore): Promise<void> {
  const overlay = setupStatusOverlay()
  overlay.setStatus(`Processing: ${action}…`)
  try {
    const resp = await fetch('/process-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, sessionId: store.sessionId }),
    })
    if (!resp.ok) throw new Error(`/process-scan returned ${resp.status}`)
    const result = await resp.json() as { action: string; result: string }
    overlay.setStatus(`Done: ${result.action}`)
    console.log('[process]', result)
    showProcessingResult(result)
  } catch (err) {
    overlay.setStatus('Processing failed')
    console.error('[process]', err)
  }
}

function showProcessingResult(result: { action: string; result: string }): void {
  const dialog = document.getElementById('infer-dialog')
  const body   = document.getElementById('infer-dialog-body')
  const title  = document.getElementById('infer-dialog-title')
  if (!dialog || !body || !title) return

  title.textContent = `Server: ${result.action}`
  body.innerHTML = `<div style="color:rgba(255,255,255,0.8);font-size:13px;line-height:1.6;white-space:pre-wrap;">${result.result}</div>`
  dialog.classList.add('visible')
  if (_inferDialogTimer) clearTimeout(_inferDialogTimer)
  _inferDialogTimer = setTimeout(() => hideInferDialog(), 15_000)
}

main().catch((e: unknown) => {
  console.error('[main]', e)
  const el = document.getElementById('status-text')
  if (el) el.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`
  // Boot died. If it got as far as section 0 the button is enabled but its
  // handler leads nowhere; if it died before that it is still pulsing
  // "Preparing…" for a boot that will never finish. Either way, say so.
  setStartButtonState('unavailable', 'Start failed — reload the page')
})

// ─── Geo indicator (inside the unified top-left HUD) ─────────────────────────

function updateGeoIndicator(fix: GeoFix): void {
  const chip    = document.getElementById('geo-chip') as HTMLElement | null
  const address = document.getElementById('geo-address')
  const coords  = document.getElementById('geo-coords')
  const needle  = document.getElementById('compass-needle') as SVGGElement | null
  if (!chip) return

  chip.style.display = 'flex'
  if (address) address.textContent = fix.address ?? `${fix.lat.toFixed(4)}, ${fix.lng.toFixed(4)}`
  if (coords)  coords.textContent  = `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)} ±${Math.round(fix.accuracy)}m`

  if (needle && fix.bearing !== null) {
    needle.style.transform = `rotate(${fix.bearing}deg)`
  }
}

// ─── Drawer geo-map (Leaflet, lazy init on first open) ─────────────────────────

// Types come from the already-vendored @types/leaflet rather than hand-rolled
// structural subsets (ADR 0001 — the same collapse foundation-updates/0005 and /0007 did).
let _geoMap: import('leaflet').Map | null = null
let _geoMapReady = false
let _currentMarker: import('leaflet').Marker | null = null

/**
 * Called by SessionHistory when the drawer opens.
 * Lazy-creates a Leaflet map, shows the current GPS fix, and plots
 * all server-side scan locations as markers.
 */
async function initDrawerGeoMap(fix: GeoFix | null): Promise<void> {
  // Dynamic import: Leaflet is bundled, but only fetched when the drawer first opens.
  let L: typeof import('leaflet')
  try {
    const [lib] = await Promise.all([
      import('leaflet'),
      import('leaflet/dist/leaflet.css'),
    ])
    L = lib
  } catch (e) {
    console.error('[geo-map] Leaflet load failed:', e)
    return
  }

  const container = document.getElementById('geo-map')
  const placeholder = document.getElementById('geo-map-placeholder')

  if (!container) return

  if (!_geoMapReady) {
    // Determine initial view center
    const center: [number, number] = fix ? [fix.lat, fix.lng] : [51.505, -0.09]
    const zoom = fix ? 16 : 3

    // Use a dark tile layer from CartoDB
    const map = L.map(container, { zoomControl: false, attributionControl: true })
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(map)
    map.setView(center, zoom)

    // Current location marker — custom pulsing dot
    if (fix) {
      const icon = L.divIcon({
        className: '',
        html: '<div style="width:12px;height:12px;background:#80ffe1;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 4px rgba(128,255,225,0.3)"></div>',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      })
      _currentMarker = L.marker([fix.lat, fix.lng], { icon }).addTo(map)
    }

    _geoMap = map
    _geoMapReady = true

    if (placeholder) placeholder.style.display = 'none'

    // Fetch + plot all stored scan locations
    void fetch('/scan-locations', { signal: AbortSignal.timeout(5000) }).then(async (r) => {
      if (!r.ok) return
      const locations = await r.json() as Array<{ lat: number; lng: number; filename: string; address: string | null }>
      for (const loc of locations) {
        const scanIcon = L.divIcon({
          className: '',
          html: '<div style="width:8px;height:8px;background:#ef7070;border-radius:50%;border:1.5px solid #fff;"></div>',
          iconSize: [8, 8],
          iconAnchor: [4, 4],
        })
        const marker = L.marker([loc.lat, loc.lng], { icon: scanIcon })
        marker.bindPopup(`<b>${loc.address ?? loc.filename}</b>`, { maxWidth: 200 })
        marker.addTo(map)
      }
    }).catch(() => {/* server may be off */})
  } else if (_geoMap) {
    // Already created — just update current position if we have a fresh fix
    _geoMap.invalidateSize()
    if (fix && _currentMarker) {
      _currentMarker.setLatLng([fix.lat, fix.lng])
    }
    if (fix) _geoMap.setView([fix.lat, fix.lng], 16)
  }
}

function showPermissionBanner(message: string): void {
  const banner = document.getElementById('permission-error-banner')
  const msgEl = document.getElementById('permission-error-msg')
  if (banner && msgEl) {
    msgEl.textContent = message
    banner.style.display = 'block'
  }
}
