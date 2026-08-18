/**
 * RtcBroadcaster — phone-side WebRTC video broadcaster.
 *
 * Streams the AR camera canvas (or a fallback getUserMedia stream) to the
 * desktop viewer via a peer-to-peer WebRTC connection.  Signaling is relayed
 * through the Deno server's /rtc-signal WebSocket endpoint.
 *
 * Usage:
 *   const bc = new RtcBroadcaster('room-abc')
 *   bc.start(canvas)        // pass the AR canvas element
 *   bc.stop()
 */

export interface BroadcasterStatus {
  state: 'idle' | 'connecting' | 'streaming' | 'error' | 'stopped'
  message: string
}

export type StatusCallback = (status: BroadcasterStatus) => void

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

/** Cap on queued-but-unsent data before geometry messages are dropped */
const DC_BACKPRESSURE_BYTES = 256 * 1024
const POINT_FLUSH_MS = 500
const POINT_FLUSH_MAX = 1500

/** Signaling reconnect backoff: 1s, 2s, 4s… capped at 15s */
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 15 * 1000

export class RtcBroadcaster {
  private _roomId: string
  private _ws: WebSocket | null = null
  private _pc: RTCPeerConnection | null = null
  private _dataChannel: RTCDataChannel | null = null
  private _stream: MediaStream | null = null
  private _onStatus: StatusCallback | null = null
  private _running = false
  private _pointBuffer: number[] = []
  private _flushHandle: ReturnType<typeof setInterval> | null = null
  private _reconnectDelay = RECONNECT_BASE_MS
  private _reconnectHandle: ReturnType<typeof setTimeout> | null = null

  constructor(roomId: string) {
    this._roomId = roomId
  }

  set onStatus(fn: StatusCallback) { this._onStatus = fn }
  get isRunning(): boolean { return this._running }

  /**
   * Queue world-space points for delivery to the viewer over the data
   * channel.  Batched (500 ms / 1500 pts) and dropped under backpressure —
   * live geometry is a best-effort preview, never a memory leak.
   */
  sendPoints(points: ReadonlyArray<{ x: number; y: number; z: number }>): void {
    if (!this._running || points.length === 0) return
    if (this._pointBuffer.length / 3 >= POINT_FLUSH_MAX * 4) return // hard cap
    for (const p of points) this._pointBuffer.push(round3(p.x), round3(p.y), round3(p.z))
  }

  /** Send a JSON message (detections, pose, hello) immediately when the channel is open. */
  sendJson(msg: Record<string, unknown>): void {
    const dc = this._dataChannel
    if (!dc || dc.readyState !== 'open') return
    if (dc.bufferedAmount > DC_BACKPRESSURE_BYTES) return
    try { dc.send(JSON.stringify(msg)) } catch { /* channel closing */ }
  }

  /** Start streaming the given canvas (or fall back to getUserMedia if null) */
  async start(canvas?: HTMLCanvasElement | null): Promise<void> {
    if (this._running) return
    this._running = true
    this._status('connecting', 'Connecting to signal server…')

    // Acquire media stream from canvas capture or camera
    try {
      if (canvas && 'captureStream' in canvas) {
        // Capture at up to 24 fps — enough to give the desktop viewer live context
        this._stream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(24)
      } else {
        // Fallback: rear camera
        this._stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
      }
    } catch (e) {
      this._status('error', `Camera access denied: ${e instanceof Error ? e.message : String(e)}`)
      this._running = false
      return
    }

    // Connect signaling WebSocket
    this._connectSignal()
  }

  /**
   * Open (or reopen) the signaling WebSocket.  On unexpected close the
   * socket reconnects with exponential backoff for as long as the
   * broadcaster is running.
   */
  private _connectSignal(): void {
    const wsUrl = this._signalUrl()
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch (e) {
      this._status('error', `Signal WS failed: ${e instanceof Error ? e.message : String(e)}`)
      this._running = false
      return
    }

    this._ws = ws

    ws.addEventListener('open', () => {
      this._reconnectDelay = RECONNECT_BASE_MS
      this._status('connecting', 'Signal connected — waiting for viewer…')
    })

    ws.addEventListener('message', (ev) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(ev.data as string) as Record<string, unknown>
      } catch {
        // Malformed relay frame — log and ignore rather than crash
        console.warn('[rtc] Ignoring malformed signal frame')
        return
      }
      void this._handleSignal(msg)
    })

    ws.addEventListener('error', () => {
      this._status('error', 'Signal WebSocket error')
    })

    ws.addEventListener('close', () => {
      if (!this._running) return
      this._status('connecting', 'Signal disconnected — retrying…')
      // Tear down the stale peer connection so the viewer's fresh
      // 'peer-ready' after reconnect triggers a clean re-offer.
      this._teardownPeer()
      this._reconnectHandle = setTimeout(() => this._connectSignal(), this._reconnectDelay)
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS)
    })
  }

  /** Close the peer connection and data channel (keeps the local stream alive). */
  private _teardownPeer(): void {
    if (this._flushHandle !== null) {
      clearInterval(this._flushHandle)
      this._flushHandle = null
    }
    this._pointBuffer = []
    this._dataChannel?.close()
    this._pc?.close()
    this._dataChannel = null
    this._pc = null
  }

  stop(): void {
    this._running = false
    if (this._reconnectHandle !== null) {
      clearTimeout(this._reconnectHandle)
      this._reconnectHandle = null
    }
    this._reconnectDelay = RECONNECT_BASE_MS
    if (this._flushHandle !== null) {
      clearInterval(this._flushHandle)
      this._flushHandle = null
    }
    this._pointBuffer = []
    this._dataChannel?.close()
    this._pc?.close()
    this._ws?.close()
    this._stream?.getTracks().forEach(t => t.stop())
    this._dataChannel = null
    this._pc = null
    this._ws = null
    this._stream = null
    this._status('stopped', 'Stream stopped')
  }

  /** Send pose, frustum, detection, or progress metadata to the viewer. */
  sendSpatial(meta: Record<string, unknown>): void {
    const message = JSON.stringify({ type: 'meta', ...meta })
    if (this._dataChannel?.readyState === 'open') {
      this._dataChannel.send(message)
      return
    }
    this._send({ type: 'meta', ...meta })
  }

  private _flushPoints(): void {
    if (this._pointBuffer.length === 0) return
    const dc = this._dataChannel
    if (!dc || dc.readyState !== 'open' || dc.bufferedAmount > DC_BACKPRESSURE_BYTES) {
      // Channel busy or absent — drop the batch rather than accumulate
      this._pointBuffer = []
      return
    }
    const batch = this._pointBuffer.splice(0, POINT_FLUSH_MAX * 3)
    try { dc.send(JSON.stringify({ t: 'pts', p: batch })) } catch { /* closing */ }
  }

  private async _handleSignal(msg: Record<string, unknown>): Promise<void> {
    switch (msg['type']) {

      case 'peer-ready': {
        // Viewer has connected — create peer connection and send offer
        this._status('connecting', 'Viewer connected — negotiating…')
        await this._createOffer()
        break
      }

      case 'answer': {
        if (!this._pc) return
        await this._pc.setRemoteDescription(new RTCSessionDescription(msg as unknown as RTCSessionDescriptionInit))
        this._status('streaming', 'Live — streaming to viewer')
        break
      }

      case 'ice': {
        if (!this._pc) return
        try {
          await this._pc.addIceCandidate(new RTCIceCandidate(msg['candidate'] as RTCIceCandidateInit))
        } catch { /* stale candidate — ignore */ }
        break
      }

      case 'peer-left':
        this._status('connecting', 'Viewer disconnected — waiting…')
        this._dataChannel?.close()
        this._pc?.close()
        this._dataChannel = null
        this._pc = null
        break
    }
  }

  private async _createOffer(): Promise<void> {
    // Close the previous negotiation first. 'peer-ready' arrives on every
    // viewer (re)connect and this used to overwrite this._pc, stranding the
    // old RTCPeerConnection with its live tracks and ICE agent still running.
    // A viewer reconnect is routine — the panel retries on any dropped signal
    // socket — so each cycle leaked one. _teardownPeer() is a no-op on the
    // first offer and keeps the local capture stream alive.
    this._teardownPeer()

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this._pc = pc

    // Data channel for live geometry, detections, and spatial metadata.
    // Reliable + ordered: traffic is a few KB/s and the backpressure guard
    // in _flushPoints/sendJson prevents queue build-up on a slow link.
    const dc = pc.createDataChannel('scan-spatial-events', { ordered: true })
    this._dataChannel = dc
    dc.addEventListener('open', () => {
      this.sendJson({ t: 'hello', startedAt: Date.now() })
      if (this._flushHandle === null) {
        this._flushHandle = setInterval(() => this._flushPoints(), POINT_FLUSH_MS)
      }
    })

    // Add all tracks from our stream
    for (const track of this._stream!.getTracks()) {
      pc.addTrack(track, this._stream!)
    }

    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) {
        this._send({ type: 'ice', candidate: e.candidate.toJSON() })
      }
    })

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') {
        this._status('streaming', 'Live — streaming to viewer')
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this._status('connecting', 'Connection lost — renegotiating…')
      }
    })

    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false })
    await pc.setLocalDescription(offer)
    this._send({ type: 'offer', sdp: offer.sdp })
  }

  private _send(msg: Record<string, unknown>): void {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg))
    }
  }

  private _signalUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/rtc-signal?role=phone&room=${encodeURIComponent(this._roomId)}`
  }

  private _status(state: BroadcasterStatus['state'], message: string): void {
    this._onStatus?.({ state, message })
  }
}

/** 1 mm precision is plenty for a live preview and keeps JSON frames small */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
