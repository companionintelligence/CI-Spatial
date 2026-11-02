/**
 * A text field under the on-screen keyboard is one the visitor cannot read or
 * reach, and it is most of what phone visitors report about typing.
 *
 * The two browsers disagree about what the keyboard does. iOS Safari keeps the
 * layout viewport at full height and shrinks only the visual viewport, so a
 * fixed dialog sized to the screen keeps its bottom under the keyboard. Android
 * Chrome shrinks the layout viewport instead (index.html asks for that with
 * `interactive-widget=resizes-content`). This makes the two match. It publishes
 * the visible height and top as `--vv-h` and `--vv-top` on <html>, which the
 * place sheet, the place popups and the history drawer size themselves to, and
 * it brings the field being typed in back on screen once the keyboard has
 * opened or changed height.
 */

/** Text-entry controls. Checkboxes, ranges and file pickers take no keyboard. */
const TEXT_ENTRY =
  'input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="color"], [type="button"], [type="submit"], [type="reset"], [type="image"], [type="hidden"]), textarea, select'

/** The keyboard takes a few hundred milliseconds to slide up. */
const KEYBOARD_SETTLE_MS = 300

export function installKeyboardAvoidance(win: Window = window, doc: Document = document): void {
  const root = doc.documentElement
  const visual = win.visualViewport

  const publish = (): void => {
    const height = visual ? visual.height : win.innerHeight
    const top = visual ? visual.offsetTop : 0
    root.style.setProperty('--vv-h', `${Math.round(height)}px`)
    root.style.setProperty('--vv-top', `${Math.round(top)}px`)
  }

  const focusedField = (): HTMLElement | null => {
    const active = doc.activeElement
    return active instanceof HTMLElement && active.matches(TEXT_ENTRY) ? active : null
  }

  const reveal = (field: HTMLElement): void => {
    field.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  publish()
  win.addEventListener('resize', publish)
  visual?.addEventListener('scroll', publish)
  visual?.addEventListener('resize', () => {
    publish()
    // The keyboard opening or closing changes the height under a field that is
    // already focused, so the field is brought back on screen here as well.
    const field = focusedField()
    if (field) reveal(field)
  })

  doc.addEventListener('focusin', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.matches(TEXT_ENTRY)) return
    win.setTimeout(() => {
      if (doc.activeElement === target) reveal(target)
    }, KEYBOARD_SETTLE_MS)
  })
}
