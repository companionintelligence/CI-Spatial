/**
 * Companion Scan world editor.
 *
 * Loads a WorldProject manifest, places many GLB scans in one ENU/Y-up Three.js
 * scene, exposes per-layer visibility, and persists scan/object edits as
 * sidecar EditPatch records on the Deno coordinator.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { SceneEditor, SEMANTIC_TAGS, type ViewMode } from './editor'
import { MeasureTool } from './measure'
import { GeoMap, type ScanLocationEntry } from './geomap'
import { LiveFeed } from './livefeed'
import { loadSemanticAsset, createMediumPolyAsset } from './assets'
import { fetchLingBotMapArtifacts, type LingBotMapOverlay } from './lingbot-map'
import { enuToGeo, hasGeoPose, matrixTranslation } from '../world/geo'
import { LAYER_LABELS, LAYER_ORDER } from '../world/layers'
import { registerPWA } from '../pwa'
import type {
  EditPatch,
  FrameObservation,
  LayerType,
  ScanManifest,
  WorldJob,
  WorldJobType,
  WorldProject,
} from '../world/types'

registerPWA()

interface Label3D {
  el: HTMLElement
  position: THREE.Vector3
  text: string
  object?: THREE.Object3D
  scanId?: string
  layerType: LayerType
}

interface LoadedScan {
  manifest: ScanManifest
  root: THREE.Group
  layerNodes: Map<LayerType, Set<THREE.Object3D>>
  points: THREE.Points[]
  visible: boolean
  loaded: boolean
  error?: string
}

interface PatchResponse {
  ok: boolean
  patch: EditPatch
  world: WorldProject
}

interface ShareLinksResponse {
  worldId: string
  shareSlug: string
  links: Record<string, string>
}

/** Optimization manifest written by the server's optimize-scan job */
interface OptimizationManifest {
  artifacts: {
    optimized: { filename: string; bytes: number; draco: boolean; quantized: boolean }
    /** Coarsest first — lods[0] is the instant preview */
    lods: Array<{ filename: string; bytes: number; points: number; voxelM: number }>
  }
}

const query = new URLSearchParams(location.search)
const initialWorldSlug = query.get('world') || 'default'
const accessToken = query.get('token') || ''

function withAccessToken(url: string): string {
  if (!accessToken) return url
  const parsed = new URL(url, location.origin)
  parsed.searchParams.set('token', accessToken)
  return parsed.pathname + parsed.search + parsed.hash
}

function accessHeaders(extra: HeadersInit = {}): HeadersInit {
  return accessToken ? { ...extra, Authorization: `Bearer ${accessToken}` } : extra
}

const loader = new GLTFLoader()
// Optimized scans may carry KHR_draco_mesh_compression; decoder files are
// copied to public/draco/ by scripts/copy-draco.mjs (npm postinstall).
const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderPath('/draco/')
loader.setDRACOLoader(dracoLoader)
const editor = new SceneEditor()
const measure = new MeasureTool(() => scene, document.getElementById('viewport')!)
// Test hook: lets Playwright assert measured distances against expected.json
;(window as unknown as { __measureTool: MeasureTool }).__measureTool = measure
const geoMap = new GeoMap()
const liveFeed = new LiveFeed(initialWorldSlug)
const labelContainer = document.getElementById('viewport')!
const loadedScans = new Map<string, LoadedScan>()
const scanItems = new Map<string, HTMLElement>()
const globalLayerVisible = LAYER_ORDER.reduce((acc, type) => {
  acc[type] = type !== 'rgbFrames' && type !== 'depth' && type !== 'semanticMasks' && type !== 'splat'
  return acc
}, {} as Record<LayerType, boolean>)

let renderer: THREE.WebGLRenderer
let camera: THREE.PerspectiveCamera
let controls: OrbitControls
let transformControls: TransformControls | null = null
let scene: THREE.Scene | null = null
let worldGroup: THREE.Group | null = null
let labels: Label3D[] = []
let labelsVisible = true
let cloudVisible = true
let detectionBoundsObjects: THREE.Object3D[] = []
let detectionBoundsVisible = false
let world: WorldProject | null = null
let selectedTransformTarget: THREE.Object3D | null = null
let selectedScanId: string | null = null
let isTransformDragging = false

const lingbotOverlays = new Map<string, LingBotMapOverlay>()
let lingbotShowPoints = false
let lingbotShowPath = false

const boundEdgeMaterial = new THREE.LineBasicMaterial({
  color: 0x4fc3f7,
  transparent: true,
  opacity: 0.75,
})
const boundPointMaterial = new THREE.PointsMaterial({
  color: 0x80deea,
  size: 0.025,
  sizeAttenuation: true,
  transparent: true,
  opacity: 0.85,
})
const cameraFrustumMaterial = new THREE.LineBasicMaterial({
  color: 0xffd54f,
  transparent: true,
  opacity: 0.72,
})
const cameraPathMaterial = new THREE.LineBasicMaterial({
  color: 0xff8a65,
  transparent: true,
  opacity: 0.7,
})

// ─── Renderer setup ──────────────────────────────────────────────────────────

function initRenderer(): void {
  const canvas = document.getElementById('viewer-canvas') as HTMLCanvasElement
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.setClearColor(0x0a0c14)

  camera = new THREE.PerspectiveCamera(60, 1, 0.01, 800)
  camera.position.set(5, 4, 6)

  controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.06
  controls.minDistance = 0.2
  controls.maxDistance = 250
  controls.maxPolarAngle = Math.PI * 0.9

  transformControls = new TransformControls(camera, canvas)
  transformControls.setMode('translate')
  transformControls.addEventListener('dragging-changed', (event) => {
    isTransformDragging = !!(event as { value?: boolean }).value
    controls.enabled = !isTransformDragging
  })
  transformControls.addEventListener('objectChange', () => {
    updateTransformReadout()
    updateWorldHud()
  })

  onResize()
  window.addEventListener('resize', onResize)

  geoMap.mount(document.getElementById('main-area')!)
  geoMap.onScanSelect = (filename: string) => {
    const item = document.querySelector<HTMLElement>(`.scan-item[data-filename="${cssEscape(filename)}"]`)
    item?.click()
  }

  liveFeed.mount(document.getElementById('main-area')!)
  liveFeed.onStatus = ({ state }) => {
    const btn = document.getElementById('btn-livefeed')!
    btn.classList.toggle('active', state === 'live')
    btn.textContent = state === 'live' ? 'Live *' : 'Live'
  }
  liveFeed.onMeta = (meta) => {
    upsertLiveFrustum(meta)
  }
  // Live geometry from the phone's data channel: point-cloud deltas,
  // detection snapshots, and camera pose — the scan grows in the editor
  // in real time while someone walks the room.
  liveFeed.onData = (msg) => {
    switch (msg['t']) {
      case 'hello':
        liveReset()
        break
      case 'pts':
        liveAddPoints(msg['p'] as number[])
        break
      case 'dets':
        liveSetDetections((msg['items'] ?? []) as Array<{ label?: string; confidence?: number; pos?: number[] }>)
        break
      case 'pose': {
        const p = msg['p'] as number[] | undefined
        if (Array.isArray(p) && p.length >= 3) {
          upsertLiveFrustum({ position: { x: p[0], y: p[1], z: p[2] } })
        }
        break
      }
    }
  }

  canvas.addEventListener('click', (event) => {
    if (!scene || isTransformDragging) return
    const rect = canvas.getBoundingClientRect()
    const ndx = ((event.clientX - rect.left) / rect.width) * 2 - 1
    const ndy = -((event.clientY - rect.top) / rect.height) * 2 + 1
    // Measure mode swallows clicks before selection
    if (measure.handleClick(ndx, ndy, camera)) return
    const obj = editor.pick(ndx, ndy, camera)
    if (obj) {
      selectEditableObject(obj)
    } else {
      clearSelection()
    }
  })
}

function onResize(): void {
  const viewport = document.getElementById('viewport')!
  const width = Math.max(1, viewport.clientWidth)
  const height = Math.max(1, viewport.clientHeight)
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

function initWorldScene(): void {
  clearLabels()
  loadedScans.clear()
  scanItems.clear()
  selectedTransformTarget = null
  selectedScanId = null
  hideInspectorOnly()

  scene = new THREE.Scene()
  scene.name = 'Companion Scan World'

  const ambient = new THREE.AmbientLight(0xffffff, 0.62)
  const sun = new THREE.DirectionalLight(0xffffff, 1.15)
  sun.position.set(6, 12, 8)
  sun.castShadow = true
  scene.add(ambient, sun)

  const grid = new THREE.GridHelper(80, 80, 0x2f3645, 0x1d2230)
  grid.name = 'World ENU meter grid'
  scene.add(grid)

  const axes = new THREE.AxesHelper(1.5)
  axes.name = 'World axes'
  axes.position.set(0, 0.02, 0)
  scene.add(axes)

  worldGroup = new THREE.Group()
  worldGroup.name = 'World scan roots'
  scene.add(worldGroup)

  if (transformControls) {
    scene.add(transformControls.getHelper())
    transformControls.detach()
  }

  editor.setScene(scene)
}

// ─── Render loop ─────────────────────────────────────────────────────────────

function startRenderLoop(): void {
  function tick() {
    requestAnimationFrame(tick)
    controls.update()
    if (scene) {
      updatePointCloudLOD()
      renderer.render(scene, camera)
      updateLabels()
      measure.updateLabel(camera)
      updateWorldHud()
    }
  }
  tick()
}

function updatePointCloudLOD(): void {
  for (const scan of loadedScans.values()) {
    for (const points of scan.points) {
      const positionAttr = points.geometry.getAttribute('position')
      if (!positionAttr) continue

      points.geometry.computeBoundingBox()
      const center = new THREE.Vector3()
      points.geometry.boundingBox?.getCenter(center)
      points.localToWorld(center)

      const distance = camera.position.distanceTo(center)
      const total = positionAttr.count
      if (distance > 35) {
        points.geometry.setDrawRange(0, Math.floor(total * 0.18))
      } else if (distance > 16) {
        points.geometry.setDrawRange(0, Math.floor(total * 0.5))
      } else {
        points.geometry.setDrawRange(0, total)
      }
    }
  }
}

function updateLabels(): void {
  const viewport = document.getElementById('viewport')!
  const width = viewport.clientWidth
  const height = viewport.clientHeight
  const projected = new THREE.Vector3()

  for (const label of labels) {
    if (!isLabelVisible(label)) {
      label.el.style.display = 'none'
      continue
    }

    const position = label.object ? label.object.getWorldPosition(new THREE.Vector3()) : label.position
    projected.copy(position).project(camera)

    if (projected.z > 1) {
      label.el.style.display = 'none'
      continue
    }

    const x = (projected.x * 0.5 + 0.5) * width
    const y = (-projected.y * 0.5 + 0.5) * height
    if (x < -80 || x > width + 80 || y < -80 || y > height + 80) {
      label.el.style.display = 'none'
      continue
    }

    label.el.style.display = 'block'
    label.el.style.left = `${x}px`
    label.el.style.top = `${y}px`
  }
}

function isLabelVisible(label: Label3D): boolean {
  if (!labelsVisible || !globalLayerVisible.labels) return false
  if (!label.scanId) return true
  return loadedScans.get(label.scanId)?.visible ?? true
}

// ─── World loading ───────────────────────────────────────────────────────────

async function loadWorldProject(): Promise<void> {
  showLoading(true, 'Loading world...')
  initWorldScene()

  try {
    const slug = encodeURIComponent(initialWorldSlug)
    const loadedWorld = await fetchJson<WorldProject>(`/worlds/${slug}`)
    world = loadedWorld
    document.title = `${loadedWorld.name} - Companion Scan`
    document.getElementById('viewer-placeholder')!.style.display = loadedWorld.scans.length ? 'none' : 'flex'

    buildScanList(loadedWorld.scans)
    renderWorldPanel()
    renderLayerPanel()
    void loadGeoLocations()
    void loadShareLinks()

    if (loadedWorld.scans.length === 0) {
      updateHudInfo('No scans in this world yet.')
      return
    }

    const results = await Promise.allSettled(loadedWorld.scans.map(loadScanIntoWorld))
    const loadedCount = results.filter(result => result.status === 'fulfilled').length
    if (loadedCount > 0 && worldGroup) {
      fitCamera(worldGroup)
      const first = loadedWorld.scans.find(scan => loadedScans.get(scan.scanId)?.loaded)
      if (first) selectScan(first.scanId, false, false)
    } else {
      const placeholder = document.getElementById('viewer-placeholder')!
      placeholder.style.display = 'flex'
      const message = placeholder.querySelector('div:last-child')
      if (message) message.textContent = 'No renderable scans were found. Empty or invalid GLBs are skipped gracefully.'
    }

    updateHudInfo()
    renderLayerPanel()
  } catch (error) {
    console.error('[viewer] World load error:', error)
    const placeholder = document.getElementById('viewer-placeholder')!
    placeholder.style.display = 'flex'
    const message = placeholder.querySelector('div:last-child')
    if (message) message.textContent = `Failed to load world: ${errorMessage(error)}`
  } finally {
    showLoading(false)
  }
}

function buildScanList(scans: ScanManifest[]): void {
  const listEl = document.getElementById('scan-list')!
  listEl.innerHTML = ''
  scanItems.clear()

  if (scans.length === 0) {
    listEl.innerHTML = `
      <div id="scan-list-empty">
        No scans uploaded yet.<br>Open the scanner link and export a GLB into this world.
      </div>`
    return
  }

  for (const scan of scans) {
    const item = buildScanItem(scan)
    scanItems.set(scan.scanId, item)
    listEl.appendChild(item)
  }
}

function buildScanItem(scan: ScanManifest): HTMLElement {
  const item = document.createElement('div')
  item.className = 'scan-item'
  item.dataset['scanId'] = scan.scanId
  item.dataset['filename'] = scan.filename

  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.className = 'scan-visible'
  checkbox.checked = true
  checkbox.title = 'Toggle scan visibility'
  checkbox.addEventListener('click', (event) => event.stopPropagation())
  checkbox.addEventListener('change', () => {
    const loaded = loadedScans.get(scan.scanId)
    if (loaded) {
      loaded.visible = checkbox.checked
      loaded.root.visible = loaded.visible
      applyLayerVisibility()
    }
  })

  const details = document.createElement('div')
  const captured = scan.capturedAt ? new Date(scan.capturedAt) : null
  const capturedLabel = captured && !Number.isNaN(captured.getTime())
    ? captured.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Unknown date'
  const accuracy = scan.accuracyM != null ? `accuracy ${scan.accuracyM.toFixed(1)}m` : 'manual align'
  const quality = scan.qualitySummary
  const qualityLabel = quality
    ? `${quality.status.replace('-', ' ')} · ${Math.round(quality.coverageScore * 100)}% coverage`
    : scan.status.replace('-', ' ')
  details.innerHTML = `
    <div class="scan-name" title="${escHtml(scan.filename)}">${escHtml(scan.name || scan.filename.replace(/\\.glb$/, ''))}</div>
    <div class="scan-meta">${capturedLabel} · ${accuracy}</div>
    <div class="scan-status" data-review-status="${escHtml(scan.status)}">${escHtml(qualityLabel)}</div>
  `

  item.append(checkbox, details)
  item.addEventListener('click', () => {
    selectScan(scan.scanId, true)
  })
  return item
}

/**
 * Progressive scan load.  When the server's optimize-scan job has produced
 * artifacts, the coarsest point-cloud LOD is shown within a few hundred ms
 * and the full-quality (quantized/Draco) GLB streams in behind it and swaps
 * atomically.  Unoptimized scans fall back to a single-pass load.
 */
async function loadScanIntoWorld(scan: ScanManifest): Promise<void> {
  if (!worldGroup) throw new Error('World scene was not initialized')
  setScanStatus(scan.scanId, 'Loading GLB...')

  try {
    const optimization = await fetchOptimizationManifest(scan.filename)
    const preview = optimization?.artifacts.lods[0]
    const optimized = optimization?.artifacts.optimized

    if (preview) {
      setScanStatus(scan.scanId, `Preview ${formatKB(preview.bytes)}...`)
      integrateScanRoot(scan, await loadGlbRoot(`/scans/${encodeURIComponent(preview.filename)}`))
      setScanStatus(scan.scanId, 'Preview shown - loading full quality...')
    }

    const fullUrl = optimized
      ? `/scans/${encodeURIComponent(optimized.filename)}`
      : scan.glbUrl
    integrateScanRoot(scan, await loadGlbRoot(fullUrl))
    setScanStatus(scan.scanId, optimized
      ? `Ready - optimized ${formatKB(optimized.bytes)}${optimized.draco ? ' - draco' : ''}`
      : 'Ready')
  } catch (error) {
    const message = errorMessage(error)
    loadedScans.set(scan.scanId, {
      manifest: scan,
      root: new THREE.Group(),
      layerNodes: new Map(),
      points: [],
      visible: false,
      loaded: false,
      error: message,
    })
    setScanStatus(scan.scanId, `Error: ${message}`)
    throw error
  }
}

async function fetchOptimizationManifest(filename: string): Promise<OptimizationManifest | null> {
  try {
    const resp = await fetch(`/scans/${encodeURIComponent(filename)}/manifest`)
    if (!resp.ok) return null
    const manifest = await resp.json() as OptimizationManifest
    return manifest.artifacts?.optimized ? manifest : null
  } catch {
    return null
  }
}

function loadGlbRoot(url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    loader.load(url, (gltf) => {
      const g = gltf as { scene?: THREE.Group; scenes?: THREE.Group[] }
      const root = g.scene ?? g.scenes?.[0]
      if (root) resolve(root)
      else reject(new Error('Scan GLB has no scene graph'))
    }, undefined, reject)
  })
}

/**
 * Attach a freshly loaded scan root to the world, replacing any previously
 * loaded root for the same scan (LOD preview → full quality swap).
 */
function integrateScanRoot(scan: ScanManifest, root: THREE.Group): void {
  if (!worldGroup) return

  // Tear down the previous generation of this scan (preview pass)
  const previous = loadedScans.get(scan.scanId)
  if (previous && previous.loaded) {
    worldGroup.remove(previous.root)
    removeLabelsForScan(scan.scanId)
    detectionBoundsObjects = detectionBoundsObjects.filter((obj) => {
      let current: THREE.Object3D | null = obj
      while (current) {
        if (current === previous.root) return false
        current = current.parent
      }
      return true
    })
  }

  root.name = scan.name || scan.filename
  root.userData['scanId'] = scan.scanId
  root.userData['filename'] = scan.filename
  root.userData['scope'] = 'scan-root'
  root.userData['objectId'] = scan.scanId

  applyMatrix(root, scan.localToWorld)
  upgradeSemanticMeshes(root, scan.scanId)
  assignStableObjectIds(root, scan.scanId)
  applyStoredPatches(root, scan)

  const layerNodes = collectLayerNodes(root)
  const points = collectPoints(root)
  addDerivedCameraLayers(root, scan, layerNodes)
  buildDetectionBounds(root, scan.scanId, layerNodes)
  createSemanticLabels(root, scan.scanId)

  worldGroup.add(root)
  root.visible = previous?.visible ?? true
  loadedScans.set(scan.scanId, {
    manifest: scan,
    root,
    layerNodes,
    points,
    visible: previous?.visible ?? true,
    loaded: true,
  })

  editor.setScene(scene!)
  editor.setMode(editor.mode)
  applyLayerVisibility()
}

function removeLabelsForScan(scanId: string): void {
  labels = labels.filter((label) => {
    if (label.scanId !== scanId) return true
    label.el.remove()
    return false
  })
}

function formatKB(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

function upgradeSemanticMeshes(root: THREE.Object3D, scanId: string): void {
  const semanticMeshes: THREE.Mesh[] = []
  root.traverse((obj) => {
    const data = obj.userData as Record<string, unknown>
    if (obj instanceof THREE.Mesh && data['label']) semanticMeshes.push(obj)
  })

  for (const mesh of semanticMeshes) {
    const data = mesh.userData as Record<string, unknown>
    const label = String(data['label'])
    const parent = mesh.parent
    if (!parent) continue

    const lod = new THREE.LOD()
    lod.name = `LOD_${mesh.name || label}`
    lod.userData = {
      ...mesh.userData,
      scanId,
      objectId: `${scanId}:${mesh.name || label}:lod`,
    }
    lod.position.copy(mesh.position)
    lod.quaternion.copy(mesh.quaternion)
    lod.scale.copy(mesh.scale)

    parent.remove(mesh)
    mesh.position.set(0, 0, 0)
    mesh.quaternion.set(0, 0, 0, 1)
    mesh.scale.set(1, 1, 1)
    lod.addLevel(mesh, 8)

    const medium = createMediumPolyAsset(label)
    medium.userData = lod.userData
    lod.addLevel(medium, 4)

    void loadSemanticAsset(label).then((high) => {
      high.userData = lod.userData
      lod.addLevel(high, 0)
    }).catch((error) => {
      console.warn(`[viewer] Failed high-detail semantic asset for ${label}:`, error)
    })

    parent.add(lod)
  }
}

function assignStableObjectIds(root: THREE.Object3D, scanId: string): void {
  const walk = (obj: THREE.Object3D, path: string): void => {
    const data = obj.userData as Record<string, unknown>
    data['scanId'] = data['scanId'] ?? scanId
    if (!data['objectId']) {
      const name = safeObjectToken(obj.name || obj.type || 'node')
      data['objectId'] = `${scanId}/${path}-${name}`
    }
    obj.children.forEach((child, index) => walk(child, path ? `${path}.${index}` : String(index)))
  }
  walk(root, '0')
}

function applyStoredPatches(root: THREE.Object3D, scan: ScanManifest): void {
  if (!world) return

  for (const patch of world.editPatches) {
    if (patch.scanId && patch.scanId !== scan.scanId && patch.scanId !== scan.filename) continue

    if (patch.scope === 'scan' && (patch.targetId === scan.filename || patch.scanId === scan.scanId)) {
      if (patch.transform?.matrix) applyMatrix(root, patch.transform.matrix)
      continue
    }

    if (patch.scope !== 'object') continue
    const target = findObjectByTargetId(root, patch.targetId)
    if (!target) continue

    if (patch.transform?.matrix) applyMatrix(target, patch.transform.matrix)
    if (patch.category) target.userData['tag'] = patch.category
    if (patch.label) target.userData['label'] = patch.label
    if (patch.notes) target.userData['notes'] = patch.notes
    if (typeof patch.visible === 'boolean') target.visible = patch.visible
  }
}

function collectLayerNodes(root: THREE.Object3D): Map<LayerType, Set<THREE.Object3D>> {
  const layers = new Map<LayerType, Set<THREE.Object3D>>()
  for (const type of LAYER_ORDER) layers.set(type, new Set())

  root.traverse((obj) => {
    const data = obj.userData as Record<string, unknown>
    const name = `${obj.name} ${data['tag'] ?? ''} ${data['label'] ?? ''}`.toLowerCase()

    if (obj instanceof THREE.Points) {
      addLayerNode(layers, 'points', obj)
    } else if (obj instanceof THREE.Mesh) {
      if (name.includes('floor')) addLayerNode(layers, 'floor', obj)
      else addLayerNode(layers, 'mesh', obj)
    } else if (obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
      if (name.includes('camera') || name.includes('path')) addLayerNode(layers, 'cameraPath', obj)
    }
  })

  return layers
}

function collectPoints(root: THREE.Object3D): THREE.Points[] {
  const points: THREE.Points[] = []
  root.traverse((obj) => {
    if (obj instanceof THREE.Points) points.push(obj)
  })
  return points
}

function addLayerNode(
  layers: Map<LayerType, Set<THREE.Object3D>>,
  type: LayerType,
  obj: THREE.Object3D,
): void {
  layers.get(type)?.add(obj)
  obj.userData['layerType'] = type
}

function addDerivedCameraLayers(
  root: THREE.Object3D,
  scan: ScanManifest,
  layers: Map<LayerType, Set<THREE.Object3D>>,
): void {
  if (scan.frameSetUrl) {
    void addFrameObservationLayers(root, scan, layers).catch((error) => {
      console.warn(`[viewer] Frame observation load failed for ${scan.name}:`, error)
      addPlaceholderCameraLayers(root, scan, layers)
    })
    return
  }
  addPlaceholderCameraLayers(root, scan, layers)
}

function addPlaceholderCameraLayers(
  root: THREE.Object3D,
  scan: ScanManifest,
  layers: Map<LayerType, Set<THREE.Object3D>>,
): void {
  const pathPoints = [
    new THREE.Vector3(-0.8, 0.35, -0.8),
    new THREE.Vector3(-0.35, 0.5, -0.35),
    new THREE.Vector3(0.05, 0.6, 0.1),
    new THREE.Vector3(0.5, 0.55, 0.35),
  ]
  const pathGeometry = new THREE.BufferGeometry().setFromPoints(pathPoints)
  const path = new THREE.Line(pathGeometry, cameraPathMaterial.clone())
  path.name = `${scan.name} camera path`
  path.userData['scanId'] = scan.scanId
  root.add(path)
  addLayerNode(layers, 'cameraPath', path)

  const frustumGroup = new THREE.Group()
  frustumGroup.name = `${scan.name} camera frustums`
  frustumGroup.userData['scanId'] = scan.scanId
  for (let i = 0; i < pathPoints.length; i += 1) {
    const frustum = createCameraFrustumMesh(0.22 + i * 0.015, 0.35)
    frustum.position.copy(pathPoints[i]!)
    frustum.rotation.y = i * 0.35
    frustumGroup.add(frustum)
  }
  root.add(frustumGroup)
  addLayerNode(layers, 'cameraFrustums', frustumGroup)
}

async function addFrameObservationLayers(
  root: THREE.Object3D,
  scan: ScanManifest,
  layers: Map<LayerType, Set<THREE.Object3D>>,
): Promise<void> {
  const response = await fetch(withAccessToken(scan.frameSetUrl!))
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  const payload = await response.json() as { frames?: FrameObservation[] }
  const frames = payload.frames ?? []
  if (frames.length === 0) {
    addPlaceholderCameraLayers(root, scan, layers)
    return
  }

  const frameGroup = new THREE.Group()
  frameGroup.name = `${scan.name} frame observations`
  frameGroup.userData['scanId'] = scan.scanId
  frameGroup.userData['layerType'] = 'cameraFrustums'

  const points = frames
    .map(frame => new THREE.Vector3(frame.pose.position.x, frame.pose.position.y, frame.pose.position.z))

  if (points.length >= 2) {
    const path = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      cameraPathMaterial.clone(),
    )
    path.name = `${scan.name} camera path`
    path.userData['scanId'] = scan.scanId
    path.userData['layerType'] = 'cameraPath'
    root.add(path)
    addLayerNode(layers, 'cameraPath', path)
  }

  const stride = Math.max(1, Math.ceil(frames.length / 48))
  for (let i = 0; i < frames.length; i += stride) {
    const frame = frames[i]!
    const frustum = createCameraFrustumMesh(0.18, 0.32)
    frustum.name = `${scan.name} frustum ${i}`
    frustum.position.set(frame.pose.position.x, frame.pose.position.y, frame.pose.position.z)
    frustum.quaternion.set(frame.pose.rotation.x, frame.pose.rotation.y, frame.pose.rotation.z, frame.pose.rotation.w)
    frustum.userData['scanId'] = scan.scanId
    frustum.userData['layerType'] = 'cameraFrustums'
    frameGroup.add(frustum)
  }
  root.add(frameGroup)
  addLayerNode(layers, 'cameraFrustums', frameGroup)

  const rgbGroup = new THREE.Group()
  rgbGroup.name = `${scan.name} RGB frames`
  rgbGroup.userData['scanId'] = scan.scanId
  rgbGroup.userData['layerType'] = 'rgbFrames'
  const textureLoader = new THREE.TextureLoader()
  const thumbStride = Math.max(1, Math.ceil(frames.length / 12))
  for (let i = 0; i < frames.length; i += thumbStride) {
    const frame = frames[i]!
    const texture = textureLoader.load(withAccessToken(frame.rgbUrl))
    texture.colorSpace = THREE.SRGBColorSpace
    const aspect = frame.intrinsics.width / Math.max(1, frame.intrinsics.height)
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(0.28 * aspect, 0.28),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true, opacity: 0.86 }),
    )
    plane.name = `${scan.name} RGB frame ${i}`
    plane.position.set(frame.pose.position.x, frame.pose.position.y, frame.pose.position.z)
    plane.quaternion.set(frame.pose.rotation.x, frame.pose.rotation.y, frame.pose.rotation.z, frame.pose.rotation.w)
    plane.translateZ(-0.18)
    plane.userData['scanId'] = scan.scanId
    plane.userData['layerType'] = 'rgbFrames'
    rgbGroup.add(plane)
  }
  root.add(rgbGroup)
  addLayerNode(layers, 'rgbFrames', rgbGroup)

  applyLayerVisibility()
}

function createCameraFrustumMesh(size: number, depth: number): THREE.LineSegments {
  const half = size * 0.5
  const vertices = [
    0, 0, 0, -half, -half, -depth,
    0, 0, 0, half, -half, -depth,
    0, 0, 0, half, half, -depth,
    0, 0, 0, -half, half, -depth,
    -half, -half, -depth, half, -half, -depth,
    half, -half, -depth, half, half, -depth,
    half, half, -depth, -half, half, -depth,
    -half, half, -depth, -half, -half, -depth,
  ]
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  const frustum = new THREE.LineSegments(geometry, cameraFrustumMaterial.clone())
  frustum.name = 'camera frustum'
  return frustum
}

function buildDetectionBounds(
  root: THREE.Object3D,
  scanId: string,
  layers: Map<LayerType, Set<THREE.Object3D>>,
): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const data = obj.userData as Record<string, unknown>
    if (!data['label']) return

    const edges = new THREE.EdgesGeometry(obj.geometry, 15)
    const wire = new THREE.LineSegments(edges, boundEdgeMaterial.clone())
    wire.name = `${obj.name || data['label']} detection bounds`
    wire.renderOrder = 2
    wire.userData['scanId'] = scanId
    wire.userData['layerType'] = 'detections'
    obj.add(wire)
    detectionBoundsObjects.push(wire)
    addLayerNode(layers, 'detections', wire)

    const positionAttr = obj.geometry.attributes['position']
    if (positionAttr instanceof THREE.BufferAttribute) {
      const step = Math.max(1, Math.floor(positionAttr.count / 200))
      const verts: number[] = []
      for (let i = 0; i < positionAttr.count; i += step) {
        verts.push(positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i))
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
      const points = new THREE.Points(geometry, boundPointMaterial.clone())
      points.name = `${obj.name || data['label']} detection samples`
      points.renderOrder = 2
      points.userData['scanId'] = scanId
      points.userData['layerType'] = 'detections'
      obj.add(points)
      detectionBoundsObjects.push(points)
      addLayerNode(layers, 'detections', points)
    }
  })
}

function createSemanticLabels(root: THREE.Object3D, scanId: string): void {
  root.traverse((obj) => {
    const data = obj.userData as Record<string, unknown>
    if (!data['label']) return
    const label = String(data['label'])
    const confidence = typeof data['confidence'] === 'number' ? ` ${Math.round(data['confidence'] * 100)}%` : ''
    createLabel(`${label}${confidence}`, obj.getWorldPosition(new THREE.Vector3()), {
      object: obj,
      scanId,
      layerType: 'labels',
    })
  })
}

// ─── Selection, inspector, and edit patches ──────────────────────────────────

function selectScan(scanId: string, focus: boolean, openEdit = true): void {
  const loaded = loadedScans.get(scanId)
  if (!loaded || !loaded.loaded) return

  document.querySelectorAll('.scan-item').forEach(el => el.classList.remove('active'))
  scanItems.get(scanId)?.classList.add('active')
  selectedScanId = scanId
  selectedTransformTarget = loaded.root
  transformControls?.attach(loaded.root)
  showInspector(loaded.root)
  syncEditPanel(loaded.root, openEdit)
  if (focus) fitCamera(loaded.root)
  void refreshLingBotMapPanel(scanId)
}

async function refreshLingBotMapPanel(scanId: string): Promise<void> {
  const status = document.getElementById('lingbot-map-status')
  const stats = document.getElementById('lingbot-map-stats')
  if (!status || !stats) return
  const scan = world?.scans.find(s => s.scanId === scanId)
  if (!scan) {
    status.textContent = 'Select a scan to see its LingBot-Map reconstruction.'
    stats.textContent = ''
    return
  }
  if (!scan.sessionId) {
    status.textContent = 'This scan has no streamed keyframes — start keyframe streaming first.'
    stats.textContent = ''
    return
  }
  let overlay = lingbotOverlays.get(scanId)
  if (!overlay) {
    status.textContent = 'Loading LingBot-Map artifacts…'
    try {
      const fetched = await fetchLingBotMapArtifacts(scan, (url) => fetch(withAccessToken(url)))
      if (!fetched) {
        status.textContent = 'No LingBot-Map manifest yet. Queue the lingbot-map-reconstruct job to create one.'
        stats.textContent = ''
        return
      }
      overlay = fetched
      lingbotOverlays.set(scanId, overlay)
      const loaded = loadedScans.get(scanId)
      if (loaded) {
        loaded.root.add(overlay.pointsGroup, overlay.pathGroup)
        overlay.pointsGroup.visible = lingbotShowPoints
        overlay.pathGroup.visible = lingbotShowPath
      }
    } catch (e) {
      console.error('[viewer] lingbot-map fetch failed:', e)
      status.textContent = `Failed to load LingBot-Map artifacts: ${e instanceof Error ? e.message : String(e)}`
      stats.textContent = ''
      return
    }
  }
  const m = overlay.manifest
  if (m.status === 'ok') {
    status.textContent = `Reconstruction ready — ${overlay.pointCount.toLocaleString()} points, ${overlay.poseCount.toLocaleString()} poses.`
    stats.textContent = m.elapsedMs ? `Run took ${(m.elapsedMs / 1000).toFixed(1)}s on ${m.frameCount ?? '?'} frames.` : ''
  } else if (m.status === 'skipped') {
    status.textContent = `Skipped: ${m.skippedReason ?? 'no reason given'}`
    stats.textContent = ''
  } else {
    status.textContent = `LingBot-Map error: ${m.error ?? 'unknown'}`
    stats.textContent = ''
  }
}

function setLingBotPointsVisible(visible: boolean): void {
  lingbotShowPoints = visible
  for (const overlay of lingbotOverlays.values()) overlay.pointsGroup.visible = visible
}

function setLingBotPathVisible(visible: boolean): void {
  lingbotShowPath = visible
  for (const overlay of lingbotOverlays.values()) overlay.pathGroup.visible = visible
}

function selectEditableObject(obj: THREE.Object3D): void {
  const scan = scanForObject(obj)
  selectedScanId = scan?.manifest.scanId ?? null
  selectedTransformTarget = obj
  transformControls?.attach(obj)
  showInspector(obj)
  syncEditPanel(obj)
  if (selectedScanId) {
    document.querySelectorAll('.scan-item').forEach(el => el.classList.remove('active'))
    scanItems.get(selectedScanId)?.classList.add('active')
  }
}

function clearSelection(): void {
  selectedTransformTarget = null
  selectedScanId = null
  transformControls?.detach()
  hideInspectorOnly()
  const noSelection = document.getElementById('edit-no-selection')!
  const selectedInfo = document.getElementById('edit-selected-info')!
  noSelection.style.display = 'block'
  selectedInfo.style.display = 'none'
}

function showInspector(obj: THREE.Object3D): void {
  const panel = document.getElementById('inspector-panel')!
  const title = document.getElementById('inspector-title')!
  const body = document.getElementById('inspector-body')!
  const data = editor.getInspectorData(obj)
  const scan = scanForObject(obj)
  const transform = matrixTranslation(obj.matrixWorld.toArray())
  const confColor = (data.confidence ?? 0) >= 0.8 ? '#66bb6a' : (data.confidence ?? 0) >= 0.5 ? '#ffa726' : '#ef9a9a'

  title.textContent = data.name || obj.name || scan?.manifest.name || '(unnamed)'
  body.innerHTML = [
    data.tag ? rowHtml('Category', `<span style="background:rgba(128,255,225,0.18);color:#80ffe1;padding:1px 6px;border-radius:4px;font-weight:700;">${escHtml(String(data.tag))}</span>`) : '',
    data.aiLabel ? rowHtml('Label', escHtml(data.aiLabel)) : '',
    data.confidence !== undefined ? rowHtml('Conf', `<span class="inspector-confidence" style="background:${confColor}22;color:${confColor};">${Math.round(data.confidence * 100)}%</span>`) : '',
    scan ? rowHtml('Scan', escHtml(scan.manifest.name)) : '',
    rowHtml('World', `${transform.x.toFixed(2)}, ${transform.y.toFixed(2)}, ${transform.z.toFixed(2)}m`),
    data.dimensions ? rowHtml('Size', `${data.dimensions.w} x ${data.dimensions.h} x ${data.dimensions.d}m`) : '',
    data.roomName ? rowHtml('Room', escHtml(data.roomName)) : '',
    data.floorName ? rowHtml('Floor', escHtml(data.floorName)) : '',
    data.description ? `<div style="font-size:10.5px;color:rgba(255,255,255,0.45);line-height:1.5;margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.06);">${escHtml(data.description)}</div>` : '',
    data.notes ? `<div style="font-size:10.5px;color:rgba(255,255,255,0.4);line-height:1.5;font-style:italic;margin-top:4px;">"${escHtml(data.notes)}"</div>` : '',
  ].filter(Boolean).join('')

  panel.classList.add('visible')
}

function hideInspectorOnly(): void {
  document.getElementById('inspector-panel')?.classList.remove('visible')
}

function syncEditPanel(obj: THREE.Object3D, openEdit = true): void {
  const noSelection = document.getElementById('edit-no-selection')!
  const selectedInfo = document.getElementById('edit-selected-info')!
  const nameEl = document.getElementById('edit-obj-name')!
  const metaEl = document.getElementById('edit-obj-meta')!
  const notesEl = document.getElementById('edit-notes') as HTMLTextAreaElement
  const data = editor.getInspectorData(obj)
  const tagInfo = editor.getTagInfo(obj)
  const scan = scanForObject(obj)

  noSelection.style.display = 'none'
  selectedInfo.style.display = 'block'
  nameEl.textContent = data.name || obj.name || scan?.manifest.name || 'Selected object'
  metaEl.innerHTML = [
    scan ? `Scan: ${escHtml(scan.manifest.name)}` : '',
    data.confidence !== undefined ? `Confidence: ${Math.round(data.confidence * 100)}%` : '',
    data.roomName ? `Room: ${escHtml(data.roomName)}` : '',
    data.floorName ? `Floor: ${escHtml(data.floorName)}` : '',
  ].filter(Boolean).join('<br>')
  notesEl.value = tagInfo?.notes ?? data.notes ?? ''

  const grid = document.getElementById('tag-grid')!
  const activeTag = tagInfo?.tag ?? data.tag
  grid.querySelectorAll<HTMLElement>('.tag-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset['tag'] === activeTag)
  })

  updateTransformReadout()
  if (openEdit) switchSidebarTab('edit')
}

function updateTransformReadout(): void {
  if (!selectedTransformTarget) return
  selectedTransformTarget.updateMatrix()
  const data = editor.getInspectorData(selectedTransformTarget)
  const metaEl = document.getElementById('edit-obj-meta')
  if (!metaEl) return
  const scan = scanForObject(selectedTransformTarget)
  const pos = selectedTransformTarget.position
  const base = [
    scan ? `Scan: ${escHtml(scan.manifest.name)}` : '',
    data.confidence !== undefined ? `Confidence: ${Math.round(data.confidence * 100)}%` : '',
    `Local: ${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}m`,
  ].filter(Boolean)
  metaEl.innerHTML = base.join('<br>')
}

async function saveSelectedTransform(): Promise<void> {
  if (!selectedTransformTarget || !world) return
  selectedTransformTarget.updateMatrix()

  const scan = scanForObject(selectedTransformTarget)
  const scope = selectedTransformTarget.userData['scope'] === 'scan-root' ? 'scan' : 'object'
  const targetId = scope === 'scan'
    ? (scan?.manifest.filename ?? String(selectedTransformTarget.userData['filename'] ?? selectedTransformTarget.name))
    : stableObjectId(selectedTransformTarget)

  await postEditPatch({
    scope,
    scanId: scan?.manifest.scanId,
    targetId,
    transform: serializeTransform(selectedTransformTarget),
  })

  flashButton('edit-save-transform', 'Saved')
}

async function saveObjectSemanticPatch(obj: THREE.Object3D): Promise<void> {
  if (!world) return
  const data = editor.getInspectorData(obj)
  const scan = scanForObject(obj)
  await postEditPatch({
    scope: 'object',
    scanId: scan?.manifest.scanId,
    targetId: stableObjectId(obj),
    label: data.aiLabel ?? data.name,
    category: data.tag ? String(data.tag) : undefined,
    notes: data.notes,
  })
}

async function postEditPatch(body: Partial<EditPatch> & { targetId: string; scope: EditPatch['scope'] }): Promise<void> {
  if (!world) return
  const response = await fetch(withAccessToken(`/worlds/${encodeURIComponent(world.shareSlug)}/patches`), {
    method: 'POST',
    headers: accessHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await response.text())
  const payload = await response.json() as PatchResponse
  world = payload.world
  renderWorldPanel()
}

function serializeTransform(obj: THREE.Object3D): EditPatch['transform'] {
  obj.updateMatrix()
  return {
    matrix: obj.matrix.toArray(),
    position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
    rotation: { x: obj.quaternion.x, y: obj.quaternion.y, z: obj.quaternion.z, w: obj.quaternion.w },
    scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
  }
}

// ─── Panels ──────────────────────────────────────────────────────────────────

function renderWorldPanel(): void {
  if (!world) return

  setText('world-scan-count', String(world.scans.length))
  setText('world-layer-count', String(LAYER_ORDER.length))
  setText('world-job-count', String(world.jobs.length))
  setText('world-origin-label', hasGeoPose(world.originGeoPose) ? 'GPS' : 'Local')
  renderJobs(world.jobs)
}

function renderLayerPanel(): void {
  const list = document.getElementById('layer-list')
  if (!list) return
  list.innerHTML = ''

  for (const type of LAYER_ORDER) {
    const row = document.createElement('label')
    row.className = 'layer-item'
    row.dataset['layer'] = type

    const left = document.createElement('div')
    left.style.minWidth = '0'
    const count = layerCount(type)
    const source = layerSource(type)
    left.innerHTML = `
      <div class="layer-name">${escHtml(LAYER_LABELS[type])}</div>
      <div class="layer-meta">${count} · ${source}</div>
    `

    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.id = `layer-toggle-${type}`
    toggle.className = 'layer-toggle'
    toggle.checked = globalLayerVisible[type]
    toggle.addEventListener('change', () => {
      globalLayerVisible[type] = toggle.checked
      if (type === 'labels') labelsVisible = toggle.checked
      if (type === 'points') cloudVisible = toggle.checked
      applyLayerVisibility()
    })

    row.append(left, toggle)
    list.appendChild(row)
  }
}

function renderJobs(jobs: WorldJob[]): void {
  const list = document.getElementById('job-list')
  if (!list) return
  list.innerHTML = ''

  if (jobs.length === 0) {
    list.innerHTML = '<div class="layer-meta">No jobs queued yet.</div>'
    return
  }

  for (const job of jobs.slice(0, 8)) {
    const row = document.createElement('div')
    row.className = 'job-row'
    const scanName = job.scanId ? world?.scans.find(scan => scan.scanId === job.scanId)?.name : null
    row.innerHTML = `
      <div style="min-width:0;">
        <div class="job-title">${escHtml(job.type)}</div>
        <div class="job-meta">${escHtml(job.status)}${scanName ? ` · ${escHtml(scanName)}` : ''}</div>
      </div>
      <span class="job-meta">${new Date(job.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
    `
    list.appendChild(row)
  }
}

async function loadShareLinks(): Promise<void> {
  if (!world) return
  const target = document.getElementById('share-links')
  if (!target) return

  try {
    const payload = await fetchJson<ShareLinksResponse>(`/worlds/${encodeURIComponent(world.shareSlug)}/share`)
    target.innerHTML = ''
    for (const role of ['owner', 'editor', 'viewer', 'scanner']) {
      const url = payload.links[role]
      if (!url) continue
      const row = document.createElement('div')
      row.className = 'world-link-row'
      const label = document.createElement('span')
      label.textContent = role
      label.title = url
      const copy = document.createElement('button')
      copy.className = 'copy-link-btn'
      copy.textContent = 'Copy'
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText(url).then(() => {
          copy.textContent = 'Copied'
          setTimeout(() => { copy.textContent = 'Copy' }, 1200)
        }).catch(() => {
          copy.textContent = 'Copy failed'
          setTimeout(() => { copy.textContent = 'Copy' }, 1200)
        })
      })
      row.append(label, copy)
      target.appendChild(row)
    }
  } catch (error) {
    target.innerHTML = `<div class="layer-meta">Share links unavailable: ${escHtml(errorMessage(error))}</div>`
  }
}

async function queueSelectedJob(): Promise<void> {
  if (!world) return
  const select = document.getElementById('job-type') as HTMLSelectElement
  const type = select.value as WorldJobType
  const response = await fetch(withAccessToken(`/worlds/${encodeURIComponent(world.shareSlug)}/jobs`), {
    method: 'POST',
    headers: accessHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      type,
      scanId: selectedScanId ?? undefined,
      payload: { source: 'viewer', requestedAt: new Date().toISOString() },
    }),
  })
  if (!response.ok) throw new Error(await response.text())
  const job = await response.json() as WorldJob
  world.jobs.unshift(job)
  renderWorldPanel()
  flashButton('btn-queue-job', 'Queued')
  setTimeout(() => { void refreshJobs() }, 1000)
}

async function refreshJobs(): Promise<void> {
  if (!world) return
  world.jobs = await fetchJson<WorldJob[]>(`/worlds/${encodeURIComponent(world.shareSlug)}/jobs`)
  renderWorldPanel()
}

function layerCount(type: LayerType): string {
  const manifestCounts = world?.scans
    .map(scan => scan.layerIndex.find(layer => layer.type === type)?.count)
    .filter((count): count is number => typeof count === 'number') ?? []
  const manifestTotal = manifestCounts.reduce((sum, count) => sum + count, 0)
  if (manifestCounts.length > 0) return `${manifestTotal.toLocaleString()} items`

  let objectCount = 0
  for (const scan of loadedScans.values()) objectCount += scan.layerNodes.get(type)?.size ?? 0
  return objectCount > 0 ? `${objectCount.toLocaleString()} objects` : 'planned'
}

function layerSource(type: LayerType): string {
  const sources = new Set<string>()
  for (const scan of world?.scans ?? []) {
    const layer = scan.layerIndex.find(item => item.type === type)
    if (layer?.source) sources.add(layer.source)
  }
  if (sources.size === 0) return 'derived'
  return [...sources].join(' + ')
}

// ─── Layer visibility ────────────────────────────────────────────────────────

function applyLayerVisibility(): void {
  const pointsAllowedByMode = editor.mode === 'points' || editor.mode === 'solid' || editor.mode === 'semantic'
  const meshesAllowedByMode = editor.mode !== 'points'

  for (const loaded of loadedScans.values()) {
    loaded.root.visible = loaded.visible
    for (const [type, nodes] of loaded.layerNodes) {
      for (const node of nodes) {
        const visible = loaded.visible && layerVisibilityFor(type, pointsAllowedByMode, meshesAllowedByMode)
        node.visible = visible
      }
    }
  }

  for (const obj of detectionBoundsObjects) {
    const scanId = String(obj.userData['scanId'] ?? '')
    obj.visible = detectionBoundsVisible
      && globalLayerVisible.detections
      && (loadedScans.get(scanId)?.visible ?? true)
  }

  for (const label of labels) {
    label.el.style.display = isLabelVisible(label) ? '' : 'none'
  }

  const cloudButton = document.getElementById('btn-toggle-cloud')
  if (cloudButton) cloudButton.style.opacity = cloudVisible && globalLayerVisible.points ? '1' : '0.4'
  const labelButton = document.getElementById('btn-toggle-labels')
  if (labelButton) labelButton.style.opacity = labelsVisible && globalLayerVisible.labels ? '1' : '0.4'
  const boundsButton = document.getElementById('btn-toggle-bounds')
  if (boundsButton) {
    boundsButton.style.opacity = detectionBoundsVisible ? '1' : '0.4'
    boundsButton.classList.toggle('active-hud', detectionBoundsVisible)
  }
}

function layerVisibilityFor(type: LayerType, pointsAllowedByMode: boolean, meshesAllowedByMode: boolean): boolean {
  if (!globalLayerVisible[type]) return false
  if (type === 'points') return cloudVisible && pointsAllowedByMode
  if (type === 'mesh' || type === 'floor') return meshesAllowedByMode
  if (type === 'detections') return detectionBoundsVisible && meshesAllowedByMode
  if (type === 'labels') return labelsVisible
  return true
}

// ─── Geomap and live metadata ────────────────────────────────────────────────

async function loadGeoLocations(): Promise<void> {
  try {
    const response = await fetch('/scan-locations')
    if (!response.ok) return
    const locations = await response.json() as ScanLocationEntry[]
    const countEl = document.getElementById('geomap-count')
    if (countEl) countEl.textContent = locations.length > 0 ? `${locations.length} mapped` : ''
    await geoMap.updatePins(locations)
  } catch {
    // Geomap is optional.
  }
}

function upsertLiveFrustum(meta: Record<string, unknown>): void {
  if (!scene) return
  const liveId = 'live-device-frustum'
  let group = scene.getObjectByName(liveId)
  if (!group) {
    group = createCameraFrustumMesh(0.3, 0.55)
    group.name = liveId
    group.userData['layerType'] = 'cameraFrustums'
    scene.add(group)
  }

  const position = meta['position']
  if (isVec3Like(position)) {
    group.position.set(position.x, position.y, position.z)
  }
}

function isVec3Like(value: unknown): value is { x: number; y: number; z: number } {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['x'] === 'number'
    && typeof candidate['y'] === 'number'
    && typeof candidate['z'] === 'number'
}

// ─── Live scan preview — geometry streamed from the phone ───────────────────

const LIVE_SCAN_ID = 'live-scan'
const LIVE_MAX_POINTS = 500_000
const LIVE_INITIAL_CAPACITY = 50_000

const liveState = {
  group: null as THREE.Group | null,
  points: null as THREE.Points | null,
  detGroup: null as THREE.Group | null,
  capacity: 0,
  count: 0,
}

function ensureLiveLayer(): THREE.Group | null {
  if (!scene) return null
  if (!liveState.group) {
    liveState.group = new THREE.Group()
    liveState.group.name = 'live-scan-preview'
  }
  if (liveState.group.parent !== scene) scene.add(liveState.group)
  return liveState.group
}

function liveReset(): void {
  liveState.count = 0
  liveState.points?.geometry.setDrawRange(0, 0)
  liveState.detGroup?.clear()
  removeLabelsForScan(LIVE_SCAN_ID)
  updateHudInfo('Live scan started')
}

function liveAddPoints(flat: number[]): void {
  const group = ensureLiveLayer()
  if (!group || !Array.isArray(flat) || flat.length < 3) return

  const incoming = Math.floor(flat.length / 3)
  const target = Math.min(liveState.count + incoming, LIVE_MAX_POINTS)
  if (target === liveState.count) return

  if (!liveState.points || target > liveState.capacity) {
    let capacity = Math.max(liveState.capacity, LIVE_INITIAL_CAPACITY)
    while (capacity < target) capacity *= 2
    capacity = Math.min(capacity, LIVE_MAX_POINTS)

    const positions = new Float32Array(capacity * 3)
    const colors = new Float32Array(capacity * 3)
    if (liveState.points) {
      positions.set((liveState.points.geometry.getAttribute('position') as THREE.BufferAttribute).array.subarray(0, liveState.count * 3))
      colors.set((liveState.points.geometry.getAttribute('color') as THREE.BufferAttribute).array.subarray(0, liveState.count * 3))
      liveState.points.geometry.dispose()
      group.remove(liveState.points)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage))
    geometry.setDrawRange(0, liveState.count)
    const material = new THREE.PointsMaterial({ vertexColors: true, size: 0.03, sizeAttenuation: true })
    liveState.points = new THREE.Points(geometry, material)
    liveState.points.name = 'live-points'
    liveState.points.frustumCulled = false
    group.add(liveState.points)
    liveState.capacity = capacity
  }

  const posAttr = liveState.points.geometry.getAttribute('position') as THREE.BufferAttribute
  const colAttr = liveState.points.geometry.getAttribute('color') as THREE.BufferAttribute
  const positions = posAttr.array as Float32Array
  const colors = colAttr.array as Float32Array

  for (let i = 0; liveState.count < target; i++, liveState.count++) {
    const base = liveState.count * 3
    const y = flat[i * 3 + 1]
    positions[base] = flat[i * 3]
    positions[base + 1] = y
    positions[base + 2] = flat[i * 3 + 2]
    // Height heatmap over a fixed -1m…2.5m band (no global bounds while live)
    const t = Math.max(0, Math.min(1, (y + 1) / 3.5))
    colors[base] = t
    colors[base + 1] = 1 - Math.abs(t * 2 - 1)
    colors[base + 2] = 1 - t
  }
  posAttr.needsUpdate = true
  colAttr.needsUpdate = true
  liveState.points.geometry.setDrawRange(0, liveState.count)
  liveState.points.geometry.computeBoundingSphere()
}

function liveSetDetections(items: Array<{ label?: string; confidence?: number; pos?: number[] }>): void {
  const group = ensureLiveLayer()
  if (!group) return
  if (!liveState.detGroup) {
    liveState.detGroup = new THREE.Group()
    liveState.detGroup.name = 'live-detections'
    group.add(liveState.detGroup)
  }
  liveState.detGroup.clear()
  removeLabelsForScan(LIVE_SCAN_ID)

  for (const det of items) {
    const pos = det.pos
    if (!Array.isArray(pos) || pos.length < 3) continue
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(0.3, 0.3, 0.3)),
      new THREE.LineBasicMaterial({ color: 0x66bb6a, transparent: true, opacity: 0.85 }),
    )
    box.position.set(pos[0], pos[1], pos[2])
    liveState.detGroup.add(box)

    const confidence = typeof det.confidence === 'number' ? ` ${Math.round(det.confidence * 100)}%` : ''
    createLabel(`${det.label ?? 'object'}${confidence}`, box.position, {
      scanId: LIVE_SCAN_ID,
      layerType: 'labels',
    })
  }
}

// ─── HUD and camera helpers ──────────────────────────────────────────────────

function updateHudInfo(message?: string): void {
  const hud = document.getElementById('hud-info')!
  hud.classList.add('visible')
  if (message) {
    hud.textContent = message
    return
  }

  const loadedCount = [...loadedScans.values()].filter(scan => scan.loaded).length
  const pointCount = [...loadedScans.values()]
    .flatMap(scan => scan.points)
    .reduce((sum, points) => sum + (points.geometry.getAttribute('position')?.count ?? 0), 0)
  const detectionCount = world?.scans.reduce((sum, scan) => sum + (scan.detectionCount ?? 0), 0) ?? 0
  hud.innerHTML = [
    world ? `World: ${escHtml(world.name)}` : null,
    `${loadedCount} scan${loadedCount === 1 ? '' : 's'} loaded`,
    pointCount > 0 ? `${pointCount.toLocaleString()} points` : null,
    detectionCount > 0 ? `${detectionCount.toLocaleString()} detections` : null,
  ].filter(Boolean).join('<br>')
}

function updateWorldHud(): void {
  if (!camera || !controls) return

  const direction = new THREE.Vector3()
  camera.getWorldDirection(direction)
  const heading = Math.atan2(direction.x, direction.z)
  const compassArrow = document.getElementById('compass-arrow')
  if (compassArrow) compassArrow.style.transform = `translateX(-50%) rotate(${-heading}rad)`

  updateScaleWidget()

  const readout = document.getElementById('coord-readout')
  if (!readout || !world) return
  const target = controls.target
  let text = `ENU ${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)}m`
  if (hasGeoPose(world.originGeoPose)) {
    const geo = enuToGeo(world.originGeoPose, { x: target.x, y: target.y, z: target.z })
    if (hasGeoPose(geo)) text += `<br>${geo.lat.toFixed(6)}, ${geo.lng.toFixed(6)}`
  }
  readout.innerHTML = text
}

function updateScaleWidget(): void {
  const scaleBar = document.getElementById('scale-bar')
  const scaleLabel = document.getElementById('scale-label')
  const viewport = document.getElementById('viewport')
  if (!scaleBar || !scaleLabel || !viewport) return

  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50]
  let selected = candidates[3]!
  let selectedPx = 96
  for (const meters of candidates) {
    const px = projectedPixelDistance(controls.target, controls.target.clone().add(new THREE.Vector3(meters, 0, 0)))
    if (px >= 58 && px <= 130) {
      selected = meters
      selectedPx = px
      break
    }
    if (px > 0) {
      selected = meters
      selectedPx = Math.min(130, Math.max(42, px))
    }
  }
  scaleBar.style.width = `${selectedPx.toFixed(0)}px`
  scaleLabel.textContent = selected < 1 ? `${Math.round(selected * 100)} cm` : `${selected} m`
}

function projectedPixelDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  const viewport = document.getElementById('viewport')!
  const p1 = a.clone().project(camera)
  const p2 = b.clone().project(camera)
  return Math.abs((p2.x - p1.x) * 0.5 * viewport.clientWidth)
}

function fitCamera(object: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) return
  const center = new THREE.Vector3()
  const size = new THREE.Vector3()
  box.getCenter(center)
  box.getSize(size)
  const maxDim = Math.max(size.x, size.y, size.z, 1)
  const fov = camera.fov * (Math.PI / 180)
  const distance = (maxDim / 2) / Math.tan(fov / 2) * 1.6

  camera.position.set(center.x + distance * 0.65, center.y + distance * 0.45, center.z + distance * 0.85)
  controls.target.copy(center)
  controls.update()
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function createLabel(
  text: string,
  position: THREE.Vector3,
  options: { object?: THREE.Object3D; scanId?: string; layerType: LayerType },
): void {
  const el = document.createElement('div')
  el.className = 'label3d'
  el.textContent = text
  labelContainer.appendChild(el)
  labels.push({ el, position: position.clone(), text, ...options })
}

function clearLabels(): void {
  for (const label of labels) label.el.remove()
  labels = []
  clearDetectionBounds()
}

function clearDetectionBounds(): void {
  for (const obj of detectionBoundsObjects) obj.removeFromParent()
  detectionBoundsObjects = []
  detectionBoundsVisible = false
}

function applyMatrix(obj: THREE.Object3D, matrixArray: number[]): void {
  if (matrixArray.length !== 16) return
  const matrix = new THREE.Matrix4().fromArray(matrixArray)
  matrix.decompose(obj.position, obj.quaternion, obj.scale)
  obj.updateMatrixWorld(true)
}

function findObjectByTargetId(root: THREE.Object3D, targetId: string): THREE.Object3D | null {
  let match: THREE.Object3D | null = null
  root.traverse((obj) => {
    if (match) return
    const data = obj.userData as Record<string, unknown>
    if (data['objectId'] === targetId || data['id'] === targetId || obj.name === targetId || obj.uuid === targetId) {
      match = obj
    }
  })
  return match
}

function stableObjectId(obj: THREE.Object3D): string {
  const data = obj.userData as Record<string, unknown>
  if (typeof data['objectId'] === 'string') return data['objectId']
  const scan = scanForObject(obj)
  const id = `${scan?.manifest.scanId ?? 'object'}:${safeObjectToken(obj.name || obj.uuid)}`
  data['objectId'] = id
  return id
}

function scanForObject(obj: THREE.Object3D): LoadedScan | null {
  let current: THREE.Object3D | null = obj
  while (current) {
    const scanId = current.userData['scanId']
    if (typeof scanId === 'string' && loadedScans.has(scanId)) return loadedScans.get(scanId)!
    current = current.parent
  }
  return null
}

function setScanStatus(scanId: string, status: string): void {
  const statusEl = scanItems.get(scanId)?.querySelector<HTMLElement>('.scan-status')
  if (statusEl) statusEl.textContent = status
}

function showLoading(visible: boolean, text = 'Loading scan...'): void {
  const overlay = document.getElementById('loading-overlay')!
  overlay.classList.toggle('visible', visible)
  const label = overlay.querySelector('span')
  if (label) label.textContent = text
}

function rowHtml(label: string, value: string): string {
  return `<div class="inspector-row"><span class="inspector-label">${label}</span><span class="inspector-value">${value}</span></div>`
}

function escHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function cssEscape(value: string): string {
  return CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"')
}

function safeObjectToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'node'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(withAccessToken(url), { headers: accessHeaders() })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return response.json() as Promise<T>
}

function setText(id: string, value: string): void {
  const el = document.getElementById(id)
  if (el) el.textContent = value
}

function flashButton(id: string, text: string): void {
  const button = document.getElementById(id)
  if (!button) return
  const original = button.textContent ?? ''
  button.textContent = text
  button.style.color = '#66bb6a'
  setTimeout(() => {
    button.textContent = original
    button.style.color = ''
  }, 1500)
}

function switchSidebarTab(name: string): void {
  document.querySelectorAll('.sidebar-tab').forEach(button => {
    const el = button as HTMLButtonElement
    el.classList.toggle('active', el.dataset['tab'] === name)
  })
  document.querySelectorAll('.sidebar-panel').forEach(panel => {
    const el = panel as HTMLElement
    el.classList.toggle('active', el.id === `tab-${name}`)
  })
}

// ─── DOM wiring ──────────────────────────────────────────────────────────────

document.querySelectorAll('.sidebar-tab').forEach(button => {
  button.addEventListener('click', () => {
    switchSidebarTab((button as HTMLButtonElement).dataset['tab']!)
  })
})

const tagGrid = document.getElementById('tag-grid')!
for (const tag of SEMANTIC_TAGS) {
  const chip = document.createElement('button')
  chip.className = 'tag-chip'
  chip.textContent = tag
  chip.dataset['tag'] = tag
  chip.addEventListener('click', () => {
    const obj = selectedTransformTarget ?? editor.selectedObject
    if (!obj) return
    editor.tagObject(obj, tag)
    tagGrid.querySelectorAll('.tag-chip').forEach(candidate => candidate.classList.remove('active'))
    chip.classList.add('active')
    showInspector(obj)
    void saveObjectSemanticPatch(obj).catch(error => console.error('[viewer] semantic patch failed:', error))
  })
  tagGrid.appendChild(chip)
}

document.getElementById('edit-save-notes')?.addEventListener('click', () => {
  const obj = selectedTransformTarget ?? editor.selectedObject
  if (!obj) return
  const notes = (document.getElementById('edit-notes') as HTMLTextAreaElement).value
  const existing = editor.getTagInfo(obj)
  if (existing) editor.tagObject(obj, existing.tag, { ...existing, notes })
  else editor.tagObject(obj, 'unknown', { notes })
  void saveObjectSemanticPatch(obj).then(() => flashButton('edit-save-notes', 'Saved'))
    .catch(error => console.error('[viewer] notes patch failed:', error))
})

document.querySelectorAll<HTMLButtonElement>('.mode-btn[data-mode]').forEach(button => {
  button.addEventListener('click', () => {
    const mode = button.dataset['mode'] as ViewMode
    editor.setMode(mode)
    document.querySelectorAll('.mode-btn[data-mode]').forEach(item => item.classList.remove('active'))
    button.classList.add('active')
    applyLayerVisibility()
  })
})

document.getElementById('btn-reset-camera')!.addEventListener('click', () => {
  if (selectedTransformTarget) fitCamera(selectedTransformTarget)
  else if (worldGroup) fitCamera(worldGroup)
  else {
    camera.position.set(5, 4, 6)
    controls.target.set(0, 0, 0)
    controls.update()
  }
})

document.getElementById('btn-toggle-cloud')!.addEventListener('click', () => {
  cloudVisible = !cloudVisible
  globalLayerVisible.points = cloudVisible
  renderLayerPanel()
  applyLayerVisibility()
})

document.getElementById('btn-toggle-labels')!.addEventListener('click', () => {
  labelsVisible = !labelsVisible
  globalLayerVisible.labels = labelsVisible
  renderLayerPanel()
  applyLayerVisibility()
})

document.getElementById('btn-toggle-bounds')!.addEventListener('click', () => {
  detectionBoundsVisible = !detectionBoundsVisible
  applyLayerVisibility()
})

document.getElementById('btn-flush-tags')!.addEventListener('click', () => {
  editor.flushTags()
  const obj = selectedTransformTarget ?? editor.selectedObject
  const save = obj ? saveObjectSemanticPatch(obj) : Promise.resolve()
  void save.then(() => flashButton('btn-flush-tags', 'Saved'))
    .catch(error => console.error('[viewer] flush patch failed:', error))
})

document.getElementById('edit-save-transform')?.addEventListener('click', () => {
  void saveSelectedTransform().catch(error => console.error('[viewer] transform patch failed:', error))
})

document.getElementById('transform-translate')?.addEventListener('click', () => setTransformMode('translate'))
document.getElementById('transform-rotate')?.addEventListener('click', () => setTransformMode('rotate'))
document.getElementById('transform-scale')?.addEventListener('click', () => setTransformMode('scale'))

document.getElementById('btn-queue-job')?.addEventListener('click', () => {
  void queueSelectedJob().catch(error => {
    console.error('[viewer] queue job failed:', error)
    flashButton('btn-queue-job', 'Failed')
  })
})

document.getElementById('lingbot-map-points-toggle')?.addEventListener('change', (e) => {
  setLingBotPointsVisible((e.target as HTMLInputElement).checked)
})
document.getElementById('lingbot-map-path-toggle')?.addEventListener('change', (e) => {
  setLingBotPathVisible((e.target as HTMLInputElement).checked)
})

document.getElementById('inspector-close')!.addEventListener('click', clearSelection)

document.getElementById('btn-geomap')!.addEventListener('click', () => {
  geoMap.toggle()
  const isOpen = document.getElementById('geomap-drawer')?.classList.contains('geomap-open')
  document.getElementById('btn-geomap')!.classList.toggle('active', !!isOpen)
})

document.getElementById('btn-livefeed')!.addEventListener('click', () => {
  liveFeed.toggle()
  if (liveFeed.isOpen) liveFeed.connect()
})

document.getElementById('btn-measure')?.addEventListener('click', () => {
  const active = measure.toggle()
  document.getElementById('btn-measure')?.classList.toggle('active', active)
  updateHudInfo(active ? 'Measure: click two points on the scan' : undefined)
})

// Hide the selected object and persist it as a visibility patch so the
// edit survives reloads (applied by applyStoredPatches on every load).
document.getElementById('edit-hide-object')?.addEventListener('click', () => {
  const obj = editor.selectedObject
  if (!obj) return
  obj.visible = false
  const scan = scanForObject(obj)
  void postEditPatch({
    targetId: stableObjectId(obj),
    scope: 'object',
    scanId: scan?.manifest.scanId,
    visible: false,
  }).then(() => flashButton('edit-hide-object', 'Hidden'))
    .catch((error) => console.error('[viewer] hide patch failed:', error))
  clearSelection()
})

function setTransformMode(mode: 'translate' | 'rotate' | 'scale'): void {
  transformControls?.setMode(mode)
  const ids: Record<'translate' | 'rotate' | 'scale', string> = {
    translate: 'transform-translate',
    rotate: 'transform-rotate',
    scale: 'transform-scale',
  }
  for (const [key, id] of Object.entries(ids)) {
    document.getElementById(id)?.classList.toggle('active', key === mode)
  }
}

// ─── Server event stream — live scan list + job status ──────────────────────

let worldRefreshTimer: ReturnType<typeof setTimeout> | null = null

function connectServerEvents(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  let ws: WebSocket
  try {
    ws = new WebSocket(`${proto}://${location.host}/events`)
  } catch {
    return
  }
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(String(event.data)) as Record<string, unknown>
      if (msg['type'] === 'scan-added' || msg['type'] === 'session-finalized') {
        scheduleWorldRefresh()
      } else if (msg['type'] === 'job-update') {
        handleJobUpdate(msg['job'] as { target?: string; status?: string; note?: string | null })
      } else if (msg['type'] === 'world-job-update') {
        const wj = msg['job'] as { jobType?: string; type?: string; status?: string; scanId?: string } | undefined
        const t = wj?.type ?? wj?.jobType
        if (t === 'lingbot-map-reconstruct' && wj?.status === 'completed' && wj?.scanId) {
          lingbotOverlays.delete(wj.scanId)
          if (selectedScanId === wj.scanId) void refreshLingBotMapPanel(wj.scanId)
        }
        void refreshJobs()
      }
    } catch { /* malformed event — ignore */ }
  })
  ws.addEventListener('close', () => {
    setTimeout(connectServerEvents, 3000)
  })
}

function scheduleWorldRefresh(): void {
  if (worldRefreshTimer) return
  worldRefreshTimer = setTimeout(() => {
    worldRefreshTimer = null
    void refreshWorldScans()
  }, 800)
}

/** Re-fetch the world and stream in any scans that appeared since page load. */
async function refreshWorldScans(): Promise<void> {
  if (!world) return
  try {
    const updated = await fetchJson<WorldProject>(`/worlds/${encodeURIComponent(initialWorldSlug)}`)
    world = updated
    const fresh = updated.scans.filter((scan) => !scanItems.has(scan.scanId))
    if (fresh.length === 0) return

    document.getElementById('viewer-placeholder')!.style.display = 'none'
    const listEl = document.getElementById('scan-list')!
    document.getElementById('scan-list-empty')?.remove()
    for (const scan of fresh) {
      const item = buildScanItem(scan)
      scanItems.set(scan.scanId, item)
      listEl.prepend(item)
      void loadScanIntoWorld(scan).catch(() => { /* status chip shows the error */ })
    }
    renderWorldPanel()
    updateHudInfo()
  } catch (error) {
    console.warn('[viewer] world refresh failed:', error)
  }
}

function handleJobUpdate(job: { target?: string; status?: string; note?: string | null } | undefined): void {
  if (!job?.target || !world) return
  const scan = world.scans.find((s) => s.filename === job.target)
  if (!scan) return

  if (job.status === 'queued') setScanStatus(scan.scanId, 'Optimization queued...')
  else if (job.status === 'running') setScanStatus(scan.scanId, 'Optimizing (quantize/draco/LODs)...')
  else if (job.status === 'error') setScanStatus(scan.scanId, `Optimize failed: ${job.note ?? 'see server log'}`)
  else if (job.status === 'done') {
    setScanStatus(scan.scanId, `Optimized - ${job.note ?? 'artifacts ready'}`)
    // Re-load to swap in the optimized artifact (preview → quantized/draco)
    if (loadedScans.get(scan.scanId)?.loaded) {
      void loadScanIntoWorld(scan).catch(() => { /* status chip shows the error */ })
    }
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────

initRenderer()
startRenderLoop()
void loadWorldProject()
connectServerEvents()
