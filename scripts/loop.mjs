#!/usr/bin/env node
/**
 * The development loop — tiered gates, fastest signal first, baseline-aware.
 *
 * Why this exists
 * ---------------
 * Two things are true of this repo right now, and together they make the
 * ordinary "just run the tests" advice useless:
 *
 *   1. GitHub Actions is budget-exhausted, so every hosted run reports failure
 *      without executing a single step. `main` is red for this reason, not for
 *      a code reason. Local verification is the only real signal.
 *
 *   2. The Playwright suite is broadly red and has been for a long time —
 *      measured 28 failed / 34 passed / 23 skipped on `main` with no local
 *      changes. `mock-ftue` alone had been failing since #128, asserting copy
 *      the markup no longer had. Nothing ran it, so nothing said so.
 *
 * A gate that fails on all 28 every run teaches you to ignore it, which is how
 * the suite got here. So this loop is *baseline-aware*: it knows which tests
 * are already failing and fails the build only on a CHANGE — a new failure, or
 * a baselined test that started passing. The second case matters as much as the
 * first: it is how the baseline shrinks instead of quietly becoming permanent.
 *
 * Usage
 * -----
 *   node scripts/loop.mjs                 # tiers 0-3 (the fast loop, ~3 min)
 *   node scripts/loop.mjs --tier=4        # everything, including reconstruction
 *   node scripts/loop.mjs --only=ui       # one tier by name
 *   node scripts/loop.mjs --update-baseline
 *   node scripts/loop.mjs --json          # machine-readable scorecard
 *
 * Exit codes: 0 clean or no-change, 1 regression, 2 loop error.
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'tests', 'known-failures.json')

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const has = (name) => argv.includes(`--${name}`)

const maxTier = Number(arg('tier', '3'))
const only = arg('only')
const asJson = has('json')
const updateBaseline = has('update-baseline')

/**
 * Tiers run in order and stop at the first failure, because a type error makes
 * every downstream result meaningless — there is no value in watching
 * Playwright act out a build that does not compile.
 *
 * `parse: 'playwright'` marks a tier whose failures are matched against the
 * baseline rather than treated as fatal on sight.
 */
const TIERS = [
  {
    n: 0,
    name: 'types',
    why: 'nothing downstream means anything if it does not compile',
    steps: [
      ['npx', ['tsc', '--noEmit']],
      ['npm', ['run', '--silent', 'typecheck:tests']],
      ['deno', ['task', 'check']],
    ],
  },
  {
    n: 1,
    name: 'unit',
    why: 'pure logic — the Umeyama fit, place clustering, job dedupe, the word budget',
    // The startup word budget is the one node-suite test in here, because it
    // is the one this loop used to catch only in T3: the same ceiling, checked
    // against index.html and resolveCapture() instead of against a rendered
    // page, so it answers in a second and without a Vite server. T3 still
    // measures the DOM and holds the model to it.
    steps: [
      ['deno', ['task', 'test']],
      ['npm', ['run', '--silent', 'test:startup:budget']],
    ],
  },
  {
    n: 2,
    name: 'contracts',
    why: 'detection quality against a synthetic corpus, no model or GPU',
    steps: [
      ['npm', ['run', '--silent', 'check:detection-gate']],
      ['npm', ['run', '--silent', 'gate:mock']],
    ],
    env: { BASE_REF: process.env.BASE_REF || 'origin/main' },
  },
  {
    n: 3,
    name: 'ui',
    why: 'the startup budgets — steps, words, and how much covers the camera',
    parse: 'playwright',
    steps: [[
      'npx',
      ['playwright', 'test', '--project=chromium-mock', '--reporter=json',
       'mock-scanner-startup-budget', 'mock-ftue'],
    ]],
  },
  {
    n: 4,
    name: 'pipeline',
    why: 'a real session reconstructs, and lands metric',
    steps: [['node', ['scripts/loop-pipeline-check.mjs']]],
  },
  {
    // Opt-in (--tier=5): ~17 minutes, and 28 of these are red before you start.
    // This is the tier the baseline exists for — it turns an unusable wall of
    // failures into one useful question: did *this* change break anything, and
    // did anything get better? Run it before pushing, not on every save.
    n: 5,
    name: 'ui-full',
    why: 'the whole mock suite, gated on change rather than on green',
    parse: 'playwright',
    steps: [['npx', ['playwright', 'test', '--project=chromium-mock', '--reporter=json']]],
  },
]

function run(cmd, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => resolve({ code: 127, out, err: String(e) }))
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }))
  })
}

/** Stable id for a Playwright test: file + full title, ignoring line numbers. */
function testId(suiteFile, titlePath) {
  return `${suiteFile} › ${titlePath.filter(Boolean).join(' › ')}`
}

/** Collect failing test ids from Playwright's JSON reporter. */
function parsePlaywright(stdout) {
  const start = stdout.indexOf('{')
  if (start < 0) return null
  let report
  try { report = JSON.parse(stdout.slice(start)) } catch { return null }
  const failed = new Set(), passed = new Set()
  const walk = (suite, trail = []) => {
    const here = [...trail, suite.title].filter(Boolean)
    for (const spec of suite.specs ?? []) {
      const id = testId(spec.file ?? here[0] ?? '?', [...here.slice(1), spec.title])
      // ok=false only when every retry failed; a test green on retry is flaky,
      // not a regression, and is reported separately rather than gating.
      ;(spec.ok ? passed : failed).add(id)
    }
    for (const child of suite.suites ?? []) walk(child, here)
  }
  for (const suite of report.suites ?? []) walk(suite)
  return { failed: [...failed].sort(), passed: [...passed].sort() }
}

function loadBaseline() {
  if (!existsSync(BASELINE)) return { knownFailures: [], missing: true }
  try { return { ...JSON.parse(readFileSync(BASELINE, 'utf8')), missing: false } }
  catch { return { knownFailures: [], missing: true } }
}

const C = process.stdout.isTTY && !asJson
const paint = (code, s) => (C ? `[${code}m${s}[0m` : s)
const dim = (s) => paint(2, s), bold = (s) => paint(1, s)
const green = (s) => paint(32, s), red = (s) => paint(31, s), yellow = (s) => paint(33, s)

async function main() {
  const selected = TIERS.filter((t) => (only ? t.name === only : t.n <= maxTier))
  if (selected.length === 0) {
    console.error(`no tier matched (--only=${only} --tier=${maxTier})`)
    process.exit(2)
  }

  const baseline = loadBaseline()
  const known = new Set(baseline.knownFailures ?? [])
  const scorecard = []
  let regressed = false
  let newlyPassing = []

  for (const tier of selected) {
    const t0 = Date.now()
    if (!asJson) process.stdout.write(`${bold(`T${tier.n} ${tier.name}`)} ${dim('— ' + tier.why)}\n`)

    let ok = true, detail = ''
    let pwResult = null

    for (const [cmd, args] of tier.steps) {
      const { code, out, err } = await run(cmd, args, tier.env)
      if (tier.parse === 'playwright') {
        pwResult = parsePlaywright(out)
        if (!pwResult) { ok = false; detail = 'could not parse the Playwright report'; break }
        continue
      }
      if (code !== 0) {
        ok = false
        const lines = (err || out).trim().split('\n')
        detail = lines.slice(-12).join('\n')
        break
      }
    }

    // Baseline comparison for the Playwright tier.
    if (pwResult) {
      const failedNow = new Set(pwResult.failed)
      const newFailures = [...failedNow].filter((id) => !known.has(id))
      const fixed = [...known].filter((id) => pwResult.passed.includes(id))
      newlyPassing = fixed

      if (updateBaseline) {
        writeFileSync(BASELINE, `${JSON.stringify({
          note: 'Tests already failing when the loop was introduced. The loop gates on CHANGE, '
              + 'not on this list being empty. Shrink it; never grow it without saying why.',
          updatedAt: new Date().toISOString().slice(0, 10),
          knownFailures: [...failedNow].sort(),
        }, null, 2)}\n`)
        detail = `baseline written: ${failedNow.size} known failures`
      } else if (baseline.missing) {
        // First run on a machine with no baseline. Every existing failure would
        // otherwise read as a regression and fail the build on arrival, which
        // is the "gate that cries wolf" this design exists to avoid. Report and
        // pass; the run that records the baseline is the one that arms it.
        detail = `${pwResult.passed.length} passed, ${failedNow.size} failing — `
               + `no baseline yet, so nothing is gated.\n`
               + `  Record one with: npm run loop:baseline`
      } else if (newFailures.length > 0) {
        ok = false
        regressed = true
        detail = `${newFailures.length} NEW failure(s):\n  ${newFailures.join('\n  ')}`
      } else {
        detail = `${pwResult.passed.length} passed, ${failedNow.size} known-red`
        if (fixed.length > 0) {
          detail += `\n  ${green('↑')} ${fixed.length} baselined test(s) now pass — remove them:`
                 +  `\n  ${fixed.join('\n  ')}`
        }
      }
    }

    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    scorecard.push({ tier: tier.n, name: tier.name, ok, seconds: +secs, detail })

    if (!asJson) {
      process.stdout.write(`  ${ok ? green('PASS') : red('FAIL')} ${dim(`${secs}s`)}\n`)
      if (detail) process.stdout.write(`${detail.split('\n').map((l) => `    ${l}`).join('\n')}\n`)
      process.stdout.write('\n')
    }

    if (!ok) {
      if (asJson) console.log(JSON.stringify({ ok: false, regressed, scorecard }, null, 2))
      else {
        process.stdout.write(`${red('✗')} stopped at T${tier.n} ${tier.name}\n`)
        if (!regressed) {
          process.stdout.write(dim('  Not a baselined-test problem — this tier failed outright.\n'))
        }
      }
      process.exit(1)
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: true, regressed: false, newlyPassing, scorecard }, null, 2))
  } else {
    const total = scorecard.reduce((a, s) => a + s.seconds, 0).toFixed(1)
    process.stdout.write(`${green('✓')} ${scorecard.length} tier(s) clean in ${total}s\n`)
    if (newlyPassing.length > 0) {
      process.stdout.write(yellow(`  ${newlyPassing.length} baselined test(s) now pass — `)
        + `run with --update-baseline to shrink the list.\n`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(2) })
