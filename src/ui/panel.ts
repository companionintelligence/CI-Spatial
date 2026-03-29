/**
 * Side panel — full object manifest with 3D positions + export controls.
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
  ) {
    this.panel = document.getElementById('side-panel')!
    this.content = document.getElementById('panel-content')!
    this.footer = document.getElementById('panel-footer')!
    this.toggle = document.getElementById('panel-toggle') as HTMLButtonElement
  }

  mount(): void {
    this.toggle.addEventListener('click', () => this.setOpen(!this.isOpen))

    const exportBtn = document.createElement('button')
    exportBtn.className = 'panel-btn-primary'
    exportBtn.textContent = '⬇ Export .glb'
    exportBtn.addEventListener('click', this.onExport)
    this.footer.appendChild(exportBtn)

    const clearBtn = document.createElement('button')
    clearBtn.className = 'panel-btn-ghost'
    clearBtn.textContent = 'Clear session'
    clearBtn.addEventListener('click', async () => { await this.store.clear() })
    this.footer.appendChild(clearBtn)

    this.store.subscribe((dets) => this.render(dets))
    this.render(this.store.detections)
  }

  setOpen(open: boolean): void {
    this.isOpen = open
    this.panel.classList.toggle('open', open)
    // Update badge
    const count = this.store.detections.size
    this.toggle.setAttribute('data-count', count > 0 ? String(count) : '')
  }

  private render(dets: Map<string, StoredDetection>): void {
    const count = dets.size
    // Update toggle badge
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

    const sorted = [...dets.values()].sort((a, b) => b.confidence - a.confidence)
    this.content.innerHTML = ''

    const header = document.createElement('div')
    header.style.cssText = 'padding:14px 16px 8px;display:flex;align-items:baseline;justify-content:space-between;'
    header.innerHTML = `
      <span style="color:rgba(255,255,255,0.5);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;">
        ${count} Object${count === 1 ? '' : 's'}
      </span>
      <span style="color:rgba(255,255,255,0.25);font-size:10px;">X · Y · Z</span>`
    this.content.appendChild(header)

    for (const det of sorted) {
      this.content.appendChild(this.buildCard(det))
    }
  }

  private buildCard(det: StoredDetection): HTMLElement {
    const color = categoryColor(det.label)
    const conf = Math.round(det.confidence * 100)
    const p = det.worldPos

    const card = document.createElement('div')
    card.style.cssText = `
      display:grid;grid-template-columns:auto 1fr auto;
      gap:10px;padding:10px 14px;
      border-bottom:1px solid rgba(255,255,255,0.06);
      align-items:start;
      transition:background 0.15s;
    `
    card.addEventListener('pointerenter', () => { card.style.background = 'rgba(255,255,255,0.04)' })
    card.addEventListener('pointerleave', () => { card.style.background = '' })

    // Thumbnail or colour swatch
    const imgWrap = document.createElement('div')
    imgWrap.style.cssText = 'width:44px;height:44px;border-radius:8px;overflow:hidden;flex-shrink:0;'
    if (det.thumbnailDataUrl) {
      const img = document.createElement('img')
      img.src = det.thumbnailDataUrl
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;'
      imgWrap.appendChild(img)
    } else {
      imgWrap.style.cssText += `background:${color}22;display:flex;align-items:center;justify-content:center;`
      imgWrap.innerHTML = `<span style="width:12px;height:12px;border-radius:50%;background:${color};box-shadow:0 0 8px ${color};"></span>`
    }

    // Label + description
    const info = document.createElement('div')
    info.style.cssText = 'min-width:0;'

    const row1 = document.createElement('div')
    row1.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:2px;'
    row1.innerHTML = `
      <span style="width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0;"></span>
      <span style="color:#fff;font-size:14px;font-weight:700;">${det.label}</span>
      <span style="color:${color};font-size:11px;">${conf}%</span>`

    const desc = document.createElement('p')
    desc.style.cssText = 'color:rgba(255,255,255,0.5);font-size:12px;line-height:1.4;margin:0 0 5px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;'
    desc.textContent = det.description

    // 3D position badge
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

    info.append(row1, desc, posBadge)

    // Confidence ring on right
    const ring = document.createElement('div')
    ring.title = `Confidence: ${conf}%`
    ring.style.cssText = 'flex-shrink:0;padding-top:2px;'
    const r = 12, stroke = 2.5, circ = 2 * Math.PI * (r - stroke / 2)
    ring.innerHTML = `
      <svg width="${r * 2}" height="${r * 2}" viewBox="0 0 ${r * 2} ${r * 2}">
        <circle cx="${r}" cy="${r}" r="${r - stroke / 2}"
          fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="${stroke}"/>
        <circle cx="${r}" cy="${r}" r="${r - stroke / 2}"
          fill="none" stroke="${color}" stroke-width="${stroke}"
          stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - conf / 100)}"
          stroke-linecap="round" transform="rotate(-90 ${r} ${r})"/>
      </svg>`

    card.append(imgWrap, info, ring)
    return card
  }
}
