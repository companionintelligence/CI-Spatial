#!/usr/bin/env node
/**
 * iwdp-console.mjs — stream console logs from a real iPhone Safari tab
 * via ios-webkit-debug-proxy.
 *
 * Usage:
 *   1. /opt/homebrew/bin/ios_webkit_debug_proxy -F &
 *   2. curl http://localhost:9222/json    ← find your tab's webSocketDebuggerUrl
 *   3. node scripts/iwdp-console.mjs ws://localhost:9222/devtools/page/2
 *
 * All console.log / warn / error / debug messages from Safari appear here
 * in real time, colour-coded by level.
 *
 * Also enables Runtime and logs uncaught exceptions.
 */

import { WebSocket } from 'ws'

const WS_URL = process.argv[2] ?? 'ws://localhost:9222/devtools/page/1'
const COLORS = {
  log: '\x1b[0m',
  debug: '\x1b[2m',
  info: '\x1b[36m',
  warning: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
}

console.log(`Connecting to ${WS_URL}`)
const ws = new WebSocket(WS_URL)
let msgId = 1

function send(method, params = {}) {
  ws.send(JSON.stringify({ id: msgId++, method, params }))
}

ws.on('open', () => {
  console.log('Connected — streaming console output from device\n')
  send('Runtime.enable')
  send('Console.enable')
  send('Log.enable')
})

ws.on('message', (raw) => {
  let msg
  try { msg = JSON.parse(raw.toString()) } catch { return }

  // Runtime.consoleAPICalled — the main source for console.log etc.
  if (msg.method === 'Runtime.consoleAPICalled') {
    const { type, args, timestamp } = msg.params
    const text = args
      .map((a) => (a.type === 'string' ? a.value : JSON.stringify(a.value ?? a.description ?? a.type)))
      .join(' ')
    const color = COLORS[type] ?? COLORS.log
    const time = new Date(timestamp * 1000).toISOString().slice(11, 23)
    process.stdout.write(`${color}[${time}] [${type.toUpperCase()}] ${text}${COLORS.reset}\n`)
  }

  // Runtime.exceptionThrown
  if (msg.method === 'Runtime.exceptionThrown') {
    const ex = msg.params.exceptionDetails
    const desc = ex.exception?.description ?? ex.text ?? 'Unknown exception'
    process.stdout.write(`${COLORS.error}[EXCEPTION] ${desc}${COLORS.reset}\n`)
  }

  // Log.entryAdded (some browsers emit this too)
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry
    const color = e.level === 'error' ? COLORS.error : e.level === 'warning' ? COLORS.warning : COLORS.log
    process.stdout.write(`${color}[${e.level.toUpperCase()}] ${e.text}${COLORS.reset}\n`)
  }
})

ws.on('error', (e) => console.error('WS error:', e.message))
ws.on('close', () => console.log('\nConnection closed'))
process.on('SIGINT', () => { ws.close(); process.exit(0) })
