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
import { createWebXRProvider, WebXRProvider } from './ar/webxr'
import type { ARProvider, Pose } from './ar/provider'
import { RoomScanner } from './ar/scanner'
import { PointCloud } from './scene/pointcloud'
import { CaptureModule } from './capture/capture'
import { AutoCapture } from './capture/auto-capture'
import { KeyframeStreamer } from './capture/keyframes'
import { ScanQualityMonitor } from './capture/quality-monitor'
import { InferenceRouter } from './inference/router'
import { resolveDetections, mergeDetections } from './spatial/resolver'
import { DetectionStore } from './scene/store'
import { ProjectStore } from './project/project-store'
import { AROverlay } from './ui/overlay'
import { SidePanel } from './ui/panel'
import { SessionHistory } from './ui/history'
import { exportToGLB } from './export/gltf'
import { exportSessionSummary } from './export/summary'
import { GeoTracker, type GeoFix } from './geo/geo-tracker'
import { RtcBroadcaster } from './rtc/broadcaster'
import { registerPWA } from './pwa'
import * as THREE from 'three'

const CAPTURE_FRAME_TIMEOUT_MS = 8000
const TRACKING_WAIT_MS = 2500

async function main() {
  registerPWA()

  const canvas = document.getElementById('camerafeed') as HTMLCanvasElement
  const overlay = setupStatusOverlay()

  // ── 1. Store + scan accumulators ────────────────────────────────────────────
  const store = new DetectionStore()
  await store.open()
  const projectStore = new ProjectStore()
  await projectStore.open()
  const qualityMonitor = new ScanQualityMonitor()
  const geoTracker = new GeoTracker()
  const pointCloud = new PointCloud(0.05)   // 5 cm voxel deduplication grid
  const poseHistory: Pose[] = []
  const scanner = new RoomScanner()
  let captureCount = 0    // total successful captures this session
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
  let autoSaveInFlight = false
  let autoSaveQueued = false
  let captureInFlight = false

  // Start geo tracker early (GPS needs time to acquire a fix)
  // Wire geo indicator chip immediately when first fix arrives
  geoTracker.onUpdate = (fix) => updateGeoIndicator(fix)
  void geoTracker.start().then((fix) => {
    if (fix) updateGeoIndicator(fix)
    if (fix?.address) overlay.setStatus(`📍 ${fix.address}`)
  })

  // ── 2. Inference router & early UI mounting (prevents test timeouts) ───────
  const router = new InferenceRouter()

  // Assigned once the AR provider exists; the export callback below runs on
  // user action, long after assignment.
  let keyframes: KeyframeStreamer | null = null

  const panel = new SidePanel(
    store,
    async () => {
      const uploadedFilename = await exportManualScan()
      if (keyframes?.active) {
        void keyframes.rotate({
          glbFilename: uploadedFilename,
          pointCount: pointCloud.count,
          detectionCount: store.detections.size,
          poseCount: poseHistory.length,
        })
      }
    },
    () => exportSessionSummary({ store, pointCloud, poseHistory, captureCount, geoFix: geoTracker.snapshot() ?? undefined }),
    (action) => requestServerProcessing(action, store),
    (mode) => {
      router.setMode(mode)
      overlay.setStatus(`AI: ${mode === 'server' ? '🖥 Server' : '⚡ WebGPU'}`)
    },
    router.path,
  )
  panel.mount()

  const history = new SessionHistory(store)
  history.mount()

  void store.saveSnapshot()

  document.getElementById('history-btn')?.addEventListener('click', () => {
    initDrawerGeoMap(geoTracker.snapshot())
  })

  await router.init(
    (stage, pct) => { overlay.setProgress(pct, stage) },
    (mode) => {
      overlay.setStatus(`AI: ${mode === 'server' ? '🖥 Server' : '⚡ WebGPU'}`)
      panel.updateInferMode(mode)
    },
  )
  overlay.setStatus(`AI: ${router.path === 'server' ? '🖥 Server' : '⚡ WebGPU'}`)

  // ── 3. AR runtime detection ────────────────────────────────────────────────
  let provider: ARProvider
  let use8thWall = false

  // Forced runtime: /webxr.html redirects here with ?ar=webxr — used in
  // WebXR-capable iOS browsers (e.g. HelloXR) where the native WebXR session
  // beats the 8th Wall SLAM fallback.  ?ar=8thwall forces the inverse.
  const forcedMode = new URLSearchParams(location.search).get('ar')

  // Test hook: ?mock=webxr installs the iwer emulation runtime (Meta's
  // immersive-web-emulator engine) so WebXR flows run in headless browsers.
  if (new URLSearchParams(location.search).get('mock') === 'webxr') {
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
      console.error('[main] No AR runtime available:', e)
      return
    }
  }
  updateXrModeLink(use8thWall)

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
    try {
      const { blob, pose, timestamp } = await capture.capture(CAPTURE_FRAME_TIMEOUT_MS)
      console.log(`[main] Captured blob: ${blob.size} bytes, type=${blob.type}, pose=`, pose)
      overlay.setStatus('Analysing…')

      // Show indeterminate analysis progress bar
      const progFill = document.getElementById('progress-bar-fill')
      const progWrap = document.getElementById('progress-bar-wrap')
      if (progFill) progFill.classList.add('analyzing')
      if (progWrap) progWrap.classList.add('visible')

      // Async frame quality analysis (non-blocking — updates overlay on next tick)
      void qualityMonitor.analyseFrame(blob).then(({ lowLight, reflective }) => {
        updateQualityOverlay(qualityMonitor.tick(provider, pointCloud))
        if (lowLight)   overlay.setStatus('⚠ Low light — add more lighting')
        if (reflective) overlay.setStatus('⚠ Reflective surface detected')
      })

      const thumbnail = await capture.captureThumbnail(blob)
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

      // Tag each resolved detection with the current capture index
      const currentCaptureIdx = captureCount + 1  // will increment after
      for (const wd of worldDets) wd.captureIndex = currentCaptureIdx

      // Build thumbnail map keyed by label (best-effort)
      const thumbMap = new Map<string, string>()
      for (const wd of worldDets) {
        thumbMap.set(`${wd.label}:${bucket(wd.worldPos)}`, thumbnail)
      }

      const merged = mergeDetections(store.detections, worldDets)
      await store.upsert(merged, thumbMap)

      showInferDialog(worldDets)

      captureCount++
      await store.saveSnapshot()
      queueAutoSave()
      overlay.setStatus(
        `${store.detections.size} object${store.detections.size === 1 ? '' : 's'} · ${pointCloud.count} pts`,
      )
    } catch (e) {
      clearAnalysisProgress()
      const message = e instanceof Error ? e.message : String(e)
      overlay.setStatus(message.includes('Timed out')
        ? 'Camera frame timed out — tap once more'
        : 'Capture failed — try again')
      console.error('[capture]', e)
    } finally {
      clearAnalysisProgress()
      overlay.setProgress(null)
      captureInFlight = false
      setCaptureBusy(false)
    }
  }

  async function exportManualScan(): Promise<string | undefined> {
    setAutosaveStatus('Exporting scan...')
    overlay.setStatus('Exporting scan...')
    try {
      const result = await exportToGLB(
        { store, pointCloud, poseHistory, geoFix: geoTracker.snapshot() ?? undefined },
        { download: true, upload: true, filenamePrefix: 'room-scan', autoSaved: false },
      )
      overlay.setStatus('Exported scan')
      setAutosaveStatus(result.uploadedFilename ? `Exported + uploaded ${shortName(result.uploadedFilename)}` : 'Export downloaded')
      return result.uploadedFilename
    } catch (error) {
      overlay.setStatus('Export failed')
      setAutosaveStatus('Export failed')
      console.error('[export]', error)
      return undefined
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
      if (pointCloud.count === 0 && store.detections.size === 0 && poseHistory.length === 0) {
        setAutosaveStatus('Autosaved locally')
        return
      }
      const result = await exportToGLB(
        { store, pointCloud, poseHistory, geoFix: geoTracker.snapshot() ?? undefined },
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

  // ── 5. Start AR — permission must be requested in the button click handler ───
  // Safari iOS 13+ requires DeviceOrientationEvent/DeviceMotionEvent.requestPermission()
  // to be called synchronously inside a click handler, with NO awaits before it.
  // A real <button> click event is the only reliable trigger for this in Safari.
  overlay.setStatus('Press Start AR to begin')
  await new Promise<void>((resolve) => {
    const startBtn = document.getElementById('start-ar-btn') as HTMLButtonElement
    startBtn.addEventListener('click', async () => {
      // ↓ Initiate BEFORE any await — this preserves the user-gesture context in Safari
      type PermAPI = { requestPermission?(): Promise<string> }
      const p1 = (DeviceOrientationEvent as unknown as PermAPI).requestPermission?.()
      const p2 = (DeviceMotionEvent as unknown as PermAPI).requestPermission?.()

      // Hide the start screen immediately
      document.getElementById('start-screen')?.remove()

      try {
        await Promise.all([p1, p2].filter(Boolean))
      } catch {
        console.warn('[main] Motion/orientation permission denied — SLAM may not track')
      }
      resolve()
    }, { once: true })
  })

  overlay.setStatus('Starting AR…')
  await provider.start(canvas)
  overlay.setStatus('Move camera to initialise tracking…')

  // ── WebRTC live-feed broadcaster (optional) ───────────────────────────────
  const broadcaster = new RtcBroadcaster('default')
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
        panel.streamButton!.textContent = '📡 Start Live Stream'
      } else {
        void broadcaster.start(canvas)
        panel.streamButton!.textContent = '📡 Stop Stream'
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
    // Update quality overlay on every scanner tick
    const snap = qualityMonitor.tick(provider, pointCloud)
    updateQualityOverlay(snap)
    if (snap.trackingLost) overlay.setStatus('Tracking lost — move slowly')
    else if (snap.driftRisk === 'high') overlay.setStatus('⚠ Moving too fast — slow down')
  })
  console.log('[main] Room scanner started')
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

function setCaptureBusy(busy: boolean): void {
  const btn = document.getElementById('capture-btn') as HTMLButtonElement | null
  if (!btn) return
  btn.classList.toggle('busy', busy)
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
    coverageFill.style.background = pct >= 80 ? '#66bb6a' : pct >= 50 ? '#ffa726' : '#ef5350'
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
 * Points the runtime-switch nav button at the other AR engine: an 8th Wall
 * session links to the WebXR scanner route (for HelloXR on iOS), and a WebXR
 * session links back to the default 8th Wall scanner.
 */
function updateXrModeLink(use8thWall: boolean): void {
  const link = document.getElementById('xr-mode-link') as HTMLAnchorElement | null
  if (!link) return
  if (use8thWall) {
    link.href = '/webxr.html'
    link.title = 'Switch to WebXR scanner (HelloXR on iOS)'
    link.setAttribute('aria-label', 'Switch to WebXR scanner')
    link.classList.remove('active')
  } else {
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

  if (dets.length === 0) return

  body.innerHTML = dets.map((d) => {
    const conf = Math.round(d.confidence * 100)
    const p = d.worldPos
    return `
      <div style="display:flex;flex-direction:column;gap:2px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span style="color:#fff;font-size:13px;font-weight:700;">${d.label}</span>
          <span style="color:rgba(255,255,255,0.4);font-size:11px;font-family:monospace;">${conf}%</span>
        </div>
        <p style="color:rgba(255,255,255,0.55);font-size:12px;line-height:1.4;margin:0;">${d.description}</p>
        <span style="color:rgba(255,255,255,0.25);font-size:10px;font-family:monospace;">(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})</span>
      </div>`
  }).join('')

  dialog.classList.add('visible')

  if (_inferDialogTimer) clearTimeout(_inferDialogTimer)
  _inferDialogTimer = setTimeout(() => hideInferDialog(), 9000)
}

function hideInferDialog(): void {
  document.getElementById('infer-dialog')?.classList.remove('visible')
  if (_inferDialogTimer) { clearTimeout(_inferDialogTimer); _inferDialogTimer = null }
}

/**
 * Send a request to the server's /process-scan endpoint.
 * The server-side scan list must contain scans from the current session;
 * if no matching filename is passed we request processing on the newest scan.
 */
async function requestServerProcessing(action: string, store: DetectionStore): Promise<void> {
  const overlay = setupStatusOverlay()
  overlay.setStatus(`Processing: ${action}…`)
  try {
    // Find the newest scan for this session on the server
    const listResp = await fetch('/scans')
    if (!listResp.ok) throw new Error(`/scans returned ${listResp.status}`)
    const list = await listResp.json() as Array<{ filename: string }>
    const filename = list[0]?.filename ?? ''

    const resp = await fetch('/process-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, action, sessionId: store.sessionId }),
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

type LeafletMap = {
  setView(latlng: [number, number], zoom: number): LeafletMap
  invalidateSize(): void
}
type LeafletMarker = { setLatLng(latlng: [number, number]): void }

let _geoMap: LeafletMap | null = null
let _geoMapReady = false
let _currentMarker: LeafletMarker | null = null

/**
 * Called by SessionHistory when the drawer opens.
 * Lazy-creates a Leaflet map, shows the current GPS fix, and plots
 * all server-side scan locations as markers.
 */
function initDrawerGeoMap(fix: GeoFix | null): void {
  const L = (window as unknown as Record<string, unknown>)['L'] as typeof import('leaflet') | undefined
  if (!L) return // Leaflet script not yet loaded

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
      _currentMarker = L.marker([fix.lat, fix.lng], { icon }).addTo(map) as unknown as LeafletMarker
    }

    _geoMap = map as unknown as LeafletMap
    _geoMapReady = true

    if (placeholder) placeholder.style.display = 'none'

    // Fetch + plot all stored scan locations
    void fetch('/scan-locations').then(async (r) => {
      if (!r.ok) return
      const locations = await r.json() as Array<{ lat: number; lng: number; filename: string; address: string | null }>
      for (const loc of locations) {
        const scanIcon = L.divIcon({
          className: '',
          html: '<div style="width:8px;height:8px;background:#ef5350;border-radius:50%;border:1.5px solid #fff;"></div>',
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
    if (fix) (_geoMap as LeafletMap).setView([fix.lat, fix.lng], 16)
  }
}
