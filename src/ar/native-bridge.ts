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
  /** True when the native layer can save a world map and start a session from one (ARKit only). */
  worldMap?: boolean
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
  /**
   * Set when start() was given a world map name. `loaded`: the saved map is the session's starting map, and the
   * session relocalizes into its coordinates (tracking reads limited.relocalizing until it does). `missing`: no
   * map has that name, or the name cannot be a file name, so the session starts fresh. `unreadable`: a file exists
   * under the name but does not decode, so the session starts fresh and the file is left in place.
   */
  worldMap?: NativeWorldMapStart
}

/** What a native start reports about a requested world map. */
export type NativeWorldMapStart = 'loaded' | 'missing' | 'unreadable'

/** A world map saved on the phone. The map itself never leaves the device. */
export interface NativeWorldMapSaved {
  name: string
  /** Size of the archived map, in bytes. */
  bytes: number
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

/** An origin anchor, as the native layer returns it from setOriginAnchor() and getOriginAnchor(). */
export interface NativeOriginAnchor {
  /** Metres, x, y, z, in the frame of the AR session that placed the origin. */
  position: number[]
  /** Quaternion, x, y, z, w. */
  rotation: number[]
  /** The heading the caller gave with the origin, or null. The native layer stores it unchanged. */
  heading: number | null
}

/** The ScanAR plugin's methods and events, as Capacitor exposes them to the web app. */
export interface ScanARPlugin {
  capabilities(): Promise<NativeARCapabilities>
  start(options: { depth: boolean; hitGrid: number; worldMap?: string }): Promise<NativeStartResult>
  stop(): Promise<void>
  captureFrame(options: { depth: boolean }): Promise<NativeFrame>
  /** A single hit test at normalised (0..1) coordinates of the overlay rect. */
  hitTest(options: { x: number; y: number }): Promise<NativeHitSample>
  /**
   * Saves the running session's world map under `name`. iOS (ARKit) only: the Android plugin has no such
   * method, so it is optional here and the provider checks for it.
   */
  saveWorldMap?(options: { name: string }): Promise<NativeWorldMapSaved>
  /**
   * Places the origin on the first feature point or plane under (x, y), normalised 0..1 over the camera rect,
   * and saves it on the device. Rejects when no surface is under the point. Optional: the Android plugin has
   * it, and the iOS plugin does not yet, so a caller checks for it before use.
   */
  setOriginAnchor?(options: { x: number; y: number; heading?: number }): Promise<{ anchor: NativeOriginAnchor }>
  /**
   * The origin this AR session placed, or `anchor: null` when this session has placed none. An origin saved by an
   * earlier session is not returned: v1 does not restore an origin across sessions. Optional, as setOriginAnchor is.
   */
  getOriginAnchor?(): Promise<{ anchor: NativeOriginAnchor | null }>
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
