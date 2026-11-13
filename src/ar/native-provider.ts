/**
 * The native AR provider: ARKit on iOS and ARCore on Android, behind the `ArSession` Capacitor plugin.
 *
 * The plugin is mobile/ios/App/App/ArSessionPlugin.swift and
 * mobile/android/app/src/main/java/com/companionintelligence/scan/ArSessionPlugin.java. Their method
 * names and event names are the ones this file uses, and tests/unit/node/native_provider.test.ts reads
 * both sources to keep them in step. The native side pushes events. This class caches the latest pushed
 * state and pose, and the synchronous ARProvider getters answer from that cache.
 *
 * What this build does, and what it does not:
 * - isSupported(), start() and stop() reach the native session.
 * - iOS pushes poses from ARKit. Android creates and resumes an ARCore session but runs no frame loop:
 *   session.update() needs the camera texture, and the camera-texture pipeline is not in this milestone.
 *   On Android the provider therefore reports a running session that has no pose.
 * - captureFrame() rejects and hitTest() returns null until that pipeline exists. featurePoints() is empty.
 * - getCameraFovY() is NaN. No native side measures the camera's field of view yet, and a fallback constant
 *   would reach reconstruction looking like a measured focal length (see the note on ARProvider.getCameraFovY).
 *
 * The plugin is read from Capacitor.Plugins on each call, so the web build does not bundle it and a test
 * can stand in a fake.
 */
import type { ARProvider, HitResult, Pose, RawFrame } from './provider.ts'
import type { TrackingStatus } from './tracking-quality.ts'

/** The part of the ArSession plugin this provider calls. Capacitor generates the real proxy from the native class. */
export interface ArSessionPlugin {
  isSupported(): Promise<{ supported?: unknown; availability?: unknown }>
  start(): Promise<void>
  stop(): Promise<void>
  addListener(event: 'pose' | 'state', listener: (data: unknown) => void): Promise<ListenerHandle>
}

interface ListenerHandle {
  remove(): Promise<void>
}

const IDENTITY_POSE: Pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }

const KNOWN_STATUSES: ReadonlySet<string> = new Set(['INITIALIZING', 'LIMITED', 'NORMAL', 'NOT_AVAILABLE'])

/** What a start that stop() overtook rejects with. */
const STOPPED = 'The AR session was stopped before it started'

/** The ArSession plugin in this native shell, or undefined on the web. */
export function nativeArSession(): ArSessionPlugin | undefined {
  return (globalThis as { Capacitor?: { Plugins?: { ArSession?: ArSessionPlugin } } }).Capacitor?.Plugins?.ArSession
}

function copyPose(pose: Pose): Pose {
  return { position: { ...pose.position }, rotation: { ...pose.rotation } }
}

function field(data: unknown, key: string): unknown {
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined
}

/** The finite numbers under `keys` in `value`, or null when any of them is missing or not a finite number. */
function finiteNumbers(value: unknown, keys: readonly string[]): number[] | null {
  const found = keys.map((key) => field(value, key))
  return found.every((n): n is number => typeof n === 'number' && Number.isFinite(n)) ? found : null
}

/**
 * A status the native side reports that this build does not know is not trusted. It reads as NOT_AVAILABLE,
 * which trackingIsUsable() rejects. (WebXR's 'UNKNOWN' is the opposite: it fails open.)
 */
function statusOf(raw: unknown): TrackingStatus {
  return typeof raw === 'string' && KNOWN_STATUSES.has(raw) ? (raw as TrackingStatus) : 'NOT_AVAILABLE'
}

/**
 * Reads a pose push: `{ position: {x,y,z}, rotation: {x,y,z,w}, trackingStatus }`. A push with a missing or
 * non-finite number, or an all-zero quaternion, is malformed and yields null, so the cache keeps its last good pose.
 */
export function parsePosePush(data: unknown): { pose: Pose; status: TrackingStatus } | null {
  const position = finiteNumbers(field(data, 'position'), ['x', 'y', 'z'])
  const rotation = finiteNumbers(field(data, 'rotation'), ['x', 'y', 'z', 'w'])
  if (!position || !rotation || rotation.every((c) => c === 0)) return null
  const [px, py, pz] = position
  const [rx, ry, rz, rw] = rotation
  return {
    pose: { position: { x: px, y: py, z: pz }, rotation: { x: rx, y: ry, z: rz, w: rw } },
    status: statusOf(field(data, 'trackingStatus')),
  }
}

function aspectOf(canvas: HTMLCanvasElement): number {
  const { clientWidth, clientHeight } = canvas
  return clientWidth > 0 && clientHeight > 0 ? clientWidth / clientHeight : Number.NaN
}

export class NativeARProvider implements ARProvider {
  private readonly plugin: () => ArSessionPlugin | undefined
  /** The start in flight, or the one that succeeded. Null after stop(), and after a start that failed. */
  private pending: Promise<void> | null = null
  /**
   * Bumped by every start and every stop. A listener, or a start, that finds it moved on belongs to a session
   * that has since stopped, so it does nothing.
   */
  private generation = 0
  /** Listener handles of the current start. Empty otherwise. */
  private handles: ListenerHandle[] = []
  /** The native side says its session is running. Set by a state push, and by start() once the native start resolves. */
  private live = false
  private havePose = false
  private pose: Pose = copyPose(IDENTITY_POSE)
  private poseStatus: TrackingStatus = 'NOT_AVAILABLE'
  private aspect = Number.NaN

  constructor(plugin: () => ArSessionPlugin | undefined = nativeArSession) {
    this.plugin = plugin
  }

  /** Whether this device runs ARKit or ARCore. False outside the native shell, and false when the check fails. */
  async isSupported(): Promise<boolean> {
    const plugin = this.plugin()
    if (!plugin) return false
    try {
      return (await plugin.isSupported()).supported === true
    } catch {
      return false
    }
  }

  /**
   * Starts the native session. A call made while a start is in flight, or after one succeeded, gets that same
   * promise. The listeners go on before the native start, so the state push that the native start sends is kept.
   * The start rejects if the native side refuses it: unsupported device, camera permission refused, or ARCore
   * still installing. A refused start leaves nothing attached, and a later start can try again. If the native
   * side ends the session later (a state push with running false), call stop() and then start() again.
   */
  start(canvas: HTMLCanvasElement): Promise<void> {
    const plugin = this.plugin()
    if (!plugin) return Promise.reject(new Error('The ArSession plugin is not in this build'))
    if (this.pending) return this.pending
    const started = this.begin(plugin, canvas)
    this.pending = started
    started.catch(() => {
      if (this.pending === started) this.pending = null
    })
    return started
  }

  /**
   * Stops the native session, forgets the cached pose, and cancels a start that is still in flight. It is
   * synchronous, as ARProvider requires, so the native call runs in the background, and a failure there is
   * ignored: the cache is already clear.
   */
  stop(): void {
    const plugin = this.plugin()
    this.generation++
    this.detach()
    if (plugin) void plugin.stop().catch(() => undefined)
  }

  /** Not in this milestone: frames come from the camera-texture pipeline, which is not wired. */
  captureFrame(): Promise<RawFrame> {
    return Promise.reject(new Error('Native camera frame capture is not in this build: the camera-texture pipeline is not wired'))
  }

  /** Not in this milestone: a hit test needs the camera frame. Null is the contract's answer for "no feature point here". */
  hitTest(_x: number, _y: number): HitResult | null {
    return null
  }

  /** Not in this milestone: neither native side reads feature points yet. */
  featurePoints(_gridSize?: number): Array<{ x: number; y: number; z: number }> {
    return []
  }

  getPose(): Pose {
    return copyPose(this.pose)
  }

  /** True once a real pose has arrived while the native session is live. */
  isTracking(): boolean {
    return this.live && this.havePose
  }

  trackingStatus(): TrackingStatus {
    if (!this.live) return 'NOT_AVAILABLE'
    return this.havePose ? this.poseStatus : 'INITIALIZING'
  }

  /** NaN: no native side measures the field of view yet. See the header comment. */
  getCameraFovY(): number {
    return Number.NaN
  }

  getCameraAspect(): number {
    return this.aspect
  }

  /** Attaches the listeners, then starts the native session. start() returns this promise. */
  private async begin(plugin: ArSessionPlugin, canvas: HTMLCanvasElement): Promise<void> {
    const generation = ++this.generation
    this.aspect = aspectOf(canvas)
    this.clearPose()
    const onPose = (data: unknown) => {
      if (generation === this.generation) this.onPose(data)
    }
    const onState = (data: unknown) => {
      if (generation === this.generation) this.onState(data)
    }
    try {
      this.keepHandle(generation, await plugin.addListener('pose', onPose))
      this.keepHandle(generation, await plugin.addListener('state', onState))
      await plugin.start()
      if (generation !== this.generation) {
        // stop() ran while the native start was in flight. The start may have brought the session up after the
        // native stop, so the native side is stopped again.
        void plugin.stop().catch(() => undefined)
        throw new Error(STOPPED)
      }
      this.live = true
    } catch (err) {
      if (generation === this.generation) this.detach()
      throw err
    }
  }

  /** Keeps a listener of this start. If stop() ran while the listener was attaching, it is taken back at once. */
  private keepHandle(generation: number, handle: ListenerHandle): void {
    if (generation === this.generation) {
      this.handles.push(handle)
      return
    }
    void handle.remove().catch(() => undefined)
    throw new Error(STOPPED)
  }

  private onPose(data: unknown): void {
    if (!this.live) return
    const parsed = parsePosePush(data)
    if (!parsed) return
    this.pose = parsed.pose
    this.poseStatus = parsed.status
    this.havePose = true
  }

  private onState(data: unknown): void {
    this.live = field(data, 'running') === true
    if (!this.live) this.clearPose()
  }

  private clearPose(): void {
    this.havePose = false
    this.pose = copyPose(IDENTITY_POSE)
    this.poseStatus = 'NOT_AVAILABLE'
  }

  /** Takes the current listeners back and clears everything they cached. Ends the pending start, if there is one. */
  private detach(): void {
    const handles = this.handles
    this.handles = []
    this.pending = null
    this.live = false
    this.clearPose()
    for (const handle of handles) void handle.remove().catch(() => undefined)
  }
}
