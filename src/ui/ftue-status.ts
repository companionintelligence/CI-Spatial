/**
 * First-run status rows: what this install can reach, read from three endpoints
 * on the Scan server. In a browser that server is the page's own origin. In a
 * native shell it is the address saved on the device (or the build's
 * VITE_API_BASE), and apiUrl() puts it in front of each path. A shell also gets
 * a Server row of its own, which names that server and opens the form that sets
 * it (src/ui/server-setting.ts).
 *
 *   Companion Memory  GET /memory/status        { enabled, reachable? }
 *   Model             GET /health               { model, engineLoadState }
 *   Sign-in           GET /authenticate/status  { enabled }
 *
 * Read-only. Nothing goes to a third-party host and nothing is recorded. Only
 * the fields named above are copied out of each response, so a URL or token the
 * server returns cannot reach the screen.
 *
 * The copy lives here and nowhere else. The first-run screen is word-budgeted
 * (tests/unit/node/startup_word_budget.test.ts), and that budget counts these
 * rows for every state they can show.
 */
import { apiBase, apiUrl, isNativeShell } from '../shared/api-base.ts'
import { beginShellSignIn, shellSignedIn } from '../shared/shell-sign-in.ts'
import { mountServerForm } from './server-setting.ts'
import { ensureShellStyles } from './shell-dialog.ts'

export interface MemoryStatus {
  enabled: boolean
  /** Present once the server has probed Companion Memory. */
  reachable?: boolean
}

export interface EngineStatus {
  /** The model in use, as /health names it, e.g. "Ollama/qwen3-vl:4b". */
  model: string
  engineLoadState: 'loading' | 'ready' | 'failed'
}

export interface SignInStatus {
  enabled: boolean
  /** A shell that holds a session the server still accepts. */
  signedIn?: boolean
  /** Set after a shell sign-in that did not finish. The control shows it and still starts another try. */
  problem?: string
}

/** A null field means that endpoint did not answer usefully. Its row says so. All three null is one Server row instead. */
export interface FtueSnapshot {
  memory: MemoryStatus | null
  engine: EngineStatus | null
  signIn: SignInStatus | null
}

export interface FtueRow {
  label?: string
  text?: string
  /** The sign-in control. It returns to the scanner, not the editor. In a shell it starts the browser sheet. */
  link?: { href: string, text: string }
  /** A shell's control, drawn as a button after the row's text. `server` opens the Scan server form. */
  control?: { action: 'server', text: string }
}

/**
 * What only a native shell adds to the rows: the Scan server it is set to, as an
 * origin, or null when none is set. A browser passes nothing, and its rows are
 * the ones it has always drawn.
 */
export interface ShellServer {
  origin: string | null
}

export const SIGN_IN_HREF = '/authenticate/oidc?redirect=%2F'
/** The control's words after a shell sign-in that failed. Short on purpose: the first-run word budget is tight. */
export const SIGN_IN_FAILED = 'Sign-in failed. Try again.'

const UNAVAILABLE = 'Status unavailable.'
const NO_SERVER = 'None answered. Sign-in, saved projects and object labels need one.'
/** A shell with no Scan server address yet. */
export const SERVER_NONE_SET = 'None set. Sign-in, saved projects and object labels need one.'
const FETCH_TIMEOUT_MS = 8_000

export function ftueRows(s: FtueSnapshot, shell?: ShellServer): FtueRow[] {
  if (shell) return shellRows(s, shell)
  // Nothing answered, which is what the static public site always sees. One plain
  // row says more than three that each read "Status unavailable."
  if (!s.memory && !s.engine && !s.signIn) return [{ label: 'Server', text: NO_SERVER }]
  return [memoryRow(s.memory), modelRow(s.engine), signInRow(s.signIn)]
}

/**
 * A shell's rows. The Server row comes first and always has a control, because in a
 * shell the server is the person's to choose: none set yet, set but silent, or set
 * and answering (then the three status rows follow it). The row names the server by
 * its host, which the person typed; nothing a server returns is shown.
 */
function shellRows(s: FtueSnapshot, shell: ShellServer): FtueRow[] {
  if (!shell.origin) return [{ label: 'Server', text: SERVER_NONE_SET, control: { action: 'server', text: 'Add server' } }]
  const host = new URL(shell.origin).host
  const change = { action: 'server', text: 'Change' } as const
  if (!s.memory && !s.engine && !s.signIn) {
    return [{ label: 'Server', text: `${host} did not answer. Sign-in, saved projects and object labels need it.`, control: change }]
  }
  return [{ label: 'Server', text: host, control: change }, memoryRow(s.memory), modelRow(s.engine), signInRow(s.signIn)]
}

function memoryRow(m: MemoryStatus | null): FtueRow {
  const label = 'Companion Memory'
  if (!m) return { label, text: UNAVAILABLE }
  if (!m.enabled) return { label, text: 'Not connected. Connect Companion Memory in Companion Hub.' }
  if (m.reachable === false) return { label, text: 'Set up, but not reachable.' }
  return { label, text: 'Connected.' }
}

function modelRow(e: EngineStatus | null): FtueRow {
  const label = 'Model'
  if (!e) return { label, text: UNAVAILABLE }
  const name = e.model.replace(/^Ollama\//, '')
  if (e.engineLoadState === 'ready') return { label, text: `${name} loaded.` }
  if (e.engineLoadState === 'loading') return { label, text: `Loading ${name}.` }
  return {
    label,
    text: `${name} did not load. Scans run in server-only mode, and object labels will not be produced.`,
  }
}

function signInRow(s: SignInStatus | null): FtueRow {
  if (!s) return { label: 'Sign-in', text: UNAVAILABLE }
  if (s.signedIn) return { label: 'Sign-in', text: 'Signed in.' }
  if (s.enabled) return { link: { href: apiUrl(SIGN_IN_HREF), text: s.problem ?? 'Sign in with Companion Account' } }
  return { label: 'Sign-in', text: 'Off on this install.' }
}

/** The words a row shows, as one string. The budget counts this, and the screen draws the same parts. */
export function ftueRowText(row: FtueRow): string {
  return [row.label, row.link ? row.link.text : row.text, row.control?.text].filter(Boolean).join(' ')
}

interface MemoryReply { enabled?: unknown, reachable?: unknown }
interface HealthReply { model?: unknown, engineLoadState?: unknown }
interface SignInReply { enabled?: unknown }

async function getJson<T extends object>(fetchFn: typeof fetch, path: string): Promise<T | null> {
  try {
    const res = await fetchFn(path, { credentials: 'same-origin', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const body: unknown = await res.json()
    return typeof body === 'object' && body !== null ? body as T : null
  } catch {
    return null
  }
}

/**
 * Hides a control that needs the Scan server when this host has none. Only a 404
 * says that: the static public site answers every server path with one. Any other
 * answer shows it again, for a shell whose server the person has just changed. A
 * network failure leaves the control alone, because it can't tell us the server is
 * missing.
 */
export async function hideWithoutServer(el: Pick<HTMLElement, 'hidden'> | null, fetchFn: typeof fetch = fetch): Promise<void> {
  if (!el) return
  try {
    const res = await fetchFn(apiUrl('/health'), { credentials: 'same-origin', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    el.hidden = res.status === 404
  } catch {
    // Offline or timed out, which says nothing about whether a server exists.
  }
}

/**
 * Asks the three endpoints in parallel. A failure, a timeout, or a reply with the
 * wrong shape becomes null for that field. Each field is rebuilt from the named
 * keys only. A shell also checks the session it stored, once sign-in is on.
 */
export async function fetchFtueSnapshot(fetchFn: typeof fetch = fetch): Promise<FtueSnapshot> {
  const [memory, health, signIn] = await Promise.all([
    getJson<MemoryReply>(fetchFn, apiUrl('/memory/status')),
    getJson<HealthReply>(fetchFn, apiUrl('/health')),
    getJson<SignInReply>(fetchFn, apiUrl('/authenticate/status')),
  ])
  return {
    memory: toMemory(memory),
    engine: toEngine(health),
    signIn: typeof signIn?.enabled === 'boolean' ? await toSignIn(signIn.enabled, fetchFn) : null,
  }
}

async function toSignIn(enabled: boolean, fetchFn: typeof fetch): Promise<SignInStatus> {
  return enabled && await shellSignedIn(fetchFn) ? { enabled, signedIn: true } : { enabled }
}

function toMemory(r: MemoryReply | null): MemoryStatus | null {
  if (!r || typeof r.enabled !== 'boolean') return null
  return typeof r.reachable === 'boolean'
    ? { enabled: r.enabled, reachable: r.reachable }
    : { enabled: r.enabled }
}

function toEngine(r: HealthReply | null): EngineStatus | null {
  if (!r || typeof r.model !== 'string') return null
  const state = r.engineLoadState
  if (state !== 'loading' && state !== 'ready' && state !== 'failed') return null
  return { model: r.model, engineLoadState: state }
}

/**
 * Draws the rows into `list`. Text goes in with textContent, and the link is built
 * with setAttribute, so no server string is ever read as HTML.
 */
export function drawFtueRows(list: HTMLElement, rows: FtueRow[]): void {
  if (rows.some((row) => row.control)) ensureShellStyles(list.ownerDocument)
  const items = rows.map((row) => {
    const li = document.createElement('li')
    li.className = 'ftue-row'
    if (row.link) {
      const a = document.createElement('a')
      a.className = 'ftue-signin'
      a.setAttribute('href', row.link.href)
      a.textContent = row.link.text
      li.append(a)
      return li
    }
    if (row.label) {
      const label = document.createElement('span')
      label.className = 'ftue-label'
      label.textContent = row.label
      li.append(label)
    }
    const text = document.createElement('span')
    text.className = 'ftue-text'
    text.textContent = row.text ?? ''
    li.append(text)
    if (row.control) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'cs-btn ftue-control'
      button.dataset['action'] = row.control.action
      button.setAttribute('aria-expanded', 'false')
      button.textContent = row.control.text
      li.append(button)
    }
    return li
  })
  list.replaceChildren(...items)
}

/** The rows with nothing fetched: a shell with no server has nothing to ask. */
const NOTHING_ANSWERED: FtueSnapshot = { memory: null, engine: null, signIn: null }

/**
 * Fetches the three endpoints and draws the rows. Never rejects: a failed fetch becomes a row that says so.
 * `problem` replaces the sign-in control's words, after a shell sign-in that did not finish.
 */
export async function renderFtueStatus(
  list: HTMLElement | null,
  fetchFn: typeof fetch = fetch,
  problem?: string,
): Promise<void> {
  if (!list) return
  const shell: ShellServer | undefined = isNativeShell() ? { origin: apiBase() || null } : undefined
  const snapshot = shell && !shell.origin ? { ...NOTHING_ANSWERED } : await fetchFtueSnapshot(fetchFn)
  if (problem && snapshot.signIn?.enabled && !snapshot.signIn.signedIn) snapshot.signIn.problem = problem
  drawFtueRows(list, ftueRows(snapshot, shell))
  wireShellSignIn(list)
  wireServerControl(list, () => { void renderFtueStatus(list, fetchFn) })
}

/**
 * In a shell the Server row's control opens the address form under the row, and
 * closes it again. A saved address redraws the rows from the new server.
 */
function wireServerControl(list: HTMLElement, redraw: () => void): void {
  const button = list.querySelector<HTMLButtonElement>('button.ftue-control[data-action="server"]')
  const row = button?.closest('li')
  if (!button || !row) return
  button.addEventListener('click', () => {
    const open = row.querySelector('form.cs-server-form')
    if (open) {
      open.remove()
      button.setAttribute('aria-expanded', 'false')
      return
    }
    mountServerForm(row, { autofocus: true, onSaved: redraw })
    button.setAttribute('aria-expanded', 'true')
  })
}

/**
 * In a shell the sign-in control starts the browser sheet. Its href would open the
 * server's page inside the shell, where the session cannot follow.
 */
function wireShellSignIn(list: HTMLElement): void {
  if (!isNativeShell()) return
  list.querySelector<HTMLAnchorElement>('a.ftue-signin')?.addEventListener('click', (event) => {
    event.preventDefault()
    void beginShellSignIn().catch(() => { /* the sheet did not open: the control stays as it is */ })
  })
}
