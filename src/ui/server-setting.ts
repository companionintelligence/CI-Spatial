/**
 * The Scan server address in a native shell: the form that sets it, tests it and
 * changes it. The first-run Server row (src/ui/ftue-status.ts) opens the form in
 * place, and the editor opens it in a dialog (src/viewer/shell-menu.ts).
 *
 * The address is kept on the device by src/shared/api-base.ts, which every server
 * request already goes through. A test asks the server's /health, the one route a
 * Scan server answers without a session. The hosted web app never shows the form:
 * its server is the page's own origin.
 */
import {
  apiBase,
  parseServerAddress,
  saveServerAddress,
  type ServerAddressProblem,
} from '../shared/api-base.ts'
import { ensureShellStyles, openShellDialog } from './shell-dialog.ts'

/** What a test found at an address: a Scan server, something else, or nothing. */
export type ServerCheck = 'ok' | 'not-scan' | 'no-answer'

const CHECK_TIMEOUT_MS = 8_000

/**
 * Asks `origin` for /health. A Scan server answers `{ status: 'ok', model }`. A
 * network failure, a timeout, and a server that refuses this app's origin all look
 * the same from the page, so they are one answer: no answer.
 */
export async function checkServer(origin: string, fetchFn: typeof fetch = fetch): Promise<ServerCheck> {
  let res: Response
  try {
    res = await fetchFn(`${origin}/health`, {
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    return 'no-answer'
  }
  if (!res.ok) return 'not-scan'
  const body = await res.json().catch(() => null) as { status?: unknown, model?: unknown } | null
  return body?.status === 'ok' && typeof body.model === 'string' ? 'ok' : 'not-scan'
}

/** Why an address was refused, in the form's words. */
export const PROBLEM_TEXT: Record<ServerAddressProblem, string> = {
  'empty': 'Enter the address of your Scan server.',
  'not-a-url': 'That is not a web address.',
  'not-https': 'Use an https:// address. The app does not send your sign-in over plain http.',
  'has-path': 'Enter the address alone, with nothing after the host name, like https://scan.example.ts.net.',
  'has-credentials': 'Leave out the user name and password.',
  'own-origin': 'That is this app\'s own address, not a server.',
}

/** What a test found, in the form's words. */
export const CHECK_TEXT: Record<ServerCheck, string> = {
  'ok': 'A Scan server answered.',
  'not-scan': 'Something answered, but not a Scan server.',
  'no-answer': 'No answer. Check the address, the network, and that the server is up to date.',
}

/** What the form says after a test, or after a save that was then tested. */
export function checkMessage(check: ServerCheck, saved: boolean): string {
  return saved ? `Saved. ${CHECK_TEXT[check]}` : CHECK_TEXT[check]
}

export const STORAGE_BLOCKED = 'This device did not keep the address. Its storage may be blocked.'

export interface ServerFormOptions {
  /** Called after an address is saved, with what its test found. */
  onSaved?: (origin: string, check: ServerCheck) => void
  /** Moves focus to the address field once the form is drawn. */
  autofocus?: boolean
  /** The fetch the test uses. Tests pass a stand-in. */
  fetchFn?: typeof fetch
}

/**
 * Draws the form into `container`: the address, Test, Save, and a line that says
 * what happened. Text goes in with textContent, so nothing typed or answered is
 * read as HTML.
 */
export function mountServerForm(container: HTMLElement, options: ServerFormOptions = {}): HTMLFormElement {
  const doc = container.ownerDocument
  ensureShellStyles(doc)
  const fetchFn = options.fetchFn ?? fetch
  const ownOrigin = doc.defaultView?.location.origin

  const form = doc.createElement('form')
  form.className = 'cs-server-form'
  form.noValidate = true

  const label = doc.createElement('label')
  const caption = doc.createElement('span')
  caption.textContent = 'Scan server address'
  const input = doc.createElement('input')
  input.type = 'url'
  input.name = 'server'
  input.inputMode = 'url'
  input.setAttribute('autocomplete', 'url')
  input.spellcheck = false
  input.setAttribute('autocapitalize', 'off')
  input.placeholder = 'https://scan.example.ts.net'
  input.value = apiBase()
  label.append(caption, input)

  const actions = doc.createElement('div')
  actions.className = 'cs-actions'
  const test = doc.createElement('button')
  test.type = 'button'
  test.className = 'cs-btn cs-btn-quiet'
  test.textContent = 'Test'
  const save = doc.createElement('button')
  save.type = 'submit'
  save.className = 'cs-btn cs-btn-primary'
  save.textContent = 'Save'
  actions.append(test, save)

  const result = doc.createElement('p')
  result.className = 'cs-result'
  result.setAttribute('role', 'status')
  result.setAttribute('aria-live', 'polite')

  form.append(label, actions, result)
  container.append(form)

  const say = (text: string, tone: 'good' | 'bad' | 'neutral') => {
    result.textContent = text
    result.dataset['tone'] = tone
  }
  const busy = (on: boolean) => {
    test.disabled = on
    save.disabled = on
    input.setAttribute('aria-busy', String(on))
  }
  /** The typed address, or null after saying why it cannot be used. */
  const address = (): string | null => {
    const parsed = parseServerAddress(input.value, ownOrigin)
    if (!parsed.ok) {
      say(PROBLEM_TEXT[parsed.problem], 'bad')
      input.focus()
      return null
    }
    input.value = parsed.origin
    return parsed.origin
  }

  test.addEventListener('click', async () => {
    const origin = address()
    if (!origin) return
    busy(true)
    say('Testing…', 'neutral')
    const check = await checkServer(origin, fetchFn)
    busy(false)
    say(checkMessage(check, false), check === 'ok' ? 'good' : 'bad')
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const origin = address()
    if (!origin) return
    if (!saveServerAddress(origin)) {
      say(STORAGE_BLOCKED, 'bad')
      return
    }
    busy(true)
    say('Saved. Testing…', 'neutral')
    const check = await checkServer(origin, fetchFn)
    busy(false)
    say(checkMessage(check, true), check === 'ok' ? 'good' : 'bad')
    options.onSaved?.(origin, check)
  })

  if (options.autofocus) input.focus()
  return form
}

/** Opens the form in a dialog, for a page with no first-run row to hold it. */
export function openServerDialog(options: ServerFormOptions = {}): HTMLDialogElement {
  const intro = document.createElement('p')
  intro.textContent = 'This app works with your own Scan server, such as the one on your Companion Hub. '
    + 'Enter its https address.'
  const holder = document.createElement('div')
  const dialog = openShellDialog('Scan server', [intro, holder])
  mountServerForm(holder, { ...options, autofocus: true })
  return dialog
}
