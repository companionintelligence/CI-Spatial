/**
 * The budget for "words before the camera", and the one rule for counting them.
 *
 * Shared because two readers need the same number and would otherwise drift
 * apart: tests/mock-scanner-startup-budget.spec.ts measures the screen a real
 * browser paints under `?mock=xr8`, and tests/unit/node/startup_word_budget.test.ts
 * proves the same ceiling holds on every OTHER screen this app can produce —
 * all 72 subject x device combinations `resolveCapture()` is total over,
 * including the ones no mock can reach (a phone that advertises a live capture
 * it cannot run, an insecure page). Neither covers the other: the browser one
 * is the only one that measures what is actually rendered, the node one is the
 * only one that measures the worst case.
 *
 * ## Why the ceiling moved
 *
 * It was 120, and the start screen had grown past it — 140 measured under the
 * mock, because `renderCaptureChoice()` unhid every capture method the device
 * could run, so the recommendation arrived with up to two ~25-word
 * alternatives already open beside it. The un-recommended methods were the
 * whole overrun and the recommendation was never the problem, which is what
 * the test of that name in the node suite states.
 *
 * Putting them behind a disclosure (`#start-alt-toggle`) rather than cutting
 * copy is what brought it down, and it had to be that way round: each card's
 * second sentence carries what its path does NOT give you — "size is not
 * measured", "nothing catalogued" — and tests/unit/node/capture_intent.test.ts
 * pins those clauses to every scale-free path. A word budget met by deleting
 * the sentence that says a capture has no real-world size would be met by
 * making the screen lie.
 *
 * Measured after the disclosure landed (2026-08-30):
 *
 *   | screen                                          | before | after |
 *   | ----------------------------------------------- | ------ | ----- |
 *   | `?mock=xr8`, subject room                        |   140  |    92 |
 *   | worst case (room/building, live advertised only) |   151* |   103 |
 *
 *   * 153 with the disclosure's own two words, which that screen did not have.
 *
 * The ceiling sits just above the worst case, not above the convenient one —
 * the same rule the rest of the budget spec follows, and the reason it is 110
 * rather than 100.
 */

/**
 * Total words a first-run visitor reads before the camera: the onboarding
 * bodies plus everything rendered on `#start-screen`.
 *
 * A ceiling, not a target. Raising it is a design decision about what someone
 * standing in a room is asked to read, so it is a deliberate edit here rather
 * than a number quietly restated at two call sites.
 */
export const WORDS_BEFORE_CAMERA_MAX = 110

/**
 * Words in a run of rendered text, ignoring collapsed whitespace.
 *
 * The Playwright spec cannot call this — its counting happens inside
 * `page.evaluate()`, in the browser, where nothing from this module exists —
 * so it keeps a copy of the split. The rule is the same one in both places and
 * has to stay that way, or the two "totals" above stop being comparable.
 */
export function countWords(text: string | null | undefined): number {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length
}
