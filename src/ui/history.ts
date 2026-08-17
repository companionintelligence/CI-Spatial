/**
 * Session history drawer — lets the user browse and reload past scan sessions
 * stored in IndexedDB without needing to re-scan the room.
 *
 * Each session card can be expanded to show its detections, which can be
 * individually selected/deselected and have their label/description edited.
 */
import type { DetectionStore, StoredDetection } from '../scene/store'

export class SessionHistory {
  private drawer: HTMLElement
  private trigger: HTMLButtonElement
  private body: HTMLElement
  private isOpen = false
  /** Tracks which session cards are expanded to show their detections */
  private expandedSessions = new Set<string>()

  constructor(private readonly store: DetectionStore) {
    this.drawer = document.getElementById('history-drawer')!
    this.trigger = document.getElementById('history-btn') as HTMLButtonElement
    this.body = document.getElementById('history-body')!
  }

  mount(): void {
    this.trigger.addEventListener('click', () => this.toggle())
    document.getElementById('history-close')?.addEventListener('click', () => this.close())

    // Close on backdrop tap
    this.drawer.addEventListener('click', (e) => {
      if (e.target === this.drawer) this.close()
    })

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close()
    })
  }

  async open(): Promise<void> {
    this.isOpen = true
    this.drawer.classList.add('open')
    await this._render()
  }

  close(): void {
    this.isOpen = false
    this.drawer.classList.remove('open')
  }

  toggle(): void {
    this.isOpen ? this.close() : this.open()
  }

  private async _render(): Promise<void> {
    this.body.innerHTML = '<p style="color:rgba(255,255,255,0.35);padding:20px 16px;font-size:13px;">Loading…</p>'

    const sessions = await this.store.allSessions()
    this.body.innerHTML = ''

    if (sessions.length === 0) {
      this.body.innerHTML = `
        <div style="padding:40px 16px;text-align:center;">
          <div style="font-size:32px;opacity:0.25;margin-bottom:12px;">🗂</div>
          <p style="color:rgba(255,255,255,0.35);font-size:13px;line-height:1.5;">
            No saved sessions yet.<br>Scan a room to create one.
          </p>
        </div>`
      return
    }

    sessions.sort((a, b) => b.startedAt - a.startedAt)

    for (const s of sessions) {
      this.body.appendChild(this._buildSessionCard(s))
    }
  }

  private _buildSessionCard(s: { sessionId: string; startedAt: number; count: number }): HTMLElement {
    const wrap = document.createElement('div')
    wrap.dataset['sessionId'] = s.sessionId
    wrap.style.cssText = 'border-bottom:1px solid rgba(255,255,255,0.07);'

    const date = new Date(s.startedAt)
    const isToday = date.toDateString() === new Date().toDateString()
    const dateStr = isToday
      ? `Today ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
      : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

    // ── Session header row ─────────────────────────────────────────────────
    const header = document.createElement('div')
    header.style.cssText = `
      display:flex;align-items:center;justify-content:space-between;
      padding:12px 16px;cursor:pointer;transition:background 0.15s;
    `
    header.addEventListener('pointerenter', () => { header.style.background = 'rgba(255,255,255,0.04)' })
    header.addEventListener('pointerleave', () => { header.style.background = '' })

    const isExpanded = this.expandedSessions.has(s.sessionId)

    const left = document.createElement('div')
    left.style.cssText = 'flex:1;min-width:0;'
    left.innerHTML = `
      <div style="color:#fff;font-size:14px;font-weight:600;margin-bottom:2px;display:flex;align-items:center;gap:6px;">
        <span style="color:rgba(255,255,255,0.4);font-size:11px;transition:transform 0.2s;display:inline-block;transform:rotate(${isExpanded ? 90 : 0}deg)">▶</span>
        ${dateStr}
      </div>
      <div style="color:rgba(255,255,255,0.4);font-size:12px;">
        ${s.count} object${s.count === 1 ? '' : 's'}
        <span style="opacity:0.5;margin-left:6px;font-family:monospace;font-size:10px;">${s.sessionId.slice(-8)}</span>
      </div>
    `

    // Actions: load + delete
    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;align-items:center;gap:4px;flex-shrink:0;margin-left:8px;'

    const loadBtn = document.createElement('button')
    loadBtn.textContent = '↩'
    loadBtn.title = 'Load session into view'
    loadBtn.className = 'ci-icon-btn ci-icon-btn--sm'
    loadBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      loadBtn.style.opacity = '0.5'
      await this.store.loadSession(s.sessionId)
      this.close()
    })

    const delBtn = document.createElement('button')
    delBtn.textContent = '✕'
    delBtn.title = 'Delete session'
    delBtn.className = 'ci-icon-btn ci-icon-btn--sm'
    delBtn.style.color = '#ffb7b7'
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      wrap.style.transition = 'opacity 0.2s'
      wrap.style.opacity = '0'
      setTimeout(() => wrap.remove(), 200)
      await this.store.deleteSession(s.sessionId)
      this.expandedSessions.delete(s.sessionId)
      if (this.body.children.length === 0) await this._render()
    })

    actions.append(loadBtn, delBtn)
    header.append(left, actions)

    // ── Detection list (expandable) ────────────────────────────────────────
    const detList = document.createElement('div')
    detList.style.cssText = `
      overflow:hidden;
      max-height:${isExpanded ? '2000px' : '0'};
      transition:max-height 0.3s ease;
      background:rgba(0,0,0,0.2);
    `

    // Toggle expand on header click
    header.addEventListener('click', async () => {
      const expanding = !this.expandedSessions.has(s.sessionId)
      const arrow = left.querySelector<HTMLSpanElement>('span')

      if (expanding) {
        this.expandedSessions.add(s.sessionId)
        detList.style.maxHeight = '2000px'
        if (arrow) arrow.style.transform = 'rotate(90deg)'
        if (detList.children.length === 0) await this._populateDetections(s.sessionId, detList)
      } else {
        this.expandedSessions.delete(s.sessionId)
        detList.style.maxHeight = '0'
        if (arrow) arrow.style.transform = 'rotate(0deg)'
      }
    })

    // Pre-populate if already expanded
    if (isExpanded) {
      void this._populateDetections(s.sessionId, detList)
    }

    wrap.append(header, detList)
    return wrap
  }

  /** Load the full session from IDB and render per-detection rows inside `container`. */
  private async _populateDetections(sessionId: string, container: HTMLElement): Promise<void> {
    // We need full detection data — load from IDB via a temp session load
    const sessions = await this.store.allSessions()  // just the summary
    const summary = sessions.find(s => s.sessionId === sessionId)
    if (!summary || summary.count === 0) {
      container.innerHTML = `<p style="color:rgba(255,255,255,0.3);font-size:12px;padding:12px 24px;">No detections in this session.</p>`
      return
    }

    // Load full detections from store (by temporarily requesting all sessions via IDB directly)
    // We use the existing allSessions() summary — for inline editing we need to load the session.
    // Strategy: load into store only if it is the active session, otherwise provide a read-only view.
    const isActive = this.store.sessionId === sessionId

    if (isActive) {
      this._renderDetectionRows(container, this.store.detections, sessionId, isActive)
    } else {
      // Load temporarily just to read — a lightweight approach using IndexedDB directly
      // We read the session via the store's loadSession to get detections, then render
      const saved = new Map(this.store.detections)  // snapshot current
      const ok = await this.store.loadSession(sessionId)
      if (!ok) {
        container.innerHTML = `<p style="color:rgba(255,255,255,0.3);font-size:12px;padding:12px 24px;">Could not load session.</p>`
        // restore
        await this.store.loadSession(this.store.sessionId)
        return
      }
      this._renderDetectionRows(container, new Map(this.store.detections), sessionId, false)
      // Restore the original active session state (without triggering full reload)
      this.store['_detections'] = saved
      this.store['notify']()
    }
  }

  private _renderDetectionRows(
    container: HTMLElement,
    dets: Map<string, StoredDetection>,
    sessionId: string,
    isActive: boolean,
  ): void {
    container.innerHTML = ''
    if (dets.size === 0) {
      container.innerHTML = `<p style="color:rgba(255,255,255,0.3);font-size:12px;padding:12px 24px;">No detections.</p>`
      return
    }

    for (const [key, det] of dets.entries()) {
      container.appendChild(this._buildDetectionRow(key, det, sessionId, isActive))
    }
  }

  private _buildDetectionRow(
    key: string,
    det: StoredDetection,
    _sessionId: string,
    isActive: boolean,
  ): HTMLElement {
    const isSelected = isActive && this.store.selected.has(key)
    const row = document.createElement('div')
    row.style.cssText = `
      display:flex;align-items:center;gap:10px;
      padding:8px 24px 8px 32px;
      border-top:1px solid rgba(255,255,255,0.04);
      transition:background 0.1s;
      ${isSelected ? 'background:rgba(114,221,212,0.08);border-left:2px solid #72ddd4;' : ''}
    `
    row.addEventListener('pointerenter', () => { if (!isSelected) row.style.background = 'rgba(255,255,255,0.03)' })
    row.addEventListener('pointerleave', () => { if (!isSelected) row.style.background = '' })

    const conf = Math.round(det.confidence * 100)
    const p = det.worldPos

    // Colour dot
    const dot = document.createElement('div')
    const COLORS: Record<string, string> = { chair: '#72ddd4', table: '#81c784', sofa: '#ff8a65', lamp: '#fff176', door: '#fbbf24', window: '#80deea', default: '#b0bec5' }
    const color = COLORS[det.label.toLowerCase()] ?? COLORS['default']
    dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;`

    // Info
    const info = document.createElement('div')
    info.style.cssText = 'flex:1;min-width:0;'

    const labelEl = document.createElement('div')
    labelEl.style.cssText = 'color:#fff;font-size:13px;font-weight:600;display:flex;align-items:center;gap:4px;'
    labelEl.textContent = det.label

    const coordEl = document.createElement('div')
    coordEl.style.cssText = 'color:rgba(255,255,255,0.3);font-size:10px;font-family:monospace;margin-top:1px;'
    coordEl.textContent = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}  ${conf}%`
    info.append(labelEl, coordEl)

    // Right-side actions: select toggle (active sessions only) + edit
    const btns = document.createElement('div')
    btns.style.cssText = 'display:flex;gap:4px;flex-shrink:0;'

    if (isActive) {
      const selBtn = document.createElement('button')
      selBtn.title = isSelected ? 'Deselect' : 'Select'
      selBtn.textContent = isSelected ? '☑' : '☐'
      selBtn.className = 'ci-icon-btn ci-icon-btn--sm'
      selBtn.style.color = isSelected ? '#72ddd4' : 'rgba(255,255,255,0.5)'
      selBtn.addEventListener('click', () => {
        this.store.toggleSelect(key)
        // Re-render this row in place
        const newRow = this._buildDetectionRow(key, det, _sessionId, isActive)
        row.replaceWith(newRow)
      })
      btns.appendChild(selBtn)
    }

    if (isActive) {
      const editBtn = document.createElement('button')
      editBtn.textContent = '✏'
      editBtn.title = 'Edit'
      editBtn.className = 'ci-icon-btn ci-icon-btn--sm'

      const editForm = document.createElement('div')
      editForm.style.cssText = 'display:none;position:absolute;inset-x:24px;background:rgba(8,28,38,0.98);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:10px;z-index:1;margin-top:4px;'
      // Structure only — label/description are assigned as DOM properties below so
      // a quote in the text cannot terminate the value="" attribute and truncate it.
      editForm.innerHTML = `
        <input type="text"
          class="ci-field" style="margin-bottom:5px;" />
        <textarea rows="2" class="ci-field ci-textarea"></textarea>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button class="ef-save ci-inline-btn ci-inline-btn--primary" style="flex:1;">Save</button>
          <button class="ef-cancel ci-inline-btn ci-inline-btn--muted" style="flex:1;">Cancel</button>
        </div>
      `
      editForm.querySelector<HTMLInputElement>('input')!.value = det.label
      editForm.querySelector<HTMLTextAreaElement>('textarea')!.value = det.description
      row.style.position = 'relative'

      editBtn.addEventListener('click', () => {
        editForm.style.display = editForm.style.display === 'none' ? 'block' : 'none'
      })
      editForm.querySelector<HTMLButtonElement>('.ef-save')!.addEventListener('click', async () => {
        const newLabel = (editForm.querySelector<HTMLInputElement>('input')!.value || det.label).trim()
        const newDesc = (editForm.querySelector<HTMLTextAreaElement>('textarea')!.value || det.description).trim()
        editForm.style.display = 'none'
        await this.store.updateDetection(key, { label: newLabel, description: newDesc })
        labelEl.textContent = newLabel
      })
      editForm.querySelector<HTMLButtonElement>('.ef-cancel')!.addEventListener('click', () => {
        editForm.style.display = 'none'
      })

      btns.appendChild(editBtn)
      row.appendChild(editForm)
    }

    row.append(dot, info, btns)
    return row
  }
}

