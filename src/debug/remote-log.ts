/**
 * Remote log relay — mirrors console errors/warnings and uncaught
 * exceptions to the dev server so phone sessions can be debugged
 * without a tethered console.
 *
 * Armed only when the page is loaded with a ?debug= list containing
 * `remote` (so ?debug=remote and ?debug=remote,pose both arm it) or when
 * localStorage['remote-log'] === '1' — otherwise installRemoteLog()
 * is a no-op. Entries buffer in memory (capped at 50, oldest dropped)
 * and POST to /client-logs every 3 s, plus a keepalive flush on
 * pagehide. Same-origin relative URL so the Vite proxy routes it.
 * The log channel must never break the app: all send errors are
 * swallowed.
 *
 * `?debug=remote,verbose` additionally mirrors console.log. It is opt-in
 * because the interesting diagnostics are log-level, not warn: the 8th Wall
 * startup dump (camera frame dims, canvas size, viewport, fov) is a
 * console.log, so a phone reporting "no camera feed" produced a remote log
 * containing nothing but a geolocation timeout — the one message that could
 * not explain it. Off by default: a scanner tick logs several times a second
 * and would evict everything else from the 50-entry buffer.
 */

import { REMOTE_LOG_KEY } from '../shared/storage-keys'
import { hasDebugFlag } from '../shared/debug-flags'

type LogLevel = 'error' | 'warn' | 'log'

interface LogEntry {
  ts: number
  level: LogLevel
  msg: string
  stack?: string
  url: string
}

const MAX_BUFFERED = 50
const MAX_MSG_CHARS = 500
const FLUSH_INTERVAL_MS = 3000

let installed = false
let buffer: LogEntry[] = []

function isArmed(): boolean {
  try {
    // `?debug=` is a comma-separated token list (src/shared/debug-flags.ts), so
    // this arms on `?debug=remote` exactly as before and additionally on
    // `?debug=remote,pose` — which an exact-equality check silently refused.
    if (hasDebugFlag('remote')) return true
    return localStorage.getItem(REMOTE_LOG_KEY) === '1'
  } catch {
    // localStorage can throw (private mode / blocked storage) — stay disarmed.
    return false
  }
}

function toMsg(args: unknown[]): string {
  return args
    .map((a) => {
      try { return String(a) } catch { return '[unstringifiable]' }
    })
    .join(' ')
    .slice(0, MAX_MSG_CHARS)
}

function firstStack(args: unknown[]): string | undefined {
  for (const a of args) {
    if (a instanceof Error && a.stack) return a.stack
  }
  return undefined
}

function push(level: LogLevel, msg: string, stack?: string): void {
  buffer.push({ ts: Date.now(), level, msg, stack, url: location.pathname })
  if (buffer.length > MAX_BUFFERED) buffer.splice(0, buffer.length - MAX_BUFFERED)
}

function flush(useKeepalive = false): void {
  if (buffer.length === 0) return
  const entries = buffer
  buffer = []
  try {
    fetch('/client-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries, ua: navigator.userAgent }),
      keepalive: useKeepalive,
    }).catch(() => { /* log channel must never break the app */ })
  } catch { /* ditto — swallow synchronous fetch failures too */ }
}

export function installRemoteLog(): void {
  if (installed || !isArmed()) return
  installed = true

  const originalError = console.error.bind(console)
  const originalWarn = console.warn.bind(console)
  const originalLog = console.log.bind(console)

  if (hasDebugFlag('verbose')) {
    console.log = (...args: unknown[]) => {
      originalLog(...args)
      push('log', toMsg(args))
    }
  }

  console.error = (...args: unknown[]) => {
    originalError(...args)
    push('error', toMsg(args), firstStack(args))
  }
  console.warn = (...args: unknown[]) => {
    originalWarn(...args)
    push('warn', toMsg(args), firstStack(args))
  }

  window.addEventListener('error', (event) => {
    const stack = event.error instanceof Error ? event.error.stack : undefined
    push('error', toMsg([event.message, `(${event.filename}:${event.lineno})`]), stack)
  })

  window.addEventListener('unhandledrejection', (event) => {
    const stack = event.reason instanceof Error ? event.reason.stack : undefined
    push('error', toMsg(['Unhandled rejection:', event.reason]), stack)
  })

  setInterval(() => flush(), FLUSH_INTERVAL_MS)
  window.addEventListener('pagehide', () => flush(true))
}
