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
 */
import { createEighthWallProvider } from './ar/eighthwall'
import { createWebXRProvider, WebXRProvider } from './ar/webxr'
import type { ARProvider, Pose } from './ar/provider'
import { RoomScanner } from './ar/scanner'
import { PointCloud } from './scene/pointcloud'
import { CaptureModule } from './capture/capture'
import { InferenceRouter } from './inference/router'
import { resolveDetections, mergeDetections } from './spatial/resolver'
import { DetectionStore } from './scene/store'
import { AROverlay } from './ui/overlay'
import { SidePanel } from './ui/panel'
import { SessionHistory } from './ui/history'
import { exportToGLB } from './export/gltf'
import * as THREE from 'three'

async function main() {
  const canvas = document.getElementById('camerafeed') as HTMLCanvasElement
  const overlay = setupStatusOverlay()

  // ── 1. Store + scan accumulators ────────────────────────────────────────────
  const store = new DetectionStore()
  await store.open()
  const pointCloud = new PointCloud(0.05)   // 5 cm voxel deduplication grid
  const poseHistory: Pose[] = []
  const scanner = new RoomScanner()

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
  const panel = new SidePanel(store, () => exportToGLB({ store, pointCloud, poseHistory }))
  const history = new SessionHistory(store)

  const capture = new CaptureModule(provider)
  const asyncHitTest = !use8thWall && provider instanceof WebXRProvider
    ? (x: number, y: number) => (provider as WebXRProvider).hitTestAsync(x, y)
    : undefined

  arOverlay.mount(async () => {
    if (!provider.isTracking()) {
      // Show a nudge but still allow capture — the resolver will fall back
      // to the estimated position if the pose is not yet valid.
      overlay.setStatus('Tracking not ready — move camera slowly over a surface')
    }
    overlay.setStatus('Capturing…')
    try {
      const { blob, pose, timestamp } = await capture.capture()
      console.log(`[main] Captured blob: ${blob.size} bytes, type=${blob.type}, pose=`, pose)
      overlay.setStatus('Analysing…')

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

      // Build thumbnail map keyed by label (best-effort)
      const thumbMap = new Map<string, string>()
      for (const wd of worldDets) {
        thumbMap.set(`${wd.label}:${bucket(wd.worldPos)}`, thumbnail)
      }

      const merged = mergeDetections(store.detections, worldDets)
      await store.upsert(merged, thumbMap)

      showInferDialog(worldDets)

      overlay.setStatus(
        `${store.detections.size} object${store.detections.size === 1 ? '' : 's'} · ${pointCloud.count} pts`,
      )
    } catch (e) {
      overlay.setStatus('Capture failed — try again')
      console.error('[capture]', e)
    }
    overlay.setProgress(null)
  })

  panel.mount()
  history.mount()

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

main().catch((e: unknown) => {
  console.error('[main]', e)
  const el = document.getElementById('status-text')
  if (el) el.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`
})
