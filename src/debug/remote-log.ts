let installed = false

const MAX_ARG_LENGTH = 4000

export function installRemoteLog(): void {
  if (installed) return
  installed = true

  const source = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  }

  function send(level: string, args: unknown[]): void {
    const payload = JSON.stringify({
      level,
      page: location.pathname + location.search,
      message: args.map(formatArg).join(' '),
      ts: new Date().toISOString(),
    })
    void fetch('/client-logs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Log-Source': source,
      },
      body: payload,
      keepalive: true,
    }).catch(() => {})
  }

  console.log = (...args: unknown[]) => {
    original.log(...args)
    send('log', args)
  }
  console.info = (...args: unknown[]) => {
    original.info(...args)
    send('info', args)
  }
  console.warn = (...args: unknown[]) => {
    original.warn(...args)
    send('warn', args)
  }
  console.error = (...args: unknown[]) => {
    original.error(...args)
    send('error', args)
  }

  window.addEventListener('error', (event) => {
    send('window-error', [event.message, `${event.filename}:${event.lineno}:${event.colno}`])
  })
  window.addEventListener('unhandledrejection', (event) => {
    send('unhandled-rejection', [event.reason])
  })

  send('info', ['remote logging enabled'])
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`.slice(0, MAX_ARG_LENGTH)
  if (typeof arg === 'string') return arg.slice(0, MAX_ARG_LENGTH)
  try {
    return JSON.stringify(arg).slice(0, MAX_ARG_LENGTH)
  } catch {
    return String(arg).slice(0, MAX_ARG_LENGTH)
  }
}
