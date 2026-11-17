/**
 * The screen half of the re-anchor flow (./reanchor-flow.ts): one banner that asks, and one control that starts a
 * drift check.
 *
 * The flow decides what is asked and what the words are; this file draws it and reports presses and canvas taps. It
 * keeps to the standard DOM (`createElement`, `appendChild`, `addEventListener`) so a small stand-in document can drive
 * it in a Node test, and the Playwright spec (tests/mock-reanchor.spec.ts) drives the real one.
 *
 * ## Where it sits, and why its styles are here
 *
 * The banner sits low on the screen, above the capture button, where the calibration card already asks its questions
 * (#project-calibration, index.html): a decision belongs where the person is already looking for one, and the HUD at the
 * top is sized against an occlusion budget that a second card would break. On a screen too short to leave room there, a
 * phone on its side, it goes down over the capture button, which turns a capture away while a choice is open. Its words
 * scroll when they are longer than the room it has, and its buttons stay in view. It takes pointer events itself and
 * nothing around it, so the camera behind stays tappable. Its rules, and the Check drift control's, are written into the page
 * by this file the first time it is used, instead of into index.html, which several packages are editing at once and
 * whose copy is held to a word budget (tests/unit/node/startup_word_budget.test.ts). Nothing here is part of the start
 * screen.
 *
 * ## Taps
 *
 * The flow asks for canvas taps only while a check is waiting for one and ignores the rest, so this file reports every
 * single-finger tap on the camera canvas and does not decide. A real touch fires `touchstart` and then `pointerdown`
 * for one tap, so `pointerdown` skips touch, as the calibration card's does (src/ar/project-calibration.ts). Neither
 * calls `preventDefault`: the tap is for whoever else is listening too.
 */
import type { Prompt, ReanchorView } from './reanchor-flow.ts'
import { CHECK_DRIFT_LABEL, CHECK_DRIFT_TITLE } from './reanchor-copy.ts'

export const BANNER_ID = 'reanchor-banner'
export const CHECK_BUTTON_ID = 'check-drift-btn'
export const STYLE_ID = 'reanchor-style'

/** The rules for the banner and the control. Colours are the calibration card's, so the two read as one family. */
export const REANCHOR_CSS = `
#${BANNER_ID} {
  position: fixed;
  z-index: 30;
  right: max(16px, env(safe-area-inset-right));
  bottom: calc(max(18px, env(safe-area-inset-bottom)) + 122px);
  left: max(16px, env(safe-area-inset-left));
  max-width: 390px;
  /* What the HUD above and the capture button below leave. The longer words scroll inside it and the buttons stay in view. */
  max-height: calc(100vh - 230px);
  max-height: calc(100dvh - 230px);
  display: flex;
  flex-direction: column;
  margin: auto;
  padding: 14px 16px;
  box-sizing: border-box;
  border: 1px solid rgba(255, 183, 77, 0.6);
  border-radius: 14px;
  background: rgba(5, 22, 31, 0.94);
  backdrop-filter: blur(16px);
  box-shadow: 0 16px 45px rgba(0, 0, 0, 0.42);
  color: #eff0f0;
  pointer-events: auto;
}
/* On a phone the action rail runs down the right edge (48 px and its gutter): the banner stops short of it, so the buttons
   under it stay in reach while a choice is open. */
@media (max-width: 520px) {
  #${BANNER_ID} { right: calc(max(16px, env(safe-area-inset-right)) + 62px); margin: 0; }
}
/* On a screen too short to leave room above the capture button, a phone on its side, the banner goes down over that button and
   takes the height that leaves. The button does nothing while a choice about the scan is open: a capture is turned away. */
@media (max-height: 520px) {
  #${BANNER_ID} {
    bottom: max(12px, env(safe-area-inset-bottom));
    max-height: calc(100vh - 100px);
    max-height: calc(100dvh - 100px);
  }
}
#${BANNER_ID}[hidden] { display: none; }
#${BANNER_ID} .reanchor-text { flex: none; margin: 0; font-size: 13px; font-weight: 700; line-height: 1.4; }
#${BANNER_ID} .reanchor-detail { flex: 0 1 auto; min-height: 0; overflow-y: auto; margin: 6px 0 0; color: rgba(239, 240, 240, 0.72); font-size: 12px; line-height: 1.45; }
#${BANNER_ID} .reanchor-detail[hidden] { display: none; }
#${BANNER_ID} .reanchor-actions { flex: none; display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-top: 12px; }
#${BANNER_ID} .reanchor-actions:empty { display: none; }
#${BANNER_ID} button {
  min-height: 44px;
  padding: 10px 14px;
  border: 0;
  background: transparent;
  color: rgba(239, 240, 240, 0.72);
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
#${BANNER_ID} button[data-primary='true'] {
  border: 1px solid rgba(114, 221, 212, 0.62);
  border-radius: 9px;
  background: rgba(114, 221, 212, 0.14);
  color: #72ddd4;
  font-weight: 700;
  text-decoration: none;
}
#${CHECK_BUTTON_ID} {
  position: fixed;
  z-index: 15;
  left: max(14px, env(safe-area-inset-left));
  bottom: calc(38px + 39px + env(safe-area-inset-bottom));
  transform: translateY(50%);
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid rgba(114, 221, 212, 0.7);
  border-radius: 16px;
  background: rgba(5, 22, 31, 0.72);
  backdrop-filter: blur(12px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
  color: #72ddd4;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  pointer-events: auto;
}
#${CHECK_BUTTON_ID}[hidden] { display: none; }
`

export interface ReanchorViewOptions {
  /** The camera canvas the person taps. */
  canvas: HTMLCanvasElement
  /** Defaults to the page's document. A test passes a stand-in. */
  doc?: Document
}

interface Parts {
  banner: HTMLElement
  text: HTMLElement
  detail: HTMLElement
  actions: HTMLElement
  check: HTMLElement
}

/**
 * The view the flow draws with. Nothing is added to the page until the flow first has something to show: a scan that is
 * never calibrated against a Place, which is most of them, pays no markup and no stylesheet for a flow it never uses.
 */
export function createReanchorView(options: ReanchorViewOptions): ReanchorView {
  const doc = options.doc ?? document
  const { canvas } = options
  let handlers: { check(): void; tap(x: number, y: number): void } | null = null
  let parts: Parts | null = null
  let buttons: HTMLElement[] = []

  const tapAt = (clientX: number, clientY: number): void => {
    const rect = canvas.getBoundingClientRect()
    // A zero-size canvas (mid-layout) would divide to NaN, which the flow's reader would take for a coordinate.
    if (!(rect.width > 0) || !(rect.height > 0)) return
    handlers?.tap((clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height)
  }

  function ensure(): Parts {
    if (parts) return parts
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement('style')
      style.id = STYLE_ID
      style.textContent = REANCHOR_CSS
      doc.head.appendChild(style)
    }

    const banner = doc.createElement('div')
    banner.id = BANNER_ID
    banner.setAttribute('role', 'alert')
    banner.hidden = true
    const text = doc.createElement('p')
    text.className = 'reanchor-text'
    const detail = doc.createElement('p')
    detail.className = 'reanchor-detail'
    detail.hidden = true
    const actions = doc.createElement('div')
    actions.className = 'reanchor-actions'
    banner.appendChild(text)
    banner.appendChild(detail)
    banner.appendChild(actions)
    doc.body.appendChild(banner)

    const check = doc.createElement('button')
    check.id = CHECK_BUTTON_ID
    check.setAttribute('type', 'button')
    check.setAttribute('title', CHECK_DRIFT_TITLE)
    check.setAttribute('aria-label', `${CHECK_DRIFT_LABEL}: ${CHECK_DRIFT_TITLE}`)
    check.textContent = CHECK_DRIFT_LABEL
    check.hidden = true
    check.addEventListener('click', () => handlers?.check())
    doc.body.appendChild(check)

    // One single-finger tap is `touchstart` and then `pointerdown`, so `pointerdown` skips touch, as the calibration
    // card's does (src/ar/project-calibration.ts). Neither calls `preventDefault`: the tap is for whoever else listens.
    canvas.addEventListener('touchstart', (event: TouchEvent) => {
      const touch = event.touches[0]
      if (event.touches.length !== 1 || !touch) return
      tapAt(touch.clientX, touch.clientY)
    }, { passive: true })
    canvas.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      tapAt(event.clientX, event.clientY)
    })

    parts = { banner, text, detail, actions, check }
    return parts
  }

  const clearActions = (): void => {
    for (const button of buttons) button.remove()
    buttons = []
  }

  return {
    showPrompt(prompt: Prompt): void {
      const { banner, text, detail, actions } = ensure()
      banner.setAttribute('data-kind', prompt.kind)
      banner.setAttribute('aria-busy', prompt.busy ? 'true' : 'false')
      text.textContent = prompt.text
      detail.textContent = prompt.detail ?? ''
      detail.hidden = !prompt.detail
      clearActions()
      for (const action of prompt.actions) {
        const button = doc.createElement('button')
        button.setAttribute('type', 'button')
        button.setAttribute('data-action', action.id)
        button.setAttribute('data-primary', action.primary ? 'true' : 'false')
        button.textContent = action.label
        button.addEventListener('click', () => action.run())
        actions.appendChild(button)
        buttons.push(button)
      }
      banner.hidden = false
    },
    hidePrompt(): void {
      if (!parts) return
      parts.banner.hidden = true
      clearActions()
    },
    setCheckButton(state: { visible: boolean }): void {
      if (!parts && !state.visible) return
      ensure().check.hidden = !state.visible
    },
    bind(next: { check(): void; tap(x: number, y: number): void }): void {
      handlers = next
    },
  }
}
