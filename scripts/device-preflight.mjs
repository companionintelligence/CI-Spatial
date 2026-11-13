#!/usr/bin/env node
/**
 * device-preflight.mjs — the checks a phone or tablet test silently depends on.
 *
 * Run it on the box that serves the app, before a device test starts:
 *
 *   npm run device:preflight
 *   HOST=my-box.example.ts.net npm run device:preflight   # when `tailscale` is not on PATH
 *
 * Every check goes through the same path a phone takes: Tailscale host, the Vite
 * HTTPS origin, and the Vite proxy into the Deno API. The native shells' CORS
 * origins and their built bundles are checked too.
 *
 * Exit 1 if any check FAILs. WARN means the test can still run, but a result may
 * mislead (for example, a shell bundle built against a different host).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VITE_PORT = process.env.VITE_PORT ?? '5173'
const API_PORT = process.env.PORT ?? '8000'

const results = []
const record = (status, name, detail) => results.push({ status, name, detail })

function tailscaleStatus() {
  try {
    return JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 5000 }))
  } catch {
    return null
  }
}

function resolveHost(ts) {
  if (process.env.HOST) return process.env.HOST
  const dns = ts?.Self?.DNSName
  return dns ? dns.replace(/\.$/, '') : null
}

async function checkHttp(name, url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    record(res.status === 200 ? 'PASS' : 'FAIL', name, `${res.status}  ${url}`)
    return res
  } catch (err) {
    record('FAIL', name, `${url}: ${err.cause?.code ?? err.message}`)
    return null
  }
}

/** The Access-Control-Allow-Origin a preflight from `origin` gets back, or null. */
function corsAllowOrigin(url, origin) {
  try {
    const out = execFileSync(
      'curl',
      ['-sk', '-m', '8', '-X', 'OPTIONS', '-H', `Origin: ${origin}`,
        '-H', 'Access-Control-Request-Method: POST', '-D', '-', '-o', '/dev/null', url],
      { encoding: 'utf8' },
    )
    const line = out.split(/\r?\n/).find((l) => /^access-control-allow-origin:/i.test(l))
    return line ? line.split(':').slice(1).join(':').trim() : null
  } catch {
    return null
  }
}

function swiftParses(file) {
  try {
    execFileSync('swiftc', ['-parse', file], { stdio: 'ignore', timeout: 60000 })
    return true
  } catch {
    return false
  }
}

async function main() {
  // ── Host and Tailscale ────────────────────────────────────────────────────
  const ts = tailscaleStatus()
  if (ts) {
    record(ts.BackendState === 'Running' ? 'PASS' : 'FAIL', 'tailscale running', ts.BackendState)
  } else {
    record('WARN', 'tailscale CLI', 'not on PATH; set HOST to test a specific host')
  }
  const host = resolveHost(ts)
  if (!host) {
    record('FAIL', 'host', 'no HOST env and no Tailscale DNS name')
    return
  }
  record('PASS', 'host', host)
  const base = `https://${host}:${VITE_PORT}`

  // ── Pages a phone or laptop opens ─────────────────────────────────────────
  await checkHttp('scanner page', `${base}/scanner.html?world=default`)
  await checkHttp('smoke page', `${base}/smoke.html`)
  await checkHttp('editor', `${base}/editor?project=default`)
  await checkHttp('webxr page', `${base}/webxr.html`)

  // ── Server, through the Vite proxy (the path a phone takes) ───────────────
  const health = await checkHttp('api health (via proxy)', `${base}/health`)
  if (health) {
    const body = await health.json().catch(() => null)
    const ready = body?.engineLoadState === 'ready'
    record(ready ? 'PASS' : 'FAIL', 'inference engine', ready ? `${body.model} ready` : `engineLoadState=${body?.engineLoadState ?? 'unknown'}`)
  }
  await checkHttp('projects api (via proxy)', `${base}/projects`)
  await checkHttp('api server (direct)', `http://localhost:${API_PORT}/health`)

  // ── Native shells: CORS origins the server must allow ─────────────────────
  for (const origin of ['capacitor://localhost', 'https://localhost']) {
    const allowed = corsAllowOrigin(`${base}/projects`, origin)
    record(allowed === origin ? 'PASS' : 'FAIL', `CORS for ${origin}`, allowed ?? 'no Access-Control-Allow-Origin in the preflight answer')
  }

  // ── Native shells: built against this host ────────────────────────────────
  const www = path.join(ROOT, 'mobile', 'www', 'assets')
  if (fs.existsSync(www)) {
    const built = fs.readdirSync(www)
      .filter((f) => f.endsWith('.js'))
      .some((f) => fs.readFileSync(path.join(www, f), 'utf8').includes(base))
    record(built ? 'PASS' : 'WARN', 'shell bundle host', built
      ? `built for ${base}`
      : `mobile/www was built for another host; rebuild: (cd mobile && VITE_API_BASE=${base} npm run build:web)`)
  } else {
    record('WARN', 'shell bundle', `mobile/www missing; build: (cd mobile && VITE_API_BASE=${base} npm run build:web)`)
  }

  // ── Android ───────────────────────────────────────────────────────────────
  const apk = path.join(ROOT, 'mobile', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
  record(fs.existsSync(apk) ? 'PASS' : 'WARN', 'android debug APK', fs.existsSync(apk)
    ? `${(fs.statSync(apk).size / 1048576).toFixed(1)} MB`
    : 'not built; (cd mobile/android && ./gradlew assembleDebug)')

  // ── iOS ───────────────────────────────────────────────────────────────────
  const spm = path.join(ROOT, 'mobile', 'ios', 'App', 'CapApp-SPM', 'Package.swift')
  record(fs.existsSync(spm) ? 'PASS' : 'FAIL', 'iOS package manifest', fs.existsSync(spm)
    ? 'CapApp-SPM/Package.swift present'
    : 'missing; (cd mobile && mkdir -p ios/App/CapApp-SPM && npx cap sync ios)')
  const plistPath = path.join(ROOT, 'mobile', 'ios', 'App', 'App', 'Info.plist')
  const plist = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, 'utf8') : ''
  for (const key of ['NSCameraUsageDescription', 'NSLocationWhenInUseUsageDescription', 'NSMotionUsageDescription']) {
    record(plist.includes(`<key>${key}</key>`) ? 'PASS' : 'FAIL', `iOS ${key}`,
      plist.includes(`<key>${key}</key>`) ? 'in Info.plist' : 'missing from Info.plist (the app crashes on that permission prompt)')
  }
  const swiftDir = path.join(ROOT, 'mobile', 'ios', 'App', 'App')
  if (fs.existsSync(swiftDir)) {
    const files = fs.readdirSync(swiftDir).filter((f) => f.endsWith('.swift')).map((f) => path.join(swiftDir, f))
    if (files.length === 0) {
      record('WARN', 'iOS Swift sources', 'none found')
    } else if (!shell('command -v swiftc')) {
      record('WARN', 'iOS Swift sources', 'swiftc not installed; syntax not checked')
    } else {
      const bad = files.filter((f) => !swiftParses(f))
      record(bad.length === 0 ? 'PASS' : 'FAIL', 'iOS Swift sources parse', bad.length === 0 ? `${files.length} file(s)` : `failed: ${bad.map((f) => path.basename(f)).join(', ')}`)
    }
  }
}

function shell(cmd) {
  try {
    execFileSync('sh', ['-c', cmd], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

await main()

const width = Math.max(...results.map((r) => r.name.length), 10)
for (const r of results) {
  console.log(`${r.status.padEnd(5)} ${r.name.padEnd(width)}  ${r.detail}`)
}
const fails = results.filter((r) => r.status === 'FAIL').length
const warns = results.filter((r) => r.status === 'WARN').length
console.log(`\n${results.length - fails - warns} passed, ${warns} warning(s), ${fails} failed`)

const host = results.find((r) => r.name === 'host')?.detail
if (host && fails === 0) {
  const b = `https://${host}:${VITE_PORT}`
  console.log('\nPhone and laptop URLs:')
  console.log(`  scanner   ${b}/scanner.html?world=default`)
  console.log(`  smoke     ${b}/smoke.html?debug=remote        (run this first: 60-second triage)`)
  console.log(`  editor    ${b}/editor?project=default         (desktop Place Scan Editor)`)
  console.log(`  webxr     ${b}/webxr.html                     (Android Chrome, Quest)`)
  console.log('\nQR for a phone: npm run qr -- "/smoke.html?debug=remote"')
}
process.exitCode = fails > 0 ? 1 : 0
