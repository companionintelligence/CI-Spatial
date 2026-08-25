/**
 * The 4d-capture HTTP service.
 *
 * Three routes, and one property that matters more than any of them:
 * **submission is idempotent on `takeId`.**
 *
 * Companion Scan's job pump requeues every in-flight job unconditionally on
 * boot (requeue-always is type-agnostic by design, ADR 0003). For a local job
 * that costs time; for a job that occupies a rented GPU for 25 minutes it costs
 * money, twice. The appliance re-attaches rather than resubmitting, and this
 * side refuses to start a second run for a take it already has — correctness
 * should not depend on only one end behaving.
 *
 * No framework: the surface is three routes and adding a dependency tree to a
 * subsystem that must run on someone else's GPU box is not worth it.
 */
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { runTake } from './pipeline.mjs'

const PORT = Number(process.env.PORT || 9040)
const WORK_DIR = process.env.WORK_DIR || path.join(process.cwd(), 'work')
const STUB = process.argv.includes('--stub') || process.env.STUB_MODE === '1'

/** takeId → job record. In-memory: a restart loses progress, and the appliance re-submits. */
const takes = new Map()

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

function startTake(take) {
  const record = {
    takeId: take.takeId,
    status: 'running',
    stage: 'queued',
    progress: 0,
    startedAt: new Date().toISOString(),
  }
  takes.set(take.takeId, record)

  // Deliberately not awaited: submit returns immediately and the appliance polls.
  runTake(take, {
    workDir: WORK_DIR,
    stub: STUB,
    onProgress: (progress, stage) => {
      record.progress = progress
      record.stage = stage
    },
  }).then(result => {
    Object.assign(record, result, { finishedAt: new Date().toISOString() })
    if (!record.status) record.status = 'error'
  }).catch(err => {
    // A throw here must still land as a reportable state, never a silent hang.
    Object.assign(record, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      finishedAt: new Date().toISOString(),
    })
  })

  return record
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, stub: STUB, takes: takes.size })
  }

  if (req.method === 'POST' && url.pathname === '/takes') {
    const body = await readBody(req)
    if (!body.takeId || !Array.isArray(body.clips)) {
      return json(res, 400, { error: 'takeId and clips[] are required' })
    }
    const existing = takes.get(body.takeId)
    if (existing) {
      // Idempotent: re-attach rather than start a second GPU run.
      return json(res, 202, { takeId: body.takeId, jobId: body.takeId, attached: true })
    }
    startTake(body)
    return json(res, 202, { takeId: body.takeId, jobId: body.takeId, attached: false })
  }

  const statusMatch = /^\/takes\/([^/]+)$/.exec(url.pathname)
  if (req.method === 'GET' && statusMatch) {
    const record = takes.get(decodeURIComponent(statusMatch[1]))
    if (!record) return json(res, 404, { error: 'unknown take' })
    return json(res, 200, record)
  }

  const seqMatch = /^\/takes\/([^/]+)\/sequence$/.exec(url.pathname)
  if (req.method === 'GET' && seqMatch) {
    const record = takes.get(decodeURIComponent(seqMatch[1]))
    if (!record || record.status !== 'ok') return json(res, 404, { error: 'no finished sequence' })
    let frames = []
    try {
      frames = (await readdir(record.sequenceDir)).filter(f => /^frame-\d{5}\.(sog|ply)$/.test(f)).sort()
    } catch { /* directory vanished */ }
    return json(res, 200, { ...record, frames })
  }

  // GET /takes/:takeId/frames/:frame — one trained timestep.
  //
  // The appliance pulls these back to where it serves from; the subsystem's
  // work directory is not reachable by a browser.
  const frameMatch = /^\/takes\/([^/]+)\/frames\/([^/]+)$/.exec(url.pathname)
  if (req.method === 'GET' && frameMatch) {
    const record = takes.get(decodeURIComponent(frameMatch[1]))
    const frame = decodeURIComponent(frameMatch[2])
    // Allowlist, not a sanitiser — these names are fully determined by the
    // trainer, so anything else is not a frame.
    if (!record || record.status !== 'ok' || !/^frame-\d{5}\.(sog|ply)$/.test(frame)) {
      return json(res, 404, { error: 'not found' })
    }
    try {
      const bytes = await readFile(path.join(record.sequenceDir, frame))
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length })
      return res.end(bytes)
    } catch {
      return json(res, 404, { error: 'frame not found' })
    }
  }

  json(res, 404, { error: 'not found' })
})

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`[4d-capture] listening on :${PORT}${STUB ? ' (STUB MODE — no GPU, synthetic sequence)' : ''}`)
    if (!STUB && !process.env.FDANYONE_DIR) {
      console.warn('[4d-capture] FDANYONE_DIR is not set — single-clip takes will report "skipped"')
    }
  })
}

export { server, startTake, takes }
