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

export class RtcBroadcaster {
  private _roomId: string
  private _ws: WebSocket | null = null
  private _pc: RTCPeerConnection | null = null
  private _stream: MediaStream | null = null
  private _onStatus: StatusCallback | null = null
  private _running = false

  constructor(roomId: string) {
    this._roomId = roomId
  }

  set onStatus(fn: StatusCallback) { this._onStatus = fn }

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
      this._status('connecting', 'Signal connected — waiting for viewer…')
    })

    ws.addEventListener('message', (ev) => {
      void this._handleSignal(JSON.parse(ev.data as string))
    })

    ws.addEventListener('error', () => {
      this._status('error', 'Signal WebSocket error')
    })

    ws.addEventListener('close', () => {
      if (this._running) this._status('connecting', 'Signal disconnected — retrying…')
    })
  }

  stop(): void {
    this._running = false
    this._pc?.close()
    this._ws?.close()
    this._stream?.getTracks().forEach(t => t.stop())
    this._pc = null
    this._ws = null
    this._stream = null
    this._status('stopped', 'Stream stopped')
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
        this._pc?.close()
        this._pc = null
        break
    }
  }

  private async _createOffer(): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this._pc = pc

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
