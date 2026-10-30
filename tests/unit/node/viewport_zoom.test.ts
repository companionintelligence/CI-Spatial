/**
 * Pinch-zoom (WCAG 1.4.4): no page of this app may take it away.
 *
 * Three things do. A viewport tag with `user-scalable=no` or a `maximum-scale` under 5 (axe reports that one as
 * `meta-viewport`); `touch-action: none` on html or body, which locks every pinch whatever the tag says and which
 * axe never sees; and a gesturestart / gesturechange / gestureend handler that cancels iOS Safari's pinch, the old
 * way round a tag Safari ignores. scripts/check-viewport-zoom.mjs holds the rules, and the cases below keep each
 * one from passing by looking at nothing.
 *
 * `touch-action: none` stays on the canvases that own a gesture (the camera feed, the editor's 3D canvas), so a
 * pinch over them is still theirs. What cannot be settled here is how iOS Safari treats an unlocked page; that
 * is a device check.
 *
 * Run: npm run test:viewport
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  gestureProblems,
  htmlZoomProblems,
  rootTouchActionProblems,
  viewportProblems,
  zoomProblemsIn,
} from '../../../scripts/check-viewport-zoom.mjs'

const ROOT = resolve(import.meta.dirname, '../../..')
const SCRIPT = join(ROOT, 'scripts/check-viewport-zoom.mjs')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const meta = (content: string) => `<meta name="viewport" content="${content}" />`

// ── the pages in this repository ─────────────────────────────────────────────

test('no page in the repository blocks pinch-zoom', () => {
  assert.deepEqual(zoomProblemsIn(ROOT), [])
})

test('each page declares a viewport, so the check above is not looking at nothing', () => {
  // The six Vite entry pages (vite.config.ts), the smoke page served from public/, and the Scanner Control PWA.
  const pages = [
    'index.html',
    'scanner.html',
    'viewer.html',
    'webxr.html',
    'ar-hittest-sphere.html',
    'ar-ground-anchor.html',
    'public/smoke.html',
    'subsystems/osmo-ble/web/index.html',
  ]
  for (const page of pages) {
    const html = read(page)
    assert.match(html, /<meta name="viewport" content="width=device-width\b/, page)
    assert.deepEqual(viewportProblems(html, page), [], page)
  }
})

test('the canvases that own a gesture keep touch-action: none, and the page itself only has manipulation', () => {
  assert.match(read('index.html'), /#camerafeed \{[^}]*touch-action:\s*none/)
  assert.match(read('viewer.html'), /#viewport canvas \{\s*touch-action:\s*none/)
  for (const page of ['index.html', 'viewer.html', 'webxr.html']) {
    assert.match(read(page), /html,\s*body\s*\{[^}]*touch-action:\s*manipulation/, page)
  }
})

// ── viewport tags ────────────────────────────────────────────────────────────

const LOCKED: Array<[string, string]> = [
  ['user-scalable=no', 'width=device-width, initial-scale=1.0, user-scalable=no'],
  ['user-scalable=0', 'width=device-width, initial-scale=1, user-scalable=0'],
  ['maximum-scale=1.0', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover'],
  ['maximum-scale=1', 'width=device-width, initial-scale=1, maximum-scale=1'],
  ['maximum-scale=4', 'width=device-width, initial-scale=1, maximum-scale=4'],
  ['the tag this repo used to ship', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'],
  ['a semicolon list', 'width=device-width; initial-scale=1; user-scalable=no'],
]
for (const [name, content] of LOCKED) {
  test(`viewportProblems fails on ${name}`, () => {
    assert.ok(viewportProblems(meta(content), 'page.html').length > 0)
  })
}

const OPEN: Array<[string, string]> = [
  ['no limits', 'width=device-width, initial-scale=1.0'],
  ['viewport-fit', 'width=device-width, initial-scale=1.0, viewport-fit=cover'],
  ['user-scalable=yes', 'width=device-width, initial-scale=1, user-scalable=yes'],
  ['user-scalable=1', 'width=device-width, initial-scale=1, user-scalable=1'],
  ['maximum-scale=5', 'width=device-width, initial-scale=1, maximum-scale=5'],
  ['maximum-scale=10', 'width=device-width, initial-scale=1, maximum-scale=10'],
]
for (const [name, content] of OPEN) {
  test(`viewportProblems accepts ${name}`, () => {
    assert.deepEqual(viewportProblems(meta(content), 'page.html'), [])
  })
}

test('viewportProblems reads single-quoted, reordered and upper-case tags, and ignores a commented-out one', () => {
  assert.equal(viewportProblems(`<META CONTENT='width=device-width, user-scalable=no' NAME='viewport'>`).length, 1)
  assert.deepEqual(viewportProblems(`<!-- ${meta('user-scalable=no')} -->${meta('width=device-width')}`), [])
})

test('viewportProblems names the page and the tag, and ignores other meta tags', () => {
  const [problem] = viewportProblems(meta('maximum-scale=1'), 'viewer.html')
  assert.match(problem, /viewer\.html/)
  assert.match(problem, /maximum-scale=1/)
  assert.deepEqual(viewportProblems('<meta name="theme-color" content="user-scalable=no" />'), [])
})

// ── touch-action on the page ─────────────────────────────────────────────────

for (const css of [
  'html, body { touch-action: none; }',
  'body{touch-action:none}',
  'html { touch-action: pan-x pan-y; }',
  ':root { touch-action: pan-y }',
  'body.app { touch-action: none !important; }',
  '@media (max-width: 600px) { html, body { touch-action: none; } }',
  '/* the old rule */ html, body { width: 100%; touch-action: none; user-select: none }',
]) {
  test(`rootTouchActionProblems fails on ${css}`, () => {
    assert.ok(rootTouchActionProblems(css, 'page.css').length > 0)
  })
}

for (const css of [
  'html, body { touch-action: manipulation; }',
  'body { touch-action: pan-x pan-y pinch-zoom; }',
  'html { touch-action: auto; }',
  'canvas { touch-action: none; }',
  '#camerafeed { touch-action: none; }',
  '#viewport canvas { touch-action: none; }',
  'html, body { overflow: hidden; }',
  '/* html, body { touch-action: none; } */ body { color: red; }',
]) {
  test(`rootTouchActionProblems accepts ${css}`, () => {
    assert.deepEqual(rootTouchActionProblems(css, 'page.css'), [])
  })
}

test('htmlZoomProblems reads inline <style> blocks as well as the viewport tag', () => {
  const page = `<!doctype html><head>${meta('width=device-width')}<style>html,body{touch-action:none}</style></head>`
  assert.equal(htmlZoomProblems(page, 'page.html').length, 1)
})

// ── iOS gesture events ───────────────────────────────────────────────────────

test('gestureProblems fails on the handler this repo used to ship, in its loop form and written out', () => {
  const loop = `for (const evt of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(evt, (e) => e.preventDefault(), { passive: false })
  }`
  assert.equal(gestureProblems(loop, 'index.html').length, 1)
  assert.equal(gestureProblems(`document.addEventListener("gesturestart", (e) => { e.preventDefault() })`).length, 1)
  assert.match(gestureProblems(loop, 'index.html')[0], /index\.html: cancels gesturestart/)
})

test('gestureProblems accepts a gesture handler that does not cancel, and cancelling other events', () => {
  assert.deepEqual(gestureProblems(`document.addEventListener('gesturechange', (e) => console.log(e.scale))`), [])
  assert.deepEqual(gestureProblems(`document.addEventListener('dblclick', (e) => e.preventDefault())`), [])
})

// ── the command ──────────────────────────────────────────────────────────────

function inTempDir(files: Record<string, string>, run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'viewport-zoom-'))
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), text)
    }
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const cli = (...targets: string[]) => spawnSync(process.execPath, [SCRIPT, ...targets], { encoding: 'utf8' })

test('the command exits 1 and names the page when a page locks zoom', () => {
  inTempDir({ 'locked.html': `<!doctype html><head>${meta('width=device-width, user-scalable=no')}</head>` }, (dir) => {
    const result = cli(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /locked\.html/)
  })
})

test('the command exits 1 on a script under src/ that cancels the gesture events', () => {
  inTempDir({ 'src/zoom.ts': `for (const t of ['gesturestart']) addEventListener(t, (e) => e.preventDefault())` }, (dir) => {
    const result = cli(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /src\/zoom\.ts/)
  })
})

test('the command exits 0 for pages that can be zoomed, and skips node_modules and dist', () => {
  const locked = `<!doctype html><head>${meta('user-scalable=no')}</head>`
  inTempDir(
    {
      'ok.html': `<!doctype html><head>${meta('width=device-width, initial-scale=1')}</head>`,
      'node_modules/x/x.html': locked,
      'dist/x.html': locked,
    },
    (dir) => {
      const result = cli(dir)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /no page blocks pinch-zoom/)
    },
  )
})
