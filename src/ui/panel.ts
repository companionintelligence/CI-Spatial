/**
 * Side panel — lists all detected objects and hosts the Export button.
 */
import type { DetectionStore, StoredDetection } from '../scene/store'

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

    // Export button
    const exportBtn = document.createElement('button')
    exportBtn.textContent = 'Export .glb'
    exportBtn.style.cssText =
      'width:100%;padding:14px;background:#fff;color:#000;border:none;font-size:15px;font-weight:700;cursor:pointer;'
    exportBtn.addEventListener('click', this.onExport)
    this.footer.appendChild(exportBtn)

    // Clear button
    const clearBtn = document.createElement('button')
    clearBtn.textContent = 'Clear session'
    clearBtn.style.cssText =
      'width:100%;padding:10px;background:transparent;color:rgba(255,255,255,0.5);border:none;font-size:13px;cursor:pointer;'
    clearBtn.addEventListener('click', async () => {
      await this.store.clear()
    })
    this.footer.appendChild(clearBtn)

    this.store.subscribe((dets) => this.render(dets))
    this.render(this.store.detections)
  }

  setOpen(open: boolean): void {
    this.isOpen = open
    this.panel.classList.toggle('open', open)
  }

  private render(dets: Map<string, StoredDetection>): void {
    // Update toggle badge
    const count = dets.size
    this.toggle.setAttribute('aria-label', `Detections (${count})`)

    if (count === 0) {
      this.content.innerHTML =
        '<p style="color:rgba(255,255,255,0.4);padding:20px 16px;font-size:13px;">No detections yet. Press the capture button to scan the room.</p>'
      return
    }

    const sorted = [...dets.values()].sort((a, b) => b.confidence - a.confidence)

    this.content.innerHTML = ''
    const header = document.createElement('p')
    header.style.cssText =
      'color:rgba(255,255,255,0.5);padding:12px 16px 6px;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;'
    header.textContent = `${count} object${count === 1 ? '' : 's'} detected`
    this.content.appendChild(header)

    for (const det of sorted) {
      const el = this.buildCard(det)
      this.content.appendChild(el)
    }
  }

  private buildCard(det: StoredDetection): HTMLElement {
    const card = document.createElement('div')
    card.style.cssText =
      'display:flex;gap:10px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.07);align-items:flex-start;'

    if (det.thumbnailDataUrl) {
      const img = document.createElement('img')
      img.src = det.thumbnailDataUrl
      img.style.cssText =
        'width:48px;height:48px;object-fit:cover;border-radius:6px;flex-shrink:0;'
      card.appendChild(img)
    }

    const info = document.createElement('div')
    info.style.flex = '1'

    const label = document.createElement('p')
    label.style.cssText = 'color:#fff;font-size:14px;font-weight:600;margin-bottom:2px;'
    label.textContent = det.label

    const desc = document.createElement('p')
    desc.style.cssText = 'color:rgba(255,255,255,0.55);font-size:12px;line-height:1.4;'
    desc.textContent = det.description

    const meta = document.createElement('p')
    meta.style.cssText = 'color:rgba(255,255,255,0.3);font-size:11px;margin-top:4px;'
    const conf = Math.round(det.confidence * 100)
    const pos = det.worldPos
    meta.textContent = `${conf}% · (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`

    info.appendChild(label)
    info.appendChild(desc)
    info.appendChild(meta)
    card.appendChild(info)
    return card
  }
}
