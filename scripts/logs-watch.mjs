#!/usr/bin/env node
/**
 * logs-watch.mjs — stream remote client logs from the dev server.
 *
 * Connects to the server's /events WebSocket (via the Vite proxy) and
 * pretty-prints { type: 'client-log' } messages as they arrive from
 * phones that loaded the app with ?debug=remote.
 *
 * Usage:
 *   node scripts/logs-watch.mjs [wss://host:5173/events]
 *   VITE_URL=https://host:5173 node scripts/logs-watch.mjs
 *
 * If the WebSocket fails, falls back to tailing scans/client-logs.jsonl.
 */

import fs from 'node:fs'
import { WebSocket } from 'ws'

const VITE_PORT = process.env.VITE_PORT ?? 5173
const raw = process.argv[2] ?? process.env.VITE_URL ?? `wss://localhost:${VITE_PORT}/events`
const WS_URL = raw.replace(/^http/, 'ws').replace(/\/$/, '') + (raw.includes('/events') ? '' : '/events')
const JSONL_PATH = 'scans/client-logs.jsonl'
const COLORS = { warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' }

function printEntry(e) {
  const time = new Date(e.ts ?? e.at ?? Date.now()).toISOString().slice(11, 19)
  const color = COLORS[e.level] ?? ''
  process.stdout.write(`${color}[${time}] ${e.ip ?? '?'} ${e.level ?? 'log'} ${e.msg ?? ''}${COLORS.reset}\n`)
}

let fellBack = false
function tailJsonl() {
  if (fellBack) return
  fellBack = true
  if (!fs.existsSync(JSONL_PATH)) {
    console.error(`WebSocket unavailable and no ${JSONL_PATH} to tail — exiting`)
    process.exit(1)
  }
  console.log(`Falling back to tailing ${JSONL_PATH}`)
  let pos = fs.statSync(JSONL_PATH).size
  fs.watch(JSONL_PATH, () => {
    const size = fs.statSync(JSONL_PATH).size
    if (size < pos) pos = 0 // file truncated/rotated — start over
    if (size === pos) return
    const chunk = fs.readFileSync(JSONL_PATH, 'utf8').slice(pos)
    pos = size
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      try { printEntry(JSON.parse(line)) } catch { /* partial line */ }
    }
  })
}

console.log(`Connecting to ${WS_URL}`)
const ws = new WebSocket(WS_URL, { rejectUnauthorized: false })

ws.on('open', () => console.log('Connected — waiting for client logs\n'))
ws.on('message', (data) => {
  /**
   * `EventPayload` (docs/factory/02-typed-event-payloads/0001) is the source
   * of truth for every `/events` message shape. This plain `.mjs` script has
   * no build step, so it isn't converted to a real `import` of that union —
   * this JSDoc `@type` reference is a type-check-free stand-in that still
   * gives an editor drift detection (hover types, the `'client-log'` literal
   * below) if `src/shared/events.ts` changes shape.
   * @type {import('../src/shared/events.ts').EventPayload}
   */
  let msg
  try { msg = JSON.parse(data.toString()) } catch { return }
  // 'client-log' is the wire value of EVENT.CLIENT_LOG in src/shared/events.ts.
  if (msg.type !== 'client-log') return
  // Server may broadcast one message per entry or a batch in `entries`.
  for (const entry of msg.entries ?? [msg]) printEntry({ ip: msg.ip, ...entry })
})
ws.on('error', (e) => { console.error('WS error:', e.message); tailJsonl() })
ws.on('close', () => tailJsonl())
process.on('SIGINT', () => { ws.close(); process.exit(0) })
