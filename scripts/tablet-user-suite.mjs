#!/usr/bin/env node
/**
 * Tablet user smoke suite for CI-Spatial.
 *
 * Drives the real Galaxy Tab S9 Ultra through the Android Remote Control MCP.
 * The MCP URL and bearer token are read from .mcp.local.json by default, or from:
 *   TABLET_MCP_URL
 *   TABLET_MCP_BEARER or TABLET_MCP_AUTH
 *
 * The app URL is resolved from TABLET_TEST_URL/VITE_URL, then the repo's
 * Tailscale cert hostname, then the historical liambook fallback.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { join } from 'node:path'

const MCP_PROTOCOL_VERSION = '2025-03-26'
const DEFAULT_MCP_SERVER = 'android-tab-s9-ultra'
const KEEP_GOING = process.argv.includes('--keep-going') || process.env.TABLET_KEEP_GOING === '1'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function loadMcpConfig() {
  const configPath = process.env.TABLET_MCP_CONFIG ?? '.mcp.local.json'
  let url = process.env.TABLET_MCP_URL
  let authorization = process.env.TABLET_MCP_AUTH

  if (!authorization && process.env.TABLET_MCP_BEARER) {
    authorization = `Bearer ${process.env.TABLET_MCP_BEARER}`
  }

  if (!url || !authorization) {
    const cfg = loadJson(configPath)
    const serverName = process.env.TABLET_MCP_SERVER ?? DEFAULT_MCP_SERVER
    const server = cfg.mcpServers?.[serverName]
    if (!server) {
      throw new Error(`MCP server "${serverName}" not found in ${configPath}`)
    }
    url ??= server.url
    authorization ??= server.headers?.Authorization
  }

  if (!url) throw new Error('Missing TABLET_MCP_URL or .mcp.local.json mcp server url')
  if (!authorization) throw new Error('Missing TABLET_MCP_BEARER/TABLET_MCP_AUTH or .mcp.local.json Authorization header')
  if (!authorization.startsWith('Bearer ')) authorization = `Bearer ${authorization}`
  return { url, authorization }
}

function resolveAppBaseUrl() {
  const explicit = process.env.TABLET_TEST_URL ?? process.env.VITE_URL
  if (explicit) return explicit.replace(/\/$/, '')

  const port = process.env.VITE_PORT ?? '5173'
  const fromEnv = process.env.TAILSCALE_HOSTNAME ?? process.env.VITE_HOSTNAME
  if (fromEnv) return `https://${fromEnv}:${port}`

  const cert = readdirSync(process.cwd()).find((f) => f.endsWith('.ts.net.crt'))
  const host = cert ? cert.replace(/\.crt$/, '') : 'liambook.capybara-ulmer.ts.net'
  return `https://${host}:${port}`
}

function withPathAndParams(baseUrl, path, params = {}) {
  const url = new URL(baseUrl)
  url.pathname = path
  url.search = ''
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

function textFromToolResult(result) {
  return (result?.content ?? [])
    .map((part) => part?.text ?? '')
    .filter(Boolean)
    .join('\n')
}

function parseJsonFromToolText(text) {
  const starts = ['[', '{']
    .map((char) => text.indexOf(char))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)
  if (starts.length === 0) throw new Error(`No JSON payload found in tool text: ${text.slice(0, 160)}`)
  return JSON.parse(text.slice(starts[0]))
}

function expectMatch(text, pattern, label) {
  if (!pattern.test(text)) {
    throw new Error(`Expected ${label} to match ${pattern}, but it did not.`)
  }
}

async function getText(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.request(parsed, { rejectUnauthorized: false, timeout: 12_000 }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`${url} returned HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
        } else {
          resolve(data)
        }
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error(`${url} timed out`))
    })
    req.on('error', reject)
    req.end()
  })
}

class McpClient {
  constructor({ url, authorization }) {
    this.url = url
    this.authorization = authorization
    this.sessionId = null
    this.nextId = 1
  }

  async initialize() {
    const response = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ci-spatial-tablet-user-suite', version: '0.1.0' },
      },
    })
    this.sessionId = response.headers.get('mcp-session-id') ?? response.headers.get('Mcp-Session-Id')
    await this.post({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }).catch(() => {
      // Some MCP servers answer notifications with an empty/202 response. The
      // following tool call confirms whether the session is actually ready.
    })
  }

  async post(payload) {
    const headers = {
      Authorization: this.authorization,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId

    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })

    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${raw.slice(0, 500)}`)
    }
    if (!raw.trim()) return { headers: response.headers, body: null }

    const body = parseMcpBody(raw)
    if (body?.error) {
      throw new Error(`MCP ${body.error.code}: ${body.error.message}`)
    }
    return { headers: response.headers, body }
  }

  async callTool(name, args = {}) {
    if (!this.sessionId) await this.initialize()
    const response = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    return response.body?.result
  }
}

function parseMcpBody(raw) {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed)

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((line) => line && line !== '[DONE]')
  if (dataLines.length > 0) return JSON.parse(dataLines.at(-1))

  throw new Error(`Unsupported MCP response: ${trimmed.slice(0, 160)}`)
}

async function main() {
  const mcp = new McpClient(loadMcpConfig())
  const baseUrl = resolveAppBaseUrl()
  const scannerUrl = withPathAndParams(baseUrl, '/', {
    mock: 'xr8',
    onboarding: '0',
    world: 'default',
  })
  const viewerUrl = withPathAndParams(baseUrl, '/viewer.html', { world: 'default' })
  const results = []

  async function screen(timeout = 20_000) {
    const result = await mcp.callTool('android_get_screen_state', { include_screenshot: false })
    const text = textFromToolResult(result)
    if (!text) throw new Error(`No screen state returned within ${timeout}ms`)
    return text
  }

  async function waitForScreen(pattern, timeout = 30_000) {
    const deadline = Date.now() + timeout
    let last = ''
    while (Date.now() < deadline) {
      last = await screen()
      if (pattern.test(last)) return last
      await wait(1_000)
    }
    throw new Error(`Timed out waiting for screen text ${pattern}. Last state started with: ${last.slice(0, 300)}`)
  }

  async function findNodes(by, value, exactMatch = true) {
    const result = await mcp.callTool('android_find_nodes', {
      by,
      value,
      exact_match: exactMatch,
    })
    const text = textFromToolResult(result)
    const parsed = parseJsonFromToolText(text)
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed.nodes)) return parsed.nodes
    if (parsed.node) return [parsed.node]
    return []
  }

  async function tapResource(resourceId, fallbackText) {
    let nodes = await findNodes('resource_id', resourceId, true)
    if ((!nodes || nodes.length === 0) && fallbackText) {
      nodes = await findNodes('text', fallbackText, false)
    }
    if (!nodes || nodes.length === 0) {
      throw new Error(`Could not find node resource_id=${resourceId}${fallbackText ? ` or text=${fallbackText}` : ''}`)
    }
    const nodeId = nodes[0].node_id ?? nodes[0].id
    if (!nodeId) throw new Error(`Found node for ${resourceId}, but it had no node_id/id`)
    await mcp.callTool('android_tap_node', {
      node_id: nodeId,
      inset_percentage: 12,
    })
  }

  async function step(name, fn) {
    const started = Date.now()
    try {
      const detail = await fn()
      const entry = { name, status: 'PASS', ms: Date.now() - started, detail: detail ?? '' }
      results.push(entry)
      console.log(`PASS ${name}${entry.detail ? ` - ${entry.detail}` : ''}`)
    } catch (error) {
      const entry = {
        name,
        status: 'FAIL',
        ms: Date.now() - started,
        detail: error instanceof Error ? error.message : String(error),
      }
      results.push(entry)
      console.error(`FAIL ${name} - ${entry.detail}`)
      if (!KEEP_GOING) throw error
    }
  }

  await step('MCP connects and reads the tablet screen', async () => {
    const state = await screen()
    expectMatch(state, /screen:\d+x\d+/, 'tablet dimensions')
    return (state.match(/pkg:[^\s]+/)?.[0] ?? 'screen state captured')
  })

  await step('CI-Spatial Tailscale app is live', async () => {
    const healthText = await getText(`${baseUrl}/health`)
    const health = JSON.parse(healthText)
    if (health.status !== 'ok') throw new Error(`Health status was ${health.status}`)
    return `base=${baseUrl}, mode=${health.mode ?? 'unknown'}, model=${health.model ?? 'unknown'}`
  })

  await step('Launch scanner in Chrome', async () => {
    await mcp.callTool('android_open_uri', {
      uri: scannerUrl,
      package_name: 'com.android.chrome',
    })
    await wait(5_000)
    const state = await waitForScreen(/Companion Scan/i, 20_000)
    expectMatch(state, /Start AR|Scan a room with live AR/i, 'scanner start control')
    expectMatch(state, /Connection is secure|ts\.net:5173/i, 'secure Tailscale Chrome URL')
    return scannerUrl
  })

  await step('Scanner exposes the main user controls', async () => {
    const state = await screen()
    for (const [label, pattern] of [
      ['video upload', /Upload a video/i],
      ['live AR start', /Start AR|Scan a room with live AR/i],
      ['capture', /Capture/i],
      ['menu', /Menu/i],
      ['viewer link', /Open 3D Viewer/i],
      ['stream keyframes', /Stream keyframes/i],
      ['auto capture', /Auto-capture/i],
      ['history', /Session history|Scan Memory/i],
      ['PWA install affordance', /Install/i],
    ]) {
      expectMatch(state, pattern, label)
    }
    return 'start, upload, capture, stream, auto-capture, history, viewer, install'
  })

  await step('Start mock AR scan and show the scanning HUD', async () => {
    await tapResource('start-ar-btn', 'Start AR')
    const state = await waitForScreen(/Capture|SCANNING|\d+ pts|tracking/i, 30_000)
    expectMatch(state, /Capture/i, 'capture button')
    expectMatch(state, /Menu/i, 'scan menu')
    return 'mock XR8 scan started'
  })

  await step('Capture one frame and surface a latest-scan result', async () => {
    await wait(1_500)
    await tapResource('capture-btn', 'Capture')
    const state = await waitForScreen(/sofa|tv|table|plant|chair|lamp|shelf|bed|[1-9]\d*\s+objects?|Capture failed/i, 45_000)
    if (/Capture failed/i.test(state)) throw new Error('Capture failed according to HUD status')
    expectMatch(state, /sofa|tv|table|plant|chair|lamp|shelf|bed|[1-9]\d*\s+objects?/i, 'detected object feedback')
    return 'capture completed'
  })

  await step('Open review/export panel', async () => {
    await tapResource('finish-scan-btn', 'Menu')
    const state = await waitForScreen(/Export GLB|Export Summary|Generate Floor Plan|Object Report|Start Live Stream/i, 15_000)
    for (const [label, pattern] of [
      ['GLB export', /Export GLB/i],
      ['summary export', /Export Summary/i],
      ['floor plan generation', /Generate Floor Plan/i],
      ['object report', /Object Report/i],
      ['live stream', /Start Live Stream/i],
    ]) {
      expectMatch(state, pattern, label)
    }
    return 'review, export, reporting, and live stream controls visible'
  })

  await step('Open session history', async () => {
    await tapResource('history-btn', 'Session history')
    const state = await waitForScreen(/Scan Memory/i, 10_000)
    expectMatch(state, /Scan Memory/i, 'history drawer')
    return 'history drawer visible'
  })

  await step('Open world viewer/editor', async () => {
    await mcp.callTool('android_open_uri', {
      uri: viewerUrl,
      package_name: 'com.android.chrome',
    })
    await wait(5_000)
    const state = await waitForScreen(/World Editor|Default World|Layers|No scans uploaded|Scan/i, 30_000)
    expectMatch(state, /World Editor|Default World|Layers|Scan/i, 'viewer/editor shell')
    return viewerUrl
  })

  const outDir = join(process.cwd(), '.test-run')
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = join(outDir, `tablet-user-suite-${stamp}.json`)
  writeFileSync(outFile, JSON.stringify({
    createdAt: new Date().toISOString(),
    appBaseUrl: baseUrl,
    scannerUrl,
    viewerUrl,
    results,
  }, null, 2))

  const failures = results.filter((result) => result.status !== 'PASS')
  console.log(`\nWrote ${outFile}`)
  console.log(`${results.length - failures.length}/${results.length} tablet user checks passed`)
  if (failures.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
