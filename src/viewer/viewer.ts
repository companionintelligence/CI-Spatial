/**
 * Standalone 3D viewer for room scan GLTF files.
 *
 * Loads scan list from GET /scans, renders selected .glb with Three.js
 * OrbitControls. Works on desktop without any AR hardware.
 *
 * Features:
 *   - Sidebar scan list (newest first)
 *   - Sidebar edit tab with semantic tagging (via SceneEditor)
 *   - Top toolbar for view mode switching (solid / points / wireframe / semantic)
 *   - Floating object inspector on click
 *   - Three.js scene with ambient + directional lights, grid helper
 *   - OrbitControls for mouse/touch navigation
 *   - HTML label overlays for detected objects (from node.userData.label)
 *   - Toggleable point cloud and label visibility
 *   - Scene info HUD (point count, object count, bbox dimensions)
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { SceneEditor, SEMANTIC_TAGS, type ViewMode } from './editor'
import { GeoMap, type ScanLocationEntry } from './geomap'
import { LiveFeed } from './livefeed'

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
let detectionBoundsObjects: THREE.Object3D[] = []
let detectionBoundsVisible = false
const labelContainer = document.getElementById('viewport')!
const loader = new GLTFLoader()
const editor = new SceneEditor()
const geoMap = new GeoMap()
const liveFeed = new LiveFeed('default')

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

  // Mount geomap drawer and wire scan-select back to sidebar
  geoMap.mount(document.getElementById('main-area')!)
  geoMap.onScanSelect = (filename: string) => {
    const item = document.querySelector<HTMLElement>(`.scan-item[data-filename="${filename}"]`)
    item?.click()
  }

  // Mount live-feed panel
  liveFeed.mount(document.getElementById('main-area')!)
  liveFeed.onStatus = ({ state }) => {
    const btn = document.getElementById('btn-livefeed')!
    btn.classList.toggle('active', state === 'live')
    btn.textContent = state === 'live' ? '📡 Live ●' : '📡 Live'
  }
  liveFeed.onMeta = (_meta) => {
    // Future: live scan-update feed (detection counts, progress, etc.)
  }

  // Click-to-pick for semantic editor
  canvas.addEventListener('click', (e) => {
    if (!scene) return
    const rect = canvas.getBoundingClientRect()
    const ndx = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const ndy = -((e.clientY - rect.top) / rect.height) * 2 + 1
    const obj = editor.pick(ndx, ndy, camera)
    if (obj) {
      showInspector(obj)
      syncEditPanel(obj)
    } else {
      hideInspector()
    }
  })
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

// ─── Inspector panel ──────────────────────────────────────────────────────────

function showInspector(obj: THREE.Object3D): void {
  const panel = document.getElementById('inspector-panel')!
  const title = document.getElementById('inspector-title')!
  const body  = document.getElementById('inspector-body')!

  const data = editor.getInspectorData(obj)
  title.textContent = data.name || obj.name || '(unnamed)'

  const confColor = (data.confidence ?? 0) >= 0.8 ? '#66bb6a' : (data.confidence ?? 0) >= 0.5 ? '#ffa726' : '#ef9a9a'
  body.innerHTML = [
    data.tag  ? rowHtml('Tag', `<span style="background:rgba(79,195,247,0.18);color:#4fc3f7;padding:1px 6px;border-radius:4px;font-weight:700;">${data.tag}</span>`) : '',
    data.aiLabel ? rowHtml('Label', escHtml(data.aiLabel)) : '',
    data.confidence !== undefined ? rowHtml('Conf', `<span class="inspector-confidence" style="background:${confColor}22;color:${confColor};">${Math.round(data.confidence * 100)}%</span>`) : '',
    data.worldPos   ? rowHtml('Pos', `${data.worldPos.x}, ${data.worldPos.y}, ${data.worldPos.z}`) : '',
    data.dimensions ? rowHtml('Size', `${data.dimensions.w}×${data.dimensions.h}×${data.dimensions.d}m`) : '',
    data.roomName   ? rowHtml('Room', escHtml(data.roomName)) : '',
    data.floorName  ? rowHtml('Floor', escHtml(data.floorName)) : '',
    data.description ? `<div style="font-size:10.5px;color:rgba(255,255,255,0.45);line-height:1.5;margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.06);">${escHtml(data.description)}</div>` : '',
    data.notes ? `<div style="font-size:10.5px;color:rgba(255,255,255,0.4);line-height:1.5;font-style:italic;margin-top:4px;">"${escHtml(data.notes)}"</div>` : '',
  ].filter(Boolean).join('')

  panel.classList.add('visible')
}

function rowHtml(label: string, value: string): string {
  return `<div class="inspector-row"><span class="inspector-label">${label}</span><span class="inspector-value">${value}</span></div>`
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function hideInspector(): void {
  document.getElementById('inspector-panel')?.classList.remove('visible')
}

// ─── Edit panel sync ──────────────────────────────────────────────────────────

function syncEditPanel(obj: THREE.Object3D): void {
  const noSel   = document.getElementById('edit-no-selection')!
  const selInfo = document.getElementById('edit-selected-info')!
  const nameEl  = document.getElementById('edit-obj-name')!
  const metaEl  = document.getElementById('edit-obj-meta')!
  const notesEl = document.getElementById('edit-notes') as HTMLTextAreaElement

  noSel.style.display   = 'none'
  selInfo.style.display = 'block'

  const data    = editor.getInspectorData(obj)
  const tagInfo = editor.getTagInfo(obj)

  nameEl.textContent = data.name
  metaEl.innerHTML = [
    data.confidence !== undefined ? `Confidence: ${Math.round(data.confidence * 100)}%` : '',
    data.roomName  ? `Room: ${data.roomName}` : '',
    data.floorName ? `Floor: ${data.floorName}` : '',
  ].filter(Boolean).join('<br>')

  notesEl.value = tagInfo?.notes ?? data.notes ?? ''

  // Update tag chips
  const grid = document.getElementById('tag-grid')!
  grid.querySelectorAll<HTMLElement>('.tag-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset['tag'] === (tagInfo?.tag ?? data.tag))
  })

  // Auto-switch to Edit tab
  switchSidebarTab('edit')
}

// ─── Scan list ────────────────────────────────────────────────────────────────

async function loadScanList(): Promise<void> {
  const listEl  = document.getElementById('scan-list')!
  const emptyEl = document.getElementById('scan-list-empty')!

  try {
    const resp = await fetch('/scans')
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const scans: ScanEntry[] = await resp.json()

    listEl.innerHTML = ''

    if (scans.length === 0) {
      listEl.innerHTML = `
        <div id="scan-list-empty" style="padding:32px 14px;text-align:center;color:rgba(255,255,255,0.25);font-size:12px;line-height:1.6;">
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

    // Fetch geo locations and populate map (non-critical, fire-and-forget)
    void loadGeoLocations()
  } catch (err) {
    emptyEl.textContent = `Error loading scans: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function loadGeoLocations(): Promise<void> {
  try {
    const resp = await fetch('/scan-locations')
    if (!resp.ok) return
    const locations = await resp.json() as ScanLocationEntry[]
    const countEl = document.getElementById('geomap-count')
    if (countEl) countEl.textContent = locations.length > 0 ? `${locations.length} mapped` : ''
    await geoMap.updatePins(locations)
  } catch { /* geomap is non-critical */ }
}

function buildScanItem(scan: ScanEntry): HTMLElement {  const item = document.createElement('div')
  item.className = 'scan-item'
  item.dataset['filename'] = scan.filename

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
  hideInspector()
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

    // Wire editor to new scene (populates tags from userData)
    editor.setScene(scene)

    // Extract metadata and build label overlays
    const meta = gltf.scene.userData as Record<string, unknown>

    gltf.scene.traverse((obj) => {
      const ud = obj.userData as Record<string, unknown>
      if (ud['label'] && obj instanceof THREE.Mesh) {
        const wp = new THREE.Vector3()
        obj.getWorldPosition(wp)
        createLabel(String(ud['label']), wp, `${Math.round((ud['confidence'] as number ?? 0) * 100)}%`)
      }
      if (obj instanceof THREE.Points) {
        currentPointCloud = obj
      }
    })

    // Build wireframe + sparse-point overlays for detected objects
    buildDetectionBounds(gltf.scene)

    // Fit camera to bounding box
    fitCamera(gltf.scene)

    // HUD info
    const hud = document.getElementById('hud-info')!
    hud.classList.add('visible')
    const stats = [
      meta['pointCount'] ? `☁ ${meta['pointCount']} points` : null,
      meta['detectionCount'] ? `📍 ${meta['detectionCount']} objects` : null,
      meta['capturedAt'] ? `📅 ${new Date(String(meta['capturedAt'])).toLocaleDateString()}` : null,
      meta['scanName'] ? `🏷 ${meta['scanName']}` : null,
    ].filter(Boolean).join('<br>')
    hud.innerHTML = stats || 'Scan loaded'

    // Restore current view mode
    editor.setMode(editor.mode)

  } catch (err) {
    console.error('[viewer] Load error:', err)
    const ph = document.getElementById('viewer-placeholder')!
    ph.style.display = 'flex'
    const lastChild = ph.querySelector('div:last-child')
    if (lastChild) lastChild.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`
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
  clearDetectionBounds()
}

// ─── Detection bounds overlay ─────────────────────────────────────────────────

const _boundEdgeMat = new THREE.LineBasicMaterial({
  color: 0x4fc3f7,
  transparent: true,
  opacity: 0.75,
})
const _boundPtMat = new THREE.PointsMaterial({
  color: 0x80deea,
  size: 0.025,
  sizeAttenuation: true,
  transparent: true,
  opacity: 0.85,
})

function buildDetectionBounds(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const ud = obj.userData as Record<string, unknown>
    if (!ud['label']) return

    // Edge geometry — creased boundaries of the detected surface
    const edges = new THREE.EdgesGeometry(obj.geometry, 15)
    const wire = new THREE.LineSegments(edges, _boundEdgeMat.clone())
    wire.renderOrder = 2
    wire.visible = detectionBoundsVisible
    obj.add(wire)
    detectionBoundsObjects.push(wire)

    // Sparse vertex cloud — sample up to 200 points from the mesh
    const pos = obj.geometry.attributes['position']
    if (pos instanceof THREE.BufferAttribute) {
      const step = Math.max(1, Math.floor(pos.count / 200))
      const verts: number[] = []
      for (let i = 0; i < pos.count; i += step) {
        verts.push(pos.getX(i), pos.getY(i), pos.getZ(i))
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
      const pts = new THREE.Points(geo, _boundPtMat.clone())
      pts.renderOrder = 2
      pts.visible = detectionBoundsVisible
      obj.add(pts)
      detectionBoundsObjects.push(pts)
    }
  })
}

function clearDetectionBounds(): void {
  for (const obj of detectionBoundsObjects) {
    if (obj.parent) obj.removeFromParent()
  }
  detectionBoundsObjects = []
  detectionBoundsVisible = false
  const btn = document.getElementById('btn-toggle-bounds')
  if (btn) { btn.style.opacity = '0.4'; btn.classList.remove('active-hud') }
}

function showLoading(visible: boolean): void {
  document.getElementById('loading-overlay')!.classList.toggle('visible', visible)
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

function switchSidebarTab(name: string): void {
  document.querySelectorAll('.sidebar-tab').forEach(btn => {
    const el = btn as HTMLButtonElement
    el.classList.toggle('active', el.dataset['tab'] === name)
  })
  document.querySelectorAll('.sidebar-panel').forEach(panel => {
    const el = panel as HTMLElement
    el.classList.toggle('active', el.id === `tab-${name}`)
  })
}

// ─── Sidebar tab switching ────────────────────────────────────────────────────

document.querySelectorAll('.sidebar-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    switchSidebarTab((btn as HTMLButtonElement).dataset['tab']!)
  })
})

// ─── Tag chip setup (Edit panel) ─────────────────────────────────────────────

const tagGrid = document.getElementById('tag-grid')!
for (const tag of SEMANTIC_TAGS) {
  const chip = document.createElement('button')
  chip.className = 'tag-chip'
  chip.textContent = tag
  chip.dataset['tag'] = tag
  chip.addEventListener('click', () => {
    const obj = editor.selectedObject
    if (!obj) return
    editor.tagObject(obj, tag)
    tagGrid.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('active'))
    chip.classList.add('active')
    // Refresh inspector if visible
    if (document.getElementById('inspector-panel')!.classList.contains('visible')) {
      showInspector(obj)
    }
  })
  tagGrid.appendChild(chip)
}

// Save notes button
document.getElementById('edit-save-notes')?.addEventListener('click', () => {
  const obj = editor.selectedObject
  if (!obj) return
  const notes = (document.getElementById('edit-notes') as HTMLTextAreaElement).value
  const existing = editor.getTagInfo(obj)
  if (existing) {
    editor.tagObject(obj, existing.tag, { ...existing, notes })
  } else {
    editor.tagObject(obj, 'unknown', { notes })
  }
})

// ─── Top toolbar: view mode buttons ──────────────────────────────────────────

document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset['mode'] as ViewMode
    editor.setMode(mode)
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    // Toggle point-cloud visibility based on mode
    if (currentPointCloud) {
      currentPointCloud.visible = mode === 'points' || mode === 'solid' || mode === 'semantic'
    }
  })
})

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

document.getElementById('btn-flush-tags')!.addEventListener('click', () => {
  editor.flushTags()
  const btn = document.getElementById('btn-flush-tags')!
  btn.textContent = '✓ Saved'
  btn.style.color = '#66bb6a'
  setTimeout(() => {
    btn.textContent = '💾 Save Tags'
    btn.style.color = ''
  }, 2000)
})

document.getElementById('inspector-close')!.addEventListener('click', hideInspector)

document.getElementById('btn-toggle-bounds')!.addEventListener('click', () => {
  detectionBoundsVisible = !detectionBoundsVisible
  for (const obj of detectionBoundsObjects) obj.visible = detectionBoundsVisible
  const btn = document.getElementById('btn-toggle-bounds')!
  btn.style.opacity = detectionBoundsVisible ? '1' : '0.4'
  btn.classList.toggle('active-hud', detectionBoundsVisible)
})

document.getElementById('btn-geomap')!.addEventListener('click', () => {
  geoMap.toggle()
  const isOpen = document.getElementById('geomap-drawer')?.classList.contains('geomap-open')
  document.getElementById('btn-geomap')!.classList.toggle('active', !!isOpen)
})

document.getElementById('btn-livefeed')!.addEventListener('click', () => {
  liveFeed.toggle()
  // Auto-connect to signaling server the first time the panel is opened
  if (liveFeed.isOpen) liveFeed.connect()
})

// ─── Boot ─────────────────────────────────────────────────────────────────────

initRenderer()
startRenderLoop()
void loadScanList()

