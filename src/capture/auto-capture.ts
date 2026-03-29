/**
 * AutoCapture — triggers captures automatically as the user moves the camera.
 *
 * Fires a capture whenever ALL three conditions are true:
 *   1. AutoCapture is enabled
 *   2. At least `minIntervalMs` have elapsed since the previous capture
 *   3. The camera has moved at least `minDistanceM` metres from the position of
 *      the previous capture (or this is the very first capture)
 *   4. No capture is already in flight
 *
 * Motion is estimated from the SLAM provider's getPose(). If the provider has
 * not yet locked tracking, the distance check is skipped for the first capture.
 *
 * Usage:
 *   const auto = new AutoCapture(provider, onCapture)
 *   auto.start()
 *   // … toggle button …
 *   auto.stop()
 */

import type { ARProvider } from '../ar/provider'

export interface AutoCaptureOptions {
  /** Minimum time between automatic captures (default 2500 ms) */
  minIntervalMs?: number
  /** Minimum camera movement to trigger a new capture (default 0.35 m) */
  minDistanceM?: number
  /** How often to poll for pose changes (default 400 ms) */
  pollIntervalMs?: number
  /** Maximum number of auto-captures per session (0 = unlimited, default 0) */
  maxCaptures?: number
}

export type AutoCaptureCallback = () => Promise<void>

export interface AutoCaptureStatus {
  enabled: boolean
  captureCount: number
  inFlight: boolean
}

const DEFAULTS: Required<AutoCaptureOptions> = {
  minIntervalMs:   2500,
  minDistanceM:    0.35,
  pollIntervalMs:  400,
  maxCaptures:     0,
}

export class AutoCapture {
  private _enabled = false
  private _inFlight = false
  private _captureCount = 0
  private _lastCaptureMs = 0
  private _lastPos: { x: number; y: number; z: number } | null = null
  private _pollHandle: ReturnType<typeof setInterval> | null = null
  private _opts: Required<AutoCaptureOptions>

  /** Fires when a capture is triggered; used by the UI to update indicators */
  onStatusChange: ((s: AutoCaptureStatus) => void) | null = null

  constructor(
    private readonly provider: ARProvider,
    private readonly onCapture: AutoCaptureCallback,
    opts: AutoCaptureOptions = {},
  ) {
    this._opts = { ...DEFAULTS, ...opts }
  }

  get enabled(): boolean { return this._enabled }
  get captureCount(): number { return this._captureCount }

  enable(): void {
    if (this._enabled) return
    this._enabled = true
    this._lastPos = null
    this._lastCaptureMs = 0
    this._startPolling()
    this._emitStatus()
  }

  disable(): void {
    this._enabled = false
    this._stopPolling()
    this._emitStatus()
  }

  toggle(): void {
    this._enabled ? this.disable() : this.enable()
  }

  reset(): void {
    this._captureCount = 0
    this._lastPos = null
    this._lastCaptureMs = 0
  }

  private _startPolling(): void {
    if (this._pollHandle !== null) return
    this._pollHandle = setInterval(() => this._tick(), this._opts.pollIntervalMs)
  }

  private _stopPolling(): void {
    if (this._pollHandle !== null) {
      clearInterval(this._pollHandle)
      this._pollHandle = null
    }
  }

  private async _tick(): Promise<void> {
    if (!this._enabled || this._inFlight) return

    const { maxCaptures, minIntervalMs, minDistanceM } = this._opts
    if (maxCaptures > 0 && this._captureCount >= maxCaptures) {
      this.disable()
      return
    }

    const now = performance.now()
    if (now - this._lastCaptureMs < minIntervalMs) return

    // Check pose movement
    let moved = true
    if (this.provider.isTracking()) {
      const pose = this.provider.getPose()
      const cur = pose.position
      if (this._lastPos !== null) {
        const dx = cur.x - this._lastPos.x
        const dy = cur.y - this._lastPos.y
        const dz = cur.z - this._lastPos.z
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        moved = dist >= minDistanceM
      }
      // Record position regardless for next tick
      this._lastPos = { ...cur }
    } else {
      // SLAM not yet tracking — wait
      return
    }

    if (!moved) return

    this._inFlight = true
    this._lastCaptureMs = now
    this._captureCount++
    this._emitStatus()

    try {
      await this.onCapture()
    } catch (e) {
      console.warn('[auto-capture] capture failed:', e)
      // Back-off: don't retry this tick
    } finally {
      this._inFlight = false
      this._emitStatus()
    }
  }

  private _emitStatus(): void {
    this.onStatusChange?.({
      enabled: this._enabled,
      captureCount: this._captureCount,
      inFlight: this._inFlight,
    })
  }
}
