#!/usr/bin/env -S deno run -A
/**
 * End-to-end room scan: photos in, splat out, no GPU box and no manual steps.
 *
 *   deno run -A scripts/scan-room.ts <session-id> [--iters 15000] [--no-finish]
 *   deno run -A scripts/scan-room.ts --pool <id-a> <id-b> … --as <new-session-id>
 *
 * Runs the same drivers the world-job coordinator runs — `runSplatTrain`
 * (which auto-chains `runColmapPoses` for a pose-less session) and
 * `runSplatFinish` — so a green run here means the `colmap-poses` →
 * `splat-train` → `splat-finish` job chain is healthy, not just that a
 * one-off script works.
 *
 * Exit codes are meaningful so this can gate CI: 0 = ok, 1 = a stage failed,
 * 2 = a stage skipped (a missing optional tool, or a capture SfM cannot
 * solve). A skip is deliberately *not* success — a pipeline that quietly
 * produces nothing is the failure mode this whole exercise started from.
 *
 * `--pool` exists because a single short capture often lacks the parallax
 * structure-from-motion needs. Pooling several captures of the same room
 * supplies cross-capture baselines, which is what lifted the reference scan
 * from 4 of 9 registered images to 20 of 22.
 */
import { runSplatTrain } from '../server/splat/splat_train.ts'
import { runSplatFinish } from '../server/splat/splat_finish.ts'

const SCANS = Deno.env.get('SCANS_DIR') ?? `${Deno.cwd()}/scans`
const SESSIONS = `${SCANS}/sessions`

function fail(msg: string): never {
  console.error(`error: ${msg}`)
  Deno.exit(1)
}

/** Merge several sessions' keyframes into one, renumbering to stay contiguous. */
async function pool(ids: string[], target: string): Promise<string> {
  const dir = `${SESSIONS}/${target}`
  await Deno.remove(dir, { recursive: true }).catch(() => {})
  await Deno.mkdir(dir, { recursive: true })

  let n = 0
  const lines: string[] = []
  for (const id of ids) {
    const src = `${SESSIONS}/${id}`
    const names: string[] = []
    for await (const e of Deno.readDir(src)) {
      if (e.isFile && /^kf-\d+\.jpg$/.test(e.name)) names.push(e.name)
    }
    for (const name of names.sort()) {
      const dest = `kf-${String(n).padStart(5, '0')}.jpg`
      await Deno.copyFile(`${src}/${name}`, `${dir}/${dest}`)
      lines.push(JSON.stringify({ index: n, file: dest, timestamp: n * 100, sourceSession: id }))
      n++
    }
  }
  if (n === 0) fail(`no keyframes found across: ${ids.join(', ')}`)
  await Deno.writeTextFile(`${dir}/keyframes.jsonl`, lines.join('\n') + '\n')
  await Deno.writeTextFile(
    `${dir}/session.json`,
    JSON.stringify({ sessionId: target, source: 'photo-ingest', frameCount: n, keyframeCount: n }, null, 2),
  )
  console.log(`pooled ${n} keyframes from ${ids.length} session(s) → ${target}`)
  return target
}

const args = [...Deno.args]
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  const v = args[i + 1] ?? fallback
  args.splice(i, 2)
  return v
}
const has = (name: string): boolean => {
  const i = args.indexOf(name)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}

const iters = Number.parseInt(flag('--iters', '15000'), 10)
const skipFinish = has('--no-finish')

let sessionId: string
if (has('--pool')) {
  const as = flag('--as', `sess-pooled-${Date.now()}`)
  const ids = args.filter((a) => !a.startsWith('--'))
  if (ids.length === 0) fail('--pool needs at least one session id')
  sessionId = await pool(ids, as)
} else {
  sessionId = args.find((a) => !a.startsWith('--')) ?? ''
  if (!sessionId) fail('usage: scan-room.ts <session-id> [--iters N] [--no-finish]')
}

const sessionDir = `${SESSIONS}/${sessionId}`
try {
  if (!(await Deno.stat(sessionDir)).isDirectory) fail(`not a directory: ${sessionDir}`)
} catch {
  fail(`no such session: ${sessionDir}`)
}

const base = `${sessionId}-scan`
const outputPlyPath = `${SCANS}/${base}.splat.ply`

console.log(`\n▸ train  (auto-solves poses when the session has none)`)
const train = await runSplatTrain({ sessionDir, outputPlyPath, trainIters: iters })
console.log(`  status ${train.status}  frames ${train.manifest.frameCount ?? '-'}  gaussians ${train.gaussianCount ?? '-'}`)

if (train.status === 'skipped') {
  console.error(`  skipped: ${train.manifest.skippedReason}`)
  if (train.manifest.remediation) console.error(`  fix: ${train.manifest.remediation}`)
  Deno.exit(2)
}
if (train.status !== 'ok') {
  console.error(`  error: ${train.manifest.error}`)
  console.error(train.log.slice(-1500))
  Deno.exit(1)
}

if (!skipFinish) {
  console.log(`\n▸ finish (SOG + compressed PLY for delivery)`)
  const finish = await runSplatFinish({
    splatPlyPath: outputPlyPath,
    outputSogPath: `${SCANS}/${base}.sog`,
    outputCompressedPlyPath: `${SCANS}/${base}.compressed.ply`,
  })
  console.log(`  status ${finish.status}`)
  if (finish.status === 'ok' && finish.manifest.sizes) {
    const s = finish.manifest.sizes
    const pct = (n?: number | null) => (n && s.inputBytes ? `${Math.round((n / s.inputBytes) * 100)}%` : '-')
    console.log(`  ${s.inputBytes} B → sog ${s.sogBytes} B (${pct(s.sogBytes)})  compressed ${s.compressedBytes} B (${pct(s.compressedBytes)})`)
  } else if (finish.status === 'skipped') {
    console.error(`  skipped: ${finish.manifest.skippedReason}`)
    Deno.exit(2)
  }
}

console.log(`\n✓ ${base}.splat.ply — ${train.gaussianCount} gaussians from ${train.manifest.frameCount} frames`)
