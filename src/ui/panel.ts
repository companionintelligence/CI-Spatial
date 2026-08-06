/**
 * Side panel — full object manifest with 3D positions + export controls.
 * Supports:
 *   - Close button inside the panel header
 *   - Select / deselect individual detections (highlighted in AR overlay)
 *   - Inline edit of label + description
 */
import type { DetectionStore, StoredDetection } from '../scene/store'
import type { InferMode } from '../inference/router'

const CATEGORY_COLORS: Record<string, string> = {
  chair: '#72ddd4', table: '#81c784', sofa: '#ff8a65', couch: '#ff8a65',
  bed: '#ce93d8', desk: '#a5d6a7', monitor: '#80cbc4', tv: '#80cbc4',
  door: '#ffcc80', window: '#80deea', shelf: '#c5e1a5', bookcase: '#c5e1a5',
  lamp: '#fff176', plant: '#66bb6a',
}
function categoryColor(label: string): string {
  const l = label.toLowerCase()
  for (const [k, c] of Object.entries(CATEGORY_COLORS)) if (l.includes(k)) return c
  return '#b0bec5'
}
function fmtCoord(v: number): string { return v.toFixed(2) }

export class SidePanel {
  private panel: HTMLElement
  private content: HTMLElement
  private footer: HTMLElement
  private toggle: HTMLButtonElement
  private isOpen = false
  private _streamBtn: HTMLButtonElement | null = null
  private _aiServerBtn: HTMLButtonElement | null = null
  private _aiWebGPUBtn: HTMLButtonElement | null = null

  get streamButton(): HTMLButtonElement | null { return this._streamBtn }

  constructor(
    private readonly store: DetectionStore,
    private readonly onExport: () => void | Promise<void>,
    private readonly onSummary?: () => void,
    private readonly onProcess?: (action: string) => void,
    private readonly onInferMode?: (mode: InferMode) => void,
    private _currentInferMode: InferMode = 'server',
  ) {
    this.panel = document.getElementById('side-panel')!
    this.content = document.getElementById('panel-content')!
    this.footer = document.getElementById('panel-footer')!
    this.toggle = document.getElementById('panel-toggle') as HTMLButtonElement
  }

  mount(): void {
    // ── Panel header (title + close button) ───────────────────────────────
    const panelHeader = document.createElement('div')
    panelHeader.id = 'panel-header'
    panelHeader.style.cssText = `
      display:flex;align-items:center;justify-content:space-between;
      padding:16px 14px 10px;border-bottom:1px solid rgba(255,255,255,0.08);
      flex-shrink:0;
    `
    panelHeader.innerHTML = `
      <div style="min-width:0;">
        <div style="color:#fff;font-size:15px;font-weight:800;">Review & Export</div>
        <div id="scan-flow-steps" style="color:rgba(255,255,255,0.34);font-size:10px;letter-spacing:0.06em;text-transform:uppercase;margin-top:3px;">
          Scan · Review · Edit · Export
        </div>
      </div>`
    const closeBtn = document.createElement('button')
    closeBtn.setAttribute('aria-label', 'Close panel')
    closeBtn.className = 'ci-icon-btn ci-icon-btn--sm'
    closeBtn.textContent = '✕'
    closeBtn.addEventListener('click', () => this.setOpen(false))
    panelHeader.appendChild(closeBtn)
    this.panel.insertBefore(panelHeader, this.content)

    // ── Toggle button (outside panel) ──────────────────────────────────────
    this.toggle.addEventListener('click', () => this.setOpen(!this.isOpen))

    // ── Footer buttons ─────────────────────────────────────────────────────
    const exportBtn = document.createElement('button')
    exportBtn.className = 'panel-btn-primary'
    exportBtn.id = 'panel-export-glb-btn'
    exportBtn.textContent = 'Export GLB'
    exportBtn.addEventListener('click', async () => {
      exportBtn.disabled = true
      exportBtn.textContent = 'Exporting...'
      try {
        await this.onExport()
        exportBtn.textContent = 'Exported'
        setTimeout(() => { exportBtn.textContent = 'Export GLB' }, 1400)
      } catch {
        exportBtn.textContent = 'Export failed'
        setTimeout(() => { exportBtn.textContent = 'Export GLB' }, 1800)
      } finally {
        exportBtn.disabled = false
      }
    })
    this.footer.appendChild(exportBtn)

    if (this.onSummary) {
      const summaryBtn = document.createElement('button')
      summaryBtn.className = 'panel-btn-ghost'
      summaryBtn.id = 'panel-export-summary-btn'
      summaryBtn.textContent = 'Export Summary'
      summaryBtn.addEventListener('click', this.onSummary)
      this.footer.appendChild(summaryBtn)
    }

    if (this.onProcess) {
      const processWrap = document.createElement('div')
      processWrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;'
      const label = document.createElement('div')
      label.style.cssText = 'color:rgba(255,255,255,0.3);font-size:10px;text-transform:uppercase;letter-spacing:0.08em;padding:4px 0 2px;'
      label.textContent = 'Server Processing'
      processWrap.appendChild(label)
      const actions: [string, string][] = [
        ['floor-plan', '🗺 Generate Floor Plan'],
        ['scene-description', '✍ Scene Description'],
        ['object-count', '📊 Object Report'],
      ]
      for (const [action, btnLabel] of actions) {
        const btn = document.createElement('button')
        btn.className = 'panel-btn-ghost'
        btn.dataset['needsObjects'] = ''
        btn.textContent = btnLabel
        btn.addEventListener('click', () => this.onProcess!(action))
        processWrap.appendChild(btn)
      }
      this.footer.appendChild(processWrap)
    }

    const clearBtn = document.createElement('button')
    clearBtn.className = 'panel-btn-ghost panel-btn-danger'
    clearBtn.id = 'panel-clear-session-btn'
    clearBtn.textContent = 'Clear session'
    clearBtn.addEventListener('click', async () => { await this.store.clear() })
    this.footer.appendChild(clearBtn)

    const streamBtn = document.createElement('button')
    streamBtn.className = 'panel-btn-ghost'
    streamBtn.id = 'panel-stream-btn'
    streamBtn.textContent = '📡 Start Live Stream'
    this._streamBtn = streamBtn
    this.footer.appendChild(streamBtn)

    // ── AI Engine settings ─────────────────────────────────────────────────
    if (this.onInferMode) {
      const aiWrap = document.createElement('div')
      aiWrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.06);'

      const aiLabel = document.createElement('div')
      aiLabel.style.cssText = 'color:rgba(255,255,255,0.3);font-size:10px;text-transform:uppercase;letter-spacing:0.08em;padding:4px 0 2px;'
      aiLabel.textContent = 'AI Engine'
      aiWrap.appendChild(aiLabel)

      const aiRow = document.createElement('div')
      aiRow.style.cssText = 'display:flex;gap:4px;'

      const mkToggle = (label: string, mode: InferMode): HTMLButtonElement => {
        const btn = document.createElement('button')
        btn.dataset['mode'] = mode
        btn.className = 'ci-toolbar-pill'
        btn.textContent = label
        btn.addEventListener('click', () => {
          this.onInferMode!(mode)
          this._setAIMode(mode)
        })
        return btn
      }

      this._aiServerBtn = mkToggle('🖥 Server', 'server')
      this._aiWebGPUBtn = mkToggle('⚡ WebGPU', 'webgpu')
      aiRow.appendChild(this._aiServerBtn)
      aiRow.appendChild(this._aiWebGPUBtn)
      aiWrap.appendChild(aiRow)

      const aiNote = document.createElement('div')
      aiNote.id = 'ai-engine-note'
      aiNote.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.25);padding:2px 0;'
      aiNote.textContent = 'Server uses all machine cores'
      aiWrap.appendChild(aiNote)

      this.footer.appendChild(aiWrap)
      this._setAIMode(this._currentInferMode)
    }

    this.store.subscribe((dets, selected) => this.render(dets, selected))
    this.render(this.store.detections, this.store.selected)

    // The footer is built once, but whether it overflows depends on the viewport:
    // below 700 px tall it scrolls so the object list keeps a usable height
    // (index.html). Re-check on resize — rotating a phone crosses that boundary.
    this._markScrollable(this.footer)
    window.addEventListener('resize', () => {
      this._markScrollable(this.content)
      this._markScrollable(this.footer)
    })
  }

  /**
   * Flag a scroll box that has more content below its bottom edge, so the CSS
   * can fade it. Read synchronously after the DOM is written — the layout it
   * forces is the same one the next paint would do anyway.
   */
  private _markScrollable(el: HTMLElement): void {
    el.classList.toggle('is-scrollable', el.scrollHeight - el.clientHeight > 1)
  }

  setOpen(open: boolean): void {
    this.isOpen = open
    this.panel.classList.toggle('open', open)
    const count = this.store.detections.size
    this.toggle.setAttribute('data-count', count > 0 ? String(count) : '')
  }

  /** Update the AI engine toggle to reflect the current active mode. */
  updateInferMode(mode: InferMode): void {
    this._currentInferMode = mode
    this._setAIMode(mode)
  }

  private _setAIMode(mode: InferMode): void {
    this._currentInferMode = mode
    const on  = 'background:rgba(255,255,255,0.92);color:#000;'
    const off = 'background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.55);'
    if (this._aiServerBtn) {
      this._aiServerBtn.style.cssText += mode === 'server' ? on : off
      this._aiServerBtn.setAttribute('data-active', String(mode === 'server'))
    }
    if (this._aiWebGPUBtn) {
      this._aiWebGPUBtn.style.cssText += mode === 'webgpu' ? on : off
      this._aiWebGPUBtn.setAttribute('data-active', String(mode === 'webgpu'))
    }
    const note = document.getElementById('ai-engine-note')
    if (note) note.textContent = mode === 'server' ? 'Server uses all machine cores' : 'On-device — no data leaves your phone'
  }

  /**
   * Gate every action that needs objects on there being objects.
   *
   * With an empty session the panel still offered a full-width primary "Export
   * GLB", plus Export Summary and the three server-processing actions — all of
   * which produce an empty file or a job over nothing. A bright primary CTA
   * next to "No objects yet" is the screen contradicting itself, and it is what
   * the empty-state screenshot showed. The buttons stay visible (they tell the
   * reader what the panel is for) but read as unavailable until there is
   * something to export.
   */
  private _setActionsEnabled(enabled: boolean): void {
    const ids = [
      'panel-export-glb-btn',
      'panel-export-summary-btn',
    ]
    for (const id of ids) {
      const btn = document.getElementById(id) as HTMLButtonElement | null
      if (btn) btn.disabled = !enabled
    }
    for (const btn of this.footer.querySelectorAll<HTMLButtonElement>('[data-needs-objects]')) {
      btn.disabled = !enabled
    }
  }

  private render(dets: Map<string, StoredDetection>, selected: Set<string>): void {
    const count = dets.size
    this.toggle.setAttribute('data-count', count > 0 ? String(count) : '')
    this._setActionsEnabled(count > 0)

    if (count === 0) {
      this.content.innerHTML = `
        <div style="padding:24px 16px;text-align:center;">
          <div style="font-size:32px;margin-bottom:10px;opacity:0.3;">📍</div>
          <p style="color:rgba(255,255,255,0.4);font-size:13px;line-height:1.5;">
            No objects yet.<br>Tap the capture button to scan.
          </p>
        </div>`
      this._markScrollable(this.content)
      return
    }

    const sorted = [...dets.entries()].sort(([, a], [, b]) => b.confidence - a.confidence)
    this.content.innerHTML = ''

    const selCount = selected.size
    const header = document.createElement('div')
    header.style.cssText = 'padding:10px 14px 6px;display:flex;align-items:baseline;justify-content:space-between;'
    header.innerHTML = `
      <span style="color:rgba(255,255,255,0.5);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;">
        ${count} Object${count === 1 ? '' : 's'}${selCount > 0 ? ` · ${selCount} sel.` : ''}
      </span>
      <span style="color:rgba(255,255,255,0.25);font-size:10px;">X · Y · Z</span>`
    this.content.appendChild(header)

    for (const [key, det] of sorted) {
      this.content.appendChild(this._buildCard(key, det, selected.has(key)))
    }

    this._markScrollable(this.content)
  }

  private _buildCard(key: string, det: StoredDetection, isSelected: boolean): HTMLElement {
    const color = categoryColor(det.label)
    const conf = Math.round(det.confidence * 100)
    const p = det.worldPos

    const card = document.createElement('div')
    card.dataset['key'] = key
    card.style.cssText = `
      display:grid;grid-template-columns:auto 1fr auto;
      gap:10px;padding:12px 14px;
      border-bottom:1px solid rgba(255,255,255,0.06);
      align-items:start;
      transition:background 0.15s;
      ${isSelected ? 'background:rgba(114,221,212,0.08);border-left:2px solid #72ddd4;padding-left:12px;' : ''}
    `
    card.addEventListener('pointerenter', () => {
      if (!isSelected) card.style.background = 'rgba(255,255,255,0.04)'
    })
    card.addEventListener('pointerleave', () => {
      if (!isSelected) card.style.background = ''
    })

    // Thumbnail / colour swatch — tap to select/deselect
    const imgWrap = document.createElement('div')
    imgWrap.style.cssText = 'width:44px;height:44px;border-radius:8px;overflow:hidden;flex-shrink:0;cursor:pointer;'
    if (det.thumbnailDataUrl) {
      const img = document.createElement('img')
      img.src = det.thumbnailDataUrl
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;'
      imgWrap.appendChild(img)
    } else {
      imgWrap.style.cssText += `background:${color}22;display:flex;align-items:center;justify-content:center;`
      imgWrap.innerHTML = `<span style="width:12px;height:12px;border-radius:50%;background:${color};box-shadow:0 0 8px ${color};"></span>`
    }
    imgWrap.addEventListener('click', () => this.store.toggleSelect(key))

    // Label + description + edit controls
    const info = document.createElement('div')
    info.style.cssText = 'min-width:0;'

    const row1 = document.createElement('div')
    row1.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:2px;flex-wrap:wrap;'

    const dot = document.createElement('span')
    dot.style.cssText = `width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0;`

    const labelEl = document.createElement('span')
    labelEl.style.cssText = 'color:#fff;font-size:14px;font-weight:700;'
    labelEl.textContent = det.label

    const confEl = document.createElement('span')
    confEl.style.cssText = `color:${color};font-size:11px;`
    confEl.textContent = `${conf}%`

    const editBtn = document.createElement('button')
    editBtn.textContent = '✏'
    editBtn.title = 'Edit label & description'
    editBtn.className = 'ci-icon-btn ci-icon-btn--sm'
    editBtn.style.marginLeft = 'auto'

    row1.append(dot, labelEl, confEl, editBtn)

    const desc = document.createElement('p')
    desc.style.cssText = 'color:rgba(255,255,255,0.5);font-size:12px;line-height:1.4;margin:0 0 5px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;'
    desc.textContent = det.description

    const posBadge = document.createElement('div')
    posBadge.style.cssText = `
      display:inline-flex;gap:4px;
      background:rgba(255,255,255,0.06);
      border:1px solid rgba(255,255,255,0.1);
      border-radius:6px;padding:3px 7px;
      font-size:11px;font-family:monospace;color:rgba(255,255,255,0.55);
    `
    posBadge.innerHTML = `
      <span style="color:#72ddd4;">${fmtCoord(p.x)}</span>
      <span style="opacity:0.3;">·</span>
      <span style="color:#81c784;">${fmtCoord(p.y)}</span>
      <span style="opacity:0.3;">·</span>
      <span style="color:#ffcc80;">${fmtCoord(p.z)}</span>
    `

    // Inline edit form
    const editForm = document.createElement('div')
    editForm.style.cssText = 'display:none;margin-top:8px;'
    const safeLabel = det.label.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const safeDesc = det.description.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    editForm.innerHTML = `
      <input type="text" value="${safeLabel}" placeholder="Label"
        class="ci-field"
        style="margin-bottom:5px;" />
      <textarea placeholder="Description" rows="2"
        class="ci-field ci-textarea">${safeDesc}</textarea>
      <div style="display:flex;gap:6px;margin-top:5px;">
        <button class="edit-save ci-inline-btn ci-inline-btn--primary" style="flex:1;">Save</button>
        <button class="edit-cancel ci-inline-btn ci-inline-btn--muted" style="flex:1;">Cancel</button>
      </div>
    `

    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const show = editForm.style.display === 'none'
      editForm.style.display = show ? 'block' : 'none'
      if (show) editForm.querySelector<HTMLInputElement>('input')?.focus()
    })

    editForm.querySelector<HTMLButtonElement>('.edit-save')!.addEventListener('click', async (e) => {
      e.stopPropagation()
      const newLabel = (editForm.querySelector<HTMLInputElement>('input')!.value || det.label).trim()
      const newDesc = (editForm.querySelector<HTMLTextAreaElement>('textarea')!.value || det.description).trim()
      editForm.style.display = 'none'
      await this.store.updateDetection(key, { label: newLabel, description: newDesc })
    })

    editForm.querySelector<HTMLButtonElement>('.edit-cancel')!.addEventListener('click', (e) => {
      e.stopPropagation()
      editForm.style.display = 'none'
    })

    info.append(row1, desc, posBadge, editForm)

    // Confidence ring / select indicator on right
    const ring = document.createElement('div')
    ring.title = isSelected ? 'Deselect' : `${conf}% — tap to select`
    ring.style.cssText = 'flex-shrink:0;padding-top:2px;cursor:pointer;'
    const r = 12, stroke = 2.5, circ = 2 * Math.PI * (r - stroke / 2)

    if (isSelected) {
      ring.innerHTML = `
        <svg width="${r * 2}" height="${r * 2}" viewBox="0 0 ${r * 2} ${r * 2}">
          <circle cx="${r}" cy="${r}" r="${r - stroke / 2}" fill="#72ddd4" stroke="#72ddd4" stroke-width="${stroke}"/>
          <text x="${r}" y="${r + 4}" text-anchor="middle" fill="#000" font-size="10" font-weight="bold">✓</text>
        </svg>`
    } else {
      ring.innerHTML = `
        <svg width="${r * 2}" height="${r * 2}" viewBox="0 0 ${r * 2} ${r * 2}">
          <circle cx="${r}" cy="${r}" r="${r - stroke / 2}"
            fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="${stroke}"/>
          <circle cx="${r}" cy="${r}" r="${r - stroke / 2}"
            fill="none" stroke="${color}" stroke-width="${stroke}"
            stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - conf / 100)}"
            stroke-linecap="round" transform="rotate(-90 ${r} ${r})"/>
        </svg>`
    }
    ring.addEventListener('click', (e) => {
      e.stopPropagation()
      this.store.toggleSelect(key)
    })

    card.append(imgWrap, info, ring)
    return card
  }
}
