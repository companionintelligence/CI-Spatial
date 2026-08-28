/**
 * The status line (`#status-text`) reports *events*; the HUD around it reports
 * *state*. Two writers on one node with no priority meant state always won,
 * because state is written on a timer and events are written once.
 *
 * Concretely: the room scanner ticks every 750 ms (`DEFAULT_INTERVAL_MS` in
 * ../ar/scanner.ts) and each tick wrote the line unconditionally, so every
 * message the capture path produced — the typed inference-error ladder,
 * "Camera access denied", the boot's `AI: WebGPU` — was painted over before it
 * could be read. Observed on a real device: tapping Capture looked like the
 * button did nothing at all.
 *
 * The structural fix is to keep per-tick state off this node entirely (see
 * `#verdict-hint` and `#quality-motion-hint` in index.html). This module is the
 * belt to that pair of braces: a `'sticky'` write owns the line for
 * STATUS_HOLD_MS, and an ordinary write during that window is dropped rather
 * than queued — a stale tick has nothing worth saying later.
 *
 * Hold state is keyed on the element, not on a writer, because both writers
 * (`AROverlay` and main.ts's `setupStatusOverlay()` shim) target the same node
 * and `setupStatusOverlay()` returns a fresh object per call.
 */

/** How long a sticky message owns the status line, in ms. */
export const STATUS_HOLD_MS = 4_000

/**
 * `'sticky'` — an event the user asked for and must be able to read: a capture
 * result or a capture failure. Always writes, and holds the line.
 * `'normal'` — everything else. Skipped while a sticky message still holds.
 *
 * Reach for `'sticky'` sparingly, and never for a message another writer is
 * about to refine. `InferenceRouter._onWorkerFailure` is the shape to avoid:
 * it reports the mode change and then the reason for it, so holding the first
 * would swallow the one worth reading.
 */
export type StatusPriority = 'normal' | 'sticky'

/**
 * Only the two members this module touches, so the hold logic is testable
 * without a DOM. `HTMLElement` satisfies it.
 */
export interface StatusNode {
  textContent: string | null
}

const holdUntil = new WeakMap<StatusNode, number>()

/**
 * Write `text` to a status node, honouring any hold in effect.
 *
 * Null-tolerant: callers reach the node with `getElementById` and the scanner
 * runs on pages that may not have one.
 *
 * `holdMs` exists so the expiry is testable in milliseconds rather than in the
 * four real seconds the default costs — the app always takes the default.
 */
export function writeStatus(
  el: StatusNode | null,
  text: string,
  priority: StatusPriority = 'normal',
  holdMs: number = STATUS_HOLD_MS,
): void {
  if (!el) return

  const now = performance.now()
  if (priority === 'normal') {
    const until = holdUntil.get(el)
    if (until !== undefined && now < until) return
    holdUntil.delete(el)
  } else {
    // A later sticky message supersedes an earlier one and re-arms the hold:
    // the capture path writes a sequence ("Analysing…" → a result or an error)
    // and each step is the one worth reading until the next arrives.
    holdUntil.set(el, now + holdMs)
  }

  el.textContent = text
}

/** Test/diagnostic hook: is a sticky message currently holding this node? */
export function statusIsHeld(el: StatusNode | null): boolean {
  if (!el) return false
  const until = holdUntil.get(el)
  return until !== undefined && performance.now() < until
}
