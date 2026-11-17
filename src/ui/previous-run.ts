/**
 * What the person is told about objects that an earlier AR run saved.
 *
 * Pure, and kept out of main.ts and history.ts, which both say it, so the two cannot drift apart and the
 * copy can be tested without a DOM.
 *
 * An object keeps the position it had in the frame of the run that found it. A reload starts a new run with
 * a new origin, so that position means nothing in the new view: drawn, it would sit in the wrong place, and
 * exported, it would be filed under this run's calibration as if it had been found here. So an earlier
 * run's objects stay in the record and are shown in the history drawer only (`DetectionStore.isCurrentRun`
 * is the rule, owner decision D14). The copy says what the code did and nothing more: they are kept, and they
 * are not placed in this view and not sent.
 */

/** The history drawer's note on a row that an earlier run saved. */
export const PREVIOUS_RUN_LABEL = 'previous run, different frame'

/**
 * The status line after a reload that found `count` objects saved by an earlier run. Nothing about those
 * objects was resumed into the view, so it does not say "resumed".
 */
export function previousRunNotice(count: number): string {
  return `Earlier scan kept in History\n• ${count} object${count === 1 ? '' : 's'}, not shown or exported`
}

/**
 * The line under the side panel's "No objects yet": where a person who remembers objects looks for them.
 * The status line above is written before the start screen is gone and is overwritten within seconds, so
 * this is the one that stays.
 */
export function previousRunPanelNote(count: number): string {
  return `${count} object${count === 1 ? '' : 's'} from an earlier run ${count === 1 ? 'is' : 'are'} in History, not shown here.`
}
