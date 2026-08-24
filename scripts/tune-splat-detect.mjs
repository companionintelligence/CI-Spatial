#!/usr/bin/env node
/**
 * tune-splat-detect.mjs — calibrate splat-detect on a REAL room splat.
 *
 * The splat_analyzer spike showed detection quality is decided by the
 * clustering knobs (score_threshold / min_votes / min_peak_score) and the
 * camera-coverage quality, NOT by the pipeline — default min_votes=8 returned
 * 0 objects on a sparse scene, min_votes=2 recovered real ones. But those
 * numbers can only be picked against a real trained room splat (the synthetic
 * fixtures are furniture-free). This runs the sweep, writes one interactions
 * JSON per parameter set, and prints a comparison table so you can eyeball the
 * winner and set it as the SPLAT_DETECT_* env defaults (see
 * ../docs/pipelines/SPLAT_DETECT_ROADMAP.md, Phase 1).
 *
 *   node scripts/tune-splat-detect.mjs <trained-splat.ply> [--prompt "sofa, bed, tv"]
 *     [--out <dir>] [--quality medium] [--grid votes=2,4,8;score=0.08,0.12;peak=0.3,0.4]
 *
 * Runs on GPU1 (HIP_VISIBLE_DEVICES=1) via the splat_analyzer venv. Each run is
 * ~15s (low) to a few min (high); a default 3×2×2 grid at medium is ~20-40 min.
 * View the boxes for the chosen set by loading <out>/<tag>.interactions.json in
 * the editor's Splat Toolbox (copy it next to a scan as <base>.interactions.json).
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0].startsWith('--')) {
  console.error('usage: node scripts/tune-splat-detect.mjs <trained-splat.ply> [--prompt "..."] [--out <dir>] [--quality medium] [--grid votes=2,4,8;score=0.08,0.12;peak=0.3,0.4]')
  process.exit(2)
}
const PLY = path.resolve(argv[0])
const args = parseArgs(argv.slice(1))
const PROMPT = args.prompt || 'sofa, chair, table, tv, lamp, plant, bed, desk, shelf, door, window, refrigerator, sink, toilet, couch'
const QUALITY = args.quality || 'medium'
const OUT = path.resolve(args.out || './splat-detect-tune-out')
const PY = process.env.SPLAT_DETECT_PYTHON || path.join(homedir(), '.venvs/splat-analyzer/bin/python')
const SA_DIR = process.env.SPLAT_DETECT_DIR || path.join(homedir(), 'splat_analyzer')

const grid = parseGrid(args.grid || 'votes=2,4,8;score=0.08,0.12;peak=0.3,0.4')

function parseArgs(list) {
  const out = {}
  for (let i = 0; i < list.length; i += 2) out[list[i].replace(/^--/, '')] = list[i + 1]
  return out
}
function parseGrid(spec) {
  const g = { votes: [8], score: [0.12], peak: [0.4] }
  for (const part of spec.split(';')) {
    const [k, v] = part.split('=')
    if (g[k] && v) g[k] = v.split(',').map(Number)
  }
  return g
}

async function countObjects(jsonPath) {
  try {
    const j = JSON.parse(await readFile(jsonPath, 'utf8'))
    const arr = Array.isArray(j) ? j : j.objects || j.interactions || []
    const labels = {}
    for (const o of arr) { const l = o.label || o.name || '?'; labels[l] = (labels[l] || 0) + 1 }
    return { count: arr.length, labels }
  } catch { return { count: 0, labels: {} } }
}

async function main() {
  if (!existsSync(PLY)) { console.error(`no such splat: ${PLY}`); process.exit(1) }
  if (!existsSync(path.join(SA_DIR, 'run_local.py'))) { console.error(`splat_analyzer not found at ${SA_DIR}`); process.exit(1) }
  await mkdir(OUT, { recursive: true })

  console.log(`[tune] splat=${path.basename(PLY)}  quality=${QUALITY}  prompt="${PROMPT}"`)
  console.log(`[tune] grid: votes=${grid.votes} score=${grid.score} peak=${grid.peak}`)
  const rows = []
  for (const votes of grid.votes) {
    for (const score of grid.score) {
      for (const peak of grid.peak) {
        const tag = `v${votes}_s${score}_p${peak}`
        const jobDir = path.join(OUT, tag)
        await mkdir(jobDir, { recursive: true })
        const t0 = Date.now()
        process.stdout.write(`[tune] ${tag} … `)
        try {
          await run(PY, [
            path.join(SA_DIR, 'run_local.py'),
            '--ply', PLY, '--prompt', PROMPT,
            '--quality', QUALITY, '--renderer', 'point',
            '--min_votes', String(votes), '--score_threshold', String(score), '--min_peak_score', String(peak),
            '--job_dir', jobDir,
          ], { env: { ...process.env, HIP_VISIBLE_DEVICES: process.env.HIP_VISIBLE_DEVICES || '1', WMD_DEVICE: 'cuda', POINT_SPLAT_SIZE: process.env.POINT_SPLAT_SIZE || '6' }, maxBuffer: 64 * 1024 * 1024 })
          const interactions = path.join(jobDir, 'interactions.json')
          const dest = path.join(OUT, `${tag}.interactions.json`)
          if (existsSync(interactions)) await writeFile(dest, await readFile(interactions))
          const { count, labels } = await countObjects(interactions)
          const secs = ((Date.now() - t0) / 1000).toFixed(0)
          const summary = Object.entries(labels).map(([l, n]) => `${l}×${n}`).join(' ')
          console.log(`${count} objects (${secs}s)  ${summary}`)
          rows.push({ tag, votes, score, peak, count, labels: summary, secs })
        } catch (e) {
          console.log(`ERROR: ${(e.stderr || e.message || '').toString().slice(0, 200)}`)
          rows.push({ tag, votes, score, peak, count: -1, labels: 'error', secs: '-' })
        }
      }
    }
  }

  // Markdown summary — the artifact you review to pick the winner.
  const md = [
    `# splat-detect calibration — ${path.basename(PLY)}`,
    ``,
    `Prompt: \`${PROMPT}\`  ·  quality: ${QUALITY}`,
    ``,
    `| votes | score | peak | objects | labels | secs |`,
    `|------:|------:|-----:|--------:|--------|-----:|`,
    ...rows.map((r) => `| ${r.votes} | ${r.score} | ${r.peak} | ${r.count} | ${r.labels} | ${r.secs} |`),
    ``,
    `Pick the row whose boxes best match the room (load \`<tag>.interactions.json\` in the`,
    `editor's Splat Toolbox next to the scan), then set in ~/.config/cscan/env:`,
    `\`\`\``,
    `SPLAT_DETECT_QUALITY=${QUALITY}`,
    `SPLAT_DETECT_MIN_VOTES=<votes>`,
    `SPLAT_DETECT_SCORE_THRESHOLD=<score>`,
    `SPLAT_DETECT_MIN_PEAK_SCORE=<peak>`,
    `\`\`\``,
  ].join('\n')
  await writeFile(path.join(OUT, 'REPORT.md'), md)
  console.log(`\n[tune] wrote ${path.join(OUT, 'REPORT.md')} — review it, load the best <tag>.interactions.json in the editor, then set the SPLAT_DETECT_* env.`)
}

main().catch((e) => { console.error('[tune] failed:', e.message ?? e); process.exit(1) })
