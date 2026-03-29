/**
 * Session history drawer — lets the user browse and reload past scan sessions
 * stored in IndexedDB without needing to re-scan the room.
 */
import type { DetectionStore } from '../scene/store'

export class SessionHistory {
  private drawer: HTMLElement
  private trigger: HTMLButtonElement
  private body: HTMLElement
  private isOpen = false

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

    // Newest first
    sessions.sort((a, b) => b.startedAt - a.startedAt)

    for (const s of sessions) {
      const card = this._buildCard(s)
      this.body.appendChild(card)
    }
  }

  private _buildCard(s: { sessionId: string; startedAt: number; count: number }): HTMLElement {
    const card = document.createElement('div')
    card.style.cssText = `
      display:flex;align-items:center;justify-content:space-between;
      padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.07);
      transition:background 0.15s;
    `
    card.addEventListener('pointerenter', () => { card.style.background = 'rgba(255,255,255,0.05)' })
    card.addEventListener('pointerleave', () => { card.style.background = '' })

    const date = new Date(s.startedAt)
    const isToday = date.toDateString() === new Date().toDateString()
    const dateStr = isToday
      ? `Today ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
      : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

    const info = document.createElement('div')
    info.style.cssText = 'flex:1;min-width:0;cursor:pointer;'
    info.innerHTML = `
      <div style="color:#fff;font-size:14px;font-weight:600;margin-bottom:3px;">${dateStr}</div>
      <div style="color:rgba(255,255,255,0.4);font-size:12px;">
        ${s.count} object${s.count === 1 ? '' : 's'}
        <span style="opacity:0.5;margin-left:6px;font-family:monospace;font-size:10px;">${s.sessionId.slice(-8)}</span>
      </div>
    `
    info.addEventListener('click', async () => {
      card.style.opacity = '0.5'
      await this.store.loadSession(s.sessionId)
      this.close()
    })

    // Delete button
    const del = document.createElement('button')
    del.textContent = '✕'
    del.title = 'Delete session'
    del.style.cssText = `
      background:none;border:none;color:rgba(255,255,255,0.25);
      font-size:14px;cursor:pointer;padding:6px 4px 6px 12px;flex-shrink:0;
      transition:color 0.15s;
    `
    del.addEventListener('pointerenter', () => { del.style.color = '#ff6b6b' })
    del.addEventListener('pointerleave', () => { del.style.color = 'rgba(255,255,255,0.25)' })
    del.addEventListener('click', async (e) => {
      e.stopPropagation()
      card.style.transition = 'opacity 0.2s'
      card.style.opacity = '0'
      setTimeout(() => card.remove(), 200)
      await this.store.deleteSession(s.sessionId)
      // Show empty state if no sessions left
      if (this.body.children.length === 0) await this._render()
    })

    card.append(info, del)
    return card
  }
}
