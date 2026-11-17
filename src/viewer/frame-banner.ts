/**
 * The editor's account of which reference each scan was made against: a chip on the scan, a banner for the Place, and
 * the "Previous reference" layer that dims and groups the scans of an earlier reference (WP-08).
 *
 * A Place's frame is replaced by a new generation, never edited (ADR 0009, ../world/frame-replacement.ts), and every
 * scan's calibration names the generation it was measured against (`ScanManifest.calibrationFrameId`). Nothing moves a
 * scan when its Place's reference is replaced, so scans made against the old one stay where they were and the editor
 * has to say so, or they pass for scans of the current reference: they sit on the same origin and look coherent.
 *
 * ## What each chip claims, and what it does not
 *
 *  - "previous reference": the scan names a generation that is not the Place's current one, or (a scan with no id)
 *    was calibrated before the Place replaced a frame that had none. Only two known, different ids, or a recorded
 *    replacement, say that. It says nothing about how far off the scan is. Its explanation calls the reference "an earlier
 *    reference of this Place", with the date, only where the Place's own record lists it; for an id the record never listed
 *    (a scan carried in from another Place) it says that the reference is not the current one and that the record does not
 *    say it was ever the Place's own.
 *  - "not in Place frame" (owner decision D6): the scan was not aligned to a Place reference at all (uncalibrated), or
 *    only from one point and the compass, or from a measured distance. Mixed scans are allowed; they are labelled.
 *  - "frame not recorded": a two-point scan with no id, in a Place whose reference has one. It was made before ids
 *    existed, so the editor cannot tell which reference it was measured against, and does not guess. Neutral.
 *  - nothing: a scan of the current reference, and every scan of a Place that has no reference (there is nothing to be
 *    in or out of), and a scan with no id in a Place whose own frame has none.
 *
 * ## The layer
 *
 * One switch, on by default: the scans of a previous reference are dimmed in the scene and listed apart under a heading, after the rest.
 * Dimming is the compare tools' see-through style (./compare-style.ts: reuse, ADR 0001), applied only to a scan those tools
 * have not tinted, and taken off only from one it dimmed.
 *
 * The first half of this file is pure and tested without a DOM. The second half builds the DOM the page has the places
 * for (viewer.html) and takes what it needs from the editor through `FrameReferenceHost`.
 */
import type * as THREE from 'three'
import { frameIdOf } from '../world/frame-replacement.ts'
import { isFrameId } from '../world/spatial-frame.ts'
import type { FrameHistoryEntry, FrameReplaceReason, ProjectSpatialFrame, ScanManifest } from '../world/types'
import { appliedStyle, applyCompareStyle, PLAIN_STYLE, type CompareStyle } from './compare-style'

// ── Chips ────────────────────────────────────────────────────────────────────────────────────────────

export type FrameChipKind = 'previous-reference' | 'not-in-frame' | 'not-recorded'

export interface FrameChip {
  kind: FrameChipKind
  /** The words on the chip. */
  text: string
  /** The longer explanation, which the row shows as the chip's tooltip. The banner above the list says the counts in words a touch screen shows too. */
  title: string
}

/** What the editor needs to know of a Place to compare its scans with it. */
export interface FramePlace {
  spatialFrame?: ProjectSpatialFrame | null
  frameHistory?: readonly FrameHistoryEntry[] | null
}

/** The calibration fields of a `ScanManifest` the chip reads. */
export type FrameScan = Pick<ScanManifest, 'calibrationMethod' | 'calibrationStatus' | 'calibrationFrameId' | 'calibratedAt'>

export const PREVIOUS_REFERENCE_TEXT = 'previous reference'
export const NOT_IN_FRAME_TEXT = 'not in Place frame'
export const NOT_RECORDED_TEXT = 'frame not recorded'

/**
 * `2026-11-03 (UTC)`: the date part of an ISO time, in UTC and saying so (the date on the person's own clock can be the day
 * before or after), or null when it is not a time.
 */
function dayOf(iso: string | undefined): string | null {
  if (typeof iso !== 'string') return null
  const time = Date.parse(iso)
  return Number.isFinite(time) ? `${new Date(time).toISOString().slice(0, 10)} (UTC)` : null
}

/**
 * The history entry that says the scan's generation was replaced, when there is one. A scan that names an id is found
 * by that id. A scan with no id is found by time: an entry for a frame with no id, replaced after the scan was calibrated,
 * is the frame it was made against, because a Place holds one frame at a time and this was the one before the
 * replacement.
 */
function replacedEntry(scan: FrameScan, history: readonly FrameHistoryEntry[]): FrameHistoryEntry | null {
  const id = isFrameId(scan.calibrationFrameId) ? scan.calibrationFrameId : null
  if (id !== null) return history.find((entry) => entry.frameId === id) ?? null
  const at = typeof scan.calibratedAt === 'string' ? Date.parse(scan.calibratedAt) : Number.NaN
  if (!Number.isFinite(at)) return null
  return history.find((entry) => entry.frameId === null && at < Date.parse(entry.supersededAt)) ?? null
}

/**
 * The chip for a scan that names a reference other than the Place's current one. When the Place's own record lists that
 * reference, it was this Place's, and the title says when it was replaced. When it does not (a scan carried in from another
 * Place, or a reference this phone made that has not reached the server), the title says only what is known: it is not the
 * current one, and the Place's record does not say it was ever its own.
 */
function previousChip(entry: FrameHistoryEntry | null): FrameChip {
  const when = dayOf(entry?.supersededAt)
  const effect = 'It may not line up with scans made against the current one.'
  const title = entry === null
    ? `This scan was measured against a reference other than this Place's current one, and the Place's record does not say it was ever the Place's own. ${effect}`
    : `This scan was measured against an earlier reference of this Place, not the current one. ${effect}${when ? ` That reference was replaced on ${when}.` : ''}`
  return { kind: 'previous-reference', text: PREVIOUS_REFERENCE_TEXT, title }
}

/**
 * The chip for one scan, or null when it needs none. See the header for each case. `place` is the Place the scan is
 * listed in; a Place with no reference gives no chip.
 */
export function frameChipFor(scan: FrameScan, place: FramePlace | null | undefined): FrameChip | null {
  if (!place?.spatialFrame) return null

  const method = scan.calibrationMethod
  if (!method || scan.calibrationStatus === 'uncalibrated') {
    return {
      kind: 'not-in-frame',
      text: NOT_IN_FRAME_TEXT,
      title: "This scan was not aligned to this Place's reference, so it is not in the Place frame.",
    }
  }
  if (method === 'ground-tap-compass') {
    return {
      kind: 'not-in-frame',
      text: NOT_IN_FRAME_TEXT,
      title: 'This scan was aligned from one point and the compass, so it is not in the Place frame. It lines up with other scans only at the same spot.',
    }
  }
  if (method !== 'two-point-ground') {
    return {
      kind: 'not-in-frame',
      text: NOT_IN_FRAME_TEXT,
      // Only the tier that is sized from a measured distance says so: a method this build does not know is only known not to be
      // the two-point one.
      title: method === 'known-distance'
        ? 'This scan was sized from a measured distance, so it is not in the Place frame.'
        : "This scan was aligned another way than with the Place's two points, so it is not in the Place frame.",
    }
  }

  const current = frameIdOf(place.spatialFrame)
  const history = place.frameHistory ?? []
  const named = isFrameId(scan.calibrationFrameId) ? scan.calibrationFrameId : null
  if (named !== null) {
    if (named === current) return null
    // A different known id is another generation. When the Place's own frame has no id, the scan's is still one the
    // history shows was replaced, or it is not shown to be another: nothing is claimed.
    const entry = replacedEntry(scan, history)
    return current !== null || entry !== null ? previousChip(entry) : null
  }
  const entry = replacedEntry(scan, history)
  if (entry) return previousChip(entry)
  if (current === null) return null
  return {
    kind: 'not-recorded',
    text: NOT_RECORDED_TEXT,
    title: "This scan was made before references were numbered, so the editor cannot tell whether it was measured against the Place's current one.",
  }
}

// ── The banner ───────────────────────────────────────────────────────────────────────────────────────

export interface ChipCounts {
  previous: number
  notInFrame: number
  notRecorded: number
}

/** How many of `scans` fall under each chip. */
export function summariseFrames(scans: readonly FrameScan[], place: FramePlace | null | undefined): ChipCounts {
  const summary: ChipCounts = { previous: 0, notInFrame: 0, notRecorded: 0 }
  for (const scan of scans) {
    const kind = frameChipFor(scan, place)?.kind
    if (kind === 'previous-reference') summary.previous += 1
    else if (kind === 'not-in-frame') summary.notInFrame += 1
    else if (kind === 'not-recorded') summary.notRecorded += 1
  }
  return summary
}

const REASON_WORDS: Record<FrameReplaceReason, string> = {
  override: 'after the points did not match',
  upgrade: 'to improve it',
  merge: 'after two Places were merged',
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

/**
 * The banner's lines for a Place, or none when there is nothing to say. Facts only: what the counts are, and when and
 * why the reference was last replaced when the Place's own record says.
 */
export function frameBannerLines(summary: ChipCounts, place: FramePlace | null | undefined): string[] {
  const lines: string[] = []
  if (summary.previous > 0) {
    lines.push(
      `${summary.previous} ${plural(summary.previous, 'scan was', 'scans were')} measured against a previous reference and may not line up with the current one.`,
    )
    const last = place?.frameHistory?.at(-1)
    const when = dayOf(last?.supersededAt)
    if (last && when) lines.push(`The reference was last replaced on ${when}, ${REASON_WORDS[last.reason] ?? 'by a person'}.`)
  }
  if (summary.notInFrame > 0) {
    lines.push(`${summary.notInFrame} ${plural(summary.notInFrame, 'scan is', 'scans are')} not in this Place's frame.`)
  }
  if (summary.notRecorded > 0) {
    lines.push(
      `${summary.notRecorded} ${plural(summary.notRecorded, 'scan does', 'scans do')} not say which reference ${plural(summary.notRecorded, 'it was', 'they were')} made against.`,
    )
  }
  return lines
}

// ── The layer ────────────────────────────────────────────────────────────────────────────────────────

/** What a scan of a previous reference looks like: the compare tools' see-through, untinted. */
const DIM: CompareStyle = { tint: null, ghost: true }

/**
 * Dims the scans that should be and puts back the ones that no longer should be.
 *
 * `dimmed` is what this layer dimmed, and is updated. A scan whose materials are plain is dimmed. One that is already
 * see-through is left as it is. One the compare tools have tinted, or whose materials disagree, is left alone: it was
 * styled on purpose by someone else. When a scan this layer dimmed is no longer to be dimmed, its style is taken off
 * only if it is still the plain see-through this layer applies. A scan the compare tools made see-through is theirs and
 * is never taken off here.
 */
export function applyPreviousReferenceDim(
  roots: Iterable<readonly [string, THREE.Object3D | undefined]>,
  shouldDim: (scanId: string) => boolean,
  dimmed: Set<string>,
): void {
  for (const [scanId, root] of roots) {
    if (!root) {
      dimmed.delete(scanId)
      continue
    }
    // Most scans are neither to be dimmed nor were: their materials are not read at all.
    if (!shouldDim(scanId) && !dimmed.has(scanId)) continue
    const now = appliedStyle(root)
    const seeThrough = now !== null && now.tint === null && now.ghost
    if (shouldDim(scanId)) {
      if (!seeThrough && now !== null && now.tint === null) {
        applyCompareStyle(root, DIM)
        dimmed.add(scanId)
      }
    } else if (dimmed.has(scanId)) {
      if (seeThrough) applyCompareStyle(root, PLAIN_STYLE)
      dimmed.delete(scanId)
    }
  }
}

// ── The order the list was built in ──────────────────────────────────────────────────────────────────

/**
 * Where each scan's row sits when nothing is grouped, so that grouping can be undone: the rows in the order the editor built
 * them. The editor builds the list from the world's scans in the world's order, and puts a scan that arrives later at the front
 * of the list, one after another, so each is in front of the one before it. A list built again (the first time, or for another
 * Place) has rows that are new elements, and is numbered from the world's order again.
 */
export class NaturalOrder<T extends object> {
  private readonly seen = new Map<string, { element: T; index: number }>()
  private front = 0

  /** Numbers the rows that are new. `rows` are the world's scans in the world's order, each with its row or none. */
  see(rows: ReadonlyArray<{ id: string; element: T | undefined }>): void {
    const fresh = rows.filter((row) => row.element !== undefined && this.seen.get(row.id)?.element !== row.element)
    const rebuilt = fresh.length === rows.length
    if (rebuilt) {
      this.seen.clear()
      this.front = 0
    }
    fresh.forEach((row, i) => this.seen.set(row.id, { element: row.element!, index: rebuilt ? i : --this.front }))
    const current = new Set(rows.filter((row) => row.element !== undefined).map((row) => row.id))
    for (const id of [...this.seen.keys()]) if (!current.has(id)) this.seen.delete(id)
  }

  /** The rows in the order they were built in. */
  ordered(): Array<{ id: string; element: T }> {
    return [...this.seen.entries()].sort((a, b) => a[1].index - b[1].index).map(([id, entry]) => ({ id, element: entry.element }))
  }
}

/**
 * The rows in the order they are to be listed: as built, or with the previous-reference rows after the rest and the heading
 * between. The heading is not a row: it is the one element that is not a scan's.
 */
export function listingOrder<T>(
  rows: ReadonlyArray<{ id: string; element: T }>,
  grouped: boolean,
  previous: ReadonlySet<string>,
  heading: T,
): T[] {
  if (!grouped) return rows.map((row) => row.element)
  return [
    ...rows.filter((row) => !previous.has(row.id)).map((row) => row.element),
    heading,
    ...rows.filter((row) => previous.has(row.id)).map((row) => row.element),
  ]
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────────────

/** What the editor hands the layer. Read when used, so a Place switch needs no re-wiring. */
export interface FrameReferenceHost {
  scans(): readonly ScanManifest[]
  place(): FramePlace | null
  /** The scan's row in the scan list. */
  scanItem(scanId: string): HTMLElement | undefined
  /** The scan list itself, which the previous-reference scans are grouped in. */
  scanList(): HTMLElement | null
  /** The scan's root in the scene, when it is loaded. */
  root(scanId: string): THREE.Object3D | undefined
}

export interface FrameReference {
  /** Redraws the chips, the banner, the layer's panel and the grouping, then dims. Call when scans or the Place change. */
  sync(): void
  /** Dims, or puts back. Call after anything that can replace a scan's materials. */
  apply(): void
}

const HEADING_ID = 'scan-group-previous'

/** Builds the layer over the elements viewer.html carries (`frame-banner`, `frame-previous-toggle`, `frame-previous-status`). */
export function createFrameReference(host: FrameReferenceHost): FrameReference {
  const byId = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null
  const dimmed = new Set<string>()
  let previousIds = new Set<string>()
  /** The layer's section opens by itself the first time there is something in it, and is the person's to close after that. */
  let opened = false
  const order = new NaturalOrder<HTMLElement>()

  const toggle = (): HTMLInputElement | null => byId<HTMLInputElement>('frame-previous-toggle')
  const layerOn = (): boolean => toggle()?.checked !== false

  function drawChips(): void {
    const place = host.place()
    for (const scan of host.scans()) {
      const item = host.scanItem(scan.scanId)
      if (!item) continue
      const chip = frameChipFor(scan, place)
      let line = item.querySelector<HTMLElement>('.scan-frame-line')
      if (!chip) {
        line?.remove()
        continue
      }
      if (!line) {
        line = document.createElement('div')
        line.className = 'scan-frame-line'
        const after = item.querySelector('.scan-meta-block')
        if (after) after.after(line)
        else item.appendChild(line)
      }
      let node = line.querySelector<HTMLElement>('.scan-frame-chip')
      if (!node) {
        node = document.createElement('span')
        node.className = 'scan-frame-chip'
        line.appendChild(node)
      }
      node.dataset['kind'] = chip.kind
      node.textContent = chip.text
      node.title = chip.title
    }
  }

  function drawBanner(summary: ChipCounts): void {
    const banner = byId('frame-banner')
    if (!banner) return
    const lines = frameBannerLines(summary, host.place())
    banner.replaceChildren(...lines.map((text) => {
      const row = document.createElement('div')
      row.textContent = text
      return row
    }))
    banner.hidden = lines.length === 0
  }

  function drawLayerPanel(): void {
    const checkbox = toggle()
    const status = byId('frame-previous-status')
    const section = byId<HTMLDetailsElement>('frame-reference-section')
    if (section && previousIds.size > 0 && !opened) {
      section.open = true
      opened = true
    }
    if (checkbox) checkbox.disabled = previousIds.size === 0
    if (status) {
      status.textContent = previousIds.size === 0
        ? 'No scan in this Place is from a previous reference.'
        : `${previousIds.size} ${plural(previousIds.size, 'scan is', 'scans are')} from a previous reference.`
    }
  }

  /**
   * Lists the previous-reference scans apart, after the rest, under a heading. The rows are moved in the list itself, so what
   * a screen reader reads and the order the keyboard tabs in are the order on the screen, and put back in the order they were
   * built in when the layer is off. A list already in the order wanted is not touched, so a focused row keeps its focus.
   */
  function drawGrouping(): void {
    const list = host.scanList()
    if (!list) return
    order.see(host.scans().map((scan) => ({ id: scan.scanId, element: host.scanItem(scan.scanId) })))
    const rows = order.ordered()
    const grouped = layerOn() && previousIds.size > 0
    for (const { id, element } of rows) element.classList.toggle('scan-previous-reference', grouped && previousIds.has(id))
    let heading = byId(HEADING_ID)
    if (!grouped) heading?.remove()
    else {
      if (!heading) {
        heading = document.createElement('div')
        heading.id = HEADING_ID
        heading.className = 'scan-group-heading'
        heading.setAttribute('role', 'heading')
        heading.setAttribute('aria-level', '3')
      }
      heading.textContent = `Previous reference (${previousIds.size})`
    }
    const wanted = listingOrder<HTMLElement | null>(rows, grouped, previousIds, heading)
    const wantedSet = new Set<Element | null>(wanted)
    const now = [...list.children].filter((child) => wantedSet.has(child))
    if (now.length !== wanted.length || now.some((child, i) => child !== wanted[i])) {
      list.append(...(wanted as HTMLElement[]))
    }
  }

  const api: FrameReference = {
    sync() {
      const place = host.place()
      const scans = host.scans()
      previousIds = new Set(scans.filter((scan) => frameChipFor(scan, place)?.kind === 'previous-reference').map((scan) => scan.scanId))
      drawChips()
      drawBanner(summariseFrames(scans, place))
      drawLayerPanel()
      drawGrouping()
      api.apply()
    },
    apply() {
      const on = layerOn()
      applyPreviousReferenceDim(
        host.scans().map((scan) => [scan.scanId, host.root(scan.scanId)] as const),
        (scanId) => on && previousIds.has(scanId),
        dimmed,
      )
    },
  }
  toggle()?.addEventListener('change', () => {
    drawGrouping()
    api.apply()
  })
  return api
}
