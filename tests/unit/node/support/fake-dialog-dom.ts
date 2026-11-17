/**
 * A stand-in for the part of the DOM the Place-reference confirmation uses (src/ar/replace-reference.ts), for
 * tests/unit/node/wp-08c-replace-dialog.test.ts and wp-08c-replace-flow.test.ts.
 *
 * Small on purpose, in the style of the stand-ins the calibration modal's tests use: an element that registers every `id="..."` in
 * the markup it is given, remembers its class, text, hidden and disabled state and its listeners, and can be clicked or sent a key.
 * It cannot say how anything looks. The Playwright spec tests/mock-frame-generation.spec.ts draws the real thing.
 *
 * Not a test file: it has no `.test.ts` name, so no runner collects it.
 */

export type Listener = (event: unknown) => void

export class FakeEl {
  hidden = false
  disabled = false
  textContent = ''
  value = ''
  className = ''
  removed = false
  focused = false
  attrs = new Map<string, string>()
  children: FakeEl[] = []
  parts = new Map<string, FakeEl>()
  /** What `querySelector` answers for a selector that is not an id: set by the test. */
  selectors = new Map<string, FakeEl>()
  private listeners = new Map<string, Listener[]>()

  set innerHTML(markup: string) {
    this.parts.clear()
    for (const [, , attributes] of markup.matchAll(/<(\w+)([^>]*)>/g)) {
      const id = /\sid="([^"]+)"/.exec(attributes!)?.[1]
      if (!id) continue
      const part = new FakeEl()
      part.className = /\sclass="([^"]*)"/.exec(attributes!)?.[1] ?? ''
      part.hidden = /\shidden(?=[\s>]|$)/.test(attributes!)
      part.disabled = /\sdisabled(?=[\s>]|$)/.test(attributes!)
      this.parts.set(id, part)
    }
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }

  querySelector(selector: string): FakeEl | null {
    return selector.startsWith('#') ? this.parts.get(selector.slice(1)) ?? null : this.selectors.get(selector) ?? null
  }

  appendChild(child: FakeEl): FakeEl {
    this.children.push(child)
    return child
  }

  remove(): void {
    this.removed = true
  }

  focus(): void {
    this.focused = true
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  fire(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  click(): void {
    this.fire('click')
  }

  /** Types into an input: its value, then the event a browser sends. */
  type(text: string): void {
    this.value = text
    this.fire('input')
  }
}

/**
 * Puts a `document` on the global object whose `createElement` makes the dialog this module builds, and returns it with what the
 * test needs: the host the dialog opens inside, the card of the modal it hides, the button that had focus when the question was
 * asked (`opener`, the document's `activeElement`), and a function that takes the document away.
 */
export function installDialogDom(): { host: FakeEl; card: FakeEl; opener: FakeEl; dialogs: FakeEl[]; restore: () => void } {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const dialogs: FakeEl[] = []
  const opener = new FakeEl()
  Object.defineProperty(globalThis, 'document', {
    value: {
      activeElement: opener,
      createElement: () => {
        const element = new FakeEl()
        dialogs.push(element)
        return element
      },
    },
    configurable: true,
    writable: true,
  })
  const host = new FakeEl()
  const card = new FakeEl()
  host.selectors.set('.project-calibration-card', card)
  return {
    host,
    card,
    opener,
    dialogs,
    restore: () => {
      if (had) Object.defineProperty(globalThis, 'document', had)
      else Reflect.deleteProperty(globalThis, 'document')
    },
  }
}
