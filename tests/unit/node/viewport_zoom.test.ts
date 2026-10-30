/**
 * Pinch-zoom (WCAG 1.4.4): no page of this app may take it away.
 *
 * Three things do. A viewport tag with `user-scalable=no` or a `maximum-scale` under 5 (axe reports that one as
 * `meta-viewport`); `touch-action: none` on html or body, which locks every pinch whatever the tag says and which
 * axe never sees; and a gesturestart / gesturechange / gestureend handler that cancels iOS Safari's pinch, the old
 * way round a tag Safari ignores. scripts/check-viewport-zoom.mjs holds the rules, and the cases below keep each
 * one from passing by looking at nothing.
 *
 * Unlocking zoom has one cost: iOS Safari zooms the page into a focused field whose text is under 16px, and the
 * tag used to prevent that. So a page with text fields also needs a touch-screen rule that keeps them at 16px.
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  focusZoomProblems,
  gestureProblems,
  hasCoarsePointerFieldFloor,
  hasTextFields,
  htmlZoomProblems,
  inlineRootStyleProblems,
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

test('the pages with text fields keep them at 16px on touch screens, so iOS does not zoom into them', () => {
  // viewer.html and Scanner Control have their fields in the markup, which is what the repository-wide check above
  // sees. index.html builds its fields in src/ (main.ts, ui/panel.ts, ui/history.ts, ar/project-calibration.ts), so
  // the checker cannot tell it needs the rule: it is named here by hand.
  const withFields = ['viewer.html', 'subsystems/osmo-ble/web/index.html']
  for (const page of withFields) assert.ok(hasTextFields(read(page)), `${page} has text fields in its markup`)
  for (const page of ['index.html', ...withFields]) {
    assert.ok(hasCoarsePointerFieldFloor(read(page)), `${page} sets its fields to 16px under (pointer: coarse)`)
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
  ['a space-separated list', 'width=device-width initial-scale=1 user-scalable=no'],
  ['spaces round the equals sign', 'width = device-width, initial-scale = 1, maximum-scale = 1'],
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

test('viewportProblems reads single-quoted, unquoted, reordered and upper-case tags, and ignores a commented-out one', () => {
  assert.equal(viewportProblems(`<META CONTENT='width=device-width, user-scalable=no' NAME='viewport'>`).length, 1)
  assert.equal(viewportProblems('<meta name=viewport content=width=device-width,user-scalable=no>').length, 1)
  assert.deepEqual(viewportProblems('<meta name=viewport content=width=device-width,initial-scale=1>'), [])
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

// A style attribute on <html> or <body> is the same lock as a stylesheet rule on them.
for (const html of [
  '<body style="touch-action: none">',
  `<html lang="en" style='touch-action:pan-x'>`,
  '<BODY CLASS="app" STYLE="margin:0;touch-action:none;color:red">',
  '<body\n  data-x="1"\n  style="touch-action: pan-y"\n>',
]) {
  test(`inlineRootStyleProblems fails on ${JSON.stringify(html)}`, () => {
    const [problem, ...rest] = inlineRootStyleProblems(html, 'page.html')
    assert.match(problem, /page\.html \(style attribute\)/)
    assert.deepEqual(rest, [])
    assert.equal(htmlZoomProblems(`${meta('width=device-width')}${html}`, 'page.html').length, 1)
  })
}

for (const html of [
  '<body style="touch-action: manipulation">',
  '<html style="touch-action:pan-x pinch-zoom">',
  '<canvas style="touch-action: none"></canvas>',
  '<div id="body" style="touch-action:none"></div>',
  '<body style="color: red">',
  '<body>',
  '<!-- <body style="touch-action: none"> -->',
]) {
  test(`inlineRootStyleProblems accepts ${JSON.stringify(html)}`, () => {
    assert.deepEqual(inlineRootStyleProblems(html, 'page.html'), [])
  })
}

// ── text fields on touch screens ─────────────────────────────────────────────

const FLOOR = '@media (pointer: coarse) { input:not([type="checkbox"]), select, textarea { font-size: 16px !important; } }'
const withFields = (fields: string, css = '') => `<!doctype html><head>${meta('width=device-width')}<style>${css}</style></head><body>${fields}</body>`

const TEXT_FIELDS: Array<[string, string]> = [
  ['an input with no type', '<input id="a">'],
  ['a text input', '<input type="text" id="a">'],
  ['a search input', "<input type='search'>"],
  ['an unquoted number input', '<input type=number step=5>'],
  ['an upper-case email input', '<INPUT TYPE="EMAIL">'],
  ['a select', '<select><option>one</option></select>'],
  ['a textarea', '<textarea rows="3"></textarea>'],
]
for (const [name, fields] of TEXT_FIELDS) {
  test(`focusZoomProblems fails on ${name} with no touch-screen floor`, () => {
    assert.equal(hasTextFields(fields), true)
    const [problem, ...rest] = focusZoomProblems(withFields(fields), 'page.html')
    assert.match(problem, /page\.html: has text fields but no `@media \(pointer: coarse\)` rule/)
    assert.deepEqual(rest, [])
  })
  test(`focusZoomProblems accepts ${name} with the floor`, () => {
    assert.deepEqual(focusZoomProblems(withFields(fields, FLOOR), 'page.html'), [])
  })
}

for (const [name, fields] of [
  ['checkboxes, radios and sliders', '<input type="checkbox"><input type="radio"><input type="range"><input TYPE=range>'],
  ['a hidden file input', '<input type="file" id="f" style="display:none">'],
  ['buttons and a colour picker', '<input type="button"><input type="submit"><input type="reset"><input type="image"><input type="color"><input type="hidden">'],
  ['a field in a comment, a script string and a stylesheet comment', '<!-- <input id="x"> --><script>const t = "<select></select>"</script><style>/* <textarea> */</style>'],
  ['no fields at all', '<main><button>Go</button></main>'],
]) {
  test(`focusZoomProblems has nothing to say about ${name}`, () => {
    assert.equal(hasTextFields(withFields(fields)), false)
    assert.deepEqual(focusZoomProblems(withFields(fields), 'page.html'), [])
  })
}

for (const [name, css] of [
  ['a floor under 16px', '@media (pointer: coarse) { input, select, textarea { font-size: 15px; } }'],
  ['a 16px rule that is not touch-only', 'input, select, textarea { font-size: 16px; }'],
  ['a rule for another pointer', '@media (pointer: fine) { input, select, textarea { font-size: 16px; } }'],
  ['a rule for another feature', '@media (max-width: 600px) { input, select, textarea { font-size: 16px; } }'],
  ['a coarse rule that sizes something else', '@media (pointer: coarse) { .label, button { font-size: 16px; } }'],
  ['a coarse rule that sets no size', '@media (pointer: coarse) { input, select, textarea { min-height: 44px; } }'],
  ['an em size, which depends on the parent', '@media (pointer: coarse) { input, select, textarea { font-size: 1em; } }'],
  ['a floor that is commented out', '/* @media (pointer: coarse) { input { font-size: 16px; } } */'],
]) {
  test(`focusZoomProblems fails on ${name}`, () => {
    assert.equal(focusZoomProblems(withFields('<input type="text">', css), 'page.html').length, 1)
  })
}

for (const [name, css] of [
  ['px', '@media (pointer: coarse) { input, select, textarea { font-size: 16px; } }'],
  ['a larger size', '@media (pointer: coarse) { input, select, textarea { font-size: 18px } }'],
  ['rem', '@media (pointer: coarse) { input, select, textarea { font-size: 1rem; } }'],
  ['!important after other rules in the block', '@media (pointer: coarse) { .a { color: red } input[type=text] { font-size: 16px !important; padding: 0 } }'],
  ['another media condition on the same query', '@media (pointer: coarse) and (max-width: 900px) { select { font-size: 16px } }'],
  ['a nested block before it', '@media (pointer: coarse) { @supports (display: grid) { .a { color: red } } textarea { font-size: 16px } }'],
]) {
  test(`hasCoarsePointerFieldFloor accepts ${name}`, () => {
    assert.equal(hasCoarsePointerFieldFloor(withFields('<input>', css)), true)
  })
}

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

test('the command exits 1 and names the page when a page has text fields and no touch-screen floor', () => {
  inTempDir({ 'form.html': withFields('<input type="text">') }, (dir) => {
    const result = cli(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /form\.html: has text fields but no `@media \(pointer: coarse\)` rule/)
  })
  inTempDir({ 'form.html': withFields('<input type="text">', FLOOR) }, (dir) => {
    assert.equal(cli(dir).status, 0)
  })
})

test('the command does not walk through a symlink into a directory, so a worktree\'s linked node_modules is skipped', () => {
  const locked = `<!doctype html><head>${meta('user-scalable=no')}</head>`
  inTempDir(
    {
      // The dependency tree lives beside the app, as it does when a worktree links the main checkout's node_modules.
      'deps/pkg/demo.html': locked,
      'app/ok.html': `<!doctype html><head>${meta('width=device-width, initial-scale=1')}</head>`,
    },
    (dir) => {
      const app = join(dir, 'app')
      symlinkSync(join(dir, 'deps'), join(app, 'node_modules'))
      symlinkSync(join(dir, 'deps'), join(app, 'linked-docs'))
      symlinkSync(join(dir, 'does-not-exist'), join(app, 'dangling'))
      assert.deepEqual(zoomProblemsIn(app), [])
      const result = cli(app)
      assert.equal(result.status, 0, result.stderr)
      // Control: the same files without the links are found, so the pass above is not a pass on an empty tree.
      assert.equal(cli(join(dir, 'deps')).status, 1)
    },
  )
})

test('the command still reads a symlink to a file', () => {
  inTempDir({ 'real/locked.html': `<!doctype html><head>${meta('user-scalable=no')}</head>`, 'app/.keep': '' }, (dir) => {
    symlinkSync(join(dir, 'real/locked.html'), join(dir, 'app/page.html'))
    const result = cli(join(dir, 'app'))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /page\.html/)
  })
})
