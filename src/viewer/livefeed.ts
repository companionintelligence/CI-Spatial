/**
 * LiveFeed — desktop viewer-side WebRTC receiver.
 *
 * Renders the phone's incoming video stream in a floating, draggable
 * picture-in-picture panel.  Also fires scan-update events when the phone
 * sends metadata messages alongside the stream (e.g. detection counts).
 *
 * Usage:
 *   const feed = new LiveFeed('room-abc')
 *   feed.mount(document.body)
 *   feed.connect()
 *   feed.disconnect()
 */

export interface FeedStatus {
  state: 'idle' | 'connecting' | 'live' | 'error' | 'disconnected'
  message: string
}

export type FeedStatusCallback = (s: FeedStatus) => void

/** Called when the phone sends an out-of-band metadata message over the data channel */
export type MetaCallback = (meta: Record<string, unknown>) => void

/**
 * Scan-data messages arriving on the phone's `scan` data channel:
 *   { t: 'hello', startedAt }                  — new live session, reset state
 *   { t: 'pts',  p: [x,y,z, x,y,z, …] }        — point-cloud delta batch
 *   { t: 'dets', items: [{label, pos, …}] }    — current detection snapshot
 *   { t: 'pose', p: [x,y,z], q: [x,y,z,w] }    — phone camera pose
 */
export type ScanDataCallback = (msg: Record<string, unknown>) => void

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

export class LiveFeed {
  private _roomId: string
  private _ws: WebSocket | null = null
  private _pc: RTCPeerConnection | null = null
  private _dataChannel: RTCDataChannel | null = null
  private _container: HTMLElement | null = null
  private _video: HTMLVideoElement | null = null
  private _onStatus: FeedStatusCallback | null = null
  private _onMeta: MetaCallback | null = null
  private _onData: ScanDataCallback | null = null
  private _connected = false
  private _open = false

  constructor(roomId: string) {
    this._roomId = roomId
  }

  set onStatus(fn: FeedStatusCallback) { this._onStatus = fn }
  set onMeta(fn: MetaCallback) { this._onMeta = fn }
  set onData(fn: ScanDataCallback) { this._onData = fn }
  get isOpen(): boolean { return this._open }

  /** Inject the panel DOM into parentEl */
  mount(parentEl: HTMLElement): void {
    if (this._container) return
    this._container = this._buildPanel()
    parentEl.appendChild(this._container)
    this._video = this._container.querySelector<HTMLVideoElement>('#livefeed-video')
  }

  /** Open the panel UI */
  show(): void {
    if (!this._container) return
    this._open = true
    this._container.style.display = 'flex'
    requestAnimationFrame(() => {
      if (this._container) this._container.style.opacity = '1'
    })
  }

  /** Hide the panel UI */
  hide(): void {
    if (!this._container) return
    this._open = false
    this._container.style.opacity = '0'
    setTimeout(() => {
      if (this._container && !this._open) this._container.style.display = 'none'
    }, 250)
  }

  toggle(): void { this._open ? this.hide() : this.show() }

  /** Begin WebRTC handshake — connects to signaling WS as 'viewer' */
  connect(): void {
    if (this._connected) return
    this._connected = true
    this._status('connecting', 'Connecting…')
    this._openSignal()
  }

  disconnect(): void {
    this._connected = false
    this._dataChannel?.close()
    this._pc?.close()
    this._ws?.close()
    this._dataChannel = null
    this._pc = null
    this._ws = null
    this._setVideoSrc(null)
    this._status('disconnected', 'Disconnected')
  }

  // ── Signaling ──────────────────────────────────────────────────────────────

  private _openSignal(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/rtc-signal?role=viewer&room=${encodeURIComponent(this._roomId)}`
    const ws = new WebSocket(url)
    this._ws = ws

    ws.addEventListener('open', () => {
      this._status('connecting', 'Waiting for phone…')
    })
    ws.addEventListener('message', (ev) => {
      void this._handleSignal(JSON.parse(ev.data as string))
    })
    ws.addEventListener('error', () => {
      this._status('error', 'Signal error — is the server running?')
    })
    ws.addEventListener('close', () => {
      if (this._connected) {
        this._status('connecting', 'Signal disconnected — reconnecting…')
        setTimeout(() => { if (this._connected) this._openSignal() }, 2000)
      }
    })
  }

  private async _handleSignal(msg: Record<string, unknown>): Promise<void> {
    switch (msg['type']) {

      case 'peer-ready':
        this._status('connecting', 'Phone connected — negotiating…')
        break

      case 'offer': {
        this._status('connecting', 'Received offer — answering…')
        await this._answerOffer(msg as unknown as RTCSessionDescriptionInit)
        break
      }

      case 'ice': {
        if (!this._pc) return
        try {
          await this._pc.addIceCandidate(new RTCIceCandidate(msg['candidate'] as RTCIceCandidateInit))
        } catch { /* stale — ignore */ }
        break
      }

      case 'peer-left':
        this._status('connecting', 'Phone disconnected — waiting…')
        this._setVideoSrc(null)
        this._dataChannel?.close()
        this._pc?.close()
        this._dataChannel = null
        this._pc = null
        break

      case 'meta':
        this._onMeta?.(msg as Record<string, unknown>)
        break
    }
  }

  private async _answerOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this._pc = pc

    pc.addEventListener('track', (e) => {
      if (e.streams[0]) {
        this._setVideoSrc(e.streams[0])
        this._status('live', 'Live')
      }
    })

    pc.addEventListener('datachannel', (e) => {
      this._bindDataChannel(e.channel)
    })

    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) {
        this._send({ type: 'ice', candidate: e.candidate.toJSON() })
      }
    })

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') {
        this._status('live', 'Live')
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this._status('connecting', 'Reconnecting…')
      }
    })

    await pc.setRemoteDescription(new RTCSessionDescription(offer))
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    this._send({ type: 'answer', sdp: answer.sdp })
  }

  private _bindDataChannel(channel: RTCDataChannel): void {
    this._dataChannel?.close()
    this._dataChannel = channel
    channel.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>
        // 'meta' frames (pose/frustum metadata) keep the legacy callback;
        // geometry frames ('hello' | 'pts' | 'dets' | 'pose') go to onData.
        if (msg['type'] === 'meta') {
          this._onMeta?.(msg)
        } else {
          this._onData?.(msg)
        }
      } catch {
        this._onMeta?.({ type: 'meta', raw: event.data })
      }
    })
  }

  private _send(msg: Record<string, unknown>): void {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg))
    }
  }

  // ── Video helper ──────────────────────────────────────────────────────────

  private _setVideoSrc(stream: MediaStream | null): void {
    if (!this._video) return
    if (stream) {
      this._video.srcObject = stream
      void this._video.play().catch(() => { /* autoplay policy: requires muted */ })
    } else {
      this._video.srcObject = null
    }
  }

  // ── Status helper ─────────────────────────────────────────────────────────

  private _status(state: FeedStatus['state'], message: string): void {
    this._onStatus?.({ state, message })
    // Update badge in panel header
    const badge = document.getElementById('livefeed-status-badge')
    if (!badge) return
    badge.textContent = message
    badge.style.color = state === 'live' ? '#4ade80'
      : state === 'error' ? '#ef9a9a'
      : 'rgba(255,255,255,0.45)'
    // Pulse dot
    const dot = document.getElementById('livefeed-dot')
    if (dot) {
      dot.style.background = state === 'live' ? '#4ade80'
        : state === 'error' ? '#ef9a9a' : 'rgba(255,255,255,0.3)'
      dot.style.animation = state === 'live' ? 'livefeed-pulse 1.2s ease-in-out infinite' : 'none'
    }
  }

  // ── Panel builder ─────────────────────────────────────────────────────────

  private _buildPanel(): HTMLElement {
    // Inject CSS once
    if (!document.getElementById('livefeed-css')) {
      const style = document.createElement('style')
      style.id = 'livefeed-css'
      style.textContent = `
        #livefeed-panel {
          position: absolute;
          bottom: 52px;
          right: 12px;
          width: 288px;
          background: rgba(8,10,18,0.96);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 12px;
          display: none;
          flex-direction: column;
          overflow: hidden;
          box-shadow: 0 8px 40px rgba(0,0,0,0.7);
          z-index: 200;
          opacity: 0;
          transition: opacity 0.2s ease;
          touch-action: none;
          user-select: none;
        }
        #livefeed-header {
          display: flex; align-items: center; gap: 7px;
          padding: 7px 10px;
          border-bottom: 1px solid rgba(255,255,255,0.07);
          cursor: grab; background: rgba(0,0,0,0.35);
          flex-shrink: 0;
        }
        #livefeed-header:active { cursor: grabbing; }
        #livefeed-dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: rgba(255,255,255,0.3);
          flex-shrink: 0;
        }
        #livefeed-status-badge {
          font-size: 11px; color: rgba(255,255,255,0.45);
          flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        #livefeed-close-btn {
          background: transparent; border: none;
          color: rgba(255,255,255,0.35); font-size: 14px; cursor: pointer;
          padding: 2px 6px; border-radius: 4px; flex-shrink: 0;
        }
        #livefeed-close-btn:hover { color: #fff; }
        #livefeed-video-wrap {
          position: relative; background: #000; flex: 1;
          min-height: 0;
        }
        #livefeed-video {
          width: 100%; height: 162px;
          object-fit: cover; display: block;
          background: #000;
        }
        #livefeed-placeholder {
          position: absolute; inset: 0;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          gap: 8px;
          font-size: 12px; color: rgba(255,255,255,0.28);
          pointer-events: none;
        }
        #livefeed-room-row {
          display: flex; align-items: center; gap: 6px;
          padding: 6px 10px;
          border-top: 1px solid rgba(255,255,255,0.07);
          flex-shrink: 0;
        }
        #livefeed-room-label {
          font-size: 10px; color: rgba(255,255,255,0.3);
          white-space: nowrap;
        }
        #livefeed-room-input {
          flex: 1; background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1); border-radius: 5px;
          color: #fff; font-size: 11px; padding: 3px 7px; outline: none;
        }
        #livefeed-connect-btn {
          background: rgba(114,221,212,0.15);
          border: 1px solid rgba(114,221,212,0.35);
          color: #72ddd4; font-size: 11px; font-weight: 600;
          padding: 3px 10px; border-radius: 5px; cursor: pointer;
          white-space: nowrap;
        }
        #livefeed-connect-btn:hover { background: rgba(114,221,212,0.25); }
        #livefeed-connect-btn.live {
          background: rgba(239,154,154,0.15);
          border-color: rgba(239,154,154,0.35); color: #ef9a9a;
        }
        @keyframes livefeed-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.35; }
        }
      `
      document.head.appendChild(style)
    }

    const el = document.createElement('div')
    el.id = 'livefeed-panel'
    el.innerHTML = `
      <div id="livefeed-header">
        <div id="livefeed-dot"></div>
        <span style="font-size:12px;font-weight:700;color:#fff;letter-spacing:.03em;">Live Feed</span>
        <span id="livefeed-status-badge">Idle</span>
        <button id="livefeed-close-btn">✕</button>
      </div>
      <div id="livefeed-video-wrap">
        <video id="livefeed-video" autoplay playsinline muted></video>
        <div id="livefeed-placeholder">
          <span style="font-size:22px;">📡</span>
          Waiting for phone stream…
        </div>
      </div>
      <div id="livefeed-room-row">
        <span id="livefeed-room-label">Room</span>
        <input id="livefeed-room-input" type="text" value="default" maxlength="40" spellcheck="false">
        <button id="livefeed-connect-btn">Connect</button>
      </div>
    `

    // Close button
    el.querySelector<HTMLButtonElement>('#livefeed-close-btn')!.addEventListener('click', () => this.hide())

    // Connect / Disconnect button
    const connectBtn = el.querySelector<HTMLButtonElement>('#livefeed-connect-btn')!
    connectBtn.addEventListener('click', () => {
      if (this._connected) {
        this.disconnect()
        connectBtn.textContent = 'Connect'
        connectBtn.classList.remove('live')
      } else {
        const roomInput = el.querySelector<HTMLInputElement>('#livefeed-room-input')!
        this._roomId = roomInput.value.trim() || 'default'
        this.connect()
        connectBtn.textContent = 'Disconnect'
        connectBtn.classList.add('live')
      }
    })

    // Hide placeholder once video is playing
    const video = el.querySelector<HTMLVideoElement>('#livefeed-video')!
    video.addEventListener('play', () => {
      const ph = el.querySelector<HTMLElement>('#livefeed-placeholder')
      if (ph) ph.style.display = 'none'
    })
    video.addEventListener('emptied', () => {
      const ph = el.querySelector<HTMLElement>('#livefeed-placeholder')
      if (ph) ph.style.display = 'flex'
    })

    // Drag to reposition
    this._makeDraggable(el)

    return el
  }

  private _makeDraggable(el: HTMLElement): void {
    const header = el.querySelector<HTMLElement>('#livefeed-header')!
    let ox = 0, oy = 0, startX = 0, startY = 0
    const onMove = (cx: number, cy: number) => {
      const parent = el.offsetParent as HTMLElement | null
      if (!parent) return
      const pw = parent.clientWidth, ph = parent.clientHeight
      const ew = el.offsetWidth, eh = el.offsetHeight
      let nx = ox + (cx - startX)
      let ny = oy + (cy - startY)
      nx = Math.max(0, Math.min(pw - ew, nx))
      ny = Math.max(0, Math.min(ph - eh, ny))
      el.style.left   = `${nx}px`
      el.style.bottom = 'auto'
      el.style.right  = 'auto'
      el.style.top    = `${ny}px`
    }
    header.addEventListener('mousedown', (e) => {
      startX = e.clientX; startY = e.clientY
      const rect = el.getBoundingClientRect()
      const prect = (el.offsetParent as HTMLElement)?.getBoundingClientRect() ?? { left: 0, top: 0 }
      ox = rect.left - prect.left; oy = rect.top - prect.top
      const up   = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
      const move = (ev: MouseEvent) => onMove(ev.clientX, ev.clientY)
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      e.preventDefault()
    })
    header.addEventListener('touchstart', (e) => {
      const t = e.touches[0]
      if (!t) return
      startX = t.clientX; startY = t.clientY
      const rect = el.getBoundingClientRect()
      const prect = (el.offsetParent as HTMLElement)?.getBoundingClientRect() ?? { left: 0, top: 0 }
      ox = rect.left - prect.left; oy = rect.top - prect.top
      const up   = () => { window.removeEventListener('touchmove', move); window.removeEventListener('touchend', up) }
      const move = (ev: TouchEvent) => { const tc = ev.touches[0]; if (tc) onMove(tc.clientX, tc.clientY) }
      window.addEventListener('touchmove', move, { passive: false })
      window.addEventListener('touchend', up)
      e.preventDefault()
    }, { passive: false })
  }
}
