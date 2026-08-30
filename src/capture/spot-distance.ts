/**
 * One measured length, typed by a person standing in a room.
 *
 * A tripod capture reconstructs a room that is an exact *similarity* of the
 * real one — right shape, no idea how big. One physically measured distance
 * between two of the spots the tripod stood on fixes that, and only that: it
 * determines size, and says nothing about which way the room faces or where its
 * origin is (server/capture/known_distance.ts publishes exactly those four
 * facts). So the whole capture-side job is to get ONE number, in metres, that
 * is actually right.
 *
 * ## Why this file exists rather than an `<input type="number">`
 *
 * The number being wrong by a unit is undetectable downstream. A distance given
 * in feet is accepted and is wrong by 3.28x, and nothing in the arithmetic can
 * tell — a room 3.28x too big is a perfectly self-consistent room. It would
 * come back as a plausible, confidently wrong set of dimensions, which is worse
 * than no dimensions at all. Nothing after this point can catch it, so it has
 * to be caught here, by the person who is holding the tape.
 *
 * Three defences, in the order they act:
 *
 *  1. There is no unit to choose. The reading is entered as metres AND
 *     centimetres in two boxes, each permanently labelled — a person cannot
 *     omit the unit, and there is no selector to leave on the wrong setting.
 *  2. A reading in centimetres above 99 is refused and restated ("340 cm is
 *     3 m 40 cm"), because the refusal is the only moment the metre/centimetre
 *     structure gets taught.
 *  3. The echo reads the number BACK in feet and inches. This is the one
 *     defence that actually catches the feet case: someone who measured 11 ft
 *     and typed 11 into the metres box is shown "about 36 ft" and knows
 *     immediately. A range check cannot do this — 11 m is a perfectly ordinary
 *     distance across a room.
 *
 * Register: metres, centimetres, feet, spots. Nothing about what the number is
 * for beyond "it is what gives the room its size".
 */

/**
 * Below this the two spots were not meaningfully apart.
 *
 * Half a metre is under one step, and the tripod is carried "a few steps"
 * between spots — so a reading under it is a mistyped number, not a capture
 * worth sizing from.
 */
export const SPOT_DISTANCE_MIN_M = 0.5

/**
 * Above this it is not two spots in a room.
 *
 * 25 m is generous — it is a long hallway, not a living room — because this is
 * a typo guard, not a judgement about the capture. It does NOT catch a reading
 * in feet: 11 ft typed as 11 m sails through, which is what the feet echo is
 * for.
 */
export const SPOT_DISTANCE_MAX_M = 25

/** Centimetres in a metre. The second box runs 0…99, and the refusal says so. */
const CM_PER_M = 100

/** Exact, by definition of the international foot. */
const M_PER_FOOT = 0.3048

export interface SpotDistanceOk {
  ok: true
  /** The reading, in metres. The only number anything downstream is given. */
  metres: number
  /** '3 m 40 cm' — the reading as entered, restated. */
  reading: string
  /** 'about 11 ft 2 in' — the same length in the unit that would be wrong. */
  inFeet: string
}

export interface SpotDistanceRefusal {
  ok: false
  /** One sentence, in the words of someone holding a tape measure. */
  reason: string
  /** True when nothing has been typed yet — a prompt, not a complaint. */
  empty: boolean
}

export type SpotDistanceReading = SpotDistanceOk | SpotDistanceRefusal

/** '' / '  ' → null; anything not a plain non-negative number → NaN. */
function readBox(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return Number.NaN
  return Number(trimmed)
}

/** '3 m 40 cm', '3 m', '40 cm' — never a bare number. */
export function formatSpotDistance(metres: number): string {
  const totalCm = Math.round(metres * CM_PER_M)
  const whole = Math.floor(totalCm / CM_PER_M)
  const cm = totalCm % CM_PER_M
  if (whole === 0) return `${cm} cm`
  if (cm === 0) return `${whole} m`
  return `${whole} m ${cm} cm`
}

/**
 * The same length in feet and inches.
 *
 * Shown next to every accepted reading, because it is the only check a person
 * can actually perform against the tape in their hand. "about" is honest: this
 * is a cross-check to recognise, not a conversion to rely on.
 */
export function spotDistanceInFeet(metres: number): string {
  const totalInches = Math.round((metres / M_PER_FOOT) * 12)
  const feet = Math.floor(totalInches / 12)
  const inches = totalInches % 12
  if (feet === 0) return `about ${inches} in`
  if (inches === 0) return `about ${feet} ft`
  return `about ${feet} ft ${inches} in`
}

/**
 * Read the two boxes.
 *
 * Every refusal names what to do about it. `empty` separates "you have not
 * typed anything yet" from "what you typed is wrong", so the screen can show a
 * prompt before the first keystroke instead of an error.
 */
export function readSpotDistance(metresText: string, centimetresText: string): SpotDistanceReading {
  const m = readBox(metresText)
  const cm = readBox(centimetresText)

  if (m === null && cm === null) {
    return { ok: false, empty: true, reason: 'Type how far apart the two spots were.' }
  }
  if (Number.isNaN(m) || Number.isNaN(cm)) {
    return { ok: false, empty: false, reason: 'Numbers only — whole metres in the first box, centimetres in the second.' }
  }

  const metres = m ?? 0
  const centimetres = cm ?? 0

  // Restated rather than rejected outright: someone who has read "340" off a
  // tape is not wrong about the length, only about which box it goes in, and
  // this is the one moment the two-box shape can be taught.
  if (centimetres >= CM_PER_M) {
    return {
      ok: false,
      empty: false,
      reason: `Centimetres go up to 99. ${centimetres} cm is ${formatSpotDistance(centimetres / CM_PER_M)} — put it in that way.`,
    }
  }
  if (!Number.isInteger(centimetres)) {
    return { ok: false, empty: false, reason: 'Centimetres are whole numbers — round to the nearest one.' }
  }

  const total = metres + centimetres / CM_PER_M
  if (total < SPOT_DISTANCE_MIN_M) {
    return {
      ok: false,
      empty: false,
      reason: `${formatSpotDistance(total)} is closer than one step. The two spots were further apart than that — check the reading.`,
    }
  }
  if (total > SPOT_DISTANCE_MAX_M) {
    return {
      ok: false,
      empty: false,
      reason: `${formatSpotDistance(total)} is further apart than a room. Check the reading — this box takes metres, not feet.`,
    }
  }

  return {
    ok: true,
    metres: Math.round(total * CM_PER_M) / CM_PER_M,
    reading: formatSpotDistance(total),
    inFeet: spotDistanceInFeet(total),
  }
}

/**
 * The line under an accepted reading: what was entered, and what it is in feet.
 *
 * Both halves are load-bearing. The first confirms the number; the second is
 * the feet cross-check, and it is phrased as a question the person can answer
 * by looking down at the tape rather than as a warning they will skim.
 */
export function spotDistanceEcho(reading: SpotDistanceOk): string {
  return `${reading.reading} — ${reading.inFeet}. If your tape does not say that, it is reading feet.`
}
