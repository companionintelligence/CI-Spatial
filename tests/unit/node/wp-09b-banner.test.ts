/**
 * The screen half of the re-anchor flow (WP-09b, src/ar/reanchor-banner.ts): one banner that asks, one control that
 * starts a drift check, and the canvas taps a check waits for.
 *
 * Driven against a small stand-in for the document (the standard calls the view makes and nothing else), as
 * wp-calibration-modal.test.ts does for the calibration card. What it cannot say is how the banner looks or whether a
 * thumb can reach a button: the Playwright spec tests/mock-reanchor.spec.ts runs the real one on a phone-sized screen.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-banner.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BANNER_ID,
  CHECK_BUTTON_ID,
  REANCHOR_CSS,
  STYLE_ID,
  createReanchorView,
} from '../../../src/ar/reanchor-banner.ts'
import type { Prompt } from '../../../src/ar/reanchor-flow.ts'

// ── A stand-in for the document ─────────────────────────────────────────────────────────────────────

type Listener = (event: unknown) => void

class FakeNode {
  readonly tag: string
  id = ''
  className = ''
  hidden = false
  textContent = ''
  children: FakeNode[] = []
  parent: FakeNode | null = null
  attributes = new Map<string, string>()
  listeners = new Map<string, Listener[]>()
  constructor(tag: string) {
    this.tag = tag
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  appendChild(child: FakeNode): FakeNode {
    child.parent = this
    this.children.push(child)
    return child
  }
  remove(): void {
    if (!this.parent) return
    this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  fire(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
  click(): void {
    this.fire('click')
  }
  find(predicate: (node: FakeNode) => boolean): FakeNode | null {
    if (predicate(this)) return this
    for (const child of this.children) {
      const found = child.find(predicate)
      if (found) return found
    }
    return null
  }
  all(predicate: (node: FakeNode) => boolean): FakeNode[] {
    return [...(predicate(this) ? [this] : []), ...this.children.flatMap((child) => child.all(predicate))]
  }
}

class FakeDocument {
  readonly head = new FakeNode('head')
  readonly body = new FakeNode('body')
  createElement(tag: string): FakeNode {
    return new FakeNode(tag)
  }
  getElementById(id: string): FakeNode | null {
    return this.head.find((node) => node.id === id) ?? this.body.find((node) => node.id === id)
  }
}

class FakeCanvas extends FakeNode {
  rect = { left: 10, top: 20, width: 400, height: 800 }
  constructor() {
    super('canvas')
  }
  getBoundingClientRect(): typeof this.rect {
    return this.rect
  }
}

function setup() {
  const doc = new FakeDocument()
  const canvas = new FakeCanvas()
  const taps: Array<[number, number]> = []
  let checks = 0
  const view = createReanchorView({ canvas: canvas as unknown as HTMLCanvasElement, doc: doc as unknown as Document })
  view.bind({ check: () => { checks++ }, tap: (x, y) => { taps.push([x, y]) } })
  return {
    doc,
    canvas,
    view,
    taps,
    checks: () => checks,
    banner: () => doc.getElementById(BANNER_ID),
    check: () => doc.getElementById(CHECK_BUTTON_ID),
    buttons: () => doc.getElementById(BANNER_ID)?.all((node) => node.tag === 'button') ?? [],
  }
}

const prompt = (over: Partial<Prompt> = {}): Prompt => ({
  kind: 'interruption',
  text: 'Tracking was interrupted. Parts of this scan may be shifted.',
  detail: 'Re-anchor saves this scan.',
  actions: [],
  ...over,
})

// ── Nothing until it is needed ──────────────────────────────────────────────────────────────────────

test('a view that has shown nothing has added nothing to the page: no markup, no stylesheet, no listener', () => {
  const s = setup()
  s.view.hidePrompt()
  s.view.setCheckButton({ visible: false })
  assert.equal(s.doc.body.children.length, 0)
  assert.equal(s.doc.head.children.length, 0)
  assert.equal(s.canvas.listeners.size, 0)
})

test('the first prompt builds the banner and the control hidden, injects the stylesheet once, and listens to the canvas', () => {
  const s = setup()
  s.view.showPrompt(prompt())
  assert.ok(s.banner())
  assert.ok(s.check())
  assert.equal(s.check()!.hidden, true, 'the control stays hidden until it is asked for')
  assert.equal(s.doc.head.children.length, 1)
  assert.equal(s.doc.head.children[0]!.id, STYLE_ID)
  assert.equal(s.doc.head.children[0]!.textContent, REANCHOR_CSS)
  assert.deepEqual([...s.canvas.listeners.keys()].sort(), ['pointerdown', 'touchstart'])
  s.view.showPrompt(prompt())
  s.view.hidePrompt()
  assert.equal(s.doc.head.children.length, 1, 'still one stylesheet')
  assert.equal(s.doc.body.children.length, 2, 'and one banner and one control')
})

test('a second view on the same page finds the stylesheet there and does not add another', () => {
  const s = setup()
  s.view.showPrompt(prompt())
  const again = createReanchorView({ canvas: s.canvas as unknown as HTMLCanvasElement, doc: s.doc as unknown as Document })
  again.showPrompt(prompt())
  assert.equal(s.doc.head.children.length, 1)
})

test('the control is built when it is first wanted, even before any prompt', () => {
  const s = setup()
  s.view.setCheckButton({ visible: true })
  assert.equal(s.check()?.hidden, false)
  s.view.setCheckButton({ visible: false })
  assert.equal(s.check()?.hidden, true)
})

// ── The banner ──────────────────────────────────────────────────────────────────────────────────────

test('a prompt writes its words and buttons, marks the primary one, and shows the banner as an alert', () => {
  const s = setup()
  const ran: string[] = []
  s.view.showPrompt(prompt({
    actions: [
      { id: 'reanchor', label: 'Re-anchor here', primary: true, run: () => ran.push('reanchor') },
      { id: 'keep', label: 'Keep going', run: () => ran.push('keep') },
    ],
  }))
  const banner = s.banner()!
  assert.equal(banner.hidden, false)
  assert.equal(banner.getAttribute('role'), 'alert')
  assert.equal(banner.getAttribute('data-kind'), 'interruption')
  assert.equal(banner.getAttribute('aria-busy'), 'false')
  assert.equal(banner.find((node) => node.className === 'reanchor-text')!.textContent, 'Tracking was interrupted. Parts of this scan may be shifted.')
  const detail = banner.find((node) => node.className === 'reanchor-detail')!
  assert.equal(detail.textContent, 'Re-anchor saves this scan.')
  assert.equal(detail.hidden, false)
  assert.deepEqual(s.buttons().map((button) => [button.textContent, button.getAttribute('data-primary'), button.getAttribute('type')]), [
    ['Re-anchor here', 'true', 'button'],
    ['Keep going', 'false', 'button'],
  ])
  s.buttons()[1]!.click()
  s.buttons()[0]!.click()
  assert.deepEqual(ran, ['keep', 'reanchor'])
})

test('a prompt with no detail hides the line, and a busy one says so', () => {
  const s = setup()
  s.view.showPrompt(prompt({ detail: undefined, busy: true }))
  const detail = s.banner()!.find((node) => node.className === 'reanchor-detail')!
  assert.equal(detail.hidden, true)
  assert.equal(detail.textContent, '')
  assert.equal(s.banner()!.getAttribute('aria-busy'), 'true')
})

test('a new prompt replaces the old one\'s buttons, and hiding takes them and the banner down', () => {
  const s = setup()
  s.view.showPrompt(prompt({ actions: [{ id: 'a', label: 'A', run: () => {} }, { id: 'b', label: 'B', run: () => {} }] }))
  s.view.showPrompt(prompt({ kind: 'closure', actions: [{ id: 'done', label: 'OK', primary: true, run: () => {} }] }))
  assert.deepEqual(s.buttons().map((button) => button.textContent), ['OK'])
  assert.equal(s.banner()!.getAttribute('data-kind'), 'closure')
  s.view.hidePrompt()
  assert.equal(s.banner()!.hidden, true)
  assert.deepEqual(s.buttons(), [])
})

test('words are written as text, never as markup', () => {
  const s = setup()
  s.view.showPrompt(prompt({ text: '<img src=x onerror=alert(1)>', detail: '“north <b>door</b>”' }))
  assert.equal(s.banner()!.find((node) => node.className === 'reanchor-text')!.textContent, '<img src=x onerror=alert(1)>')
  assert.equal(s.banner()!.all((node) => node.tag === 'img' || node.tag === 'b').length, 0)
})

// ── The control ─────────────────────────────────────────────────────────────────────────────────────

test('the Check drift control says so, explains itself to assistive technology, and asks the flow when pressed', () => {
  const s = setup()
  s.view.setCheckButton({ visible: true })
  const button = s.check()!
  assert.equal(button.textContent, 'Check drift')
  assert.equal(button.getAttribute('type'), 'button')
  assert.match(button.getAttribute('title') ?? '', /Tap the landmark again/)
  assert.match(button.getAttribute('aria-label') ?? '', /^Check drift: /)
  button.click()
  assert.equal(s.checks(), 1)
})

// ── Taps ────────────────────────────────────────────────────────────────────────────────────────────

/** A canvas event with no preventDefault: calling it would throw, and the tap belongs to whoever else listens. */
const touch = (clientX: number, clientY: number, count = 1) => ({ touches: Array.from({ length: count }, () => ({ clientX, clientY })) })

test('a single-finger touch is reported as normalised canvas coordinates', () => {
  const s = setup()
  s.view.setCheckButton({ visible: true })
  s.canvas.fire('touchstart', touch(210, 420))
  s.canvas.fire('touchstart', touch(10, 20))
  s.canvas.fire('touchstart', touch(410, 820))
  assert.deepEqual(s.taps, [[0.5, 0.5], [0, 0], [1, 1]])
})

test('a pinch is not a tap, and a touch with no point is not one either', () => {
  const s = setup()
  s.view.setCheckButton({ visible: true })
  s.canvas.fire('touchstart', touch(210, 420, 2))
  s.canvas.fire('touchstart', { touches: [] })
  assert.deepEqual(s.taps, [])
})

test('a mouse or controller press is a tap, and the pointer event a touch makes beside its touch event is not a second one', () => {
  const s = setup()
  s.view.setCheckButton({ visible: true })
  s.canvas.fire('pointerdown', { pointerType: 'mouse', clientX: 110, clientY: 220 })
  s.canvas.fire('pointerdown', { pointerType: 'touch', clientX: 110, clientY: 220 })
  assert.deepEqual(s.taps, [[0.25, 0.25]])
})

test('a canvas with no size reports nothing: a tap there would divide by zero', () => {
  const s = setup()
  s.view.setCheckButton({ visible: true })
  s.canvas.rect = { left: 0, top: 0, width: 0, height: 800 }
  s.canvas.fire('touchstart', touch(5, 5))
  s.canvas.rect = { left: 0, top: 0, width: 400, height: 0 }
  s.canvas.fire('pointerdown', { pointerType: 'mouse', clientX: 5, clientY: 5 })
  assert.deepEqual(s.taps, [])
})

// ── The rules ───────────────────────────────────────────────────────────────────────────────────────

test('the rules keep the camera tappable around the banner, and a hidden banner or control really is hidden', () => {
  assert.match(REANCHOR_CSS, new RegExp(`#${BANNER_ID} \\{[^}]*pointer-events: auto`), 'the banner takes pointer events itself')
  assert.match(REANCHOR_CSS, new RegExp(`#${BANNER_ID}\\[hidden\\] \\{ display: none; \\}`))
  assert.match(REANCHOR_CSS, new RegExp(`#${CHECK_BUTTON_ID}\\[hidden\\] \\{ display: none; \\}`))
  assert.match(REANCHOR_CSS, /\.reanchor-detail\[hidden\] \{ display: none; \}/)
  // Each rule on its own: a 44 px rule elsewhere in the sheet must not stand in for the one that is missing.
  const bannerButton = new RegExp(`#${BANNER_ID} button \\{([^}]*)\\}`).exec(REANCHOR_CSS)
  assert.ok(bannerButton, 'a rule for the banner\'s buttons')
  assert.match(bannerButton![1]!, /min-height: 44px/, 'a thumb can hit a button of the banner')
  const checkButton = new RegExp(`#${CHECK_BUTTON_ID} \\{([^}]*)\\}`).exec(REANCHOR_CSS)
  assert.ok(checkButton, 'a rule for the Check drift control')
  assert.match(checkButton![1]!, /min-height: 44px/, 'and of the Check drift control')
  assert.doesNotMatch(REANCHOR_CSS, /inset: 0|top: 0;[^}]*bottom: 0/, 'it is not a full-screen layer, which would swallow every tap on the camera')
})

test('on a phone the banner stops short of the action rail on the right, and above the capture button', () => {
  const phone = /@media \(max-width: 520px\) \{\s*#reanchor-banner \{([^}]*)\}/.exec(REANCHOR_CSS)
  assert.ok(phone, 'a rule for narrow screens')
  assert.match(phone![1]!, /right: calc\(max\(16px, env\(safe-area-inset-right\)\) \+ 62px\)/, 'the rail is 48 px wide with a 14 px gutter (index.html #scanner-action-rail)')
  // The capture button is 78 px tall and 38 px up from the bottom, so it ends 116 px up: the banner starts above that.
  const bottom = /#reanchor-banner \{[^}]*bottom: calc\(max\(18px, env\(safe-area-inset-bottom\)\) \+ (\d+)px\)/.exec(REANCHOR_CSS)
  assert.ok(bottom && Number(bottom[1]) + 18 > 38 + 78, `the banner's lower edge is ${Number(bottom?.[1]) + 18} px up and the capture button's upper edge 116`)
})

test('the banner sits below the calibration overlay, so the two never fight for the same place on the screen', () => {
  const banner = Number(/#reanchor-banner \{[^}]*z-index: (\d+)/.exec(REANCHOR_CSS)?.[1])
  assert.ok(banner > 0 && banner < 40, `z-index ${banner}: the calibration overlay (index.html #project-calibration) is 40`)
})

test('a long choice scrolls its words inside the banner and keeps its buttons in view, on a screen too short for it', () => {
  const rule = new RegExp(`#${BANNER_ID} \\{([^}]*)\\}`).exec(REANCHOR_CSS)![1]!
  // The banner is the screen less what the HUD above and the capture button below leave (230 px): never taller than that.
  assert.match(rule, /max-height: calc\(100vh - 230px\);\s*max-height: calc\(100dvh - 230px\)/, 'a browser with no dynamic viewport unit takes the first of the two')
  assert.match(rule, /display: flex;\s*flex-direction: column/, 'a column, so the words can give way and the buttons cannot')
  const detail = new RegExp(`#${BANNER_ID} \\.reanchor-detail \\{([^}]*)\\}`).exec(REANCHOR_CSS)![1]!
  assert.match(detail, /overflow-y: auto/, 'the words are what scrolls')
  assert.match(detail, /min-height: 0/, 'a flex child that may shrink below its text')
  const fixed = (selector: string) => new RegExp(`#${BANNER_ID} \\.${selector} \\{([^}]*)\\}`).exec(REANCHOR_CSS)![1]!
  assert.match(fixed('reanchor-text'), /flex: none/, 'the headline does not shrink')
  assert.match(fixed('reanchor-actions'), /flex: none/, 'and neither do the buttons')
  assert.match(REANCHOR_CSS, new RegExp(`#${BANNER_ID}\\[hidden\\] \\{ display: none; \\}`), 'display: flex does not show a hidden banner: the attribute rule is the more specific')
})

test('on a screen too short for it, a phone on its side, the banner goes down over the capture button and takes the height that leaves', () => {
  const short = /@media \(max-height: 520px\) \{\s*#reanchor-banner \{([^}]*)\}/.exec(REANCHOR_CSS)
  assert.ok(short, 'a rule for short screens')
  assert.match(short![1]!, /bottom: max\(12px, env\(safe-area-inset-bottom\)\)/, 'not held up 140 px above the capture button: nothing is added while a choice is open')
  assert.match(short![1]!, /max-height: calc\(100vh - 100px\);\s*max-height: calc\(100dvh - 100px\)/, 'the HUD above is all it leaves room for')
  // It follows the base rule, so it wins: the same selector with the same weight, later.
  assert.ok(REANCHOR_CSS.indexOf('@media (max-height: 520px)') > REANCHOR_CSS.indexOf(`#${BANNER_ID} {`), 'after the rule it overrides')
  assert.ok(REANCHOR_CSS.indexOf('@media (max-height: 520px)') < REANCHOR_CSS.indexOf(`#${BANNER_ID}[hidden]`), 'and does not touch what hides the banner')
})
