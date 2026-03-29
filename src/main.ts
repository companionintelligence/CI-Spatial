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
import { GeoTracker } from './geo/geo-tracker'
import { RtcBroadcaster } from './rtc/broadcaster'
import * as THREE from 'three'

async function main() {
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

  // Start geo tracker early (GPS needs time to acquire a fix)
  void geoTracker.start().then((fix) => {
    if (fix?.address) overlay.setStatus(`📍 ${fix.address}`)
  })

  // ── 2. Inference router ────────────────────────────────────────────────────
  const router = new InferenceRouter()
  await router.init((stage, pct) => {
    overlay.setProgress(pct, stage)
  })
  overlay.setStatus(`Inference: ${router.path}`)

  // ── 3. AR runtime detection ────────────────────────────────────────────────
  let provider: ARProvider
  let use8thWall = false

  // XR8 global is set by xr.js (8th Wall OSS engine binary in public/xr.js).
  // If it's not present after a grace timeout we fall back to WebXR.
  const xr8Available = await waitForXR8(3000)

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
      overlay.setStatus('WebXR ready')
    } catch (e) {
      overlay.setStatus('AR not available on this device')
      console.error('[main] No AR runtime available:', e)
      return
    }
  }

  // ── 4. UI ──────────────────────────────────────────────────────────────────
  const arOverlay = new AROverlay(store, use8thWall, provider)
  const panel = new SidePanel(
    store,
    () => exportToGLB({ store, pointCloud, poseHistory, geoFix: geoTracker.snapshot() ?? undefined }),
    () => exportSessionSummary({ store, pointCloud, poseHistory, captureCount, geoFix: geoTracker.snapshot() ?? undefined }),
    (action) => requestServerProcessing(action, store),
  )
  const history = new SessionHistory(store)

  const capture = new CaptureModule(provider)
  const asyncHitTest = !use8thWall && provider instanceof WebXRProvider
    ? (x: number, y: number) => (provider as WebXRProvider).hitTestAsync(x, y)
    : undefined

  // Shared capture handler used by both the manual button and auto-capture
  async function doCapture() {
    if (!provider.isTracking()) {
      overlay.setStatus('Tracking not ready — move camera slowly over a surface')
    }
    overlay.setStatus('Capturing…')
    try {
      const { blob, pose, timestamp } = await capture.capture()
      console.log(`[main] Captured blob: ${blob.size} bytes, type=${blob.type}, pose=`, pose)
      overlay.setStatus('Analysing…')

      // Async frame quality analysis (non-blocking — updates overlay on next tick)
      void qualityMonitor.analyseFrame(blob).then(({ lowLight, reflective }) => {
        updateQualityOverlay(qualityMonitor.tick(provider, pointCloud))
        if (lowLight)   overlay.setStatus('⚠ Low light — add more lighting')
        if (reflective) overlay.setStatus('⚠ Reflective surface detected')
      })

      const thumbnail = await capture.captureThumbnail(blob)
      const rawDets = await router.infer(blob)
      console.log(`[main] Raw detections (${rawDets.length}):`, JSON.stringify(rawDets))

      overlay.setStatus(`${rawDets.length} object${rawDets.length === 1 ? '' : 's'} detected`)

      // Snapshot a Three.js camera from the current SLAM pose for frustum raycasting.
      // This gives the resolver a proper projection matrix at the moment of capture.
      let captureCamera: THREE.PerspectiveCamera | undefined
      if (use8thWall && provider.isTracking()) {
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
      overlay.setStatus(
        `${store.detections.size} object${store.detections.size === 1 ? '' : 's'} · ${pointCloud.count} pts`,
      )
    } catch (e) {
      overlay.setStatus('Capture failed — try again')
      console.error('[capture]', e)
    }
    overlay.setProgress(null)
  }

  arOverlay.mount(doCapture)

  panel.mount()
  history.mount()

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
    const badge = document.getElementById('rtc-stream-badge')
    if (badge) {
      badge.textContent = state === 'streaming' ? '● LIVE' : state === 'error' ? '✕ RTC' : '◌ RTC'
      badge.style.color = state === 'streaming' ? '#66bb6a' : state === 'error' ? '#ef9a9a' : 'rgba(255,255,255,0.4)'
    }
    if (state === 'error') overlay.setStatus(`RTC: ${message}`)
  }
  const streamBtn = document.getElementById('rtc-stream-btn') as HTMLButtonElement | null
  streamBtn?.addEventListener('click', () => {
    if (streamBtn.classList.contains('active')) {
      broadcaster.stop()
      streamBtn.classList.remove('active')
    } else {
      void broadcaster.start(canvas)
      streamBtn.classList.add('active')
    }
  })
  overlay.setProgress(null)

  // ── 6. Continuous SLAM point-cloud accumulation ──────────────────────────────
  scanner.start(provider, (frame) => {
    const added = pointCloud.add(frame.points)
    if (frame.points.length > 0) poseHistory.push(frame.pose)
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
