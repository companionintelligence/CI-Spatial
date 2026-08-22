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
import { collectDetections, hasLabelledAncestor } from './detections'
import { GeoMap, type ProjectLocationEntry } from './geomap'
import type { LiveFeed } from './livefeed'
import { loadSemanticAsset, createMediumPolyAsset } from './assets'
import { fetchLingBotMapArtifacts, type LingBotMapOverlay } from './lingbot-map'
import { attachSparkRenderer, loadSplat, disposeSplat, type LoadedSplat } from './splat-viewer'
import { fetchScanSplatLayer, disposeScanSplatLayer, splatPlyUrl, splatManifestUrl, splatSogUrl, formatFinishStats, type ScanSplatLayer } from './splat-layer'
import { fetchScanDetectLayer, type ScanDetectLayer } from './splat-detect-layer'
import { buildTrainJobRequest, buildDetectJobRequest } from './splat-toolbox'
import { buildThingObservationIndex, resolveThingTagsForScan } from '../../thing_tags'
import { PlacesPanel } from './places'
import {
  computeQualityTier,
  jobProcessingLabel,
  QUALITY_TIERS,
  QUALITY_TIER_LABELS,
  QUALITY_TIER_BLURBS,
  type QualityTier,
} from './quality-tier'
import { distanceM, enuToGeo, hasGeoPose, matrixTranslation } from '../world/geo'
import { LAYER_LABELS, LAYER_ORDER } from '../world/layers'
import { buildAnchorMarker } from '../world/anchor-marker'
import { registerPWA } from '../pwa'
import { iconLabel } from '../ui/icons'
import { EVENT } from '../shared/events'
import { WEBRTC_LIVE_ENABLED } from '../rtc/feature'
import type {
  EditPatch,
  FrameObservation,
  LayerType,
  PlaceArea,
  Project,
  ReviewComment,
  ScanManifest,
  WorldJob,
  WorldJobType,
  WorldProject,
} from '../world/types'

// Place composition remains opt-in while its building/floor/room editing flow
// is refined. The static HTML stays hidden unless this build-time flag is set.
const PLACE_COMPOSER_ENABLED = import.meta.env?.VITE_ENABLE_PLACE_COMPOSER === 'true'

registerPWA()
void refreshAccountChip()

interface Label3D {
  el: HTMLElement
  position: THREE.Vector3
  text: string
  object?: THREE.Object3D
  scanId?: string
  layerType: LayerType
}

interface InventoryItem {
  id: string
  label: string
  scanId: string
  position: { x: number; y: number; z: number }
  confidence: number | null
  source: 'thing' | 'detection'
}

interface LoadedScan {
  manifest: ScanManifest
  root: THREE.Group
  layerNodes: Map<LayerType, Set<THREE.Object3D>>
  points: THREE.Points[]
  visible: boolean
  inTimeWindow: boolean
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
let activeProjectId = query.get('project') || null

function withAccessToken(url: string): string {
  if (!accessToken) return url
  const parsed = new URL(url, location.origin)
  parsed.searchParams.set('token', accessToken)
  return parsed.pathname + parsed.search + parsed.hash
}

function accessHeaders(extra: HeadersInit = {}): HeadersInit {
  return accessToken ? { ...extra, Authorization: `Bearer ${accessToken}` } : extra
}

async function refreshAccountChip(): Promise<void> {
  const chip = document.getElementById('account-chip') as HTMLAnchorElement | null
  if (!chip) return
  const redirect = `/editor${location.search}`
  chip.href = `/authenticate/oidc?redirect=${encodeURIComponent(redirect)}`
  try {
    const response = await fetch('/authenticate/whoami', { credentials: 'same-origin' })
    if (!response.ok) return
    const account = await response.json() as { name?: string | null; email?: string | null }
    chip.textContent = account.name || account.email || 'Companion account'
    chip.title = 'Connected to your Companion Intelligence Portal account. Spatial captures can be sent to Companion Memory by a processing job.'
  } catch {
    // OIDC is optional in local and self-hosted installs; the connect link stays useful.
  }
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
let liveFeed: LiveFeed | null = null
const labelContainer = document.getElementById('viewport')!
const loadedScans = new Map<string, LoadedScan>()
const scanItems = new Map<string, HTMLElement>()
let timelineSessions: Array<{ key: string; time: number; label: string; scanIds: string[] }> = []
let timelineStart = Number.NEGATIVE_INFINITY
let timelineEnd = Number.POSITIVE_INFINITY
let projectLocations: ProjectLocationEntry[] = []
let knownProjects: Project[] = []
let currentProject: Project | null = null
// Serializes loadScanIntoWorld() calls per scanId. The initial world load
// (loadWorldProject) and the optimize-scan job-completion reload
// (handleJobUpdate) can both target the same scan; without this, a slow or
// failing initial load can resolve after the job-completion reload already
// set the correct ".scan-status" chip, clobbering it. Queuing a second call
// behind the first (rather than racing it) guarantees the caller that fires
// later also finishes later, so its status always wins.
const scanLoadChains = new Map<string, Promise<void>>()
const globalLayerVisible = LAYER_ORDER.reduce((acc, type) => {
  acc[type] = type !== 'rgbFrames' && type !== 'depth' && type !== 'semanticMasks' && type !== 'splat'
  return acc
}, {} as Record<LayerType, boolean>)

let renderer: THREE.WebGLRenderer
let camera: THREE.PerspectiveCamera
let controls: OrbitControls
let transformControls: TransformControls | null = null
let viewportResizeObserver: ResizeObserver | null = null
let scene: THREE.Scene | null = null
let worldGroup: THREE.Group | null = null
let groundGrid: THREE.GridHelper | null = null
let labels: Label3D[] = []
let labelsVisible = true
let cloudVisible = true
let detectionBoundsObjects: THREE.Object3D[] = []
let detectionBoundsVisible = false
let world: WorldProject | null = null
let selectedTransformTarget: THREE.Object3D | null = null
let selectedScanId: string | null = null
let isTransformDragging = false
let placesPanel: PlacesPanel | null = null

function scanRendered(loaded: Pick<LoadedScan, 'visible' | 'inTimeWindow'> | null | undefined): boolean {
  return !!loaded && loaded.visible && loaded.inTimeWindow
}

const lingbotOverlays = new Map<string, LingBotMapOverlay>()
let lingbotShowPoints = false
let lingbotShowPath = false

const loadedSplats = new Map<string, LoadedSplat>()

// Trained-splat sidecars attached per scan (splat-train job output).
const scanSplatLayers = new Map<string, ScanSplatLayer>()
let scanSplatVisible = false

// Splat-detect object-box overlays attached per scan (splat-detect job output).
const scanDetectLayers = new Map<string, ScanDetectLayer>()
let scanDetectVisible = false

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
  // Drawer resizing and responsive layout changes do not fire `window.resize`.
  // Keep the WebGL drawing buffer synchronized with the actual viewport size.
  viewportResizeObserver?.disconnect()
  viewportResizeObserver = new ResizeObserver(() => onResize())
  viewportResizeObserver.observe(document.getElementById('viewport')!)
  requestAnimationFrame(onResize)

  geoMap.mount(document.getElementById('main-area')!)
  geoMap.onProjectSelect = (projectId: string) => {
    selectActiveProject(projectId)
  }

  if (WEBRTC_LIVE_ENABLED) void initializeLiveFeed()

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

async function initializeLiveFeed(): Promise<void> {
  const { LiveFeed } = await import('./livefeed')
  const feed = new LiveFeed(initialWorldSlug)
  liveFeed = feed
  feed.mount(document.getElementById('main-area')!)
  feed.onStatus = ({ state }) => {
    const btn = document.getElementById('btn-livefeed') as HTMLButtonElement | null
    if (!btn) return
    btn.classList.toggle('active', state === 'live')
    // innerHTML, not textContent: the button holds an inline SVG icon.
    btn.innerHTML = iconLabel('broadcast', state === 'live' ? 'Live *' : 'Live', { size: '14px' })
  }
  feed.onMeta = (meta) => {
    upsertLiveFrustum(meta)
  }
  // Live geometry from the phone's data channel: point-cloud deltas,
  // detection snapshots, and camera pose — the scan grows in the editor
  // in real time while someone walks the room.
  feed.onData = (msg) => {
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
  const button = document.getElementById('btn-livefeed') as HTMLButtonElement | null
  if (button) button.hidden = false
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
  for (const layer of scanSplatLayers.values()) disposeScanSplatLayer(layer)
  scanSplatLayers.clear()
  scanDetectLayers.clear()
  lingbotOverlays.clear()
  selectedTransformTarget = null
  selectedScanId = null
  hideInspectorOnly()

  scene = new THREE.Scene()
  scene.name = 'Companion Scan World'
  attachSparkRenderer(renderer, scene)

  const ambient = new THREE.AmbientLight(0xffffff, 0.62)
  const sun = new THREE.DirectionalLight(0xffffff, 1.15)
  sun.position.set(6, 12, 8)
  sun.castShadow = true
  scene.add(ambient, sun)

  const grid = new THREE.GridHelper(80, 80, 0x2f3645, 0x1d2230)
  grid.name = 'World ENU meter grid'
  scene.add(grid)
  groundGrid = grid

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

/** Breathing room between an edge-pinned chip and the canvas edge. */
const LABEL_EDGE_PAD = 4
/**
 * How close to an edge an anchor has to be before its chip pins to that edge.
 * Half the widest chip the semantic overlay can produce, plus the pad: chips are
 * `<label> <confidence>%` at 10px/600 and `white-space: nowrap`, and the longest
 * label in CATEGORY_COLORS ("bookcase 100%") measures about 92 px.
 */
const LABEL_EDGE_ZONE = 50
/**
 * Floor for a chip's anchor, so one near the top of the canvas is not cut by it.
 * A chip is a single nowrap line — 20 px — lifted 6 px clear of its anchor.
 */
const LABEL_MIN_TOP = 20 + 6 + LABEL_EDGE_PAD
/**
 * Chip geometry, computed rather than measured — see the note in updateLabels
 * about why this loop never reads layout. A chip is `padding: 3px 8px` plus a
 * 1px border on a single 10px/600 line, so 20 px tall and 18 px of horizontal
 * chrome; the label text itself averages 5.7 px per glyph at that size, which
 * is the figure "bookcase 100%" ≈ 92 px in LABEL_EDGE_ZONE is derived from.
 */
const LABEL_CHIP_HEIGHT = 20
const LABEL_CHIP_CHROME = 18
const LABEL_CHAR_ADVANCE = 5.7
/** Chips closer than this on both axes read as one smeared blob. */
const LABEL_CHIP_GAP = 3

interface LabelPlacement {
  label: Label3D
  x: number
  y: number
  pin: '' | 'left' | 'right'
  depthCm: number
  left: number
  right: number
  top: number
  bottom: number
}

/** Estimated on-screen width of a chip, from its text alone. No layout read. */
function estimateChipWidth(text: string): number {
  return Math.round(text.length * LABEL_CHAR_ADVANCE) + LABEL_CHIP_CHROME
}

function updateLabels(): void {
  const viewport = document.getElementById('viewport')!
  const width = viewport.clientWidth
  const height = viewport.clientHeight
  const projected = new THREE.Vector3()

  // ── Pass 1: project, cull, and collect candidates ──────────────────────────
  const candidates: LabelPlacement[] = []
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
    // Cull on the ANCHOR, not on a slack box around it. The old +/-80 px margin
    // let objects that are off-camera label the frame anyway: in a world of three
    // adjacent rooms, the two rooms either side of the framed one threw their
    // chips at the canvas edge, where `translate(-50%)` sliced each one into a
    // fragment — on a 360 px viewport "lamp 94%" arrived as "%". An object that
    // is not on screen has no business naming anything on screen.
    if (x < 0 || x > width || y < 0 || y > height) {
      label.el.style.display = 'none'
      continue
    }

    // Keep the chip whole without ever measuring it. A chip is centred on its
    // anchor by `translate(-50%)`, so an anchor close to the edge hangs half a
    // box outside the canvas and gets sliced — that is how "lamp 94%" arrived as
    // "%" at 360 px. Rather than read the box and clamp it, hand the alignment
    // to CSS: inside the edge zone the chip pins to the edge and aligns away
    // from it, and the browser applies its own width.
    //
    // Not measuring is the point, not an optimisation. updateLabels runs every
    // frame, so any offsetWidth read here forces a synchronous layout mid-frame
    // — and a layout forced during the web font's swap window bakes a slightly
    // different text shaping, which is enough to move every chip by a third of a
    // pixel. Two captures of the same world then disagree depending only on how
    // fast the page loaded. The hot path stays writes-only.
    const pin: '' | 'left' | 'right' =
      x < LABEL_EDGE_ZONE ? 'left' : x > width - LABEL_EDGE_ZONE ? 'right' : ''
    const anchorX = pin === 'left' ? LABEL_EDGE_PAD : pin === 'right' ? width - LABEL_EDGE_PAD : x
    const anchorY = Math.max(LABEL_MIN_TOP, y)
    const chipW = estimateChipWidth(label.text)
    const left = pin === 'left' ? anchorX : pin === 'right' ? anchorX - chipW : anchorX - chipW / 2

    candidates.push({
      label, pin,
      x: anchorX,
      y: anchorY,
      // Nearer labels win. Ranked on metric distance rather than `projected.z`,
      // which is so non-linear near the far plane that every label in the world
      // rounds to the same value.
      depthCm: Math.round(camera.position.distanceTo(position) * 100),
      left,
      right: left + chipW,
      // The chip sits above its anchor: translate(-100%) then -6px.
      top: anchorY - LABEL_CHIP_HEIGHT - 6,
      bottom: anchorY - 6,
    })
  }

  // ── Pass 2: nearest-wins de-collision ──────────────────────────────────────
  // Chips are opaque, so two that overlap do not produce two readable labels —
  // they produce one label and a fragment. That is where "table 76%" reached a
  // committed screenshot as "le 76%" and "bed 94%" as "d 94%": the nearer chip
  // painted over the first half of the farther one and left a word that is not
  // a word. Hiding the loser is strictly better than showing a lie; the object
  // is still in the manifest, still selectable, and its chip returns as soon as
  // the camera moves. Sorted nearest-first so the chip the reader is looking at
  // is the one that survives, and the order is a total order on an integer, so
  // two captures of the same camera resolve identically.
  candidates.sort((a, b) => a.depthCm - b.depthCm || (a.label.text < b.label.text ? -1 : 1))
  const placed: LabelPlacement[] = []
  for (const c of candidates) {
    const collides = placed.some(p =>
      c.left < p.right + LABEL_CHIP_GAP && c.right + LABEL_CHIP_GAP > p.left
      && c.top < p.bottom + LABEL_CHIP_GAP && c.bottom + LABEL_CHIP_GAP > p.top)
    if (collides) {
      c.label.el.style.display = 'none'
      continue
    }
    placed.push(c)
    const el = c.label.el
    el.style.display = 'block'
    el.dataset['pin'] = c.pin
    el.style.left = `${c.x}px`
    el.style.top = `${c.y}px`
    el.style.zIndex = String(Math.max(1, 1_000_000 - c.depthCm))
  }
}

function isLabelVisible(label: Label3D): boolean {
  if (!labelsVisible || !globalLayerVisible.labels) return false
  if (!label.scanId) return true
  const loaded = loadedScans.get(label.scanId)
  return loaded ? scanRendered(loaded) : true
}

// ─── World loading ───────────────────────────────────────────────────────────

async function loadWorldProject(): Promise<void> {
  showLoading(true, 'Loading world...')
  initWorldScene()

  try {
    const [loadedWorld, locations, projects] = await Promise.all([
      fetchJson<WorldProject>(activeWorldUrl()),
      fetchJson<ProjectLocationEntry[]>('/project-locations').catch(() => []),
      fetchJson<Project[]>('/projects').catch(() => []),
    ])
    projectLocations = locations
    knownProjects = projects
    const scopedWorld = scopeWorldToActiveProject(loadedWorld)
    world = scopedWorld
    currentProject = projects.find(project => project.projectId === activeProjectId) ?? null
    document.title = `${scopedWorld.name} - Companion Scan Spatial Editor`
    setText('sidebar-title', scopedWorld.name)
    document.getElementById('viewer-placeholder')!.style.display = scopedWorld.scans.length ? 'none' : 'flex'

    buildScanList(scopedWorld.scans)
    buildTimeline(scopedWorld.scans)
    renderWorldPanel()
    renderLayerPanel()
    if (PLACE_COMPOSER_ENABLED) renderPlacesPanel()
    renderProjectHierarchyEditor()
    renderProjectSwitcher()
    renderThingsPanel()
    void geoMap.updatePins(projectLocations, activeProjectId)
    void loadShareLinks()

    if (scopedWorld.scans.length === 0) {
      updateHudInfo('No scans in this world yet.')
      return
    }

    const results = await Promise.allSettled(scopedWorld.scans.map(enqueueScanLoad))
    const loadedCount = results.filter(result => result.status === 'fulfilled').length
    if (loadedCount > 0 && worldGroup) {
      fitCamera(worldGroup)
      const first = scopedWorld.scans.find(scan => loadedScans.get(scan.scanId)?.loaded)
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

function scopeWorldToActiveProject(source: WorldProject): WorldProject {
  const fallbackProjectId = source.projectId ?? projectLocations[0]?.projectId ?? 'proj-default'
  activeProjectId ??= fallbackProjectId
  const activeProject = projectLocations.find((project) => project.projectId === activeProjectId)
  const scans = source.projectId === activeProjectId
    ? source.scans
    : source.scans.filter((scan) => (scan.projectId ?? 'proj-default') === activeProjectId)
  const scanIds = new Set(scans.map(scan => scan.scanId))
  const thingObservations = source.thingObservations.filter(observation => scanIds.has(observation.scanId))
  const observedThingIds = new Set(thingObservations.map(observation => observation.thingId))
  const things = source.things.filter(thing =>
    observedThingIds.has(thing.thingId)
    || scanIds.has(thing.firstSeenScanId)
    || scanIds.has(thing.lastSeenScanId))
  return {
    ...source,
    projectId: activeProjectId,
    name: activeProject?.name ?? source.name,
    scans,
    things,
    thingObservations,
    comments: (source.comments ?? []).filter(comment => !comment.scanId || scanIds.has(comment.scanId)),
  }
}

function selectActiveProject(projectId: string): void {
  if (projectId === activeProjectId) {
    geoMap.close()
    return
  }
  activeProjectId = projectId
  selectedScanId = null
  selectedTransformTarget = null
  hideInspectorOnly()
  const nextUrl = new URL(location.href)
  nextUrl.searchParams.set('project', projectId)
  history.replaceState(null, '', nextUrl)
  geoMap.close()
  void loadWorldProject()
}

function projectDistanceMeters(a: ProjectLocationEntry, b: ProjectLocationEntry): number | null {
  if (a.lat === null || a.lng === null || b.lat === null || b.lng === null) return null
  return distanceM(
    { lat: a.lat, lng: a.lng, altitudeM: null, bearing: null, accuracyM: null },
    { lat: b.lat, lng: b.lng, altitudeM: null, bearing: null, accuracyM: null },
  )
}

function normalizedAddress(address: string | null): string | null {
  const value = address?.trim().toLocaleLowerCase()
  return value || null
}

function renderProjectSwitcher(): void {
  const root = document.getElementById('project-switcher')
  const nearbyList = document.getElementById('nearby-projects-list')
  const otherList = document.getElementById('other-projects-list')
  const nearbyCount = document.getElementById('nearby-project-count')
  const otherCount = document.getElementById('other-project-count')
  if (!root || !nearbyList || !otherList || !nearbyCount || !otherCount) return

  const active = projectLocations.find(project => project.projectId === activeProjectId) ?? null
  const activeAddress = normalizedAddress(active?.address ?? null)
  const candidates = projectLocations.filter(project => project.projectId !== activeProjectId)
  const nearby = candidates
    .map(project => {
      const distance = active ? projectDistanceMeters(active, project) : null
      const sameAddress = Boolean(activeAddress && activeAddress === normalizedAddress(project.address))
      return { project, distance, sameAddress }
    })
    .filter(item => item.sameAddress || (item.distance !== null && item.distance <= 50))
    .sort((a, b) => Number(b.sameAddress) - Number(a.sameAddress) || (a.distance ?? Infinity) - (b.distance ?? Infinity))
  const nearbyIds = new Set(nearby.map(item => item.project.projectId))
  const other = candidates
    .filter(project => !nearbyIds.has(project.projectId))
    .sort((a, b) => a.name.localeCompare(b.name))

  nearbyCount.textContent = String(nearby.length)
  otherCount.textContent = String(other.length)
  const renderList = (
    list: HTMLElement,
    entries: Array<{ project: ProjectLocationEntry; distance?: number | null; sameAddress?: boolean }>,
    empty: string,
  ) => {
    list.replaceChildren()
    if (entries.length === 0) {
      const message = document.createElement('p')
      message.className = 'project-switcher-empty'
      message.textContent = empty
      list.appendChild(message)
      return
    }
    for (const entry of entries) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'project-switcher-option'
      const title = document.createElement('span')
      title.className = 'project-switcher-name'
      title.textContent = entry.project.name
      const meta = document.createElement('span')
      meta.className = 'project-switcher-meta'
      meta.textContent = entry.sameAddress
        ? 'Same address'
        : entry.distance !== null && entry.distance !== undefined
          ? `${Math.round(entry.distance)} m away`
          : entry.project.address ?? 'Location unavailable'
      button.append(title, meta)
      button.addEventListener('click', () => selectActiveProject(entry.project.projectId))
      list.appendChild(button)
    }
  }

  renderList(nearbyList, nearby, 'No other Places at this address or within 50 m.')
  renderList(otherList, other.map(project => ({ project })), 'No other Places are available.')
}

const PLACE_TYPE_LABELS: Record<NonNullable<Project['placeType']>, string> = {
  building: 'Building',
  floor: 'Floor',
  room: 'Room',
  other: 'Other',
}

function canUseProjectAsParent(candidateId: string, projectId: string): boolean {
  if (candidateId === projectId) return false
  const projectsById = new Map(knownProjects.map(project => [project.projectId, project]))
  const visited = new Set<string>()
  let cursor = candidateId
  while (cursor) {
    if (cursor === projectId || visited.has(cursor)) return false
    visited.add(cursor)
    cursor = projectsById.get(cursor)?.parentProjectId ?? ''
  }
  return true
}

function normalizedHierarchyName(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function hierarchyNameCandidates(kind: 'building' | 'floor'): string[] {
  const names = new Set<string>()
  for (const project of knownProjects) {
    const fieldName = kind === 'building' ? project.buildingName : project.floorName
    if (fieldName?.trim()) names.add(fieldName.trim())
    if (project.placeType === kind && project.name.trim()) names.add(project.name.trim())
    for (const area of project.areas ?? []) {
      if (area.kind === kind && area.name.trim()) names.add(area.name.trim())
    }
    if (kind === 'floor') {
      for (const floor of project.floors) {
        if (floor.name.trim()) names.add(floor.name.trim())
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

function setHierarchySuggestions(id: string, values: string[]): void {
  const list = document.getElementById(id) as HTMLDataListElement | null
  if (!list) return
  list.replaceChildren(...values.map(value => new Option(value, value)))
}

function hierarchyContextFromAncestors(project: Project, kind: 'building' | 'floor'): string {
  const projectsById = new Map(knownProjects.map(candidate => [candidate.projectId, candidate]))
  const visited = new Set<string>([project.projectId])
  let cursor = project.parentProjectId ?? null
  while (cursor && !visited.has(cursor)) {
    const parent = projectsById.get(cursor)
    if (!parent) break
    if (parent.placeType === kind) return parent.name
    visited.add(cursor)
    cursor = parent.parentProjectId ?? null
  }
  return ''
}

function matchingParentProjectId(
  type: NonNullable<Project['placeType']>,
  buildingName: string,
  floorName: string,
): string | null {
  const match = (value: string, candidateType: NonNullable<Project['placeType']>) => knownProjects
    .filter(candidate => canUseProjectAsParent(candidate.projectId, currentProject?.projectId ?? ''))
    .filter(candidate => candidate.placeType === candidateType)
    .filter(candidate => normalizedHierarchyName(candidate.name) === normalizedHierarchyName(value))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null

  if (type === 'floor' && buildingName) return match(buildingName, 'building')?.projectId ?? null
  if (type === 'room' && floorName) {
    const floor = match(floorName, 'floor')
    if (!floor) return null
    if (!buildingName || normalizedHierarchyName(floor.buildingName ?? '') === normalizedHierarchyName(buildingName)) {
      return floor.projectId
    }
  }
  return null
}

function syncProjectHierarchyFields(): void {
  const type = document.getElementById('project-place-type') as HTMLSelectElement | null
  const nameLabel = document.getElementById('project-place-name-label')
  const floorField = document.getElementById('project-floor-name-field')
  const buildingField = document.getElementById('project-building-name-field')
  if (!type || !nameLabel || !floorField || !buildingField) return

  const selectedType = type.value as Project['placeType'] | ''
  nameLabel.textContent = selectedType ? `${PLACE_TYPE_LABELS[selectedType]} name` : 'Place name'
  floorField.hidden = selectedType !== 'room'
  buildingField.hidden = selectedType !== 'floor' && selectedType !== 'room'
}

function updateProjectHierarchyPreview(): void {
  const preview = document.getElementById('project-hierarchy-preview')
  const type = document.getElementById('project-place-type') as HTMLSelectElement | null
  const name = document.getElementById('project-place-name') as HTMLInputElement | null
  const floor = document.getElementById('project-floor-name') as HTMLInputElement | null
  const building = document.getElementById('project-building-name') as HTMLInputElement | null
  if (!preview || !type || !name || !floor || !building || !currentProject) return

  const selectedType = type.value as Project['placeType'] | ''
  const level = selectedType ? PLACE_TYPE_LABELS[selectedType] : 'Place'
  const path = selectedType === 'room'
    ? [building.value.trim(), floor.value.trim(), name.value.trim() || currentProject.name]
    : selectedType === 'floor'
      ? [building.value.trim(), name.value.trim() || currentProject.name]
      : [name.value.trim() || currentProject.name]
  const visiblePath = path.filter(Boolean)
  preview.textContent = `${level} path: ${visiblePath.join(' › ')}`
}

function renderProjectHierarchyEditor(): void {
  const root = document.getElementById('project-hierarchy-editor')
  const type = document.getElementById('project-place-type') as HTMLSelectElement | null
  const name = document.getElementById('project-place-name') as HTMLInputElement | null
  const floor = document.getElementById('project-floor-name') as HTMLInputElement | null
  const building = document.getElementById('project-building-name') as HTMLInputElement | null
  const status = document.getElementById('project-hierarchy-status')
  if (!root || !type || !name || !floor || !building) return

  root.hidden = !currentProject || !document.getElementById('tab-btn-world')?.classList.contains('active')
  if (!currentProject) return
  const project = currentProject

  type.value = project.placeType ?? ''
  name.value = project.name
  building.value = project.buildingName ?? hierarchyContextFromAncestors(project, 'building')
  floor.value = project.floorName ?? hierarchyContextFromAncestors(project, 'floor')
  setHierarchySuggestions('project-building-name-options', hierarchyNameCandidates('building'))
  setHierarchySuggestions('project-floor-name-options', hierarchyNameCandidates('floor'))
  syncProjectHierarchyFields()
  if (status) status.textContent = ''
  updateProjectHierarchyPreview()
}

async function saveProjectHierarchy(): Promise<void> {
  const type = document.getElementById('project-place-type') as HTMLSelectElement | null
  const name = document.getElementById('project-place-name') as HTMLInputElement | null
  const floor = document.getElementById('project-floor-name') as HTMLInputElement | null
  const building = document.getElementById('project-building-name') as HTMLInputElement | null
  const status = document.getElementById('project-hierarchy-status')
  const button = document.getElementById('project-hierarchy-save') as HTMLButtonElement | null
  if (!currentProject || !type || !name || !floor || !building) return

  const nextName = name.value.trim()
  const nextType = type.value as Project['placeType'] | ''
  const nextBuildingName = nextType === 'building'
    ? nextName
    : building.value.trim()
  const nextFloorName = nextType === 'floor'
    ? nextName
    : nextType === 'room'
      ? floor.value.trim()
      : ''
  if (!nextName) {
    if (status) status.textContent = 'Enter a name before saving this Place.'
    name.focus()
    return
  }

  if (button) button.disabled = true
  if (status) status.textContent = 'Saving Place structure...'
  try {
    const response = await fetch(withAccessToken(`/projects/${encodeURIComponent(currentProject.projectId)}`), {
      method: 'PUT',
      headers: accessHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        ...currentProject,
        name: nextName,
        placeType: nextType || undefined,
        parentProjectId: nextType ? matchingParentProjectId(nextType, nextBuildingName, nextFloorName) : null,
        buildingName: nextBuildingName || undefined,
        floorName: nextFloorName || undefined,
        roomName: nextType === 'room' ? nextName : undefined,
      }),
    })
    if (!response.ok) throw new Error(await response.text())
    const updated = await response.json() as Project
    currentProject = updated
    knownProjects = knownProjects.map(project => project.projectId === updated.projectId ? updated : project)
    if (world) world.name = updated.name
    setText('sidebar-title', updated.name)
    document.title = `${updated.name} - Companion Scan Spatial Editor`
    renderProjectHierarchyEditor()
    renderProjectSwitcher()
    renderItemsPanel()
    if (status) status.textContent = 'Place structure saved.'
  } catch (error) {
    if (status) status.textContent = `Could not save: ${errorMessage(error)}`
  } finally {
    if (button) button.disabled = false
  }
}

function renderThingsPanel(): void {
  const list = document.getElementById('things-list')
  const summary = document.getElementById('things-panel-summary')
  if (!list || !summary || !world) return

  const byLabel = new Map<string, { count: number; confidence: number | null; scanId: string }>()
  for (const scan of world.scans.filter(scanInTimeline)) {
    for (const item of inventoryItems(scan.scanId)) {
      const key = item.label.trim().toLocaleLowerCase()
      const current = byLabel.get(key)
      if (current) {
        current.count += 1
        current.confidence = Math.max(current.confidence ?? 0, item.confidence ?? 0) || null
      } else {
        byLabel.set(key, { count: 1, confidence: item.confidence, scanId: scan.scanId })
      }
    }
  }

  const things = [...byLabel.entries()].sort(([a], [b]) => a.localeCompare(b))
  summary.textContent = things.length
    ? `${things.length} identified thing${things.length === 1 ? '' : 's'} in the visible scan range.`
    : 'No Things are visible in the current scan range.'
  list.replaceChildren()
  for (const [label, thing] of things) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'things-list-item'
    const confidence = thing.confidence == null ? '' : ` · ${Math.round(thing.confidence * 100)}%`
    button.innerHTML = `<strong>${escHtml(label)}</strong><span>${thing.count} observation${thing.count === 1 ? '' : 's'}${confidence}</span>`
    button.addEventListener('click', () => selectScan(thing.scanId, true, false))
    list.appendChild(button)
  }
}

function activeWorldUrl(): string {
  if (activeProjectId && activeProjectId !== 'proj-default') {
    return `/projects/${encodeURIComponent(activeProjectId)}/world`
  }
  return `/worlds/${encodeURIComponent(initialWorldSlug)}`
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

function buildTimeline(scans: ScanManifest[]): void {
  const scrubber = document.getElementById('timeline-scrubber') as HTMLElement | null
  const startRange = document.getElementById('timeline-start') as HTMLInputElement | null
  const endRange = document.getElementById('timeline-end') as HTMLInputElement | null
  const label = document.getElementById('timeline-label')
  const fill = document.getElementById('timeline-range-fill')
  if (!scrubber || !startRange || !endRange || !label || !fill) return

  const groups = new Map<string, { time: number; scanIds: string[] }>()
  scans.forEach((scan) => {
    const parsed = scan.capturedAt ? Date.parse(scan.capturedAt) : Number.NaN
    const time = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
    const key = scan.sessionId ?? scan.scanId
    const group = groups.get(key)
    if (group) {
      group.time = Math.min(group.time, time)
      group.scanIds.push(scan.scanId)
    } else {
      groups.set(key, { time, scanIds: [scan.scanId] })
    }
  })

  timelineSessions = [...groups.entries()]
    .map(([key, group]) => ({
      key,
      time: group.time,
      scanIds: group.scanIds,
      label: group.time === Number.NEGATIVE_INFINITY
        ? 'Unknown date'
        : new Date(group.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    }))
    .sort((a, b) => a.time - b.time)

  if (timelineSessions.length <= 1) {
    scrubber.hidden = true
    applyTimelineWindow(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
    return
  }

  scrubber.hidden = false
  const latest = timelineSessions.length - 1
  startRange.max = String(latest)
  endRange.max = String(latest)
  startRange.value = '0'
  endRange.value = String(latest)

  const applyRange = () => {
    let startIndex = Number(startRange.value)
    let endIndex = Number(endRange.value)
    if (startIndex > endIndex) {
      if (document.activeElement === startRange) endIndex = startIndex
      else startIndex = endIndex
      startRange.value = String(startIndex)
      endRange.value = String(endIndex)
    }
    const start = timelineSessions[startIndex]?.time ?? Number.NEGATIVE_INFINITY
    const end = timelineSessions[endIndex]?.time ?? Number.POSITIVE_INFINITY
    const startPercent = (startIndex / latest) * 100
    const endPercent = (endIndex / latest) * 100
    fill.style.left = `${startPercent}%`
    fill.style.width = `${endPercent - startPercent}%`
    label.textContent = startIndex === 0 && endIndex === latest
      ? 'All scans'
      : `${timelineSessions[startIndex]?.label ?? 'Start'} - ${timelineSessions[endIndex]?.label ?? 'End'}`
    applyTimelineWindow(start, end)
  }
  startRange.oninput = applyRange
  endRange.oninput = applyRange
  applyRange()
}

function applyTimelineWindow(start: number, end: number): void {
  timelineStart = start
  timelineEnd = end
  for (const loaded of loadedScans.values()) {
    loaded.inTimeWindow = scanInTimeline(loaded.manifest)
  }
  for (const [scanId, item] of scanItems) {
    const scan = world?.scans.find(candidate => candidate.scanId === scanId)
    const inTime = !scan || scanInTimeline(scan)
    item.classList.toggle('out-of-time', !inTime)
  }
  applyLayerVisibility()
  renderItemsPanel()
}

function scanInTimeline(scan: ScanManifest): boolean {
  const time = effectiveSessionTime(scan)
  if (time === Number.NEGATIVE_INFINITY) {
    // An undated scan has no place on the timeline, so only show it while the
    // full known range is selected. applyRange() always resolves start/end to
    // real session timestamps once the scrubber is shown (never literal
    // +/-Infinity), so comparing against the actual earliest/latest session
    // time — not against literal Infinity — is what "full range" means here.
    const earliest = timelineSessions[0]?.time ?? Number.NEGATIVE_INFINITY
    const latest = timelineSessions[timelineSessions.length - 1]?.time ?? Number.POSITIVE_INFINITY
    return timelineStart <= earliest && timelineEnd >= latest
  }
  return time >= timelineStart && time <= timelineEnd
}

function effectiveSessionTime(scan: ScanManifest): number {
  if (!world) return Number.NEGATIVE_INFINITY
  const key = scan.sessionId ?? scan.scanId
  return timelineSessions.find(session => session.key === key)?.time ?? Number.NEGATIVE_INFINITY
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
      loaded.root.visible = scanRendered(loaded)
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
    // Scan selection opens its identified-item inventory; object picking still
    // opens Edit for direct annotation.
    selectScan(scan.scanId, true, false)
  })
  return item
}

/**
 * Progressive scan load.  When the server's optimize-scan job has produced
 * artifacts, the coarsest point-cloud LOD is shown within a few hundred ms
 * and the full-quality (quantized/Draco) GLB streams in behind it and swaps
 * atomically.  Unoptimized scans fall back to a single-pass load.
 */
/**
 * Queue a loadScanIntoWorld() call behind any already-in-flight load for the
 * same scanId, instead of racing a fresh call against it. All external
 * callers (initial world load, world refresh, job-completion reload) must go
 * through this instead of calling loadScanIntoWorld() directly.
 */
function enqueueScanLoad(scan: ScanManifest): Promise<void> {
  const previous = scanLoadChains.get(scan.scanId) ?? Promise.resolve()
  const chained = previous.catch(() => {}).then(() => loadScanIntoWorld(scan))
  scanLoadChains.set(scan.scanId, chained)
  void chained.finally(() => {
    if (scanLoadChains.get(scan.scanId) === chained) scanLoadChains.delete(scan.scanId)
  })
  return chained
}

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
    const previous = loadedScans.get(scan.scanId)
    if (previous && previous.loaded) {
      // A preview (or earlier full load) already made it into worldGroup — the
      // full-quality pass that just failed must not orphan it behind a phantom
      // detached Group. Keep the live root; only the manifest/error need updating.
      loadedScans.set(scan.scanId, { ...previous, manifest: scan, error: message })
    } else {
      loadedScans.set(scan.scanId, {
        manifest: scan,
        root: new THREE.Group(),
        layerNodes: new Map(),
        points: [],
        visible: false,
        inTimeWindow: true,
        loaded: false,
        error: message,
      })
    }
    setScanStatus(scan.scanId, `Error: ${message}`)
    throw error
  }
}

async function fetchOptimizationManifest(filename: string): Promise<OptimizationManifest | null> {
  try {
    const resp = await withTransientRetry(() => fetch(`/scans/${encodeURIComponent(filename)}/manifest`))
    if (!resp.ok) return null
    const manifest = await resp.json() as OptimizationManifest
    return manifest.artifacts?.optimized ? manifest : null
  } catch {
    return null
  }
}

// A scan only flips to "Ready" once its GLB loads, so this fetch is the gate the
// mock-editor tests wait on — retry the transient burst drop that would strand
// it. GLTFLoader forwards fetch's TypeError to onError, so withTransientRetry
// catches it; the deterministic "no scene graph" reject is not transient and is
// surfaced immediately.
function loadGlbRoot(url: string): Promise<THREE.Group> {
  return withTransientRetry(() => new Promise<THREE.Group>((resolve, reject) => {
    loader.load(url, (gltf) => {
      const g = gltf as { scene?: THREE.Group; scenes?: THREE.Group[] }
      const root = g.scene ?? g.scenes?.[0]
      if (root) resolve(root)
      else reject(new Error('Scan GLB has no scene graph'))
    }, undefined, reject)
  }))
}

/**
 * Attach a freshly loaded scan root to the world, replacing any previously
 * loaded root for the same scan (LOD preview → full quality swap).
 */
function integrateScanRoot(scan: ScanManifest, root: THREE.Group): void {
  if (!worldGroup) return

  // Tear down the previous generation of this scan (preview pass)
  const previous = loadedScans.get(scan.scanId)
  let reselectId: string | null = null
  if (previous && previous.loaded) {
    // If the live selection/gizmo is anchored somewhere inside the root we're about
    // to remove, capture its stable id so it can be re-attached to the corresponding
    // object in the new root below. Left unhandled, TransformControls keeps pointing
    // at this now-detached object: dragging it produces no visible change (it is no
    // longer in worldGroup), and "Save Transform" would silently persist that ghost's
    // matrix while still reporting success.
    if (selectedTransformTarget) {
      let current: THREE.Object3D | null = selectedTransformTarget
      while (current) {
        if (current === previous.root) {
          reselectId = stableObjectId(selectedTransformTarget)
          break
        }
        current = current.parent
      }
    }

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
  addAnchorMarker(root, scan, layerNodes)
  createSemanticLabels(root, scan.scanId)

  worldGroup.add(root)
  const inTimeWindow = previous?.inTimeWindow ?? scanInTimeline(scan)
  root.visible = scanRendered({ visible: previous?.visible ?? true, inTimeWindow })
  loadedScans.set(scan.scanId, {
    manifest: scan,
    root,
    layerNodes,
    points,
    visible: previous?.visible ?? true,
    inTimeWindow,
    loaded: true,
  })

  editor.setScene(scene!)
  editor.setMode(editor.mode)
  applyLayerVisibility()

  if (reselectId) {
    // stableObjectId()/findObjectByTargetId() round-trip: objectId survives the
    // reload (assignStableObjectIds() above re-derives the same ids from the same
    // node paths/names), so this finds the new root's counterpart of whatever was
    // selected in the old one — the root itself for a whole-scan selection, since
    // its objectId is scan.scanId same as before.
    const match = findObjectByTargetId(root, reselectId)
    if (match) selectEditableObject(match, false)
    else clearSelection()
  }
  renderItemsPanel()
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
  for (const { node, mesh } of collectDetections(root)) {
    const data = node.userData as Record<string, unknown>
    const label = String(data['label'])
    const parent = mesh.parent
    if (!parent) continue

    const name = node.name || mesh.name || label
    const lod = new THREE.LOD()
    lod.name = `LOD_${name}`
    lod.userData = {
      ...data,
      scanId,
      objectId: `${scanId}:${name}:lod`,
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
  const thingTags = resolveThingTagsForScan(
    world.editPatches,
    world.things ?? [],
    buildThingObservationIndex(world.thingObservations ?? []),
    scan.scanId,
  )

  for (const patch of world.editPatches) {
    if (patch.scope === 'thing') continue
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

  for (const [targetId, tag] of thingTags) {
    const target = findObjectByTargetId(root, targetId)
    if (!target) continue
    if (tag.category) target.userData['tag'] = tag.category
    if (tag.label) target.userData['label'] = tag.label
    if (tag.notes) target.userData['notes'] = tag.notes
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
  const response = await withTransientRetry(() => fetch(withAccessToken(scan.frameSetUrl!)))
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

/**
 * Adds a calibration-anchor marker for scans with a real calibration — a
 * GPS-only-placed scan's local origin is just wherever AR tracking booted,
 * not a marked physical point, so rendering a decal there would mislead.
 *
 * The marker sits at local (0,0,0) — the invariant every calibration method
 * (old 3-point, new one-tap) shares, since the calibrated reference always
 * maps to project-space zero. Positioning comes for free from being a child
 * of the scan root, which already carries scan.localToWorld.
 *
 * No bearing is passed here (unlike the live capture-side decal): the whole
 * root's own rotation may come from either calibration method or a
 * gizmo-drag override, so there's no single "true north" axis to derive
 * from it after the fact — the ring+crosshair alone marks the anchor point;
 * the north tick is a live-capture-only refinement.
 */
function addAnchorMarker(
  root: THREE.Object3D,
  scan: ScanManifest,
  layers: Map<LayerType, Set<THREE.Object3D>>,
): void {
  if (scan.calibrationStatus !== 'verified' && scan.calibrationStatus !== 'provisional') return
  const marker = buildAnchorMarker()
  marker.userData['scanId'] = scan.scanId
  root.add(marker)
  addLayerNode(layers, 'anchor', marker)
}

function buildDetectionBounds(
  root: THREE.Object3D,
  scanId: string,
  layers: Map<LayerType, Set<THREE.Object3D>>,
): void {
  // Bounds attach to the mesh, not the labelled node: after optimization the
  // mesh carries a dequantization transform, and a wire parented above it would
  // render in quantized space — a box in the wrong place, at the wrong scale.
  for (const { node, mesh } of collectDetections(root)) {
    const data = node.userData as Record<string, unknown>

    const edges = new THREE.EdgesGeometry(mesh.geometry, 15)
    const wire = new THREE.LineSegments(edges, boundEdgeMaterial.clone())
    wire.name = `${node.name || data['label']} detection bounds`
    wire.renderOrder = 2
    wire.userData['scanId'] = scanId
    wire.userData['layerType'] = 'detections'
    mesh.add(wire)
    detectionBoundsObjects.push(wire)
    addLayerNode(layers, 'detections', wire)

    const positionAttr = mesh.geometry.attributes['position']
    if (positionAttr instanceof THREE.BufferAttribute) {
      const step = Math.max(1, Math.floor(positionAttr.count / 200))
      const verts: number[] = []
      for (let i = 0; i < positionAttr.count; i += step) {
        verts.push(positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i))
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
      const points = new THREE.Points(geometry, boundPointMaterial.clone())
      points.name = `${node.name || data['label']} detection samples`
      points.renderOrder = 2
      points.userData['scanId'] = scanId
      points.userData['layerType'] = 'detections'
      mesh.add(points)
      detectionBoundsObjects.push(points)
      addLayerNode(layers, 'detections', points)
    }
  }
}

function createSemanticLabels(root: THREE.Object3D, scanId: string): void {
  root.traverse((obj) => {
    const data = obj.userData as Record<string, unknown>
    if (!data['label']) return
    // One label per detected object, not one per level of detail.
    // upgradeSemanticMeshes() wraps each labelled mesh in a THREE.LOD and copies
    // the mesh's userData — label included — onto the LOD and onto every proxy
    // level it adds. Labelling all of them stacked three pills on each object at
    // three slightly different projected positions, and because the high-detail
    // level attaches asynchronously (assets.ts:18 resolves on a timer) their DOM
    // order — and so which pill painted on top — differed from run to run.
    if (hasLabelledAncestor(obj, root)) return
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
  // Gating the whole selection on the 3D scene having loaded left every
  // freshly-ingested scan permanently unselectable: registerSessionScan()
  // gives video/photo-ingest scans a synthetic filename that never lands on
  // disk (scan_id.ts), so their GLB 404s and loadedScans never gets a
  // `loaded: true` entry for them — clicking such a scan did nothing at all,
  // and job queueing (queueGuidedWorkflow) requires selectedScanId to be set.
  // Only the operations below that need actual geometry (camera focus,
  // transform gizmo, inspector) are gated on a loaded scan now; everything
  // else — selection state, panels, and job queueing — only needs the scan
  // to exist in the manifest.
  if (!world?.scans.some(scan => scan.scanId === scanId)) return
  const loaded = loadedScans.get(scanId)

  document.querySelectorAll('.scan-item').forEach(el => el.classList.remove('active'))
  scanItems.get(scanId)?.classList.add('active')
  selectedScanId = scanId

  if (loaded?.loaded) {
    selectedTransformTarget = loaded.root
    // Keep editor.selectedObject in sync the same way selectEditableObject() does —
    // handlers like "Hide Object" read it directly, and without this a whole-scan
    // selection made from the scan list (as opposed to a 3D-view pick) left it null.
    editor.selectObject(loaded.root)
    transformControls?.attach(loaded.root)
    showInspector(loaded.root)
    syncEditPanel(loaded.root, openEdit)
    if (focus) fitCamera(loaded.root)
  } else {
    // No geometry to show yet (still processing, or a session-backed scan
    // whose synthetic filename never gets a real GLB). Drop any 3D-object
    // selection left over from a previously-selected loaded scan instead of
    // leaving the inspector/gizmo pointed at it under the new scan's name.
    selectedTransformTarget = null
    editor.clearSelection()
    transformControls?.detach()
    hideInspectorOnly()
    const noSelection = document.getElementById('edit-no-selection')
    const selectedInfo = document.getElementById('edit-selected-info')
    if (noSelection) noSelection.style.display = 'block'
    if (selectedInfo) selectedInfo.style.display = 'none'
  }
  void refreshQualityPanel(scanId)
  void refreshLingBotMapPanel(scanId)
  void refreshSplatLayerPanel(scanId)
  if (PLACE_COMPOSER_ENABLED) renderPlacesPanel()
  renderItemsPanel()
}

// ─── Map-quality headline (per-scan tier + processing state) ──────────────────

/**
 * Render the "Map Quality" headline for the selected scan: a Preview →
 * Reconstructed → Photoreal stepper lit by which artifacts exist, plus a
 * single processing line when a quality-relevant world job is in flight for
 * this scan. Reuses the same manifest fetches the detailed sections use — it
 * prefers already-cached overlay/layer state and otherwise reads just the
 * manifests (no heavy PLY loads) so the badge lights up fast.
 */
async function refreshQualityPanel(scanId: string): Promise<void> {
  const stepper = document.getElementById('quality-stepper')
  if (!stepper) return
  const scan = world?.scans.find(s => s.scanId === scanId)
  if (!scan) return

  // Processing line first — it doesn't depend on the (async) manifest reads.
  renderQualityProcessing(scanId)

  const [reconstructedOk, splatOk] = await Promise.all([
    isReconstructedOk(scan),
    isSplatOk(scan),
  ])
  // A later selection may have superseded this async read.
  if (selectedScanId !== scanId) return

  const { tier, nextStep } = computeQualityTier({ reconstructedOk, splatOk })
  renderQualityStepper(tier)

  const blurb = document.getElementById('quality-blurb')
  if (blurb) blurb.textContent = QUALITY_TIER_BLURBS[tier]
  const next = document.getElementById('quality-next')
  if (next) {
    next.textContent = nextStep ?? ''
    next.hidden = !nextStep
  }
}

/** True when the scan's LingBot-Map reconstruction manifest exists and is ok. */
async function isReconstructedOk(scan: ScanManifest): Promise<boolean> {
  const cached = lingbotOverlays.get(scan.scanId)
  if (cached) return cached.manifest.status === 'ok'
  if (!scan.sessionId) return false
  try {
    const resp = await fetch(withAccessToken(
      `/sessions/${encodeURIComponent(scan.sessionId)}/lingbot-map.manifest.json`))
    if (!resp.ok) return false
    const m = await resp.json() as { status?: string }
    return m.status === 'ok'
  } catch {
    return false
  }
}

/** True when the scan's trained-splat manifest exists and is ok. */
async function isSplatOk(scan: ScanManifest): Promise<boolean> {
  const cached = scanSplatLayers.get(scan.scanId)
  if (cached) return cached.manifest.status === 'ok'
  try {
    const resp = await fetch(withAccessToken(splatManifestUrl(scan)))
    if (!resp.ok) return false
    const m = await resp.json() as { status?: string }
    return m.status === 'ok'
  } catch {
    return false
  }
}

function renderQualityStepper(current: QualityTier): void {
  const stepper = document.getElementById('quality-stepper')
  if (!stepper) return
  const currentIdx = QUALITY_TIERS.indexOf(current)
  stepper.innerHTML = ''
  for (let i = 0; i < QUALITY_TIERS.length; i++) {
    const tier = QUALITY_TIERS[i]!
    const step = document.createElement('div')
    step.className = 'quality-step'
    step.dataset['tier'] = tier
    step.setAttribute('role', 'listitem')
    if (i <= currentIdx) step.classList.add('reached')
    if (i === currentIdx) {
      step.classList.add('current')
      step.setAttribute('aria-current', 'step')
    }
    step.innerHTML = `
      <div class="quality-step-tick">${i <= currentIdx ? '●' : ''}</div>
      <div class="quality-step-label">${escHtml(QUALITY_TIER_LABELS[tier])}</div>
    `
    stepper.appendChild(step)
  }
}

/**
 * Show a single "Improving your scan — <friendly>…" line when a
 * quality-relevant world job for this scan is queued/processing; hide it
 * otherwise. A job with no scanId is treated as world-wide (applies to the
 * selected scan too).
 */
function renderQualityProcessing(scanId: string): void {
  const line = document.getElementById('quality-processing')
  const text = document.getElementById('quality-processing-text')
  if (!line || !text) return
  const active = (world?.jobs ?? []).find(job =>
    (job.status === 'queued' || job.status === 'processing')
    && (!job.scanId || job.scanId === scanId)
    && jobProcessingLabel(job.type) !== null)
  if (!active) {
    line.hidden = true
    text.textContent = ''
    return
  }
  text.textContent = `Improving your scan — ${jobProcessingLabel(active.type)}…`
  line.hidden = false
}

// Test hook: lets Playwright inject a queued job and re-render the headline
// without spinning up a GPU trainer.
;(window as unknown as { __quality: { injectJob: (type: WorldJobType, scanId: string | null) => void } })
  .__quality = {
    injectJob(type, scanId) {
      if (!world) return
      world.jobs.unshift({
        jobId: `test-${Date.now()}`,
        worldId: world.worldId,
        type,
        status: 'queued',
        scanId: scanId ?? undefined,
        capabilities: [],
        payload: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      renderWorldPanel()
    },
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

// ─── Trained splat layer (splat-train job output) ─────────────────────────────

async function refreshSplatLayerPanel(scanId: string): Promise<void> {
  const status = document.getElementById('splat-layer-status')
  const stats = document.getElementById('splat-layer-stats')
  const toggle = document.getElementById('splat-layer-toggle') as HTMLInputElement | null
  if (!status || !stats) return
  const scan = world?.scans.find(s => s.scanId === scanId)
  if (!scan) {
    status.textContent = 'Select a scan to see its trained Gaussian splat.'
    stats.textContent = ''
    return
  }
  if (!scan.sessionId) {
    status.textContent = 'This scan has no streamed keyframes — start keyframe streaming first.'
    stats.textContent = ''
    return
  }

  let layer = scanSplatLayers.get(scanId)
  if (!layer) {
    status.textContent = 'Loading trained splat…'
    stats.textContent = ''
    try {
      const fetched = await fetchScanSplatLayer(scan, (url) => fetch(withAccessToken(url)))
      if (!fetched) {
        status.textContent = 'No trained splat yet. Queue the splat-train job to create one.'
        stats.textContent = ''
        if (toggle) toggle.checked = false
        return
      }
      layer = fetched
      scanSplatLayers.set(scanId, layer)
      if (layer.loaded) {
        const loadedScan = loadedScans.get(scanId)
        if (loadedScan) loadedScan.root.add(layer.loaded.mesh)
        layer.loaded.mesh.visible = scanSplatVisible
      }
    } catch (e) {
      console.error('[viewer] splat layer fetch failed:', e)
      status.textContent = `Failed to load trained splat: ${e instanceof Error ? e.message : String(e)}`
      stats.textContent = ''
      return
    }
  }

  const m = layer.manifest
  if (m.status === 'ok') {
    const sourceNote = layer.loadedSource === 'sog'
      ? ' (web-optimized .sog)'
      : layer.loadedSource === 'compressed-ply'
        ? ' (compressed .ply)'
        : ''
    status.textContent = `Trained splat ready — ${layer.gaussianCount.toLocaleString()} gaussians${sourceNote}.`
    const trainedLine = m.timing?.elapsedMs
      ? `Trained in ${(m.timing.elapsedMs / 1000).toFixed(1)}s on ${m.frameCount ?? '?'} frames.`
      : ''
    const finishLine = formatFinishStats(layer.finish)
    stats.textContent = [trainedLine, finishLine].filter(Boolean).join(' ')
    if (toggle) toggle.checked = scanSplatVisible
    setSplatDownloadLink(scan, layer)
  } else if (m.status === 'skipped') {
    status.textContent = `Skipped: ${m.skippedReason ?? 'no reason given'}`
    stats.textContent = m.remediation ?? ''
    setSplatDownloadLink(null)
  } else {
    status.textContent = `Splat train error: ${m.error ?? 'unknown'}`
    stats.textContent = ''
    setSplatDownloadLink(null)
  }

  void refreshSplatDetectPanel(scanId)
}

/** Reveal (or hide) the Download .ply / .sog links for a scan with a trained splat. */
function setSplatDownloadLink(scan: ScanManifest | null, layer?: ScanSplatLayer): void {
  const link = document.getElementById('splat-download-link') as HTMLAnchorElement | null
  const sogLink = document.getElementById('splat-download-sog-link') as HTMLAnchorElement | null
  if (link) {
    if (!scan) {
      link.hidden = true
    } else {
      link.href = withAccessToken(splatPlyUrl(scan))
      link.setAttribute('download', `${scan.name || scan.scanId}.splat.ply`)
      link.hidden = false
    }
  }
  // The .sog link appears only once the splat-finish job has landed its bundle.
  if (sogLink) {
    const finishOk = Boolean(scan && layer?.finish?.status === 'ok' && layer.finish.sogPath)
    if (!finishOk || !scan) {
      sogLink.hidden = true
    } else {
      sogLink.href = withAccessToken(splatSogUrl(scan))
      sogLink.setAttribute('download', `${scan.name || scan.scanId}.sog`)
      sogLink.hidden = false
    }
  }
}

function setScanSplatVisible(visible: boolean): void {
  scanSplatVisible = visible
  for (const layer of scanSplatLayers.values()) {
    if (layer.loaded) layer.loaded.mesh.visible = visible
  }
}

// ─── Splat-detect object boxes (splat-detect job output) ──────────────────────

async function refreshSplatDetectPanel(scanId: string): Promise<void> {
  const status = document.getElementById('splat-detect-status')
  const toggle = document.getElementById('splat-detect-toggle') as HTMLInputElement | null
  if (!status) return
  const scan = world?.scans.find(s => s.scanId === scanId)
  if (!scan) {
    status.textContent = 'Detect objects in the trained splat with an open-vocabulary prompt.'
    return
  }

  let layer = scanDetectLayers.get(scanId)
  if (!layer) {
    try {
      const fetched = await fetchScanDetectLayer(scan, (url) => fetch(withAccessToken(url)))
      if (!fetched) {
        status.textContent = 'No detections yet. Run Detect objects to find furniture in the splat.'
        if (toggle) toggle.checked = false
        return
      }
      layer = fetched
      scanDetectLayers.set(scanId, layer)
      if (layer.objectCount > 0) {
        const loadedScan = loadedScans.get(scanId)
        if (loadedScan) loadedScan.root.add(layer.boxesGroup)
        layer.boxesGroup.visible = scanDetectVisible
        for (const marker of layer.labels) {
          createLabel(marker.text, marker.position, { scanId, layerType: 'labels' })
        }
      }
    } catch (e) {
      console.error('[viewer] detect layer fetch failed:', e)
      status.textContent = `Failed to load detections: ${e instanceof Error ? e.message : String(e)}`
      return
    }
  }

  const m = layer.manifest
  if (m.status === 'ok') {
    status.textContent = layer.objectCount > 0
      ? `${layer.objectCount.toLocaleString()} object${layer.objectCount === 1 ? '' : 's'} detected${m.prompt ? ` · ${m.prompt}` : ''}.`
      : 'Detect finished, but no objects matched the prompt.'
    if (toggle) toggle.checked = scanDetectVisible
  } else if (m.status === 'skipped') {
    status.textContent = `Detect skipped: ${m.skippedReason ?? 'no reason given'}`
  } else {
    status.textContent = `Detect error: ${m.error ?? 'unknown'}`
  }
}

function setScanDetectVisible(visible: boolean): void {
  scanDetectVisible = visible
  for (const layer of scanDetectLayers.values()) {
    layer.boxesGroup.visible = visible
  }
  applyLayerVisibility()
}

async function queueSplatToolboxJob(kind: 'train' | 'detect'): Promise<void> {
  if (!world) return
  if (!selectedScanId) {
    const statusId = kind === 'train' ? 'splat-layer-status' : 'splat-detect-status'
    setText(statusId, 'Select a scan first, then run this job.')
    return
  }
  const prompt = (document.getElementById('splat-detect-prompt') as HTMLInputElement | null)?.value
  const request = kind === 'train'
    ? buildTrainJobRequest(selectedScanId)
    : buildDetectJobRequest(selectedScanId, prompt)
  const response = await fetch(withAccessToken(`/worlds/${encodeURIComponent(world.shareSlug)}/jobs`), {
    method: 'POST',
    headers: accessHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(await response.text())
  const job = await response.json() as WorldJob
  world.jobs.unshift(job)
  renderWorldPanel()
  flashButton(kind === 'train' ? 'btn-splat-train' : 'btn-splat-detect', 'Queued')
  setTimeout(() => { void refreshJobs() }, 1000)
}

async function queueSenseNovaJob(): Promise<void> {
  if (!world) return
  if (!selectedScanId) {
    setText('sensenova-status', 'Select a scan first, then run SenseNova.')
    return
  }
  const task = (document.getElementById('sensenova-task') as HTMLSelectElement | null)?.value ?? 'recon3d'
  const query = (document.getElementById('sensenova-query') as HTMLInputElement | null)?.value.trim() ?? ''
  const response = await fetch(withAccessToken(`/worlds/${encodeURIComponent(world.shareSlug)}/jobs`), {
    method: 'POST',
    headers: accessHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      type: 'sensenova-vision',
      scanId: selectedScanId,
      payload: { task, ...(query ? { query } : {}), source: 'viewer-processing-studio', requestedAt: new Date().toISOString() },
    }),
  })
  if (!response.ok) throw new Error(await response.text())
  const job = await response.json() as WorldJob
  world.jobs.unshift(job)
  setText('sensenova-status', `Queued SenseNova ${task.replace(/_/g, ' ')}.`)
  renderWorldPanel()
  flashButton('btn-sensenova-run', 'Queued')
  setTimeout(() => { void refreshJobs() }, 1000)
}

// ─── Gaussian splats (Spark) ──────────────────────────────────────────────────

async function addSplat(source: Parameters<typeof loadSplat>[0]): Promise<void> {
  const status = document.getElementById('splat-status')
  if (status) status.textContent = 'Loading splat…'
  try {
    const loaded = await loadSplat(source)
    if (!scene) throw new Error('scene not ready')
    scene.add(loaded.mesh)
    loadedSplats.set(loaded.id, loaded)
    if (status) status.textContent = ''
  } catch (e) {
    if (status) status.textContent = `Failed to load splat: ${e instanceof Error ? e.message : String(e)}`
    console.error('[viewer] splat load failed:', e)
  }
  renderSplatList()
}

function removeSplat(id: string): void {
  const loaded = loadedSplats.get(id)
  if (!loaded) return
  disposeSplat(loaded)
  loadedSplats.delete(id)
  renderSplatList()
}

function renderSplatList(): void {
  const list = document.getElementById('splat-list')
  if (!list) return
  list.innerHTML = ''

  if (loadedSplats.size === 0) {
    list.innerHTML = '<div class="layer-meta">No splats loaded.</div>'
    return
  }

  for (const loaded of loadedSplats.values()) {
    const row = document.createElement('div')
    row.className = 'layer-item'

    const left = document.createElement('div')
    left.style.minWidth = '0'
    left.innerHTML = `
      <div class="layer-name">${escHtml(loaded.label)}</div>
      <div class="layer-meta">${loaded.mesh.numSplats.toLocaleString()} splats</div>
    `

    const remove = document.createElement('button')
    remove.className = 'job-btn'
    remove.textContent = '✕'
    remove.title = 'Remove splat'
    remove.addEventListener('click', () => removeSplat(loaded.id))

    row.append(left, remove)
    list.appendChild(row)
  }
}

function selectEditableObject(obj: THREE.Object3D, openEdit = true): void {
  const scan = scanForObject(obj)
  selectedScanId = scan?.manifest.scanId ?? null
  selectedTransformTarget = obj
  // editor.pick() already syncs editor.selectedObject for the click-to-pick caller, but
  // the background-reload reattach below calls this directly without a raycast — and
  // setScene() (called unconditionally on every reload, before that reattach runs) resets
  // editor.selectedObject to null regardless. Syncing it here, for every caller, is what
  // keeps handlers that read editor.selectedObject directly (e.g. "Hide Object") working
  // right after a reattach instead of silently no-op-ing on a selection the UI still shows.
  editor.selectObject(obj)
  transformControls?.attach(obj)
  showInspector(obj)
  syncEditPanel(obj, openEdit)
  if (selectedScanId) {
    document.querySelectorAll('.scan-item').forEach(el => el.classList.remove('active'))
    scanItems.get(selectedScanId)?.classList.add('active')
  }
}

function clearSelection(): void {
  selectedTransformTarget = null
  selectedScanId = null
  editor.clearSelection()
  transformControls?.detach()
  hideInspectorOnly()
  const noSelection = document.getElementById('edit-no-selection')!
  const selectedInfo = document.getElementById('edit-selected-info')!
  noSelection.style.display = 'block'
  selectedInfo.style.display = 'none'
  renderItemsPanel()
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
    data.tag ? rowHtml('Category', `<span style="background:rgba(114,221,212,0.18);color:#72ddd4;padding:1px 6px;border-radius:4px;font-weight:700;">${escHtml(String(data.tag))}</span>`) : '',
    data.aiLabel ? rowHtml('Label', escHtml(data.aiLabel)) : '',
    data.confidence !== undefined ? rowHtml('Conf', `<span class="inspector-confidence" style="background:${confColor}22;color:${confColor};">${Math.round(data.confidence * 100)}%</span>`) : '',
    // 'Scan' comes from the viewer's own loaded-scan registry — which file this
    // node was loaded from. 'Source' comes from the node's baked-in extras —
    // which capture(s) the geometry itself came from. They agree today and will
    // not once a merged per-place GLB exists, which is the whole reason
    // provenance is written per node.
    scan ? rowHtml('Scan', escHtml(scan.manifest.name)) : '',
    data.sourceScanIds?.length ? rowHtml('Source', escHtml(data.sourceScanIds.join(', '))) : '',
    data.captureIndex !== undefined ? rowHtml('Capture', `#${data.captureIndex}`) : '',
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

// Traverses like findObjectByTargetId() (:2336) — a plain THREE.Object3D.traverse()
// with a first-match early exit, not hand-rolled recursion.
function firstLod(root: THREE.Object3D): THREE.LOD | null {
  let match: THREE.LOD | null = null
  root.traverse((obj) => {
    if (match) return
    if (obj instanceof THREE.LOD) match = obj
  })
  return match
}

// Test hook: selects a scan's first semantic LOD (by tree order — NOT necessarily the
// same node a raycast would resolve to; see editor_pick.test.ts for that) and drives
// the save-transform round trip through the real selectEditableObject()/
// saveSelectedTransform() path, without a raycast. A real canvas click cannot reach a
// semantic object in the seeded test-home corpus today — point-cloud hits and the
// always-attached gizmo's own helper both intercept the ray first, a separate defect
// recorded in docs/factory/03-readiness-hardening/README.md ("found but deferred").
// This hook lets 0004's round-trip regression test (tests/mock-editor-homes.spec.ts)
// exercise the LOD save/reload fix without depending on that unrelated fix landing
// first. Double-gated: import.meta.env.DEV is a Vite build-time constant, so `npm run
// build`'s production bundle (what Docker/STATIC_DIR actually serves, per CLAUDE.md)
// dead-code-eliminates this whole block — appending ?mock=editor to a deployed session
// cannot reach it. The ?mock=... query check on top is the same convention
// src/test/webxr-emulation.ts uses for ?mock=webxr, so it still doesn't fire in an
// ordinary `vite dev` session either.
if (import.meta.env.DEV && query.get('mock') === 'editor') {
  (window as unknown as {
    __editorTest: {
      selectFirstLod: (scanId: string) => { name: string; objectId: string; filename: string; gizmoAttached: boolean } | null
      worldTransform: () => { position: [number, number, number]; scale: [number, number, number] } | null
      nudgeAndSave: (dx: number, dy: number, dz: number) => Promise<boolean>
    }
  }).__editorTest = {
    selectFirstLod(scanId: string) {
      const loaded = loadedScans.get(scanId)
      if (!loaded) return null
      const found = firstLod(loaded.root)
      if (!found) return null
      // `filename` disambiguates which *generation* this is. loadedScans is keyed by
      // scanId, but a world can hold several scans sharing one scanId (re-uploading a
      // fixture derives the same scanId from its sessionId), and only the last to
      // finish loading survives in the Map — so the same scanId can resolve to a
      // different root across a reload. Returning it lets a caller assert it didn't.
      // selectEditableObject() already syncs editor.selectedObject internally (see
      // its own comment) — no separate editor.selectObject() call needed here.
      selectEditableObject(found)
      return {
        name: found.name,
        objectId: stableObjectId(found),
        filename: loaded.manifest.filename,
        gizmoAttached: transformControls?.object === found,
      }
    },
    worldTransform() {
      if (!selectedTransformTarget) return null
      const pos = new THREE.Vector3()
      const scl = new THREE.Vector3()
      selectedTransformTarget.getWorldPosition(pos)
      selectedTransformTarget.getWorldScale(scl)
      return { position: [pos.x, pos.y, pos.z], scale: [scl.x, scl.y, scl.z] }
    },
    async nudgeAndSave(dx: number, dy: number, dz: number) {
      if (!selectedTransformTarget || !world) return false
      selectedTransformTarget.position.x += dx
      selectedTransformTarget.position.y += dy
      selectedTransformTarget.position.z += dz
      selectedTransformTarget.updateMatrixWorld(true)
      // A real drag fires TransformControls' objectChange listener (updates the Edit
      // panel readout and HUD) — this mutates position directly, so fire it too.
      transformControls?.dispatchEvent({ type: 'objectChange' })
      await saveSelectedTransform()
      return true
    },
  }
}

async function saveObjectSemanticPatch(obj: THREE.Object3D): Promise<void> {
  if (!world) return
  const data = editor.getInspectorData(obj)
  const scan = scanForObject(obj)
  const originTargetId = stableObjectId(obj)
  const thing = thingForTarget(originTargetId)
  await postEditPatch({
    scope: thing ? 'thing' : 'object',
    scanId: scan?.manifest.scanId,
    targetId: thing?.thingId ?? originTargetId,
    originTargetId: thing ? originTargetId : undefined,
    label: data.aiLabel ?? data.name,
    category: data.tag ? String(data.tag) : undefined,
    notes: data.notes,
  })
}

function thingForTarget(targetId: string) {
  if (!world) return null
  const observation = (world.thingObservations ?? []).find(obs => obs.targetId === targetId)
  if (!observation) return null
  return (world.things ?? []).find(thing => thing.thingId === observation.thingId) ?? null
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

function inventoryItems(scanId: string | null = null): InventoryItem[] {
  if (!world) return []

  const observations = world.thingObservations ?? []
  if (world.things.length > 0) {
    const preferredObservations = scanId
      ? observations.filter(observation => observation.scanId === scanId)
      : observations
    const observationsByThing = new Map<string, typeof observations[number]>()
    for (const observation of preferredObservations) {
      const current = observationsByThing.get(observation.thingId)
      if (!current || (observation.observedAt ?? '') > (current.observedAt ?? '')) {
        observationsByThing.set(observation.thingId, observation)
      }
    }

    return world.things
      .filter(thing => !scanId || observationsByThing.has(thing.thingId))
      .map(thing => {
        const observation = observationsByThing.get(thing.thingId)
          ?? observations.find(candidate => candidate.thingId === thing.thingId && candidate.scanId === thing.lastSeenScanId)
          ?? observations.find(candidate => candidate.thingId === thing.thingId)
        return {
          id: thing.thingId,
          label: thing.canonicalLabel,
          scanId: observation?.scanId ?? thing.lastSeenScanId,
          position: observation?.worldPos ?? thing.position,
          confidence: observation?.confidence ?? null,
          source: 'thing',
        }
      })
  }

  // A correspondence job has not run yet. Surface the actual labelled nodes in
  // each loaded GLB rather than hiding the inventory behind that later step.
  const records: InventoryItem[] = []
  for (const [loadedScanId, loaded] of loadedScans) {
    if (!loaded.loaded || (scanId && loadedScanId !== scanId)) continue
    loaded.root.updateMatrixWorld(true)
    loaded.root.traverse((node) => {
      const data = node.userData as Record<string, unknown>
      const label = typeof data['label'] === 'string' ? data['label'] : ''
      if (!label) return
      // The renderer can label an optimized proxy that no longer has a Mesh
      // below it. It is still a real identified item, so follow the same
      // one-label-per-ancestor rule used by createSemanticLabels().
      if (hasLabelledAncestor(node, loaded.root)) return
      const position = node.getWorldPosition(new THREE.Vector3())
      records.push({
        id: String(data['objectId'] ?? node.uuid),
        label,
        scanId: loadedScanId,
        position: { x: position.x, y: position.y, z: position.z },
        confidence: typeof data['confidence'] === 'number' ? data['confidence'] : null,
        source: 'detection',
      })
    })
  }
  return records
}

interface OutlinerLocation {
  building: string
  floor: string
  room: string
}

interface OutlinerRoom {
  scans: ScanManifest[]
}

interface OutlinerFloor {
  rooms: Map<string, OutlinerRoom>
}

interface OutlinerBuilding {
  floors: Map<string, OutlinerFloor>
}

function outlinerLocationForScan(scan: ScanManifest): OutlinerLocation {
  const areas = currentProject?.areas ?? []
  const areasById = new Map(areas.map(area => [area.areaId, area]))
  const ancestry: PlaceArea[] = []
  const visited = new Set<string>()
  let current = scan.areaId ? areasById.get(scan.areaId) : undefined
  while (current && !visited.has(current.areaId)) {
    ancestry.unshift(current)
    visited.add(current.areaId)
    current = current.parentAreaId ? areasById.get(current.parentAreaId) : undefined
  }

  const linkedFloorId = [...ancestry].reverse().find(area => area.floorId)?.floorId ?? null
  const linkedRoomId = [...ancestry].reverse().find(area => area.roomId)?.roomId ?? null
  const linkedFloor = linkedFloorId
    ? currentProject?.floors.find(floor => floor.floorId === linkedFloorId)
    : undefined
  const linkedRoom = linkedFloor?.rooms.find(room => room.roomId === linkedRoomId)

  return {
    building: ancestry.find(area => area.kind === 'building')?.name ?? 'Unassigned building',
    floor: ancestry.find(area => area.kind === 'floor')?.name ?? linkedFloor?.name ?? 'Unassigned floor',
    room: ancestry.find(area => area.kind === 'room')?.name ?? linkedRoom?.name ?? 'Unassigned room',
  }
}

function createOutlinerGroup(kind: string, name: string, detail: string, open: boolean): HTMLDetailsElement {
  const group = document.createElement('details')
  group.className = `scene-tree-group scene-tree-${kind}`
  group.open = open

  const summary = document.createElement('summary')
  summary.className = 'scene-tree-row'
  const label = document.createElement('span')
  label.className = 'scene-tree-label'
  label.textContent = name
  const meta = document.createElement('span')
  meta.className = 'scene-tree-meta'
  meta.textContent = detail
  summary.append(label, meta)
  group.appendChild(summary)
  return group
}

function scanDateLabel(scan: ScanManifest): string {
  if (!scan.capturedAt) return 'Unknown date'
  const date = new Date(scan.capturedAt)
  return Number.isNaN(date.getTime())
    ? 'Unknown date'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function appendOutlinerScan(parent: HTMLElement, scan: ScanManifest, items: InventoryItem[]): void {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'scene-tree-scan'
  row.classList.toggle('active', scan.scanId === selectedScanId)
  row.setAttribute('aria-pressed', String(scan.scanId === selectedScanId))
  row.innerHTML = `
    <span class="scene-tree-scan-name">${escHtml(scan.name)}</span>
    <span class="scene-tree-scan-meta">${scanDateLabel(scan)} · ${items.length} thing${items.length === 1 ? '' : 's'}</span>
  `
  row.addEventListener('click', () => selectScan(scan.scanId, true, false))
  parent.appendChild(row)

  if (items.length === 0) return
  const things = createOutlinerGroup('things', 'Things', `${items.length} identified`, scan.scanId === selectedScanId)
  for (const item of items.sort((a, b) => a.label.localeCompare(b.label))) {
    const thing = document.createElement('button')
    thing.type = 'button'
    thing.className = 'scene-tree-thing'
    const confidence = item.confidence == null ? '' : ` · ${Math.round(item.confidence * 100)}%`
    thing.innerHTML = `<span>${escHtml(item.label)}</span><small>${formatItemPosition(item.position)}${confidence}</small>`
    thing.addEventListener('click', () => selectScan(scan.scanId, true, false))
    things.appendChild(thing)
  }
  parent.appendChild(things)
}

function placeLabel(): string {
  const place = projectLocations.find(location => location.projectId === activeProjectId)
  if (!place) return world?.name ?? 'Current project'
  return place.address ? `${place.name} - ${place.address}` : place.name
}

function formatItemPosition(position: InventoryItem['position']): string {
  return `ENU ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)} m`
}

function renderItemsPanel(): void {
  const list = document.getElementById('items-list')
  if (!list || !world) return

  const selectedScan = selectedScanId
    ? world.scans.find(scan => scan.scanId === selectedScanId) ?? null
    : null
  const visibleScans = world.scans.filter(scanInTimeline)
  const itemsByScan = new Map(visibleScans.map(scan => [scan.scanId, inventoryItems(scan.scanId)]))
  list.innerHTML = ''
  renderReviewComments()

  if (visibleScans.length === 0) {
    list.innerHTML = `<div class="inventory-empty">No scans are in this date range. Expand the range to show this Place.</div>`
    return
  }

  const hierarchy = new Map<string, OutlinerBuilding>()
  for (const scan of visibleScans) {
    const location = outlinerLocationForScan(scan)
    let building = hierarchy.get(location.building)
    if (!building) {
      building = { floors: new Map() }
      hierarchy.set(location.building, building)
    }
    let floor = building.floors.get(location.floor)
    if (!floor) {
      floor = { rooms: new Map() }
      building.floors.set(location.floor, floor)
    }
    let room = floor.rooms.get(location.room)
    if (!room) {
      room = { scans: [] }
      floor.rooms.set(location.room, room)
    }
    room.scans.push(scan)
  }

  const place = createOutlinerGroup('place', placeLabel(), `${visibleScans.length} scan${visibleScans.length === 1 ? '' : 's'}`, true)
  for (const [buildingName, building] of hierarchy) {
    const buildingScans = [...building.floors.values()].reduce((total, floor) => total + [...floor.rooms.values()].reduce((count, room) => count + room.scans.length, 0), 0)
    const buildingNode = createOutlinerGroup('building', buildingName, `${buildingScans} scan${buildingScans === 1 ? '' : 's'}`, Boolean(selectedScan && visibleScans.some(scan => scan.scanId === selectedScan.scanId && outlinerLocationForScan(scan).building === buildingName)))
    for (const [floorName, floor] of building.floors) {
      const floorScans = [...floor.rooms.values()].reduce((total, room) => total + room.scans.length, 0)
      const floorNode = createOutlinerGroup('floor', floorName, `${floorScans} scan${floorScans === 1 ? '' : 's'}`, Boolean(selectedScan && outlinerLocationForScan(selectedScan).building === buildingName && outlinerLocationForScan(selectedScan).floor === floorName))
      for (const [roomName, room] of floor.rooms) {
        const roomNode = createOutlinerGroup('room', roomName, `${room.scans.length} scan${room.scans.length === 1 ? '' : 's'}`, Boolean(selectedScan && outlinerLocationForScan(selectedScan).building === buildingName && outlinerLocationForScan(selectedScan).floor === floorName && outlinerLocationForScan(selectedScan).room === roomName))
        for (const scan of room.scans.sort((a, b) => (a.capturedAt ?? '').localeCompare(b.capturedAt ?? ''))) {
          appendOutlinerScan(roomNode, scan, itemsByScan.get(scan.scanId) ?? [])
        }
        floorNode.appendChild(roomNode)
      }
      buildingNode.appendChild(floorNode)
    }
    place.appendChild(buildingNode)
  }
  list.appendChild(place)
}

function renderReviewComments(): void {
  const list = document.getElementById('review-comments-list')
  const scope = document.getElementById('review-comments-scope')
  const input = document.getElementById('review-comment-input') as HTMLTextAreaElement | null
  if (!list || !scope || !world) return

  const selectedScan = selectedScanId
    ? world.scans.find(scan => scan.scanId === selectedScanId) ?? null
    : null
  const comments = (world.comments ?? [])
    .filter(comment => !selectedScanId || comment.scanId === selectedScanId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  scope.textContent = selectedScan ? selectedScan.name : placeLabel()
  if (input) input.placeholder = selectedScan
    ? `Leave a review note for ${selectedScan.name}`
    : 'Leave a review note for this Place'
  list.innerHTML = ''

  if (comments.length === 0) {
    list.innerHTML = `<div class="inventory-empty">No comments for ${selectedScan ? 'this scan' : 'this Place'} yet.</div>`
    return
  }

  for (const comment of comments) {
    const row = document.createElement('article')
    row.className = 'review-comment'
    const target = comment.scanId
      ? world.scans.find(scan => scan.scanId === comment.scanId)?.name ?? 'scan'
      : 'Place'
    const when = new Date(comment.createdAt).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    row.innerHTML = `
      <div class="review-comment-body">${escHtml(comment.body)}</div>
      <div class="review-comment-meta">${escHtml(comment.actorRole)} review · ${escHtml(target)} · ${escHtml(when)}</div>
    `
    list.appendChild(row)
  }
}

async function addReviewComment(): Promise<void> {
  if (!world) return
  const input = document.getElementById('review-comment-input') as HTMLTextAreaElement | null
  const status = document.getElementById('review-comment-status')
  const button = document.getElementById('review-comment-submit') as HTMLButtonElement | null
  const body = input?.value.trim() ?? ''
  if (!body) {
    if (status) status.textContent = 'Write a note before adding it.'
    input?.focus()
    return
  }
  if (button) button.disabled = true
  if (status) status.textContent = 'Saving review note...'
  try {
    const response = await fetch(withAccessToken(`/worlds/${encodeURIComponent(world.shareSlug)}/comments`), {
      method: 'POST',
      headers: accessHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ body, scanId: selectedScanId ?? null }),
    })
    if (!response.ok) throw new Error(await response.text())
    const comment = await response.json() as ReviewComment
    ;(world.comments ??= []).unshift(comment)
    if (input) input.value = ''
    if (status) status.textContent = 'Comment saved.'
    renderReviewComments()
  } catch (error) {
    if (status) status.textContent = `Could not add comment: ${errorMessage(error)}`
  } finally {
    if (button) button.disabled = false
  }
}

function renderWorldPanel(): void {
  if (!world) return

  // optimize-scan runs as a WorldJob since the 01-merge-jobs wave (ADR 0003),
  // but the Processing Queue panel keeps its pre-merge scope: optimize-scan
  // surfaces only as the per-scan status chip (via the 'job-update' event),
  // never in this list — every upload would otherwise push a row here and,
  // with the list capped at 8, crowd out the reconstruction jobs this panel
  // exists to show.
  const queueJobs = world.jobs.filter(job => job.type !== 'optimize-scan')
  setText('world-scan-count', String(world.scans.length))
  setText('world-layer-count', String(LAYER_ORDER.length))
  setText('world-job-count', String(queueJobs.length))
  setText('world-origin-label', hasGeoPose(world.originGeoPose) ? 'GPS' : 'Local')
  renderToolbarSummary(queueJobs)
  renderJobs(queueJobs)
  renderItemsPanel()
  if (selectedScanId) renderQualityProcessing(selectedScanId)
}

function renderLayerPanel(): void {
  const list = document.getElementById('layer-list')
  if (!list) return
  list.innerHTML = ''

  for (const type of LAYER_ORDER) {
    // The Gaussian-splat surface lives in the dedicated Splat Toolbox section
    // below; keep it out of this generic sidecar-layer list.
    if (type === 'splat') continue
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

function renderPlacesPanel(): void {
  const root = document.getElementById('places-list')
  if (!root) return
  placesPanel ??= new PlacesPanel(
    root,
    accessHeaders,
    () => selectedScanId && world ? world.scans.find(scan => scan.scanId === selectedScanId) ?? null : null,
    () => { void refreshWorldScans() },
  )
  void placesPanel.render()
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
    const labels: Record<string, string> = {
      viewer: 'View only',
      commenter: 'Comment',
      editor: 'Edit',
      scanner: 'Scanner',
      owner: 'Owner',
    }
    for (const role of ['viewer', 'commenter', 'editor', 'scanner', 'owner']) {
      const url = payload.links[role]
      if (!url) continue
      const row = document.createElement('div')
      row.className = 'world-link-row'
      const label = document.createElement('span')
      label.textContent = labels[role] ?? role
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

async function queueJob(type: WorldJobType): Promise<void> {
  if (!world) return
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
}

async function queueSelectedJob(): Promise<void> {
  const select = document.getElementById('job-type') as HTMLSelectElement
  await queueJob(select.value as WorldJobType)
  renderWorldPanel()
  flashButton('btn-queue-job', 'Queued')
  setTimeout(() => { void refreshJobs() }, 1000)
}

const GUIDED_WORKFLOWS: Record<string, WorldJobType[]> = {
  prepare: ['ingest', 'extract-layers', 'align-scan'],
  understand: ['semantic-pass', 'thing-correspondence'],
  reconstruct: ['lingbot-map-reconstruct', 'splat-train'],
  publish: ['memory-push', 'export-world'],
}

async function queueGuidedWorkflow(name: string, button: HTMLButtonElement): Promise<void> {
  if (!selectedScanId) {
    button.textContent = 'Select scan'
    setTimeout(() => { button.textContent = name[0].toUpperCase() + name.slice(1) }, 1500)
    return
  }
  const types = GUIDED_WORKFLOWS[name]
  if (!types) return
  button.textContent = 'Queuing...'
  for (const type of types) await queueJob(type)
  renderWorldPanel()
  button.textContent = 'Queued'
  setTimeout(() => { button.textContent = name[0].toUpperCase() + name.slice(1) }, 1500)
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

function syncViewMenu(): void {
  const setChecked = (id: string, checked: boolean) => {
    const control = document.getElementById(id) as HTMLInputElement | null
    if (control) control.checked = checked
  }
  setChecked('view-toggle-map', geoMap.isOpen)
  setChecked('view-toggle-points', cloudVisible && globalLayerVisible.points)
  setChecked('view-toggle-floor', globalLayerVisible.floor)
  setChecked('view-toggle-mesh', globalLayerVisible.mesh)
  setChecked('view-toggle-path', globalLayerVisible.cameraPath)
  setChecked('view-toggle-frustums', globalLayerVisible.cameraFrustums)
  setChecked('view-toggle-images', globalLayerVisible.rgbFrames)
  setChecked('view-toggle-grid', groundGrid?.visible ?? true)
  setChecked('view-toggle-labels', labelsVisible && globalLayerVisible.labels)
}

function renderToolbarSummary(queueJobs: WorldJob[]): void {
  if (!world) return
  const activeJobs = queueJobs.filter(job => job.status === 'queued' || job.status === 'processing')
  setText('toolbar-project-name', world.name)
  setText('toolbar-scan-count', String(world.scans.length))
  setText('toolbar-layer-count', String(LAYER_ORDER.length))
  setText('toolbar-job-count', `${activeJobs.length}/${queueJobs.length}`)
  document.getElementById('toolbar-jobs')?.classList.toggle('is-active', activeJobs.length > 0)
}

// ─── Layer visibility ────────────────────────────────────────────────────────

function applyLayerVisibility(): void {
  const pointsAllowedByMode = editor.mode === 'points' || editor.mode === 'solid' || editor.mode === 'semantic'
  const meshesAllowedByMode = editor.mode !== 'points'

  for (const loaded of loadedScans.values()) {
    loaded.root.visible = scanRendered(loaded)
    for (const [type, nodes] of loaded.layerNodes) {
      for (const node of nodes) {
        const visible = scanRendered(loaded) && layerVisibilityFor(type, pointsAllowedByMode, meshesAllowedByMode)
        node.visible = visible
      }
    }
  }

  for (const obj of detectionBoundsObjects) {
    const scanId = String(obj.userData['scanId'] ?? '')
    obj.visible = detectionBoundsVisible
      && globalLayerVisible.detections
      && (scanRendered(loadedScans.get(scanId)) || !loadedScans.has(scanId))
  }

  for (const label of labels) {
    label.el.style.display = isLabelVisible(label) ? '' : 'none'
  }

  // OFF is 0.6, not 0.4. At 0.4 the label measured 2.88:1 against the HUD
  // ground — below the 4.5:1 AA minimum for text and below even the 3:1 for a
  // UI component, so a toggle that is merely off read as broken in a still.
  // 0.6 measures ~4.6:1 and is still obviously dimmer than the ON state, which
  // now also carries the `active` treatment rather than relying on dimness alone.
  const setToggle = (id: string, on: boolean) => {
    const el = document.getElementById(id)
    if (!el) return
    el.style.opacity = on ? '1' : '0.6'
    el.classList.toggle('active', on)
    el.setAttribute('aria-pressed', String(on))
  }

  setToggle('btn-toggle-cloud', cloudVisible && globalLayerVisible.points)
  setToggle('btn-toggle-labels', labelsVisible && globalLayerVisible.labels)
  // `active-hud` had no rule anywhere in viewer.html — a typo for `active`, so
  // the teal on-state this line was meant to apply had never once rendered.
  setToggle('btn-toggle-bounds', detectionBoundsVisible)
  syncViewMenu()
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

  // The bar's WIDTH is the claim; the label only says what unit it is in. So the
  // two have to be the same measurement, and the fallback is where that broke.
  //
  // Rungs step by up to 2.5x while [58, 130] px spans only 2.24x, so a camera can
  // sit in a gap where NO rung fits the bar. The old loop had no answer for that:
  // it overwrote `selected` on every non-fitting pass and clamped the width, so it
  // ran off the end of the ladder and drew a 130 px bar under the largest label
  // there was. The mobile World Editor found that hole the moment its aspect
  // changed — 2 m projected to 56 px and 5 m to 135 px, and a six-metre room was
  // captioned "50 m", the same false readout video/README.md calls the tell of a
  // badly framed shot.
  //
  // Below, a gap resolves to the rung that comes CLOSEST to the band, drawn at its
  // true width. Whenever a rung does fit — which is every camera the band already
  // covered — the answer is unchanged.
  const RUNGS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200]
  const MIN_PX = 58
  const MAX_PX = 130

  let meters = 0
  let px = 0
  let closest = Infinity
  for (const rung of RUNGS) {
    const width = projectedPixelDistance(controls.target, controls.target.clone().add(new THREE.Vector3(rung, 0, 0)))
    if (!(width > 0)) continue
    if (width >= MIN_PX && width <= MAX_PX) {
      meters = rung
      px = width
      break
    }
    const miss = width < MIN_PX ? MIN_PX - width : width - MAX_PX
    if (miss < closest) {
      closest = miss
      meters = rung
      px = width
    }
  }

  // Nothing measured — a camera looking straight down the axis being measured
  // projects every rung to zero width. Hold the last good reading rather than
  // draw a bar with no length under a unit it does not stand for.
  if (!meters) return

  scaleBar.style.width = `${Math.min(MAX_PX, px).toFixed(0)}px`
  scaleLabel.textContent = meters < 1 ? `${Math.round(meters * 100)} cm` : `${meters} m`
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

function safeObjectToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'node'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A dropped-mid-flight network request. `fetch` (and three's FileLoader, which
 * forwards fetch's reject) throw `TypeError: Failed to fetch` when the browser
 * drops an in-flight request during the heavy initial load burst under CPU
 * contention — even though the server answers every request it receives. HTTP
 * error statuses arrive as a plain Error / HttpError instead, so restricting to
 * TypeError retries only the genuine transient and surfaces real errors at once.
 */
function isTransientFetchError(error: unknown): boolean {
  if (error instanceof TypeError) return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /failed to fetch/i.test(message)
}

/**
 * Run an idempotent network op, retrying only transient drops with a short
 * backoff. During the initial world-load burst (world + jobs + share links, GLB
 * loads, optimize-manifest and frame-observation fetches all firing at once)
 * these transient rejects would otherwise drop the scan list / jobs / geometry
 * on the floor and strand the scan at "not Ready". Worst case adds ~0.9s.
 */
async function withTransientRetry<T>(op: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op()
    } catch (error) {
      if (attempt >= retries || !isTransientFetchError(error)) throw error
      await delay(150 * (attempt + 1))
    }
  }
}

/** GET + parse JSON, riding out transient network drops during load. */
function fetchJson<T>(url: string): Promise<T> {
  return withTransientRetry(async () => {
    const response = await fetch(withAccessToken(url), { headers: accessHeaders() })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    return await response.json() as T
  })
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
  if (name === 'places' && !PLACE_COMPOSER_ENABLED) {
    switchSidebarTab('scans')
    return
  }
  const isDetailsTab = ['scans', 'things', 'world', 'layers', 'edit'].includes(name)
  const detailsPanelId = name === 'scans' || name === 'things' ? 'details-items' : `tab-${name}`
  const layerInfo = document.getElementById('sidebar-layer-info')
  const hierarchyEditor = document.getElementById('project-hierarchy-editor')
  const projectSwitcher = document.getElementById('project-switcher')
  if (layerInfo) layerInfo.hidden = name !== 'layers'
  if (hierarchyEditor) hierarchyEditor.hidden = name !== 'world'
  if (projectSwitcher) projectSwitcher.hidden = name !== 'world'
  document.querySelectorAll('.sidebar-tab').forEach(button => {
    const el = button as HTMLButtonElement
    const isActive = el.dataset['tab'] === name
    el.classList.toggle('active', isActive)
    el.setAttribute('aria-selected', String(isActive))
  })
  document.querySelectorAll('.sidebar-panel').forEach(panel => {
    const el = panel as HTMLElement
    el.classList.toggle('active', el.id === `tab-${name}`)
  })

  document.querySelectorAll('.details-panel').forEach(panel => {
    const el = panel as HTMLElement
    el.classList.toggle('active', isDetailsTab && el.id === detailsPanelId)
  })

  const drawer = document.getElementById('details-drawer')
  if (isDetailsTab) drawer?.classList.remove('collapsed')

  const title = document.getElementById('details-drawer-title')
  if (title && isDetailsTab) {
    title.textContent = name === 'scans' || name === 'things'
      ? 'Items'
      : name === 'world'
        ? 'Project'
        : name === 'edit'
          ? 'Edit & annotate'
          : name[0].toUpperCase() + name.slice(1)
  }
  if (name === 'scans' || name === 'things') renderItemsPanel()
  if (name === 'things') renderThingsPanel()
  if (name === 'world') renderProjectHierarchyEditor()
}

// ─── DOM wiring ──────────────────────────────────────────────────────────────

if (PLACE_COMPOSER_ENABLED) {
  document.getElementById('tab-btn-places')?.removeAttribute('hidden')
  document.getElementById('tab-places')?.removeAttribute('hidden')
}

document.querySelectorAll('.sidebar-tab').forEach(button => {
  button.addEventListener('click', () => {
    switchSidebarTab((button as HTMLButtonElement).dataset['tab']!)
  })
})

document.getElementById('project-place-type')?.addEventListener('change', () => {
  syncProjectHierarchyFields()
  updateProjectHierarchyPreview()
})
document.getElementById('project-place-name')?.addEventListener('input', updateProjectHierarchyPreview)
document.getElementById('project-floor-name')?.addEventListener('input', updateProjectHierarchyPreview)
document.getElementById('project-building-name')?.addEventListener('input', updateProjectHierarchyPreview)
document.getElementById('project-hierarchy-save')?.addEventListener('click', () => void saveProjectHierarchy())

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

const viewModeSelect = document.getElementById('view-mode-select') as HTMLSelectElement | null
viewModeSelect?.addEventListener('change', () => {
  editor.setMode(viewModeSelect.value as ViewMode)
  applyLayerVisibility()
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

document.getElementById('review-comment-submit')?.addEventListener('click', () => {
  void addReviewComment()
})

document.querySelectorAll<HTMLButtonElement>('[data-workflow]').forEach((button) => {
  button.addEventListener('click', () => {
    void queueGuidedWorkflow(button.dataset['workflow'] ?? '', button).catch((error) => {
      console.error('[viewer] guided workflow queue failed:', error)
      button.textContent = 'Failed'
      setTimeout(() => { button.textContent = button.dataset['workflow'] ?? 'Retry' }, 1500)
    })
  })
})

document.getElementById('lingbot-map-points-toggle')?.addEventListener('change', (e) => {
  setLingBotPointsVisible((e.target as HTMLInputElement).checked)
})
document.getElementById('lingbot-map-path-toggle')?.addEventListener('change', (e) => {
  setLingBotPathVisible((e.target as HTMLInputElement).checked)
})
document.getElementById('splat-layer-toggle')?.addEventListener('change', (e) => {
  setScanSplatVisible((e.target as HTMLInputElement).checked)
})
document.getElementById('splat-detect-toggle')?.addEventListener('change', (e) => {
  setScanDetectVisible((e.target as HTMLInputElement).checked)
})
document.getElementById('btn-splat-train')?.addEventListener('click', () => {
  void queueSplatToolboxJob('train').catch(error => {
    console.error('[viewer] splat-train queue failed:', error)
    flashButton('btn-splat-train', 'Failed')
  })
})
document.getElementById('btn-splat-detect')?.addEventListener('click', () => {
  void queueSplatToolboxJob('detect').catch(error => {
    console.error('[viewer] splat-detect queue failed:', error)
    flashButton('btn-splat-detect', 'Failed')
  })
})
document.getElementById('btn-sensenova-run')?.addEventListener('click', () => {
  void queueSenseNovaJob().catch((error) => {
    setText('sensenova-status', `Could not queue SenseNova: ${errorMessage(error)}`)
    flashButton('btn-sensenova-run', 'Failed')
  })
})

document.getElementById('btn-load-splat-url')?.addEventListener('click', () => {
  const input = document.getElementById('splat-url-input') as HTMLInputElement | null
  const url = input?.value.trim()
  if (!url) return
  void addSplat({ kind: 'url', url })
  if (input) input.value = ''
})
document.getElementById('splat-file-input')?.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  void file.arrayBuffer().then((fileBytes) => addSplat({ kind: 'file', fileBytes, fileName: file.name }))
  input.value = ''
})

document.getElementById('inspector-close')!.addEventListener('click', clearSelection)

const viewToggle = (id: string) => document.getElementById(id) as HTMLInputElement | null

viewToggle('view-toggle-map')?.addEventListener('change', (event) => {
  if ((event.target as HTMLInputElement).checked) geoMap.open()
  else geoMap.close()
  syncViewMenu()
})

viewToggle('view-toggle-points')?.addEventListener('change', (event) => {
  cloudVisible = (event.target as HTMLInputElement).checked
  globalLayerVisible.points = cloudVisible
  renderLayerPanel()
  applyLayerVisibility()
})

viewToggle('view-toggle-floor')?.addEventListener('change', (event) => {
  globalLayerVisible.floor = (event.target as HTMLInputElement).checked
  renderLayerPanel()
  applyLayerVisibility()
})

viewToggle('view-toggle-mesh')?.addEventListener('change', (event) => {
  globalLayerVisible.mesh = (event.target as HTMLInputElement).checked
  renderLayerPanel()
  applyLayerVisibility()
})

viewToggle('view-toggle-path')?.addEventListener('change', (event) => {
  globalLayerVisible.cameraPath = (event.target as HTMLInputElement).checked
  renderLayerPanel()
  applyLayerVisibility()
})

viewToggle('view-toggle-frustums')?.addEventListener('change', (event) => {
  globalLayerVisible.cameraFrustums = (event.target as HTMLInputElement).checked
  renderLayerPanel()
  applyLayerVisibility()
})

viewToggle('view-toggle-images')?.addEventListener('change', (event) => {
  globalLayerVisible.rgbFrames = (event.target as HTMLInputElement).checked
  renderLayerPanel()
  applyLayerVisibility()
})

viewToggle('view-toggle-grid')?.addEventListener('change', (event) => {
  if (groundGrid) groundGrid.visible = (event.target as HTMLInputElement).checked
  syncViewMenu()
})

viewToggle('view-toggle-labels')?.addEventListener('change', (event) => {
  labelsVisible = (event.target as HTMLInputElement).checked
  globalLayerVisible.labels = labelsVisible
  renderLayerPanel()
  applyLayerVisibility()
})

document.getElementById('btn-livefeed')?.addEventListener('click', () => {
  if (!liveFeed) return
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
      if (msg['type'] === EVENT.SCAN_ADDED || msg['type'] === EVENT.SESSION_FINALIZED) {
        scheduleWorldRefresh()
      } else if (msg['type'] === EVENT.JOB_UPDATE) {
        handleJobUpdate(msg['job'] as { target?: string; status?: string; note?: string | null })
      } else if (msg['type'] === EVENT.WORLD_JOB_UPDATE) {
        const wj = msg['job'] as { jobType?: string; type?: string; status?: string; scanId?: string } | undefined
        const t = wj?.type ?? wj?.jobType
        if (t === 'lingbot-map-reconstruct' && wj?.status === 'completed' && wj?.scanId) {
          lingbotOverlays.delete(wj.scanId)
          if (selectedScanId === wj.scanId) void refreshLingBotMapPanel(wj.scanId)
        }
        if ((t === 'splat-train' || t === 'splat-finish') && wj?.status === 'completed' && wj?.scanId) {
          const existing = scanSplatLayers.get(wj.scanId)
          if (existing) disposeScanSplatLayer(existing)
          scanSplatLayers.delete(wj.scanId)
          if (selectedScanId === wj.scanId) void refreshSplatLayerPanel(wj.scanId)
        }
        if (t === 'splat-detect' && wj?.status === 'completed' && wj?.scanId) {
          scanDetectLayers.delete(wj.scanId)
          if (selectedScanId === wj.scanId) void refreshSplatDetectPanel(wj.scanId)
        }
        if (t === 'thing-correspondence' && wj?.status === 'completed') {
          scheduleWorldRefresh()
        }
        if ((t === 'lingbot-map-reconstruct' || t === 'splat-train')
          && wj?.status === 'completed' && selectedScanId
          && (!wj.scanId || wj.scanId === selectedScanId)) {
          void refreshQualityPanel(selectedScanId)
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
    const [updated, projects] = await Promise.all([
      fetchJson<WorldProject>(activeWorldUrl()),
      fetchJson<Project[]>('/projects').catch(() => []),
    ])
    world = scopeWorldToActiveProject(updated)
    knownProjects = projects
    currentProject = projects.find(project => project.projectId === activeProjectId) ?? currentProject
    buildTimeline(world.scans)
    renderWorldPanel()
    if (PLACE_COMPOSER_ENABLED) renderPlacesPanel()
    renderProjectHierarchyEditor()
    renderThingsPanel()
    const fresh = world.scans.filter((scan) => !scanItems.has(scan.scanId))
    if (fresh.length === 0) return

    document.getElementById('viewer-placeholder')!.style.display = 'none'
    const listEl = document.getElementById('scan-list')!
    document.getElementById('scan-list-empty')?.remove()
    for (const scan of fresh) {
      const item = buildScanItem(scan)
      scanItems.set(scan.scanId, item)
      listEl.prepend(item)
      void enqueueScanLoad(scan).catch(() => { /* status chip shows the error */ })
    }
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
      void enqueueScanLoad(scan).catch(() => { /* status chip shows the error */ })
    }
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────

initRenderer()
startRenderLoop()
void loadWorldProject()
connectServerEvents()
