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
import type { ARProvider } from './ar/provider'
import { CaptureModule } from './capture/capture'
import { InferenceRouter } from './inference/router'
import { resolveDetections, mergeDetections } from './spatial/resolver'
import { DetectionStore } from './scene/store'
import { AROverlay } from './ui/overlay'
import { SidePanel } from './ui/panel'
import { exportToGLB } from './export/gltf'

async function main() {
  const canvas = document.getElementById('camerafeed') as HTMLCanvasElement
  const overlay = setupStatusOverlay()

  // ── 1. Store ────────────────────────────────────────────────────────────────
  const store = new DetectionStore()
  await store.open()

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
  const arOverlay = new AROverlay(store, use8thWall)
  const panel = new SidePanel(store, () => exportToGLB(store))

  const capture = new CaptureModule(provider)
  const asyncHitTest = !use8thWall && provider instanceof WebXRProvider
    ? (x: number, y: number) => (provider as WebXRProvider).hitTestAsync(x, y)
    : undefined

  arOverlay.mount(async () => {
    overlay.setStatus('Capturing…')
    try {
      const { blob, pose, timestamp } = await capture.capture()
      overlay.setStatus('Analysing…')

      const thumbnail = await capture.captureThumbnail(blob)
      const rawDets = await router.infer(blob)

      overlay.setStatus(`${rawDets.length} object${rawDets.length === 1 ? '' : 's'} detected`)

      const worldDets = await resolveDetections(rawDets, timestamp, {
        provider,
        asyncHitTest,
      })

      // Build thumbnail map keyed by label (best-effort)
      const thumbMap = new Map<string, string>()
      for (const wd of worldDets) {
        thumbMap.set(`${wd.label}:${bucket(wd.worldPos)}`, thumbnail)
      }

      const merged = mergeDetections(store.detections, worldDets)
      await store.upsert(merged, thumbMap)

      overlay.setStatus(`Scan complete — ${store.detections.size} object${store.detections.size === 1 ? '' : 's'}`)
      void pose // pose stored in worldDets; kept here for future raw-JSON export
    } catch (e) {
      overlay.setStatus('Capture failed — try again')
      console.error('[capture]', e)
    }
    overlay.setProgress(null)
  })

  panel.mount()

  // ── 5. Start AR ────────────────────────────────────────────────────────────
  overlay.setStatus('Starting AR…')
  await provider.start(canvas)
  overlay.setStatus('Ready — tap capture to scan')
  overlay.setProgress(null)
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

function waitForXR8(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
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

main().catch(console.error)
