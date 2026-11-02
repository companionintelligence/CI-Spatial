/**
 * First-run status rows: what this install can reach, read from three
 * same-origin endpoints.
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
}

/** A null field means that endpoint did not answer usefully, and its row says so. */
export interface FtueSnapshot {
  memory: MemoryStatus | null
  engine: EngineStatus | null
  signIn: SignInStatus | null
}

export interface FtueRow {
  label?: string
  text?: string
  /** The sign-in control. Same-origin, and it returns to the scanner, not the editor. */
  link?: { href: string, text: string }
}

export const SIGN_IN_HREF = '/authenticate/oidc?redirect=%2F'

const UNAVAILABLE = 'Status unavailable.'
const FETCH_TIMEOUT_MS = 8_000

export function ftueRows(s: FtueSnapshot): FtueRow[] {
  return [memoryRow(s.memory), modelRow(s.engine), signInRow(s.signIn)]
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
  if (s.enabled) return { link: { href: SIGN_IN_HREF, text: 'Sign in with Companion Account' } }
  return { label: 'Sign-in', text: 'Off on this install.' }
}

/** The words a row shows, as one string. The budget counts this, and the screen draws the same parts. */
export function ftueRowText(row: FtueRow): string {
  return [row.label, row.link ? row.link.text : row.text].filter(Boolean).join(' ')
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
 * Asks the three endpoints in parallel. A failure, a timeout, or a reply with the
 * wrong shape becomes null for that field. Each field is rebuilt from the named
 * keys only.
 */
export async function fetchFtueSnapshot(fetchFn: typeof fetch = fetch): Promise<FtueSnapshot> {
  const [memory, health, signIn] = await Promise.all([
    getJson<MemoryReply>(fetchFn, '/memory/status'),
    getJson<HealthReply>(fetchFn, '/health'),
    getJson<SignInReply>(fetchFn, '/authenticate/status'),
  ])
  return {
    memory: toMemory(memory),
    engine: toEngine(health),
    signIn: typeof signIn?.enabled === 'boolean' ? { enabled: signIn.enabled } : null,
  }
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
    return li
  })
  list.replaceChildren(...items)
}

/** Fetches the three endpoints and draws the rows. Never rejects: a failed fetch becomes a row that says so. */
export async function renderFtueStatus(list: HTMLElement | null, fetchFn: typeof fetch = fetch): Promise<void> {
  if (!list) return
  drawFtueRows(list, ftueRows(await fetchFtueSnapshot(fetchFn)))
}
