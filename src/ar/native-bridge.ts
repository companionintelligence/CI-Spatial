/**
 * The ScanAR Capacitor plugin as the web app sees it: its methods, its events, and how the
 * plugin is found. The native code is mobile/ios/App/App/ScanARPlugin.swift (ARKit) and
 * mobile/android/app/src/main/java/com/companionintelligence/scan/ScanARPlugin.java (ARCore).
 *
 * The plugin is read from Capacitor.Plugins, so the web build bundles no native code, and a
 * browser (or a shell without the plugin) reports "no native layer" rather than failing.
 */
import { isNativeShell } from '../shared/api-base.ts'

export interface NativeListenerHandle {
  remove(): Promise<void>
}

export interface NativeARCapabilities {
  /** `ios` or `android`, or `web` when a native layer answered without a platform. */
  platform: string
  /** The AR runtime behind the plugin. */
  engine: 'arkit' | 'arcore' | 'none'
  /** True when a native AR session can start on this device right now. */
  supported: boolean
  /** True when the device can also return metric depth (LiDAR, or ARCore's depth API). */
  depth: boolean
  /** Why `supported` is false, when the native layer knows. */
  reason?: string
}

/** A rectangle in CSS pixels, relative to the WebView. */
export interface NativeRect {
  x: number
  y: number
  width: number
  height: number
}

export interface NativeStartResult {
  /**
   * Where the camera view sits, in CSS pixels. The native layer fits the whole camera
   * image inside the WebView ("contain"), so this rectangle has the camera's aspect and the
   * overlay canvas must cover exactly this rectangle.
   */
  rect: NativeRect
  /** Width over height of the camera image in display orientation. Equals rect.width / rect.height. */
  cameraAspect: number
}

export interface NativeDepthPayload {
  width: number
  height: number
  /** Float32 metres, little-endian, row-major. */
  metersBase64: string
}

export interface NativeFrame {
  timestamp: number
  width: number
  height: number
  /** The full camera image as JPEG, in display orientation, so its aspect matches the overlay rect. */
  jpegBase64: string
  /** Camera-to-world transform, 16 numbers, column-major. */
  transform: number[]
  /** Perspective projection for the overlay rect, 16 numbers, column-major. */
  projection: number[]
  depth?: NativeDepthPayload
}

export interface NativePoseEvent {
  timestamp: number
  /** Camera-to-world, 16 numbers, column-major. */
  transform: number[]
  /** Perspective projection for the overlay rect, 16 numbers, column-major. */
  projection: number[]
  /** A native tracking state, read by trackingStatusFromNative(). */
  tracking: string
}

/** New feature points since the last event, flat as x, y, z, x, y, z, ... in ARKit world metres. */
export interface NativePointsEvent {
  timestamp: number
  points: number[]
}

export interface NativeHitSample {
  hit: boolean
  position?: number[]
  rotation?: number[]
  distance?: number
}

/** A `cols × rows` grid of hit-test samples over the overlay rect, row-major, normalised 0..1 coordinates. */
export interface NativeHitsEvent {
  timestamp: number
  cols: number
  rows: number
  samples: NativeHitSample[]
}

export interface NativeTrackingEvent {
  state: string
}

export interface NativeErrorEvent {
  message: string
}

/** The ScanAR plugin's methods and events, as Capacitor exposes them to the web app. */
export interface ScanARPlugin {
  capabilities(): Promise<NativeARCapabilities>
  start(options: { depth: boolean; hitGrid: number }): Promise<NativeStartResult>
  stop(): Promise<void>
  captureFrame(options: { depth: boolean }): Promise<NativeFrame>
  /** A single hit test at normalised (0..1) coordinates of the overlay rect. */
  hitTest(options: { x: number; y: number }): Promise<NativeHitSample>
  addListener(event: 'pose', listener: (e: NativePoseEvent) => void): Promise<NativeListenerHandle>
  addListener(event: 'points', listener: (e: NativePointsEvent) => void): Promise<NativeListenerHandle>
  addListener(event: 'hits', listener: (e: NativeHitsEvent) => void): Promise<NativeListenerHandle>
  addListener(event: 'tracking', listener: (e: NativeTrackingEvent) => void): Promise<NativeListenerHandle>
  addListener(event: 'error', listener: (e: NativeErrorEvent) => void): Promise<NativeListenerHandle>
}

/** The ScanAR plugin, or null outside the native shell or when the shell has not registered it. */
export function scanARPlugin(): ScanARPlugin | null {
  if (!isNativeShell()) return null
  const plugins = (globalThis as unknown as { Capacitor?: { Plugins?: { ScanAR?: ScanARPlugin } } }).Capacitor
    ?.Plugins
  return plugins?.ScanAR ?? null
}

/**
 * What the native layer can do, or null when there is no native layer or it cannot answer.
 * Never throws: a failed probe is the same as no native layer, and the web runtimes take over.
 */
export async function probeNativeAR(plugin: ScanARPlugin | null = scanARPlugin()): Promise<NativeARCapabilities | null> {
  if (!plugin) return null
  try {
    return await plugin.capabilities()
  } catch {
    return null
  }
}
