/**
 * Session summary exporter — generates a Markdown document for a completed
 * room-scan session.
 *
 * The output includes:
 *  - Session metadata (ID, date, duration, point count, capture count)
 *  - A synthesised natural-language scene description built from the detected objects
 *  - A table of every detected object with label, confidence, world position,
 *    and the VLM-generated description
 *  - Camera path statistics
 *  - Bounding-box / floor-area estimate
 *
 * The summary is:
 *  1. Triggered by the user via the side panel "Export Summary" button
 *  2. Downloaded as a .md file immediately
 *  3. Uploaded to the server's POST /upload-summary endpoint (non-blocking)
 */
import type { DetectionStore } from '../scene/store'
import type { PointCloud } from '../scene/pointcloud'
import type { Pose } from '../ar/provider'
import type { GeoFix } from '../geo/geo-tracker'

export interface SummaryData {
  store: DetectionStore
  pointCloud: PointCloud
  poseHistory: Pose[]
  captureCount: number
  geoFix?: GeoFix
}

export async function exportSessionSummary(data: SummaryData): Promise<void> {
  const md = buildMarkdown(data)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = `scan-summary-${ts}.md`
  triggerDownload(md, filename)
  void uploadSummary(md, filename, data.store)
}

function buildMarkdown(data: SummaryData): string {
  const { store, pointCloud, poseHistory, captureCount, geoFix } = data
  const dets = [...store.detections.values()]
  const now = new Date()
  const sessionStart = new Date(store.startedAt)
  const durationMs = now.getTime() - sessionStart.getTime()
  const durationMin = Math.round(durationMs / 60_000)

  // Bounding box
  const bb = pointCloud.count > 0 ? pointCloud.boundingBox() : null
  const roomW = bb ? (bb.max.x - bb.min.x).toFixed(1) : '?'
  const roomD = bb ? (bb.max.z - bb.min.z).toFixed(1) : '?'
  const roomH = bb ? (bb.max.y - bb.min.y).toFixed(1) : '?'
  const areaM2 = bb
    ? ((bb.max.x - bb.min.x) * (bb.max.z - bb.min.z)).toFixed(1)
    : '?'

  // Camera path length
  let pathLengthM = 0
  for (let i = 1; i < poseHistory.length; i++) {
    const a = poseHistory[i - 1].position
    const b = poseHistory[i].position
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
    pathLengthM += Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  // Natural language scene description
  const scene = synthesiseDescription(dets, bb)

  // Format date/time
  const dateStr = sessionStart.toLocaleDateString('en-GB', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
  const timeStr = sessionStart.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit',
  })

  const lines: string[] = []
  lines.push(`# Room Scan Summary`)
  lines.push(``)
  lines.push(`> Generated ${now.toISOString().slice(0, 19).replace('T', ' ')} UTC`)
  lines.push(``)

  // ── Location ────────────────────────────────────────────────────
  if (geoFix) {
    lines.push(`## Location`)
    lines.push(``)
    if (geoFix.address) {
      lines.push(`**Address:** ${geoFix.address}`)
      lines.push(``)
    }
    if (geoFix.displayAddress) {
      lines.push(`**Full address:** ${geoFix.displayAddress}`)
      lines.push(``)
    }
    lines.push(`| Field | Value |`)
    lines.push(`|-------|-------|`)
    lines.push(`| Latitude | ${geoFix.lat.toFixed(6)}° |`)
    lines.push(`| Longitude | ${geoFix.lng.toFixed(6)}° |`)
    lines.push(`| Accuracy | ±${Math.round(geoFix.accuracy)} m |`)
    if (geoFix.altitudeM !== null) lines.push(`| Altitude | ${Math.round(geoFix.altitudeM)} m ASL |`)
    if (geoFix.bearing !== null) lines.push(`| Compass Bearing | ${Math.round(geoFix.bearing)}° (true north) |`)
    const mapUrl = `https://maps.google.com/maps?q=${geoFix.lat.toFixed(6)},${geoFix.lng.toFixed(6)}`
    lines.push(`| Map | [View on Google Maps](${mapUrl}) |`)
    lines.push(``)
  }

  // ── Scene description ────────────────────────────────────────────────────
  lines.push(`## Scene`)
  lines.push(``)
  lines.push(scene)
  lines.push(``)

  // ── Session metadata ─────────────────────────────────────────────────────
  lines.push(`## Session Details`)
  lines.push(``)
  lines.push(`| Field | Value |`)
  lines.push(`|-------|-------|`)
  lines.push(`| Session ID | \`${store.sessionId}\` |`)
  lines.push(`| Captured | ${dateStr} at ${timeStr} |`)
  lines.push(`| Duration | ~${durationMin} min |`)
  lines.push(`| SLAM Points | ${pointCloud.count.toLocaleString()} |`)
  // Captures are reported with their inference outcome. One whose detection
  // failed carries no labels, so it cannot be a row in the object table below —
  // counting it here is what keeps it from disappearing from the report entirely.
  const caps = store.captureCounts()
  const capsUnresolved = caps.pending + caps.failed
  lines.push(`| Captures | ${captureCount}${
    capsUnresolved > 0 ? ` (${caps.failed} failed, ${caps.pending} pending)` : ''
  } |`)
  lines.push(`| Objects Detected | ${dets.length} |`)
  lines.push(`| Room Width | ${roomW} m |`)
  lines.push(`| Room Depth | ${roomD} m |`)
  lines.push(`| Room Height | ${roomH} m |`)
  lines.push(`| Estimated Floor Area | ${areaM2} m² |`)
  lines.push(`| Camera Path Length | ${pathLengthM.toFixed(1)} m |`)
  lines.push(``)

  // ── Object table ─────────────────────────────────────────────────────────
  lines.push(`## Detected Objects`)
  lines.push(``)
  if (dets.length === 0) {
    lines.push(`_No objects detected in this session._`)
  } else {
    lines.push(`| # | Object | Confidence | Scan # | Captured At | Position (x, y, z) | Description |`)
    lines.push(`|---|--------|-----------|--------|-------------|---------------------|-------------|`)
    dets.forEach((d, i) => {
      const conf = `${Math.round(d.confidence * 100)}%`
      const pos  = `(${d.worldPos.x.toFixed(2)}, ${d.worldPos.y.toFixed(2)}, ${d.worldPos.z.toFixed(2)})`
      const captIdx = (d.captureIndex != null) ? `#${d.captureIndex}` : '—'
      const ts = d.captureTimestamp
        ? new Date(d.captureTimestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : '—'
      const desc = (d.description ?? '').replace(/\|/g, '\\|')
      lines.push(`| ${i + 1} | **${d.label}** | ${conf} | ${captIdx} | ${ts} | \`${pos}\` | ${desc} |`)
    })
  }
  if (capsUnresolved > 0) {
    lines.push(``)
    const unusableNote = caps.unusable > 0
      ? ` ${caps.unusable} ${caps.unusable === 1 ? 'frame was' : 'frames were'} too dark or ` +
        `reflective to be worth keeping, so ${caps.unusable === 1 ? 'its image was' : 'their images were'} discarded.`
      : ''
    lines.push(
      `_${capsUnresolved} of ${captureCount} captures produced no detections — ` +
      `${caps.failed} failed, ${caps.pending} still pending; they are counted above but ` +
      `have no row here.${unusableNote} ${caps.retained} of ${captureCount} frames are ` +
      `still held and can be inferred later._`,
    )
  }
  lines.push(``)

  // ── Object groupings ──────────────────────────────────────────────────────
  if (dets.length > 0) {
    const grouped = groupByCategory(dets)
    if (grouped.size > 0) {
      lines.push(`## Object Categories`)
      lines.push(``)
      lines.push(`| Category | Count | Objects |`)
      lines.push(`|----------|-------|---------|`)
      for (const [cat, items] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
        lines.push(`| ${cat} | ${items.length} | ${items.map(d => d.label).join(', ')} |`)
      }
      lines.push(``)
    }
  }

  // ── Spatial layout ────────────────────────────────────────────────────────
  if (dets.length >= 2 && bb) {
    lines.push(`## Spatial Layout`)
    lines.push(``)
    lines.push(`Objects sorted by distance from room centre:`)
    lines.push(``)
    const cx = (bb.min.x + bb.max.x) / 2
    const cz = (bb.min.z + bb.max.z) / 2
    const sorted = [...dets].sort((a, b) => {
      const da = Math.hypot(a.worldPos.x - cx, a.worldPos.z - cz)
      const db = Math.hypot(b.worldPos.x - cx, b.worldPos.z - cz)
      return da - db
    })
    sorted.forEach((d) => {
      const dist = Math.hypot(d.worldPos.x - cx, d.worldPos.z - cz)
      lines.push(`- **${d.label}** — ${dist.toFixed(1)} m from centre`)
    })
    lines.push(``)
  }

  lines.push(`---`)
  lines.push(`_Generated by Companion Scan · ${now.toISOString()}_`)

  return lines.join('\n')
}

type DetLike = { label: string; confidence: number }

/** Natural language paragraph describing the room based on detections */
function synthesiseDescription(
  dets: DetLike[],
  bb: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null,
): string {
  if (dets.length === 0) {
    return 'No objects were detected in this scan session. Try moving closer to surfaces and tapping the capture button, or enable auto-capture mode.'
  }

  const names = (dets as DetLike[]).map((d) => d.label)
  const unique = [...new Set(names.map((n: string) => n.toLowerCase()))]

  let area = ''
  if (bb) {
    const w = (bb.max.x - bb.min.x).toFixed(0)
    const d = (bb.max.z - bb.min.z).toFixed(0)
    area = ` spanning approximately ${w} m × ${d} m`
  }

  const listStr = unique.length <= 2
    ? unique.join(' and ')
    : `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`

  const count = dets.length
  const plural = count === 1 ? 'object was' : 'objects were'

  return `This scan captures a room${area} containing ${count} detected ${plural} identified: ${listStr}. ` +
    `The inference model analysed ${count} frame${count === 1 ? '' : 's'} and ` +
    `produced confidence scores ranging from ` +
    `${Math.round(Math.min(...(dets as DetLike[]).map((d) => d.confidence)) * 100)}% ` +
    `to ${Math.round(Math.max(...(dets as DetLike[]).map((d) => d.confidence)) * 100)}%.`
}

/** Group detections by broad semantic category */
function groupByCategory(dets: Array<{ label: string }>): Map<string, typeof dets> {
  const MAP: Record<string, string> = {
    chair: 'Seating', sofa: 'Seating', couch: 'Seating', stool: 'Seating',
    table: 'Tables', desk: 'Tables', counter: 'Tables',
    monitor: 'Electronics', tv: 'Electronics', screen: 'Electronics', laptop: 'Electronics',
    bookcase: 'Storage', shelf: 'Storage', cabinet: 'Storage', wardrobe: 'Storage',
    door: 'Architecture', window: 'Architecture', wall: 'Architecture',
    lamp: 'Lighting',
    plant: 'Plants',
    bed: 'Bedroom',
  }

  const grouped = new Map<string, typeof dets>()
  for (const det of dets) {
    const lower = det.label.toLowerCase()
    let cat = 'Other'
    for (const [keyword, category] of Object.entries(MAP)) {
      if (lower.includes(keyword)) { cat = category; break }
    }
    if (!grouped.has(cat)) grouped.set(cat, [])
    grouped.get(cat)!.push(det)
  }
  return grouped
}

function triggerDownload(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

async function uploadSummary(content: string, filename: string, store: DetectionStore): Promise<void> {
  try {
    const form = new FormData()
    form.append('file', new Blob([content], { type: 'text/markdown' }), filename)
    form.append('sessionId', store.sessionId)
    const resp = await fetch('/upload-summary', { method: 'POST', body: form })
    if (resp.ok) {
      const body = await resp.json() as { filename: string }
      console.log(`[summary] Uploaded to server: ${body.filename}`)
    } else {
      console.warn(`[summary] Server upload failed: ${resp.status}`)
    }
  } catch (err) {
    console.warn('[summary] Server upload error:', err)
  }
}
