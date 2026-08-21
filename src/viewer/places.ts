import type { PlaceArea, Project, ScanManifest } from '../world/types'

export class PlacesPanel {
  constructor(
    private readonly root: HTMLElement,
    private readonly headers: () => HeadersInit,
    private readonly selectedScan: () => ScanManifest | null,
    private readonly onChanged: () => void,
  ) {}

  async render(): Promise<void> {
    const projects = await this.fetchProjects()
    const scan = this.selectedScan()
    this.root.innerHTML = ''

    for (const project of projects) {
      const section = document.createElement('div')
      section.className = 'edit-section'
      section.innerHTML = `
        <input class="place-name" value="${esc(project.name)}" aria-label="Place name" />
        <div class="layer-meta">Place · ${esc(project.projectId)}</div>
        <div class="place-actions">
          <button class="sidebar-tool" data-action="rename">Rename</button>
          <button class="sidebar-tool" data-action="delete">Delete</button>
          <button class="sidebar-tool" data-action="merge">Merge selected into this</button>
        </div>
        <div class="place-area-list"></div>
        <div class="place-floor-list"></div>
        <div class="place-actions">
          <button class="sidebar-tool" data-action="area">Add area</button>
          <button class="sidebar-tool" data-action="floor">Add floor</button>
          ${scan ? '<button class="sidebar-tool" data-action="assign">Assign to place</button>' : ''}
        </div>
      `
      section.querySelector<HTMLButtonElement>('[data-action="rename"]')?.addEventListener('click', async () => {
        const input = section.querySelector<HTMLInputElement>('.place-name')
        if (!input?.value.trim()) return
        await this.putProject({ ...project, name: input.value.trim() })
      })
      section.querySelector<HTMLButtonElement>('[data-action="delete"]')?.addEventListener('click', async () => {
        const response = await fetch(`/projects/${encodeURIComponent(project.projectId)}`, { method: 'DELETE', headers: this.headers() })
        if (!response.ok) alert(await response.text())
        await this.refresh()
      })
      section.querySelector<HTMLButtonElement>('[data-action="floor"]')?.addEventListener('click', async () => {
        project.floors.push({ floorId: `floor-${Date.now()}`, name: 'New floor', level: project.floors.length, rooms: [] })
        await this.putProject(project)
      })
      section.querySelector<HTMLButtonElement>('[data-action="area"]')?.addEventListener('click', async () => {
        const name = prompt('Area name, for example Kitchen or South Wing')?.trim()
        if (!name) return
        const requestedKind = prompt('Area type: room, floor, zone, building, or outdoor', 'room')?.trim().toLowerCase()
        const allowedKinds = new Set<PlaceArea['kind']>(['room', 'floor', 'zone', 'building', 'outdoor'])
        const kind = allowedKinds.has(requestedKind as PlaceArea['kind'])
          ? requestedKind as PlaceArea['kind']
          : 'zone'
        project.areas = [
          ...(project.areas ?? []),
          {
            areaId: `area-${Date.now()}`,
            name,
            kind,
            parentAreaId: project.areas?.[0]?.areaId ?? null,
          },
        ]
        await this.putProject(project)
      })
      section.querySelector<HTMLButtonElement>('[data-action="assign"]')?.addEventListener('click', async () => {
        await this.assignScan(project, null)
      })
      section.querySelector<HTMLButtonElement>('[data-action="merge"]')?.addEventListener('click', async () => {
        const sourceProjectId = prompt('Source project id to merge into this place')
        if (!sourceProjectId) return
        await fetch(`/projects/${encodeURIComponent(project.projectId)}/merge`, {
          method: 'POST',
          headers: { ...this.headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceProjectId }),
        })
        await this.refresh()
      })

      const areaList = section.querySelector<HTMLElement>('.place-area-list')!
      for (const area of project.areas ?? []) {
        const row = document.createElement('div')
        row.className = 'layer-meta'
        const childCount = (project.areas ?? []).filter(candidate => candidate.parentAreaId === area.areaId).length
        row.innerHTML = `<strong>${esc(area.name)}</strong> · ${esc(area.kind)}${childCount ? ` · ${childCount} areas` : ''}${scan ? ` <button class="sidebar-tool" data-area="${esc(area.areaId)}">Assign scan</button>` : ''}`
        row.querySelector<HTMLButtonElement>('button')?.addEventListener('click', async () => {
          await this.assignScan(project, area.areaId)
        })
        areaList.appendChild(row)
      }

      const floorList = section.querySelector<HTMLElement>('.place-floor-list')!
      for (const floor of project.floors) {
        const row = document.createElement('div')
        row.className = 'layer-meta'
        row.innerHTML = `<strong>${esc(floor.name)}</strong> · ${floor.rooms.length} rooms <button class="sidebar-tool" data-room="${esc(floor.floorId)}">Add room</button>`
        row.querySelector('button')?.addEventListener('click', async () => {
          floor.rooms.push({ roomId: `room-${Date.now()}`, name: 'New room' })
          await this.putProject(project)
        })
        floorList.appendChild(row)
      }

      this.root.appendChild(section)
    }
  }

  private async refresh(): Promise<void> {
    await this.render()
    this.onChanged()
  }

  private async fetchProjects(): Promise<Project[]> {
    const response = await fetch('/projects', { headers: this.headers() })
    if (!response.ok) return []
    return await response.json() as Project[]
  }

  private async putProject(project: Project): Promise<void> {
    await fetch(`/projects/${encodeURIComponent(project.projectId)}`, {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(project),
    })
    await this.refresh()
  }

  private async assignScan(project: Project, areaId: string | null): Promise<void> {
    const scan = this.selectedScan()
    if (!scan) return
    const area = project.areas?.find(candidate => candidate.areaId === areaId) ?? null
    await fetch(`/projects/${encodeURIComponent(project.projectId)}/scans/${encodeURIComponent(scan.scanId)}`, {
      method: 'PATCH',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ floorId: area?.floorId ?? null, roomId: area?.roomId ?? null, areaId }),
    })
    await this.refresh()
  }
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
