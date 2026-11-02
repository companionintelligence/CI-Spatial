/**
 * The first-run overlay's third step: what the Companion services behind this
 * Scan server are, as the server reports them.
 *
 * Nothing here is typed in. The Companion Hub writes the Companion Account
 * issuer, the Companion Memory address and key, and the inference host into the
 * app's environment when Scan is installed from the store and connected there
 * (`hub_integration` in CI-Marketplace's apps/ci-web-xr-scan/config.json). The
 * server reads them at boot. This module asks the server what it found and turns
 * the answers into rows. The same bundle draws them in a browser and in the
 * Capacitor shells.
 *
 * Only status reaches this module, never a token or a key. A check that fails is
 * a row that says so. It never holds the overlay up.
 */
import { apiCredentials, apiUrl, isNativeShell } from './api-base.ts'

export type ConnectionState = 'ok' | 'busy' | 'warn' | 'off' | 'unknown'

export interface ConnectionRow {
  id: 'account' | 'memory' | 'model'
  /** Two words at most, so the overlay stays short. */
  label: string
  state: ConnectionState
  /** One short status line. */
  text: string
  /** A line under the status, for the one row with a next step that is not a link. */
  hint?: string
  /** A link for the next step, when there is one. */
  action?: { label: string; href: string }
}

/** `GET /authenticate/whoami`, reduced to what the account row needs. `null`: the server could not be asked. */
export type AccountAnswer =
  | { kind: 'signed-in'; name: string }
  | { kind: 'signed-out' }
  | { kind: 'off' }
  | null

/** `GET /memory/status`. `reachable` is null when the server did not probe. */
export type MemoryAnswer = { enabled: boolean; reachable: boolean | null } | null

/** `GET /health`, for the vision model. `model` is null when the server names none. */
export type ModelAnswer = { model: string | null; ready: boolean; loading: boolean } | null

export function accountRow(answer: AccountAnswer, opts: { native: boolean; signInHref: string }): ConnectionRow {
  const row = { id: 'account' as const, label: 'Companion Account' }
  if (answer === null) return { ...row, state: 'unknown', text: "Can't check" }
  if (answer.kind === 'signed-in') return { ...row, state: 'ok', text: `Signed in as ${answer.name}` }
  if (answer.kind === 'off') return { ...row, state: 'off', text: 'Sign-in is off here' }
  // The shell's page is on another origin than the server, so the session the
  // server sets cannot reach it. Signing in happens in a browser.
  if (opts.native) return { ...row, state: 'off', text: 'Sign in on the web' }
  return { ...row, state: 'off', text: 'Not signed in', action: { label: 'Sign in', href: opts.signInHref } }
}

export function memoryRow(answer: MemoryAnswer): ConnectionRow {
  const row = { id: 'memory' as const, label: 'Companion Memory' }
  if (answer === null) return { ...row, state: 'unknown', text: "Can't check" }
  if (!answer.enabled) {
    return { ...row, state: 'off', text: 'Not connected', hint: 'Connect it in your Companion Hub' }
  }
  if (answer.reachable === false) return { ...row, state: 'warn', text: 'Connected, unreachable' }
  return { ...row, state: 'ok', text: 'Connected' }
}

export function modelRow(answer: ModelAnswer): ConnectionRow {
  const row = { id: 'model' as const, label: 'Vision model' }
  if (answer === null) return { ...row, state: 'unknown', text: "Can't check" }
  if (answer.ready) return { ...row, state: 'ok', text: answer.model ? `${answer.model} ready` : 'Ready' }
  if (answer.loading) return { ...row, state: 'busy', text: answer.model ? `Loading ${answer.model}` : 'Loading' }
  return { ...row, state: 'warn', text: 'Unavailable' }
}

/** How long one status check may take before its row says it could not be asked. */
const ASK_TIMEOUT_MS = 4000

/** A status reply: its HTTP status and its parsed JSON body, or undefined when the body is not JSON. */
export interface Reply {
  status: number
  body: unknown
}

async function ask(path: string): Promise<Reply | null> {
  try {
    const response = await fetch(apiUrl(path), {
      credentials: apiCredentials(),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    })
    const json = (response.headers.get('content-type') ?? '').includes('application/json')
    return { status: response.status, body: json ? await response.json().catch(() => undefined) : undefined }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toAccount(reply: Reply | null): AccountAnswer {
  if (!reply) return null
  if (reply.status === 401) return { kind: 'signed-out' }
  if (reply.status === 200 && isRecord(reply.body)) {
    const name = [reply.body.name, reply.body.email].find((v): v is string => typeof v === 'string' && v !== '')
    return { kind: 'signed-in', name: name ?? 'your account' }
  }
  // 404 when sign-in is not enabled. A 200 without a JSON body is the static
  // bundle answering for a route this server does not register, which is the same thing.
  if (reply.status === 404 || reply.status === 200) return { kind: 'off' }
  return null
}

export function toMemory(reply: Reply | null): MemoryAnswer {
  if (!reply || reply.status !== 200 || !isRecord(reply.body)) return null
  const reachable = typeof reply.body.reachable === 'boolean' ? reply.body.reachable : null
  return { enabled: reply.body.enabled === true, reachable }
}

/** `/health` names the engine and the model ("Ollama/llava:7b"). The row only needs the model. */
export function toModel(reply: Reply | null): ModelAnswer {
  if (!reply || reply.status !== 200 || !isRecord(reply.body)) return null
  const raw = typeof reply.body.model === 'string' ? reply.body.model : ''
  const model = raw.split('/').pop() || null
  return { model, ready: reply.body.modelReady === true, loading: reply.body.engineLoadState === 'loading' }
}

/** The three rows, in the order the overlay draws them. Never throws. */
export async function checkConnections(): Promise<ConnectionRow[]> {
  const [who, memory, health] = await Promise.all([
    ask('/authenticate/whoami'),
    ask('/memory/status'),
    ask('/health'),
  ])
  return [
    accountRow(toAccount(who), {
      native: isNativeShell(),
      signInHref: apiUrl(`/authenticate/oidc?redirect=${encodeURIComponent('/editor')}`),
    }),
    memoryRow(toMemory(memory)),
    modelRow(toModel(health)),
  ]
}

/** Draws the rows into `list`. Text goes in with textContent, so an account name cannot inject markup. */
export async function renderConnections(list: HTMLElement): Promise<void> {
  const rows = await checkConnections()
  list.replaceChildren(...rows.map(rowElement))
}

function rowElement(row: ConnectionRow): HTMLElement {
  const el = document.createElement('div')
  el.className = 'onboard-conn'
  el.dataset.state = row.state
  const label = document.createElement('span')
  label.className = 'onboard-conn-label'
  label.textContent = row.label
  const text = document.createElement('span')
  text.className = 'onboard-conn-text'
  text.textContent = row.text
  el.append(label, text)
  if (row.hint) {
    const hint = document.createElement('span')
    hint.className = 'onboard-conn-hint'
    hint.textContent = row.hint
    el.append(hint)
  }
  if (row.action) {
    const link = document.createElement('a')
    link.href = row.action.href
    link.textContent = row.action.label
    el.append(link)
  }
  return el
}
