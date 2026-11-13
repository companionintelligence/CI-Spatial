/**
 * Headset world editor (xr-world.html): one world's Things, edited inside an immersive-vr session.
 *
 * The page opens the world the desktop editor opens (worldSlugFrom), loads each scan's GLB under its
 * localToWorld matrix, and draws each Thing as a marker at its position. In VR a controller ray picks
 * a marker (trigger), the thumbstick relabels it (up / down), and grip plus motion moves it. Every
 * committed change is POSTed to /worlds/:slug/patches, the endpoint and body the desktop editor uses:
 * a relabel is { scope: 'thing', label }, a move is { scope: 'thing', transform: { position } }.
 *
 * The decisions (label order, stick steps, the move, the slug) live in ./xr-world-model.ts.
 * ?mock=webxr installs the iwer emulator (src/test/webxr-emulation.ts); tests/mock-xr-world.spec.ts
 * drives it.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { apiUrl } from '../shared/api-base'
import { accessTokenFrom, accessTokenHeaders, addAccessToken } from '../shared/access-token'
import { resolveThingEditsForWorld, type ResolvedThingEdit } from '../shared/thing_tags'
import type {
  EditPatch,
  ScanManifest,
  Thing,
  ThingObservation,
  TransformPatch,
  Vec3,
  WorldProject,
} from '../world/types.ts'
import { cycleLabel, moveThing, thumbstickStep, worldSlugFrom, type StickLatch } from './xr-world-model'

const IDLE_COLOR = 0x72ddd4
const SELECTED_COLOR = 0xffd166
const MARKER_RADIUS_M = 0.07
const SELECTED_SCALE = 1.6
const RAY_LENGTH_M = 2
/** A grip that moves a marker less than this is a click: it moves nothing and saves nothing. */
const MIN_MOVE_M = 0.002

interface Marker {
  thingId: string
  /** The scan the patches are written against: the Thing's observation scan, else its last-seen scan. */
  scanId: string
  /** The object id the Thing has in that scan, the same originTargetId the desktop editor sends. */
  originTargetId: string | undefined
  label: string
  position: Vec3
  group: THREE.Group
  sphere: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>
  canvas: HTMLCanvasElement
  labelTexture: THREE.CanvasTexture
}

interface Grab {
  hand: number
  marker: Marker
  start: Vec3
  last: Vec3
}

/** The body POSTed to /worlds/:slug/patches. Field names and nesting match the desktop editor's patches. */
interface ThingPatchBody {
  scope: 'thing'
  scanId: string
  targetId: string
  originTargetId?: string
  label?: string
  transform?: TransformPatch
}

interface PatchResponse {
  ok: boolean
  patch: EditPatch
  world: WorldProject
}

interface OptimizationManifest {
  artifacts?: { optimized?: { filename: string } }
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id)
  if (!found) throw new Error(`xr-world.html has no #${id}`)
  return found
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** Same placement rule as the desktop viewer's applyMatrix(): the scan's localToWorld, column-major. */
function applyLocalToWorld(obj: THREE.Object3D, localToWorld: number[] | undefined): void {
  if (!localToWorld || localToWorld.length !== 16) return
  new THREE.Matrix4().fromArray(localToWorld).decompose(obj.position, obj.quaternion, obj.scale)
  obj.updateMatrixWorld(true)
}

function observationFor(thing: Thing, observations: ThingObservation[]): ThingObservation | undefined {
  const own = observations.filter(observation => observation.thingId === thing.thingId)
  return own.find(observation => observation.scanId === thing.lastSeenScanId) ?? own[0]
}

class HeadsetWorldEditor {
  private readonly token = accessTokenFrom(location.search)
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true })
  private readonly scene = new THREE.Scene()
  /** Scans and markers, in the Place frame. */
  private readonly content = new THREE.Group()
  private readonly scanRoots = new THREE.Group()
  private readonly markerRoot = new THREE.Group()
  private readonly preview = new THREE.PerspectiveCamera(60, 1, 0.05, 500)
  private readonly controls: OrbitControls
  private readonly loader = new GLTFLoader()
  private readonly raycaster = new THREE.Raycaster()
  private readonly rayGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -RAY_LENGTH_M),
  ])
  private readonly controllers: THREE.XRTargetRaySpace[]
  private readonly inputSources: Array<XRInputSource | null> = [null, null]
  private readonly latches: StickLatch[] = ['neutral', 'neutral']
  private readonly markers = new Map<string, Marker>()
  private readonly enterButton = element('enter-vr') as HTMLButtonElement
  private readonly statusEl = element('xr-status')
  private readonly worldNameEl = element('world-name')
  private edits = new Map<string, ResolvedThingEdit>()
  private world: WorldProject | null = null
  private selectedId: string | null = null
  private grab: Grab | null = null
  private saveQueue: Promise<void> = Promise.resolve()

  constructor() {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.xr.enabled = true
    element('stage').appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color(0x061c28)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x243a44, 1.8))
    const sun = new THREE.DirectionalLight(0xffffff, 1.1)
    sun.position.set(2, 4, 3)
    this.scene.add(sun)
    this.scene.add(new THREE.GridHelper(20, 20, IDLE_COLOR, 0x1d3a44))
    this.content.add(this.scanRoots, this.markerRoot)
    this.scene.add(this.content)

    this.preview.position.set(0, 1.6, 3)
    this.controls = new OrbitControls(this.preview, this.renderer.domElement)
    this.controls.target.set(0, 1, -1.5)
    this.controls.enableDamping = true
    this.controls.update()
    this.resize()
    window.addEventListener('resize', () => this.resize())

    const draco = new DRACOLoader()
    draco.setDecoderPath('/draco/')
    this.loader.setDRACOLoader(draco)

    this.controllers = [0, 1].map(index => this.renderer.xr.getController(index))
    this.controllers.forEach((controller, hand) => {
      controller.add(new THREE.Line(this.rayGeometry, new THREE.LineBasicMaterial({ color: IDLE_COLOR })))
      this.scene.add(controller)
      controller.addEventListener('connected', (event) => { this.inputSources[hand] = event.data })
      controller.addEventListener('disconnected', () => {
        this.inputSources[hand] = null
        this.endGrab(hand, false)
      })
      controller.addEventListener('selectstart', () => this.pick(hand))
      controller.addEventListener('squeezestart', () => this.beginGrab(hand))
      controller.addEventListener('squeezeend', () => this.endGrab(hand, true))
    })

    this.enterButton.addEventListener('click', () => { void this.enterVr() })
  }

  async start(): Promise<void> {
    this.renderer.setAnimationLoop(() => this.frame())

    const slug = worldSlugFrom(location.search)
    const blocked = await this.vrBlocker()
    try {
      this.world = await this.loadWorld(slug)
    } catch (error) {
      this.setStatus(`Could not load the world "${slug}": ${errorMessage(error)}.`, 'error')
      return
    }

    const world = this.world
    this.worldNameEl.textContent = world.name
    this.edits = resolveThingEditsForWorld(world.editPatches ?? [], world.things ?? [])
    const observations = world.thingObservations ?? []
    for (const thing of world.things ?? []) this.addMarker(thing, observationFor(thing, observations))

    const scans = world.scans ?? []
    this.setStatus(`Loading ${scans.length} scan${scans.length === 1 ? '' : 's'}…`)
    const results = await Promise.allSettled(scans.map(scan => this.loadScan(scan)))
    results.forEach((result, index) => {
      if (result.status === 'rejected') console.warn(`[xr-world] scan ${scans[index].filename}: ${errorMessage(result.reason)}`)
    })
    const failed = results.filter(result => result.status === 'rejected').length
    this.fitPreview()

    const things = `${this.markers.size} thing${this.markers.size === 1 ? '' : 's'} in "${world.name}"`
    const noGeometry = failed ? `; ${failed} scan${failed === 1 ? '' : 's'} without geometry` : ''
    if (blocked) {
      this.setStatus(`${things}${noGeometry}. ${blocked} This 2D view is read-only.`, 'error')
    } else {
      this.enterButton.disabled = false
      this.setStatus(`${things}${noGeometry}. Enter VR to edit.`)
    }
  }

  /** Why a headset session cannot start here, or null when it can. */
  private async vrBlocker(): Promise<string | null> {
    const xr = navigator.xr
    if (!xr) return 'WebXR is not available in this browser. Open this page in a VR headset browser to edit.'
    try {
      if (await xr.isSessionSupported('immersive-vr')) return null
    } catch (error) {
      return `Checking for immersive VR failed (${errorMessage(error)}).`
    }
    return 'This browser cannot start an immersive VR session. Open this page in a VR headset browser to edit.'
  }

  private async enterVr(): Promise<void> {
    const xr = navigator.xr
    if (!xr) return
    this.enterButton.disabled = true
    this.setStatus('Starting the VR session…')
    let session: XRSession | null = null
    try {
      session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] })
      session.addEventListener('end', () => this.onSessionEnd())
      await this.renderer.xr.setSession(session)
      document.body.dataset['mode'] = 'vr'
      this.setStatus('In VR. Point the ray at a marker and pull the trigger to select it.')
    } catch (error) {
      if (session) await session.end().catch(() => undefined)
      this.enterButton.disabled = false
      this.setStatus(`Could not start the VR session: ${errorMessage(error)}.`, 'error')
    }
  }

  private onSessionEnd(): void {
    if (document.body.dataset['mode'] !== 'vr') return
    const grab = this.grab
    if (grab) this.endGrab(grab.hand, false)
    this.latches.fill('neutral')
    this.inputSources.fill(null)
    document.body.dataset['mode'] = 'preview'
    this.enterButton.disabled = false
    this.setStatus('Left VR. Back to the read-only 2D view.')
  }

  private frame(): void {
    if (this.renderer.xr.isPresenting) {
      for (let hand = 0; hand < this.controllers.length; hand++) this.readThumbstick(hand)
      this.trackGrab()
    } else {
      this.controls.update()
    }
    this.renderer.render(this.scene, this.preview)
  }

  private readThumbstick(hand: number): void {
    const axes = this.inputSources[hand]?.gamepad?.axes
    // gamepad axes[3] is the thumbstick's y: negative pushed up, positive pushed down.
    const { step, latch } = thumbstickStep(axes?.[3] ?? 0, this.latches[hand])
    this.latches[hand] = latch
    if (step !== 0) this.cycleSelected(step)
  }

  private pick(hand: number): void {
    const controller = this.controllers[hand]
    controller.updateMatrixWorld(true)
    this.raycaster.setFromXRController(controller)
    const spheres = [...this.markers.values()].map(marker => marker.sphere)
    const hit = this.raycaster.intersectObjects(spheres, false)[0]
    this.select(hit ? String(hit.object.userData['thingId']) : null)
  }

  private select(thingId: string | null): void {
    this.selectedId = thingId
    document.body.dataset['selected'] = thingId ?? ''
    for (const marker of this.markers.values()) this.paint(marker)
    const marker = this.selectedMarker()
    this.setStatus(marker
      ? `Selected ${marker.label}. Thumbstick up or down changes its label; hold grip to move it.`
      : 'Nothing selected. Point the ray at a marker and pull the trigger.')
  }

  private cycleSelected(step: -1 | 1): void {
    const marker = this.selectedMarker()
    if (!marker) return
    const previous = marker.label
    const next = cycleLabel(previous, step)
    if (next === previous) return
    this.paintLabel(marker, next)
    this.commit(
      { ...this.patchBase(marker), label: next },
      () => this.paintLabel(marker, previous),
      `Saved label ${next}.`,
    )
    this.setStatus(`Label ${next}. Saving…`)
  }

  private beginGrab(hand: number): void {
    const marker = this.selectedMarker()
    if (this.grab || !marker) return
    this.grab = { hand, marker, start: { ...marker.position }, last: this.handPosition(hand) }
    document.body.dataset['drag'] = 'active'
    this.setStatus(`Moving ${marker.label}. Release grip to save.`)
  }

  /** Carries the gripped marker by however far the controller moved since the last frame. */
  private trackGrab(): void {
    const grab = this.grab
    if (!grab) return
    const now = this.handPosition(grab.hand)
    const delta = { x: now.x - grab.last.x, y: now.y - grab.last.y, z: now.z - grab.last.z }
    grab.last = now
    this.placeMarker(grab.marker, moveThing(grab.marker.position, delta))
  }

  /** Ends a grip and saves the move as one patch. `sample` takes the controller's pose at this release. */
  private endGrab(hand: number, sample: boolean): void {
    const grab = this.grab
    if (!grab || grab.hand !== hand) return
    if (sample) this.trackGrab()
    this.grab = null
    delete document.body.dataset['drag']
    const { marker, start } = grab
    if (distance(start, marker.position) < MIN_MOVE_M) {
      this.placeMarker(marker, start)
      return
    }
    this.commit(
      { ...this.patchBase(marker), transform: { position: { ...marker.position } } },
      () => this.placeMarker(marker, start),
      `Saved position of ${marker.label}.`,
    )
  }

  /**
   * Sends one patch. Patches go out one at a time, in order, so each response's world is
   * the state after every earlier edit. A failed one reverts its own change.
   */
  private commit(body: ThingPatchBody, revert: () => void, doneText: string): void {
    this.saveQueue = this.saveQueue
      .then(async () => {
        const slug = this.world?.shareSlug ?? ''
        const response = await fetch(addAccessToken(`/worlds/${encodeURIComponent(slug)}/patches`, this.token), {
          method: 'POST',
          headers: accessTokenHeaders(this.token, { 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
        })
        if (!response.ok) throw new Error(`the Scan server answered ${response.status}`)
        const payload = await response.json() as PatchResponse
        this.world = payload.world
        this.setStatus(doneText)
      })
      .catch((error: unknown) => {
        revert()
        this.setStatus(`Not saved, so the change was reverted: ${errorMessage(error)}.`, 'error')
      })
  }

  private patchBase(marker: Marker): Pick<ThingPatchBody, 'scope' | 'scanId' | 'targetId' | 'originTargetId'> {
    return {
      scope: 'thing',
      scanId: marker.scanId,
      targetId: marker.thingId,
      originTargetId: marker.originTargetId,
    }
  }

  private async loadWorld(slug: string): Promise<WorldProject> {
    const response = await fetch(addAccessToken(`/worlds/${encodeURIComponent(slug)}`, this.token), {
      headers: accessTokenHeaders(this.token),
    })
    if (!response.ok) throw new Error(`the Scan server answered ${response.status}`)
    return await response.json() as WorldProject
  }

  private async loadScan(scan: ScanManifest): Promise<void> {
    const root = new THREE.Group()
    root.name = scan.name || scan.filename
    applyLocalToWorld(root, scan.localToWorld)
    const gltf = await this.loader.loadAsync(apiUrl(await this.fullScanUrl(scan)))
    root.add(gltf.scene)
    this.scanRoots.add(root)
  }

  /** The GLB the desktop viewer loads for a scan: its optimized artifact when there is one, else the raw GLB. */
  private async fullScanUrl(scan: ScanManifest): Promise<string> {
    try {
      const response = await fetch(apiUrl(`/scans/${encodeURIComponent(scan.filename)}/manifest`))
      if (response.ok) {
        const manifest = await response.json() as OptimizationManifest
        const optimized = manifest.artifacts?.optimized
        if (optimized) return `/scans/${encodeURIComponent(optimized.filename)}`
      }
    } catch {
      // No readable manifest: the raw GLB is the scan.
    }
    return scan.glbUrl
  }

  private addMarker(thing: Thing, observation: ThingObservation | undefined): void {
    const edit = this.edits.get(thing.thingId)
    const group = new THREE.Group()
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(MARKER_RADIUS_M, 20, 14),
      new THREE.MeshStandardMaterial({ color: IDLE_COLOR, emissive: 0x0b3b3a, roughness: 0.5 }),
    )
    sphere.userData['thingId'] = thing.thingId
    group.add(sphere)

    // Drawn at twice the on-screen size, so the text stays sharp when the sprite is seen up close in VR.
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 192
    const labelTexture = new THREE.CanvasTexture(canvas)
    labelTexture.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthWrite: false }))
    sprite.scale.set(0.5, 0.1875, 1)
    sprite.position.set(0, 0.17, 0)
    group.add(sprite)
    this.markerRoot.add(group)

    const marker: Marker = {
      thingId: thing.thingId,
      scanId: observation?.scanId ?? thing.lastSeenScanId,
      originTargetId: observation?.targetId,
      label: '',
      position: { x: 0, y: 0, z: 0 },
      group,
      sphere,
      canvas,
      labelTexture,
    }
    this.markers.set(thing.thingId, marker)
    this.placeMarker(marker, edit?.position ?? thing.position)
    this.paintLabel(marker, edit?.label ?? thing.canonicalLabel)
    this.paint(marker)
  }

  private placeMarker(marker: Marker, position: Vec3): void {
    marker.position = { x: position.x, y: position.y, z: position.z }
    marker.group.position.set(position.x, position.y, position.z)
  }

  private paintLabel(marker: Marker, label: string): void {
    marker.label = label
    const context = marker.canvas.getContext('2d')
    if (context) {
      const { width, height } = marker.canvas
      context.clearRect(0, 0, width, height)
      context.fillStyle = 'rgba(4, 22, 32, 0.86)'
      context.fillRect(0, 0, width, height)
      context.fillStyle = '#eff0f0'
      context.font = '600 88px "Avenir Next", "Helvetica Neue", Arial, sans-serif'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(label, width / 2, height / 2)
    }
    marker.labelTexture.needsUpdate = true
  }

  private paint(marker: Marker): void {
    const selected = marker.thingId === this.selectedId
    marker.sphere.material.color.setHex(selected ? SELECTED_COLOR : IDLE_COLOR)
    marker.sphere.scale.setScalar(selected ? SELECTED_SCALE : 1)
  }

  private selectedMarker(): Marker | null {
    return this.selectedId ? this.markers.get(this.selectedId) ?? null : null
  }

  /** The controller's position in the scene, which is the Place frame the markers use. */
  private handPosition(hand: number): Vec3 {
    const controller = this.controllers[hand]
    controller.updateMatrixWorld(true)
    const position = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld)
    return { x: position.x, y: position.y, z: position.z }
  }

  private fitPreview(): void {
    const box = new THREE.Box3().setFromObject(this.content)
    if (box.isEmpty()) return
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    this.controls.target.copy(center)
    this.preview.position.copy(center).add(new THREE.Vector3(0, Math.max(1.5, size.y), Math.max(2.5, size.length())))
    this.controls.update()
  }

  private resize(): void {
    if (this.renderer.xr.isPresenting) return
    const width = window.innerWidth
    const height = window.innerHeight
    this.renderer.setSize(width, height)
    this.preview.aspect = width / height
    this.preview.updateProjectionMatrix()
  }

  private setStatus(text: string, tone: 'info' | 'error' = 'info'): void {
    this.statusEl.textContent = text
    this.statusEl.dataset['tone'] = tone
  }
}

function reportFailure(message: string): void {
  const statusEl = document.getElementById('xr-status')
  if (!statusEl) return
  statusEl.textContent = message
  statusEl.dataset['tone'] = 'error'
}

async function boot(): Promise<void> {
  // The emulator goes in before the renderer is built: three reads the XRWebGLBinding global when a
  // WebXR manager is constructed, and the emulator changes that global. src/main.ts does the same.
  if (new URLSearchParams(location.search).get('mock') === 'webxr') {
    const emulation = await import('../test/webxr-emulation')
    await emulation.installWebXREmulation()
  }
  await new HeadsetWorldEditor().start()
}

boot().catch((error: unknown) => {
  reportFailure(`This browser cannot run the headset editor (${errorMessage(error)}).`)
})
