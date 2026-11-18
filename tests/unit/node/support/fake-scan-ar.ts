/**
 * A fake ScanAR plugin and the small helpers that drive one: the stand-in the native provider's tests share
 * (tests/unit/node/native_ar_provider.test.ts, wp-09b-native-provider.test.ts, desktop_engine_state.test.ts), so that no
 * test file carries its own copy of how the plugin answers.
 *
 * Not a test file: it has no `.test.ts` name, so no runner collects it. Nothing here has run against a device: the
 * plugin's behaviour is the one native-bridge.ts documents and the two native sources show.
 */
import type { NativeRenderer } from '../../../../src/ar/native.ts'
import type { NativeFrame, NativeHitSample, ScanARPlugin } from '../../../../src/ar/native-bridge.ts'

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

export function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
}

/** A column-major perspective projection for a vertical field of view and an aspect (width / height). */
export function perspective(fovYDeg: number, aspect: number): number[] {
  const t = Math.tan((fovYDeg * Math.PI) / 360)
  return [1 / (aspect * t), 0, 0, 0, 0, 1 / t, 0, 0, 0, 0, -1.0002, -1, 0, 0, -0.02, 0]
}

export const RECT = { x: 10, y: 20, width: 300, height: 400 }

export interface FakePlugin extends ScanARPlugin {
  emit(event: string, payload: unknown): void
  listenerCount(event: string): number
  removed: number
  started: number
  stopped: number
  captures: number
  hitCalls: Array<{ x: number; y: number }>
  nextFrame: () => Promise<NativeFrame>
  nextHit: NativeHitSample
  startFails: string | null
  startOptions: Array<{ depth: boolean; hitGrid: number; worldMap?: string }>
  worldMapResult: 'loaded' | 'missing' | 'unreadable' | null
  saves: string[]
}

export function fakeJpegFrame(timestamp = 2): NativeFrame {
  return {
    timestamp,
    width: 4,
    height: 2,
    jpegBase64: Buffer.from([0xff, 0xd8, 0xff]).toString('base64'),
    transform: translation(0, 1.5, 0),
    projection: perspective(60, 2),
  }
}

export function fakePlugin(): FakePlugin {
  const listeners = new Map<string, Array<(e: unknown) => void>>()
  const plugin: FakePlugin = {
    removed: 0,
    started: 0,
    stopped: 0,
    captures: 0,
    hitCalls: [],
    startFails: null,
    startOptions: [],
    worldMapResult: null,
    saves: [],
    nextHit: { hit: true, position: [0, 1, -2], rotation: [0, 0, 0, 1], distance: 2.24 },
    nextFrame: async () => fakeJpegFrame(),
    emit(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    listenerCount(event: string) {
      return listeners.get(event)?.length ?? 0
    },
    async capabilities() {
      return { platform: 'ios', engine: 'arkit', supported: true, depth: false, worldMap: true }
    },
    async start(options: { depth: boolean; hitGrid: number; worldMap?: string }) {
      if (plugin.startFails) throw new Error(plugin.startFails)
      plugin.started += 1
      plugin.startOptions.push(options)
      return plugin.worldMapResult
        ? { rect: RECT, cameraAspect: 0.75, worldMap: plugin.worldMapResult }
        : { rect: RECT, cameraAspect: 0.75 }
    },
    async saveWorldMap({ name }: { name: string }) {
      plugin.saves.push(name)
      return { name, bytes: 123 }
    },
    async stop() {
      plugin.stopped += 1
    },
    async captureFrame() {
      plugin.captures += 1
      return plugin.nextFrame()
    },
    async hitTest({ x, y }: { x: number; y: number }) {
      plugin.hitCalls.push({ x, y })
      return plugin.nextHit
    },
    addListener(event: string, listener: (e: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return Promise.resolve({
        remove: async () => {
          plugin.removed += 1
          const current = listeners.get(event) ?? []
          listeners.set(event, current.filter((l) => l !== listener))
        },
      })
    },
  } as unknown as FakePlugin
  return plugin
}

export function fakeRenderer(): NativeRenderer & { disposed: number; sizes: number[][] } {
  const renderer = {
    disposed: 0,
    sizes: [] as number[][],
    setPixelRatio() {},
    setSize(width: number, height: number) {
      renderer.sizes.push([width, height])
    },
    render() {},
    dispose() {
      renderer.disposed += 1
    },
  }
  return renderer
}

export function fakeCanvas(): HTMLCanvasElement {
  return { style: {} } as unknown as HTMLCanvasElement
}

/** The options a NativeARProvider is built with in these tests: the fake plugin, no WebGL, no real timers. */
export function providerOptions(plugin: FakePlugin, extra: Record<string, unknown> = {}) {
  let time = 0
  return {
    plugin,
    createRenderer: () => fakeRenderer(),
    schedule: () => 1,
    cancel: () => undefined,
    now: () => {
      time += 1
      return time
    },
    decodeJpeg: async (_jpeg: Uint8Array, width: number, height: number) =>
      new Uint8ClampedArray(width * height * 4),
    ...extra,
  }
}

/** One native frame every 1/30 s: the rate both plugins send poses at (33 ms on Android, 1/30 s on iOS). */
export const FRAME_S = 1 / 30

/**
 * A phone that moves through a native session and reports it the way the plugin does: a pose event for each frame,
 * stamped in seconds on the native clock, and a `tracking` event for a state change that has no pose behind it.
 * The motion is scripted by the test from physical reasoning (a walk, a stall, a pause), not computed by anything
 * under test.
 */
export class ScriptedPhone {
  /** The native clock, seconds. Starts at an arbitrary uptime. */
  t = 100
  x = 0
  y = 1.4
  z = 0
  private readonly plugin: FakePlugin
  constructor(plugin: FakePlugin) {
    this.plugin = plugin
  }

  /** Sends one pose event for the phone where it is now. */
  send(tracking = 'normal'): void {
    this.plugin.emit('pose', {
      timestamp: this.t,
      transform: translation(this.x, this.y, this.z),
      projection: perspective(60, 0.75),
      tracking,
    })
  }

  /** `frames` frames at 30 Hz, walking along +x at `speedMps`. */
  walk(frames: number, speedMps = 1.4, tracking = 'normal'): void {
    for (let i = 0; i < frames; i++) {
      this.t += FRAME_S
      this.x += speedMps * FRAME_S
      this.send(tracking)
    }
  }

  /** One frame `gapS` seconds after the last, the phone having moved by (dx, dy, dz) in between. */
  frameAfter(gapS: number, dx = 0, dy = 0, dz = 0, tracking = 'normal'): void {
    this.t += gapS
    this.x += dx
    this.y += dy
    this.z += dz
    this.send(tracking)
  }

  /** A tracking state change that is not a pose: what the plugin sends when the session stops giving poses. */
  track(state: string): void {
    this.plugin.emit('tracking', { state })
  }
}
