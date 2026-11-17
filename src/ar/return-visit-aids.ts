/**
 * The aids a return visit gets while it finds the same two points again (WP-07): its own copy for each step, a chip that
 * says whether the markers are the stored distance apart, a ring on the floor at that distance around the landmark, and
 * both stored photos side by side while the pair is checked.
 *
 * `./project-calibration.ts` creates one of these and calls it from its render; the sentences are
 * ./return-visit-copy.ts, the ring is ./calibration-guides.ts, and the photos are loaded the way the modal's own
 * reference panel loads them (`loadReferencePhoto`). It reads the card's elements by id, from the markup this file writes
 * (`returnVisitMarkup`) and the chip the modal's own template carries, and touches nothing else in the DOM but the card
 * itself, which it measures. An element that is not there is skipped, so a card without them still works.
 *
 * ## Which stage gets what
 *
 *  - The landmark and heading steps keep the modal's own reference panel (one photo, for the point being placed); this
 *    file only says what the step's copy should be, counted to the taps the visit asks for (`totalSteps`).
 *  - The ring is drawn once the landmark is confirmed and stays through the check step (where the stored check point's own
 *    ring is the one to walk to), review and the mismatch screen, centred on wherever the landmark is now (a landmark moved
 *    after Confirm takes its ring with it).
 *  - The chip is on in review, where both markers exist and can still be moved, and only while the commit compares the
 *    distance: a visit that re-taps a stored check point is judged by a fit of three points, which the card's readout
 *    reports (`comparedByFit`), and a distance chip beside it could say pass where the fit says mismatch, or the reverse
 *    (a pair 20 cm too long with a check point that sits right fits). Its tolerance is the commit's (`toleranceM`), so it
 *    says pass exactly when the commit accepts. While it fails, the card's status line does not say "Ready to commit."
 *    (`statusLine`).
 *  - The side-by-side photos are on in review and on the mismatch screen, which the modal's own reference panel does not
 *    cover: it names the one point being placed, and by review both have been. A Place whose stored frame has no photo
 *    at all has nothing to compare, so the panel stays off rather than show two notes saying so.
 *
 * ## Room for the photos
 *
 * The panel sits in the top corner and the card is anchored to the bottom, and on a short screen the card is tall enough
 * to reach the panel. The panel is measured against the card on every draw: it takes the space above the card, its photos
 * shrink to fit it, and below a size a photo is worth looking at it is not shown, so it never lies under the card. Beside
 * the card (a wide screen) it has all the room it wants.
 *
 * ## A stored record this file cannot read
 *
 * What it reads of the stored frame at construction (the points, the labels, the photos) it reads defensively: a record
 * this app did not write, or one an older build did, may lack a point or carry a list that is not one. Such a record gets
 * the aids that can be made from what it does hold, and a failure to draw one never stops the card from being drawn.
 *
 * ## Switched off
 *
 * `?returnaids=off` turns the aids off for the device comparison DX10 asks for (re-tap error with and without them): the
 * copy is the modal's own, and the chip, the ring and the photos are not drawn. It switches off what a person is shown
 * while re-tapping, and nothing about how a photo is taken, which is not an aid but a record.
 */
import type * as THREE from 'three'
import type { CalibrationReferencePhoto, Vec3 } from '../world/types.ts'
import type { TwoPointFrame } from './calibration-commit.ts'
import { buildDistanceRing } from './calibration-guides.ts'
import type { CalibrationStage } from './one-point-offer.ts'
import { referenceCrosshairPixels, ringRadiiFromStoredPoints, type ReferencePhotoRole } from './reference-photo.ts'
import {
  COMPARE_HEAD,
  NOT_STORED_DISTANCE_STATUS,
  compareNote,
  distanceChip,
  returnHeadingCopy,
  returnLandmarkCopy,
  returnVisitOf,
  type DistanceChip,
} from './return-visit-copy.ts'

/** Whether the aids are on: they are, unless the page was opened with `?returnaids=off`. */
export function returnAidsEnabled(search: string): boolean {
  return new URLSearchParams(search).get('returnaids') !== 'off'
}

// ── Room above the card ──────────────────────────────────────────────────────────────────────────────

/** Where something is on screen, in CSS pixels: what `getBoundingClientRect` reports. */
export interface Box {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * The gap kept between the photo panel and the card under it. Adopted, not measured (ADR 0005 rule 5): enough to read as
 * two things and not one. Revisit if the two are seen to touch on a device.
 */
const COMPARE_GAP_PX = 8

/**
 * What the photo panel is made of besides its photos, in CSS pixels: its padding and border, the heading, and a caption of
 * the three lines it is held to. Adopted, not measured on a device (ADR 0005 rule 5): it is 68 in Chromium with the
 * shipped fonts, and 70 leaves a little over. Revisit when the panel's type or padding changes
 * (`.project-calibration-compare-*` in index.html), which this must follow.
 */
export const COMPARE_CHROME_PX = 70

/**
 * The shortest a photo is shown at, in CSS pixels. Adopted, not measured (ADR 0005 rule 5): a photo this tall is about 54
 * wide, which still shows what is round the crosshair; under it the crosshair (14 px) is most of the picture and the panel
 * is left out. Revisit when a person on a device cannot place a point from a photo this small.
 */
export const COMPARE_MIN_PHOTO_PX = 72

/** The room a panel needs before it is worth drawing: its own chrome and one photo at the least. */
const COMPARE_MIN_ROOM_PX = COMPARE_CHROME_PX + COMPARE_MIN_PHOTO_PX

/**
 * How far down from its own top edge the panel can reach before it meets the card, less the gap: the room for the panel
 * and its photos. Null when the card is not under it (the two do not overlap across the screen, as on a wide window with
 * the card centred and the panel in the corner), which is all the room there is.
 */
export function roomAboveCard(card: Box, panel: Box): number | null {
  if (panel.left >= card.right || panel.right <= card.left) return null
  return card.top - panel.top - COMPARE_GAP_PX
}

// ── The markup ───────────────────────────────────────────────────────────────────────────────────────

const COMPARE_ID = 'project-calibration-compare'

const SLOTS: ReadonlyArray<{ key: string; role: 'landmark' | 'headingMarker'; name: string }> = [
  { key: 'a', role: 'landmark', name: 'Point A' },
  { key: 'b', role: 'headingMarker', name: 'Point B' },
]

/**
 * The panel that shows both stored photos, to sit beside the modal's own reference panel in its template. Hidden until
 * it is drawn. It takes the reference panel's classes for the box, the picture and the crosshair, so it looks like it.
 */
export function returnVisitMarkup(): string {
  const slots = SLOTS.map(({ key, name }) => `
        <div class="project-calibration-compare-slot">
          <figure id="${COMPARE_ID}-figure-${key}" class="project-calibration-reference-figure" hidden>
            <img id="${COMPARE_ID}-img-${key}" alt="${name} when it was placed, with a crosshair on the spot that was tapped" />
            <span id="${COMPARE_ID}-cross-${key}" class="project-calibration-crosshair" aria-hidden="true"></span>
          </figure>
          <p id="${COMPARE_ID}-note-${key}" class="project-calibration-reference-note" hidden></p>
          <p class="project-calibration-compare-caption"><span>${name}</span><span id="${COMPARE_ID}-label-${key}" class="project-calibration-compare-label"></span></p>
        </div>`).join('')
  return `<div id="${COMPARE_ID}" class="project-calibration-reference" hidden>
        <div class="project-calibration-reference-head"><span>${COMPARE_HEAD}</span></div>
        <div class="project-calibration-compare-row">${slots}
        </div>
      </div>`
}

// ── The aids ─────────────────────────────────────────────────────────────────────────────────────────

/** What the aids use of an element. A real element has all of it, and so does the stand-in a test builds the card from. */
interface Part {
  hidden: boolean
  textContent: string | null
  dataset: Record<string, string | undefined>
  /** Where it is on screen. Absent from a stand-in with no layout, which then has no room to measure. */
  getBoundingClientRect?: () => Box
}

/** What they use of a picture. `offsetLeft` and `offsetTop` are where it sits in its figure, which centres it. */
interface PicturePart {
  src: string
  onload: ((event?: unknown) => void) | null
  clientWidth: number
  clientHeight: number
  offsetLeft?: number
  offsetTop?: number
  style?: { maxHeight?: string }
}

interface CrosshairPart {
  style: { left: string; top: string }
}

export interface ReturnVisitAidsOptions {
  /** Whether the aids are on (`returnAidsEnabled`). Off, the copy methods answer null and nothing is drawn. */
  enabled: boolean
  /** The card the elements are found in, by id, and the dialog itself, by its class, to measure the room above it. */
  root: { querySelector(selector: string): unknown }
  /** The Place's stored two-point frame, or null on a first visit and on a Place with another kind of frame. */
  stored: TwoPointFrame | null
  /**
   * The spacing tolerance the commit applies (`twoPointToleranceM` at the tap noise it judges by), which the chip judges the
   * pair by and the heading step quotes. The commit no longer reads the record's own `toleranceM`, so neither do these.
   * Absent: what a commit at the adopted tap noise applies (`returnVisitOf`).
   */
  toleranceM?: number
  /**
   * What the steps' counters count to (`stepsInVisit`, ./constellation-flow.ts): 3 where the check point follows the heading
   * marker by itself, else 2. Absent: 2.
   */
  totalSteps?: number
  /** The group the modal draws its placement in and removes at every exit: the rings go in it. */
  placement: THREE.Object3D
  /** Makes the modal's scene, and so its placement group, exist, and answers whether they do. Asked before a ring is drawn. */
  ensureScene: () => unknown
  /** The modal's loader for a stored photo: what an `<img>` can show, or null. Absent: no photo can be loaded. */
  loadReferencePhoto?: (photo: CalibrationReferencePhoto) => Promise<string | null>
  /** Which stored photo the modal's own reference panel is showing now, with its picture on screen, if any. */
  shownPhoto: () => ReferencePhotoRole | null
}

/** What the modal tells the aids about itself each time it draws. */
export interface ReturnVisitView {
  stage: CalibrationStage
  /** The landmark where it is in the session now, which is the ring's centre. Null before one is placed. */
  landmark: Vec3 | null
  /** The distance between the two markers now, in metres, or null before both are placed. */
  separationM: number | null
  /**
   * Whether the commit would judge these markers by a fit of three points (a check point is placed against a stored one)
   * and not by the distance between two. The chip is the distance's verdict and is not shown then. Absent: by distance.
   */
  comparedByFit?: boolean
}

export interface ReturnVisitAids {
  /** Step 1's instruction on a return visit, or null when this is not one (or the aids are off): keep the modal's. */
  landmarkCopy(): string | null
  /** Step 2's instruction on a return visit, or null: keep the modal's. */
  headingCopy(): string | null
  /**
   * The card's status line: `base` (what the modal would write) unless the chip is failing, when it must not read "Ready to
   * commit." under a warning that the pair is not the stored distance.
   */
  statusLine(base: string): string
  render(view: ReturnVisitView): void
  /** Removes the rings and lets go of the photos. The modal calls it on every exit; a draw after it does nothing. */
  dispose(): void
}

interface Slot {
  photo: CalibrationReferencePhoto | null
  figure: Part | null
  img: PicturePart | null
  cross: CrosshairPart | null
  note: Part | null
  /** `'idle'` until the panel is first drawn, then where its picture has got to. */
  state: 'idle' | 'none' | 'loading' | 'shown' | 'failed'
}

/** A stored point the ring can be measured to: it has a place on the ground, whatever else the record holds of it. */
const isGroundPoint = (value: unknown): value is Vec3 =>
  typeof value === 'object' && value !== null && Number.isFinite((value as Vec3).x) && Number.isFinite((value as Vec3).z)

/**
 * The radii of the rings for a stored frame, in the order the points are stored: the heading marker, then any check points
 * the frame carries. A record whose landmark is not a point, or whose list of check points is not a list, gives what its
 * points that are readable give, which may be none: an unreadable record is no reason to stop the card opening.
 */
function storedRadii(stored: TwoPointFrame): number[] {
  if (!isGroundPoint(stored.landmark)) return []
  const checkPoints: unknown[] = Array.isArray(stored.checkPoints) ? stored.checkPoints : []
  return ringRadiiFromStoredPoints([stored.headingMarker, ...checkPoints].filter(isGroundPoint), stored.landmark)
}

export function createReturnVisitAids(options: ReturnVisitAidsOptions): ReturnVisitAids {
  const { stored, placement, ensureScene } = options
  const totalSteps = options.totalSteps ?? 2
  const visit = options.enabled ? returnVisitOf(stored, options.toleranceM) : null
  const pick = <T>(id: string): T | null => (options.root.querySelector(`#${id}`) as T | null) ?? null

  const chip = pick<Part>('project-calibration-chip')
  const compare = pick<Part>(COMPARE_ID)
  const card = (options.root.querySelector('.project-calibration-card') as Part | null) ?? null
  const slots: Slot[] = SLOTS.map(({ key, role }) => {
    const names = stored?.pointLabels as unknown
    const label = Array.isArray(names) ? names[role === 'landmark' ? 0 : 1] : ''
    const caption = pick<Part>(`${COMPARE_ID}-label-${key}`)
    if (caption) caption.textContent = typeof label === 'string' && label ? ` “${label}”` : ''
    return {
      photo: stored?.referencePhotos?.[role] ?? null,
      figure: pick<Part>(`${COMPARE_ID}-figure-${key}`),
      img: pick<PicturePart>(`${COMPARE_ID}-img-${key}`),
      cross: pick<CrosshairPart>(`${COMPARE_ID}-cross-${key}`),
      note: pick<Part>(`${COMPARE_ID}-note-${key}`),
      state: 'idle',
    }
  })
  const hasPhoto = slots.some((slot) => slot.photo !== null)

  const radii = stored ? storedRadii(stored) : []
  const radiiKey = radii.join(',')
  /**
   * Whether the ring and the sentence about it are the same distance: the ring is measured from the stored points and the
   * sentence quotes the record's `separationM`, both to the centimetre. They are for a frame this app wrote.
   */
  const ringIsTheStoredDistance = visit !== null
    && visit.separationM !== null
    && radii.length > 0
    && radii[0]!.toFixed(2) === visit.separationM.toFixed(2)

  let rings: THREE.LineSegments[] = []
  let ringsFor = ''
  const objectUrls: string[] = []
  let disposed = false
  let shownChip = ''
  let chipState: DistanceChip['state'] | null = null
  const warned = new Set<string>()

  // ── The chip ───────────────────────────────────────────────────────────────────────────────────────

  function renderChip(view: ReturnVisitView): void {
    const result = visit && view.stage === 'review' && !view.comparedByFit ? distanceChip(visit, view.separationM) : null
    chipState = result?.state ?? null
    if (!chip) return
    chip.hidden = result === null
    const next = result ? `${result.state}|${result.text}` : ''
    if (!result || next === shownChip) return
    shownChip = next
    chip.dataset['state'] = result.state
    chip.textContent = result.text
  }

  // ── The rings ──────────────────────────────────────────────────────────────────────────────────────

  function clearRings(): void {
    for (const ring of rings) {
      placement.remove(ring)
      ring.geometry.dispose()
      ;(ring.material as THREE.Material).dispose()
    }
    rings = []
    ringsFor = ''
  }

  function renderRings(view: ReturnVisitView): void {
    const landmark = view.landmark
    const wanted = visit !== null
      && radii.length > 0
      && landmark !== null
      && (view.stage === 'heading' || view.stage === 'check' || view.stage === 'review' || view.stage === 'mismatch')
    if (!wanted) {
      clearRings()
      return
    }
    // The placement group exists once the provider has a scene; the next draw tries again until it does.
    if (!ensureScene()) return
    if (ringsFor !== radiiKey) {
      clearRings()
      rings = radii.map((radius) => buildDistanceRing(radius))
      for (const ring of rings) placement.add(ring)
      ringsFor = radiiKey
    }
    for (const ring of rings) {
      if (ring.position.x !== landmark.x || ring.position.y !== landmark.y || ring.position.z !== landmark.z) {
        ring.position.set(landmark.x, landmark.y, landmark.z)
      }
    }
  }

  // ── Both photos ────────────────────────────────────────────────────────────────────────────────────

  function positionCrosshair(slot: Slot): void {
    if (!slot.photo || !slot.img || !slot.cross) return
    const { left, top } = referenceCrosshairPixels(slot.photo.tapPoint, {
      width: slot.img.clientWidth,
      height: slot.img.clientHeight,
    })
    // The crosshair is in the figure's own space, and the picture is centred in it when it is held to less than the width.
    slot.cross.style.left = `${(slot.img.offsetLeft ?? 0) + left}px`
    slot.cross.style.top = `${(slot.img.offsetTop ?? 0) + top}px`
  }

  /** A slot with no picture says why in its place, and shows no figure: an empty frame would read as a photo of nothing. */
  function say(slot: Slot, state: 'none' | 'loading' | 'failed'): void {
    if (slot.figure) slot.figure.hidden = true
    if (!slot.note) return
    slot.note.textContent = compareNote(state, slot.photo !== null && slot.photo.url !== null)
    slot.note.hidden = false
  }

  function loadSlot(slot: Slot): void {
    const photo = slot.photo
    const load = options.loadReferencePhoto
    if (!photo || !load) {
      slot.state = photo ? 'failed' : 'none'
      say(slot, slot.state)
      return
    }
    slot.state = 'loading'
    say(slot, 'loading')
    // A loader that throws before it returns a promise is a loader that failed, as one that rejects is.
    void Promise.resolve()
      .then(() => load(photo))
      .catch(() => null)
      .then((src) => {
        if (disposed) {
          // The modal has gone: a blob nobody will show is released here, and not left to leak.
          if (src && src.startsWith('blob:')) URL.revokeObjectURL(src)
          return
        }
        if (!src || !slot.img || !slot.figure) {
          slot.state = 'failed'
          say(slot, 'failed')
          return
        }
        if (src.startsWith('blob:')) objectUrls.push(src)
        slot.img.onload = () => positionCrosshair(slot)
        slot.img.src = src
        slot.figure.hidden = false
        if (slot.note) slot.note.hidden = true
        slot.state = 'shown'
        positionCrosshair(slot)
      })
  }

  /** The room above the card for the panel, now, or null when it cannot be measured or the card is not under it. */
  function roomAbove(): number | null {
    const cardBox = card?.getBoundingClientRect?.()
    const panelBox = compare?.getBoundingClientRect?.()
    return cardBox && panelBox ? roomAboveCard(cardBox, panelBox) : null
  }

  function renderCompare(view: ReturnVisitView): void {
    if (!compare) return
    const wanted = visit !== null && hasPhoto && (view.stage === 'review' || view.stage === 'mismatch')
    compare.hidden = !wanted
    if (!wanted) return
    // Measured with the panel showing, on every draw: the card grows and shrinks with its copy and the screen with its
    // toolbars, and the panel's own top is where the stylesheet puts it, whatever its height.
    const room = roomAbove()
    if (room !== null && room < COMPARE_MIN_ROOM_PX) {
      compare.hidden = true
      return
    }
    for (const slot of slots) {
      if (slot.state === 'idle') loadSlot(slot)
      if (slot.img?.style) slot.img.style.maxHeight = room === null ? '' : `${Math.floor(room - COMPARE_CHROME_PX)}px`
      if (slot.state === 'shown') positionCrosshair(slot)
    }
  }

  /** Draws one of the aids; one that cannot be drawn is said once on the console and never keeps the card from the rest. */
  function guarded(what: string, draw: () => void): void {
    try {
      draw()
    } catch (error) {
      if (warned.has(what)) return
      warned.add(what)
      console.warn(`[return-visit-aids] ${what} could not be drawn`, error)
    }
  }

  return {
    landmarkCopy: () => (visit ? returnLandmarkCopy(options.shownPhoto() === 'landmark', totalSteps) : null),
    headingCopy: () =>
      visit
        ? returnHeadingCopy(visit, options.shownPhoto() === 'headingMarker', rings.length > 0 && ringIsTheStoredDistance, totalSteps)
        : null,
    statusLine: (base) => (chipState === 'fail' ? NOT_STORED_DISTANCE_STATUS : base),
    render(view) {
      if (disposed) return
      guarded('the distance chip', () => renderChip(view))
      guarded('the distance rings', () => renderRings(view))
      guarded('the stored photos', () => renderCompare(view))
    },
    dispose() {
      disposed = true
      clearRings()
      objectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url))
    },
  }
}
