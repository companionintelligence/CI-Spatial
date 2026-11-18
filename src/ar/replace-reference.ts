/**
 * The calibration modal's Place-reference hooks, and the confirmation that stands between a person and replacing
 * a Place's reference (WP-08).
 *
 * `./project-calibration.ts` is the shell: its stages, its card, its markers. It knows nothing about the server
 * and builds no dialog of its own. What it needs for the generation policy comes in on one optional object,
 * {@link GenerationHooks}, supplied by the page that runs it (src/main.ts, through ./calibration-run.ts), so a run of the
 * modal without one behaves as it did before this package. The words are ./replace-copy.ts's; this file is the DOM around
 * them.
 *
 * "Wrong Place? Choose another" is not here: its button and its `onWrongPlace` option are the return-visit package's (WP-07),
 * and what the page does when it is pressed (open the Place picker, run the modal again) is ./calibration-run.ts's.
 *
 * ## The confirmation
 *
 * Opens over the modal's own card, in the card's own style (it is a `.project-calibration-card`, so no page style
 * had to be added), and hides that card until it is answered. It asks the server how many scans were made against
 * the reference being replaced (`fetchStatus`) and says "Checking which scans use it…" while it waits, with the
 * confirm button off: no button is live before the count is. When scans are tied to the reference, or the count
 * could not be read, the confirm button stays off until the person types the word. Cancel, and the Escape key,
 * give the card back and answer false.
 *
 * Every piece of text goes in with `textContent`. Nothing here is built from a record.
 */
import { affectedScans, type AffectedScans, type GenerationMode, type ReferenceStatus } from '../world/frame-replacement.ts'
import type { ProjectSpatialFrame } from '../world/types'
import type { CalibrationStage } from './one-point-offer.ts'
import { replaceCopy, typedWordMatches, type ReplaceReason } from './replace-copy.ts'

/** What the confirmation is asked about. */
export interface ReplaceAsk {
  reason: ReplaceReason
  /** The pair's spacing as placed minus the recorded one, in metres, for `'override'`. */
  residualM?: number
}

/**
 * What the calibration modal takes from its host for the Place-reference policy. Every member is optional and a
 * modal given none does what it always did.
 */
export interface GenerationHooks {
  /**
   * `'upgrade'`: the modal is running as a first calibration over a Place that already has a reference, to replace
   * it. The one-point tier is not offered then (it would replace a two-point reference with a weaker one).
   */
  mode?: GenerationMode
  /** Whether "Improve this Place's reference" is offered for the frame the Place holds. Absent: never. */
  canImprove?: (stored: ProjectSpatialFrame | undefined) => boolean
  /** Asks before the reference is replaced. Resolves true to go on, false to keep the saved one. */
  confirmReplace?: (host: HTMLElement, ask: ReplaceAsk) => Promise<boolean>
  /** The person confirmed an improve: the modal closes without a result right after, and the page runs it again as an upgrade. */
  onImprove?: () => void
  /** The person gave up an upgrade: the modal closes without a result right after, and the page runs it again as an ordinary visit. */
  onKeepReference?: () => void
}

export interface ReplaceDeps {
  /** The server's account of the Place's reference. Null when it could not be read. */
  fetchStatus: () => Promise<ReferenceStatus | null>
  /** Whether the browser knows it is offline. Default: `navigator.onLine === false`. */
  offline?: () => boolean
}

/**
 * The safe answer is the promoted button and the one that replaces the reference is a plain link, as it is on the mismatch screen
 * the person came from: the question does not make the destructive answer the one the eye goes to.
 */
const TEMPLATE = `
  <div class="project-calibration-eyebrow">Place reference</div>
  <h2 id="frame-replace-title"></h2>
  <p id="frame-replace-reason"></p>
  <p id="frame-replace-scans" aria-live="polite"></p>
  <p id="frame-replace-offline" hidden></p>
  <label id="frame-replace-typed-field" class="project-calibration-label-field" hidden>
    <span id="frame-replace-typed-label"></span>
    <input id="frame-replace-typed" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" />
  </label>
  <div class="project-calibration-actions">
    <button id="frame-replace-confirm" type="button" class="project-calibration-link" disabled></button>
    <button id="frame-replace-cancel" type="button" class="project-calibration-link project-calibration-link-promoted"></button>
  </div>`

/** The dialogs that are open, by the element they are in: asking again while one is open gets the same answer. */
const open = new WeakMap<object, Promise<boolean>>()

function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/**
 * Asks whether to replace the Place's reference, inside `host`. Resolves true only when the person confirmed, with the
 * typed word where one is needed. Never rejects.
 */
export function askToReplaceReference(host: HTMLElement, ask: ReplaceAsk, deps: ReplaceDeps): Promise<boolean> {
  const already = open.get(host)
  if (already) return already

  const answered = new Promise<boolean>((resolve) => {
    const dialog = document.createElement('div')
    dialog.className = 'project-calibration-card'
    dialog.setAttribute('role', 'alertdialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'frame-replace-title')
    dialog.setAttribute('aria-describedby', 'frame-replace-reason frame-replace-scans')
    dialog.innerHTML = TEMPLATE
    const pick = <T extends HTMLElement>(id: string) => dialog.querySelector<T>(`#${id}`)!
    const title = pick('frame-replace-title')
    const reason = pick('frame-replace-reason')
    const scans = pick('frame-replace-scans')
    const offlineLine = pick('frame-replace-offline')
    const typedField = pick('frame-replace-typed-field')
    const typedLabel = pick('frame-replace-typed-label')
    const typed = pick<HTMLInputElement>('frame-replace-typed')
    const confirm = pick<HTMLButtonElement>('frame-replace-confirm')
    const cancel = pick<HTMLButtonElement>('frame-replace-cancel')

    // Where focus was when the question was asked (the button that asked it). It goes back there when the question is answered, so a
    // keyboard or screen-reader person is not left on the page body, which is where focus falls when the dialog is removed.
    const opener = document.activeElement as HTMLElement | null | undefined
    // The modal's own card is put away while the question is open, and given back when it is answered.
    const card = host.querySelector<HTMLElement>('.project-calibration-card')
    const cardWasHidden = card ? card.hidden : false
    if (card) card.hidden = true
    host.appendChild(dialog)

    let affected: AffectedScans | 'checking' = 'checking'
    let finished = false

    const render = (): void => {
      const copy = replaceCopy({
        reason: ask.reason,
        affected,
        residualM: ask.residualM,
        offline: (deps.offline ?? browserOffline)(),
      })
      title.textContent = copy.title
      reason.textContent = copy.reasonLine
      scans.textContent = copy.scanLine
      offlineLine.textContent = copy.offlineLine ?? ''
      offlineLine.hidden = copy.offlineLine === null
      typedLabel.textContent = copy.typedLabel
      typedField.hidden = !copy.typed
      confirm.textContent = copy.confirm
      cancel.textContent = copy.cancel
      confirm.disabled = affected === 'checking' || (copy.typed && !typedWordMatches(typed.value))
    }

    const finish = (answer: boolean): void => {
      if (finished) return
      finished = true
      dialog.remove()
      // The card first: focus cannot go to a button inside a card that is still hidden.
      if (card) card.hidden = cardWasHidden
      opener?.focus?.()
      open.delete(host)
      resolve(answer)
    }

    typed.addEventListener('input', render)
    confirm.addEventListener('click', () => {
      if (!confirm.disabled) finish(true)
    })
    cancel.addEventListener('click', () => finish(false))
    dialog.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') finish(false)
    })

    render()
    // Keyboard and screen-reader focus starts on the safe answer, not on the button that replaces the reference.
    cancel.focus?.()
    void Promise.resolve().then(deps.fetchStatus).catch(() => null).then((status) => {
      if (finished) return
      affected = affectedScans(status)
      render()
      if (!typedField.hidden) typed.focus?.()
    })
  })

  open.set(host, answered)
  return answered
}

// ── What the modal asks of the hooks ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether "Improve this Place's reference" shows: before anything is placed, on the frame the Place holds, when the page
 * says that frame can be improved. Not once a pair is on the floor: a visit that is under way is not turned into a
 * new reference by a stray tap.
 */
export function improveShown(
  hooks: GenerationHooks | undefined,
  now: { stage: CalibrationStage; hasLandmark: boolean; stored: ProjectSpatialFrame | undefined },
): boolean {
  return now.stage === 'landmark' && !now.hasLandmark && hooks?.canImprove?.(now.stored) === true
}

/** Whether the modal is an upgrade: it runs as a first calibration over a reference it is about to replace. */
export function isUpgrade(hooks: GenerationHooks | undefined): boolean {
  return hooks?.mode === 'upgrade'
}

/**
 * Whether "Keep the saved reference" shows: inside an upgrade, at every stage. An upgrade is a first calibration over a Place
 * that has a reference, and a person who starts one and gives up has no ordinary visit to go back to without it: the modal has
 * no stored frame to compare their points with. This is the way back.
 */
export function keepShown(hooks: GenerationHooks | undefined): boolean {
  return isUpgrade(hooks) && hooks?.onKeepReference !== undefined
}

/** What the modal gives the actions: its own state and the two things only it can do. */
export interface ShellSeam {
  /** The modal's own element, which the confirmation opens inside. */
  overlay: HTMLElement
  /** The frame the Place holds. A Place with none has nothing to replace, and a click on "Replace" then asks nothing. */
  stored: ProjectSpatialFrame | undefined
  stage: () => CalibrationStage
  hasLandmark: () => boolean
  /** The recorded pair's spacing subtracted from the placed pair's, for the reason line. */
  residualM: () => number
  /**
   * Whether keeping the placed pair replaces the Place's reference. It does unless the commit cannot write one: the floor check was
   * bypassed (`mayWritePlaceFrame`, ./ground-gate.ts). Read when "Replace" is pressed, so it is the rule the button's own label is
   * drawn by. When it does not, the pair is kept and nothing is asked: the question promises what becomes of the scans made against a
   * reference that is being replaced. Absent: it replaces, as it did before there was a bypass.
   */
  replacesReference?: () => boolean
  /** Keeps the placed pair over the mismatch, as the modal always did. */
  keepPair: () => Promise<void>
  /** Closes the modal without a result. */
  close: () => void
}

export interface GenerationActions {
  replace: () => Promise<void>
  improve: () => Promise<void>
  keep: () => void
}

/**
 * The three clicks, in the order their questions are asked. Each is guarded by the rule that shows its button, so a click that
 * reaches a hidden button (a script, or a later caller) is refused by the rule and not only by the paint.
 *
 *  - Replace: asks first, when the Place has a reference to replace, keeping the pair replaces it, and the page supplies the
 *    question, then keeps the pair. With no question it keeps the pair, as before. A pair kept with the floor check bypassed
 *    replaces nothing (`replacesReference`), so it is kept with no question.
 *  - Improve: asks, and only on a yes tells the page and closes. The page runs the modal again as an upgrade.
 *  - Keep: inside an upgrade, tells the page and closes. The page runs the modal again as an ordinary visit.
 */
export function generationActions(hooks: GenerationHooks | undefined, shell: ShellSeam): GenerationActions {
  // One answer at a time: a second click while the question is open or the pair is being kept is the same decision, and
  // must not keep the pair twice (which would drop a second set of markers into the scene).
  let deciding = false
  const once = async (decide: () => Promise<void>): Promise<void> => {
    if (deciding) return
    deciding = true
    try {
      await decide()
    } finally {
      deciding = false
    }
  }
  return {
    replace: () => once(async () => {
      const ask = hooks?.confirmReplace
      // The question is about replacing the reference. A pair kept without writing a frame replaces nothing, and asking would promise
      // that the scans made against the reference "stay in the Place, listed as previous reference" when no reference was replaced.
      if (ask && shell.stored && (shell.replacesReference?.() ?? true) && !(await ask(shell.overlay, { reason: 'override', residualM: shell.residualM() }))) return
      await shell.keepPair()
    }),
    improve: () => once(async () => {
      const shown = improveShown(hooks, { stage: shell.stage(), hasLandmark: shell.hasLandmark(), stored: shell.stored })
      if (!shown || !hooks?.onImprove) return
      if (hooks.confirmReplace && !(await hooks.confirmReplace(shell.overlay, { reason: 'upgrade' }))) return
      hooks.onImprove()
      shell.close()
    }),
    keep() {
      if (!keepShown(hooks) || !hooks?.onKeepReference) return
      hooks.onKeepReference()
      shell.close()
    },
  }
}
