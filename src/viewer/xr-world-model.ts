/**
 * Pure model for the headset world editor (xr-world.html).
 *
 * No DOM and no three.js. The page (src/viewer/xr-world.ts) owns the scene and the
 * controllers; this file owns the decisions it makes with them: which label a
 * thumbstick flick lands on, how one stick push counts, where a gripped marker goes,
 * and which world a page opens. Kept apart so those rules run under node --test.
 *
 * LABEL_CHOICES is the headset's short list, drawn from SEMANTIC_TAGS in
 * src/viewer/editor.ts (the tags the desktop editor already labels things with).
 * `other` is the fallback for anything else.
 *
 * Run: npm run test:xr-world-model
 */
import type { Vec3 } from '../world/types.ts'

export const LABEL_CHOICES: readonly string[] = [
  'chair', 'table', 'sofa', 'bed', 'lamp', 'tv', 'shelf', 'desk', 'plant', 'door', 'window', 'other',
]

function modulo(n: number, m: number): number {
  return ((n % m) + m) % m
}

/**
 * The label `step` places along LABEL_CHOICES from `current`, wrapping at both ends.
 * A label outside the list counts as sitting just before the first choice (a forward
 * step lands on the first) or just after the last (a backward step lands on the last).
 */
export function cycleLabel(current: string, step: number): string {
  const count = LABEL_CHOICES.length
  const found = LABEL_CHOICES.indexOf(current)
  const from = found >= 0 ? found : step < 0 ? count : -1
  return LABEL_CHOICES[modulo(from + Math.trunc(step), count)]
}

/** `position` moved by `delta`, as a new object. Neither argument is changed. */
export function moveThing(position: Vec3, delta: Vec3): Vec3 {
  return { x: position.x + delta.x, y: position.y + delta.y, z: position.z + delta.z }
}

/** Past this, a stick is pushed. Between the two thresholds the last state holds. */
export const STICK_PUSH = 0.6
/** Below this, the stick has come back to rest and may push again. */
export const STICK_RELEASE = 0.3

export type StickLatch = 'neutral' | 'up' | 'down'

export interface StickStep {
  /** -1 or 1 for one label step, 0 for none. */
  step: -1 | 0 | 1
  latch: StickLatch
}

/**
 * One thumbstick reading to at most one label step. `y` is gamepad axes[3]: negative
 * is the stick pushed up (forward), positive is pushed down. A push fires once, and
 * must come back below STICK_RELEASE before it can fire again, so holding the stick
 * does not run through the whole list.
 */
export function thumbstickStep(y: number, latch: StickLatch): StickStep {
  if (y <= -STICK_PUSH) return latch === 'up' ? { step: 0, latch } : { step: 1, latch: 'up' }
  if (y >= STICK_PUSH) return latch === 'down' ? { step: 0, latch } : { step: -1, latch: 'down' }
  if (Math.abs(y) < STICK_RELEASE) return { step: 0, latch: 'neutral' }
  return { step: 0, latch }
}

/**
 * The world a page opens, by the desktop viewer's rule (src/viewer/viewer.ts): `?world=`
 * if given, else the Place's own world for `?project=`, else `default`.
 */
export function worldSlugFrom(search: string): string {
  const query = new URLSearchParams(search)
  const project = query.get('project')
  return query.get('world') || (project ? `project-${project}` : 'default')
}
