/**
 * Side panel — full object manifest with 3D positions + export controls.
 * Supports:
 *   - Close button inside the panel header
 *   - Select / deselect individual detections (highlighted in AR overlay)
 *   - Inline edit of label + description
 */
import type { DetectionStore, StoredDetection } from '../scene/store'

const CATEGORY_COLORS: Record<string, string> = {
  chair: '#4fc3f7', table: '#81c784', sofa: '#ff8a65', couch: '#ff8a65',
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

  constructor(
    private readonly store: DetectionStore,
    private readonly onExport: () => void,
    private readonly onSummary?: () => void,
    private readonly onProcess?: (action: string) => void,
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
    panelHeader.innerHTML = `<span style="color:#fff;font-size:15px;font-weight:700;">Detections</span>`
    const closeBtn = document.createElement('button')
    closeBtn.setAttribute('aria-label', 'Close panel')
    closeBtn.style.cssText = `
      background:none;border:none;color:rgba(255,255,255,0.4);
      font-size:18px;cursor:pointer;padding:0 2px;line-height:1;
    `
    closeBtn.textContent = '✕'
    closeBtn.addEventListener('click', () => this.setOpen(false))
    panelHeader.appendChild(closeBtn)
    this.panel.insertBefore(panelHeader, this.content)

    // ── Toggle button (outside panel) ──────────────────────────────────────
    this.toggle.addEventListener('click', () => this.setOpen(!this.isOpen))

    // ── Footer buttons ─────────────────────────────────────────────────────
    const exportBtn = document.createElement('button')
    exportBtn.className = 'panel-btn-primary'
    exportBtn.textContent = '⬇ Export .glb'
    exportBtn.addEventListener('click', this.onExport)
    this.footer.appendChild(exportBtn)

    if (this.onSummary) {
      const summaryBtn = document.createElement('button')
      summaryBtn.className = 'panel-btn-ghost'
      summaryBtn.textContent = '📄 Export Summary'
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
        btn.textContent = btnLabel
        btn.addEventListener('click', () => this.onProcess!(action))
        processWrap.appendChild(btn)
      }
      this.footer.appendChild(processWrap)
    }

    const clearBtn = document.createElement('button')
    clearBtn.className = 'panel-btn-ghost'
    clearBtn.textContent = 'Clear session'
    clearBtn.addEventListener('click', async () => { await this.store.clear() })
    this.footer.appendChild(clearBtn)

    this.store.subscribe((dets, selected) => this.render(dets, selected))
    this.render(this.store.detections, this.store.selected)
  }

  setOpen(open: boolean): void {
    this.isOpen = open
    this.panel.classList.toggle('open', open)
    const count = this.store.detections.size
    this.toggle.setAttribute('data-count', count > 0 ? String(count) : '')
  }

  private render(dets: Map<string, StoredDetection>, selected: Set<string>): void {
    const count = dets.size
    this.toggle.setAttribute('data-count', count > 0 ? String(count) : '')

    if (count === 0) {
      this.content.innerHTML = `
        <div style="padding:24px 16px;text-align:center;">
          <div style="font-size:32px;margin-bottom:10px;opacity:0.3;">📍</div>
          <p style="color:rgba(255,255,255,0.4);font-size:13px;line-height:1.5;">
            No objects yet.<br>Tap the capture button to scan.
          </p>
        </div>`
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
  }

  private _buildCard(key: string, det: StoredDetection, isSelected: boolean): HTMLElement {
    const color = categoryColor(det.label)
    const conf = Math.round(det.confidence * 100)
    const p = det.worldPos

    const card = document.createElement('div')
    card.dataset['key'] = key
    card.style.cssText = `
      display:grid;grid-template-columns:auto 1fr auto;
      gap:10px;padding:10px 14px;
      border-bottom:1px solid rgba(255,255,255,0.06);
      align-items:start;
      transition:background 0.15s;
      ${isSelected ? 'background:rgba(79,195,247,0.08);border-left:2px solid #4fc3f7;padding-left:12px;' : ''}
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
    editBtn.style.cssText = `
      background:none;border:none;color:rgba(255,255,255,0.25);
      font-size:11px;cursor:pointer;padding:0 2px;margin-left:auto;
      transition:color 0.15s;flex-shrink:0;
    `
    editBtn.addEventListener('pointerenter', () => { editBtn.style.color = '#4fc3f7' })
    editBtn.addEventListener('pointerleave', () => { editBtn.style.color = 'rgba(255,255,255,0.25)' })

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
      <span style="color:#4fc3f7;">${fmtCoord(p.x)}</span>
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
        style="width:100%;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);
               border-radius:6px;color:#fff;font-size:12px;padding:5px 8px;margin-bottom:5px;
               outline:none;box-sizing:border-box;" />
      <textarea placeholder="Description" rows="2"
        style="width:100%;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);
               border-radius:6px;color:#fff;font-size:12px;padding:5px 8px;resize:none;
               outline:none;font-family:inherit;box-sizing:border-box;">${safeDesc}</textarea>
      <div style="display:flex;gap:6px;margin-top:5px;">
        <button class="edit-save" style="flex:1;padding:5px;background:#4fc3f7;color:#000;border:none;
          border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">Save</button>
        <button class="edit-cancel" style="flex:1;padding:5px;background:rgba(255,255,255,0.08);
          color:rgba(255,255,255,0.6);border:none;border-radius:6px;font-size:12px;cursor:pointer;">Cancel</button>
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
          <circle cx="${r}" cy="${r}" r="${r - stroke / 2}" fill="#4fc3f7" stroke="#4fc3f7" stroke-width="${stroke}"/>
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
