/**
 * Standalone 3D viewer for room scan GLTF files.
 *
 * Loads scan list from GET /scans, renders selected .glb with Three.js
 * OrbitControls. Works on desktop without any AR hardware.
 *
 * Features:
 *   - Sidebar scan list (newest first)
 *   - Three.js scene with ambient + directional lights, grid helper
 *   - OrbitControls for mouse/touch navigation
 *   - HTML label overlays for detected objects (from node.userData.label)
 *   - Toggleable point cloud and label visibility
 *   - Scene info HUD (point count, object count, bbox dimensions)
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScanEntry {
  filename: string
  size: number
  uploadedAt: string
}

interface Label3D {
  el: HTMLElement
  position: THREE.Vector3
  text: string
}

// ─── State ────────────────────────────────────────────────────────────────────

let renderer: THREE.WebGLRenderer
let camera: THREE.PerspectiveCamera
let controls: OrbitControls
let scene: THREE.Scene | null = null
let labels: Label3D[] = []
let labelsVisible = true
let currentPointCloud: THREE.Points | null = null
let cloudVisible = true
const labelContainer = document.getElementById('viewport')!
const loader = new GLTFLoader()

// ─── Renderer setup ───────────────────────────────────────────────────────────

function initRenderer(): void {
  const canvas = document.getElementById('viewer-canvas') as HTMLCanvasElement
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.setClearColor(0x0a0c14)

  camera = new THREE.PerspectiveCamera(60, 1, 0.01, 500)
  camera.position.set(0, 2, 4)

  controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.06
  controls.minDistance = 0.2
  controls.maxDistance = 50
  controls.maxPolarAngle = Math.PI * 0.85

  onResize()
  window.addEventListener('resize', onResize)
}

function onResize(): void {
  const vp = document.getElementById('viewport')!
  const w = vp.clientWidth, h = vp.clientHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

// ─── Render loop ──────────────────────────────────────────────────────────────

function startRenderLoop(): void {
  function tick() {
    requestAnimationFrame(tick)
    controls.update()
    if (scene) {
      renderer.render(scene, camera)
      if (labelsVisible) updateLabels()
    }
  }
  tick()
}

function updateLabels(): void {
  const vp = document.getElementById('viewport')!
  const w = vp.clientWidth
  const h = vp.clientHeight
  const v = new THREE.Vector3()

  for (const label of labels) {
    v.copy(label.position)
    v.project(camera)

    // Cull labels behind the camera or outside viewport
    if (v.z > 1) {
      label.el.style.display = 'none'
      continue
    }
    const x = (v.x * 0.5 + 0.5) * w
    const y = (-v.y * 0.5 + 0.5) * h

    if (x < -50 || x > w + 50 || y < -50 || y > h + 50) {
      label.el.style.display = 'none'
      continue
    }

    label.el.style.display = 'block'
    label.el.style.left = `${x}px`
    label.el.style.top = `${y}px`
  }
}

// ─── Scan list ────────────────────────────────────────────────────────────────

async function loadScanList(): Promise<void> {
  const listEl = document.getElementById('scan-list')!
  const emptyEl = document.getElementById('scan-list-empty')!

  try {
    const resp = await fetch('/scans')
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const scans: ScanEntry[] = await resp.json()

    listEl.innerHTML = ''

    if (scans.length === 0) {
      listEl.innerHTML = `
        <div id="scan-list-empty" style="padding:40px 16px;text-align:center;color:rgba(255,255,255,0.3);font-size:13px;line-height:1.6;">
          No scans uploaded yet.<br>Export a .glb from the AR app.
        </div>`
      return
    }

    for (const scan of scans) {
      const item = buildScanItem(scan)
      listEl.appendChild(item)
    }

    // Auto-load the first (newest) scan
    const first = listEl.querySelector<HTMLElement>('.scan-item')
    first?.click()
  } catch (err) {
    emptyEl.textContent = `Error loading scans: ${err instanceof Error ? err.message : String(err)}`
  }
}

function buildScanItem(scan: ScanEntry): HTMLElement {
  const item = document.createElement('div')
  item.className = 'scan-item'

  const date = new Date(scan.uploadedAt)
  const isToday = date.toDateString() === new Date().toDateString()
  const dateStr = isToday
    ? `Today ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const sizeMB = (scan.size / 1024 / 1024).toFixed(1)

  item.innerHTML = `
    <div class="scan-name" title="${scan.filename}">${scan.filename.replace(/^\d+_/, '')}</div>
    <div class="scan-meta">${dateStr} · ${sizeMB} MB</div>
  `

  item.addEventListener('click', () => {
    document.querySelectorAll('.scan-item').forEach(el => el.classList.remove('active'))
    item.classList.add('active')
    void loadScan(scan.filename)
  })

  return item
}

// ─── Scan loading ─────────────────────────────────────────────────────────────

async function loadScan(filename: string): Promise<void> {
  showLoading(true)
  clearLabels()
  document.getElementById('viewer-placeholder')!.style.display = 'none'

  try {
    const url = `/scans/${encodeURIComponent(filename)}`
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      loader.load(url, resolve as (g: unknown) => void, undefined, reject)
    })

    scene = new THREE.Scene()

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.6)
    const sun = new THREE.DirectionalLight(0xffffff, 1.2)
    sun.position.set(5, 10, 7)
    sun.castShadow = true
    scene.add(ambient, sun)

    // Grid
    const grid = new THREE.GridHelper(20, 40, 0x333344, 0x22232e)
    scene.add(grid)

    scene.add(gltf.scene)

    // Extract metadata and build label overlays
    const meta = gltf.scene.userData as Record<string, unknown>
    const labelNodes: Array<{ name: string; pos: THREE.Vector3; userData: Record<string, unknown> }> = []

    gltf.scene.traverse((obj) => {
      const ud = obj.userData as Record<string, unknown>
      if (ud['label'] && obj instanceof THREE.Mesh) {
        const wp = new THREE.Vector3()
        obj.getWorldPosition(wp)
        labelNodes.push({ name: String(ud['label']), pos: wp, userData: ud })
      }
      if (obj instanceof THREE.Points) {
        currentPointCloud = obj
      }
    })

    for (const n of labelNodes) {
      createLabel(n.name, n.pos, `${Math.round((n.userData['confidence'] as number ?? 0) * 100)}%`)
    }

    // Fit camera to bounding box
    fitCamera(gltf.scene)

    // HUD info
    const hud = document.getElementById('hud-info')!
    hud.classList.add('visible')
    const stats = [
      meta['pointCount'] ? `☁ ${meta['pointCount']} points` : null,
      meta['detectionCount'] ? `📍 ${meta['detectionCount']} objects` : null,
      meta['capturedAt'] ? `📅 ${new Date(String(meta['capturedAt'])).toLocaleDateString()}` : null,
    ].filter(Boolean).join('<br>')
    hud.innerHTML = stats || 'Scan loaded'

  } catch (err) {
    console.error('[viewer] Load error:', err)
    document.getElementById('viewer-placeholder')!.style.display = 'flex'
    ;(document.getElementById('viewer-placeholder')! as HTMLElement).querySelector('div:last-child')!.textContent =
      `Failed to load scan: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    showLoading(false)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createLabel(text: string, position: THREE.Vector3, detail = ''): void {
  const el = document.createElement('div')
  el.className = 'label3d'
  el.textContent = detail ? `${text} ${detail}` : text
  labelContainer.appendChild(el)
  labels.push({ el, position: position.clone(), text })
}

function clearLabels(): void {
  for (const { el } of labels) el.remove()
  labels = []
  currentPointCloud = null
}

function showLoading(visible: boolean): void {
  const el = document.getElementById('loading-overlay')!
  el.classList.toggle('visible', visible)
}

function fitCamera(object: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) return
  const center = new THREE.Vector3()
  const size = new THREE.Vector3()
  box.getCenter(center)
  box.getSize(size)
  const maxDim = Math.max(size.x, size.y, size.z)
  const fov = camera.fov * (Math.PI / 180)
  const distance = (maxDim / 2) / Math.tan(fov / 2) * 1.6

  camera.position.set(center.x + distance * 0.6, center.y + distance * 0.4, center.z + distance * 0.8)
  controls.target.copy(center)
  controls.update()
}

// ─── HUD button wiring ────────────────────────────────────────────────────────

document.getElementById('btn-reset-camera')!.addEventListener('click', () => {
  if (scene) fitCamera(scene)
  else { camera.position.set(0, 2, 4); controls.target.set(0, 0, 0); controls.update() }
})

document.getElementById('btn-toggle-cloud')!.addEventListener('click', () => {
  cloudVisible = !cloudVisible
  if (currentPointCloud) currentPointCloud.visible = cloudVisible
  const btn = document.getElementById('btn-toggle-cloud')!
  btn.style.opacity = cloudVisible ? '1' : '0.4'
})

document.getElementById('btn-toggle-labels')!.addEventListener('click', () => {
  labelsVisible = !labelsVisible
  for (const { el } of labels) {
    el.style.display = labelsVisible ? '' : 'none'
  }
  const btn = document.getElementById('btn-toggle-labels')!
  btn.style.opacity = labelsVisible ? '1' : '0.4'
})

// ─── Boot ─────────────────────────────────────────────────────────────────────

initRenderer()
startRenderLoop()
void loadScanList()
