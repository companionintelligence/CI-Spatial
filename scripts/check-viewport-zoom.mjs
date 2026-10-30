#!/usr/bin/env node
/**
 * Fail when a page cannot be pinch-zoomed (WCAG 1.4.4 Resize Text), or can be but would make iOS Safari zoom
 * into a text field by itself.
 *
 *     node scripts/check-viewport-zoom.mjs [file-or-dir ...]     (default: the repository)
 *     npm run test:viewport                                      (the same rules, with negative cases)
 *
 * Three patterns are known to lock zoom, and axe's `meta-viewport` rule only sees the first:
 *
 *   1. <meta name="viewport"> with `user-scalable` set to anything but yes/1, or a `maximum-scale` below 5
 *      (axe's `meta-viewport-large` threshold; WCAG itself needs 2).
 *   2. CSS `touch-action: none` (or pan-x / pan-y without pinch-zoom) on html, body or :root, in a stylesheet or
 *      in a style attribute. Every touch has those in its ancestor chain, so the browser never starts a pinch
 *      whatever the viewport tag says. `touch-action: none` belongs on the canvas that owns the gesture, not on the page.
 *   3. A gesturestart / gesturechange / gestureend handler that calls preventDefault. Those are iOS Safari's
 *      pinch events; cancelling them was the way round a viewport tag Safari ignores.
 *
 * One more follows from unlocking it:
 *
 *   4. Text fields under 16px. iOS Safari zooms the page into a focused field smaller than that, and a viewport tag
 *      with `maximum-scale=1` used to stop it. A page with text fields needs an `@media (pointer: coarse)` rule that
 *      sets input, select and textarea to 16px or more.
 *
 * Reads HTML (viewport tags, inline <style> and <script> blocks), .css files, and script files under src/ and
 * subsystems/ (never public/, whose scripts are vendored engine bundles). Skips node_modules, build output, vendored
 * code, and any symlink that points at a directory.
 *
 * This is a static read. A pass means none of those patterns is present, not that the page can be pinched: the proof
 * is a real two-finger gesture (CDP `Input.synthesizePinchGesture`, touch source) and, for rule 4, a measured computed
 * font-size under a coarse pointer. Known blind spots, none of them checked here:
 *   - a viewport tag that script writes or rewrites;
 *   - `touch-action: none` on the page by other routes: `* { }`, `:where(body) { }`, `body:has(...) { }`,
 *     `document.body.style.touchAction = 'none'`;
 *   - a gesture handler whose preventDefault comes more than 400 characters after the event name, an
 *     `ongesturestart=` attribute, a `wheel` handler that cancels ctrl+wheel (desktop trackpad pinch), a `touchmove`
 *     handler that cancels two-finger moves;
 *   - text fields that script creates: they are invisible here, so the pages that build them are named in
 *     tests/unit/node/viewport_zoom.test.ts;
 *   - whether the 16px rule beats a more specific rule on the same field (measure it).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directories that are not ours to fix: dependencies, build output, test output, vendored code, scan data. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'playwright-report', 'test-results', 'vendor', '.test-run', 'scans', 'worlds'])
/** The smallest `maximum-scale` a page may declare. */
export const MIN_MAXIMUM_SCALE = 5
/** The smallest text size at which iOS Safari does not zoom into a focused field. */
export const MIN_FIELD_PX = 16

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const stripHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '')

/**
 * What is wrong with the viewport meta tags in a piece of HTML.
 * @param {string} html
 * @param {string} [label] shown in front of every message
 * @returns {string[]}
 */
export function viewportProblems(html, label = 'page') {
  const problems = []
  const source = stripHtmlComments(html)
  for (const [tag] of source.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\sname\s*=\s*["']?viewport["']?(?=[\s/>])/i.test(tag)) continue
    const content = /\scontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag)
    const text = content ? (content[1] ?? content[2] ?? content[3]) : ''
    // Properties are separated by commas, semicolons or whitespace; `key = value` may have spaces round the sign.
    const entries = new Map(
      text
        .replace(/\s*=\s*/g, '=')
        .split(/[\s,;]+/)
        .map((part) => part.split('='))
        .filter((pair) => pair.length === 2)
        .map(([key, value]) => [key.trim().toLowerCase(), value.trim().toLowerCase()]),
    )
    const scalable = entries.get('user-scalable')
    if (scalable !== undefined && scalable !== 'yes' && scalable !== '1') {
      problems.push(`${label}: user-scalable=${scalable} blocks pinch-zoom (${tag.trim()})`)
    }
    const maximum = entries.get('maximum-scale')
    if (maximum !== undefined && !(Number.parseFloat(maximum) >= MIN_MAXIMUM_SCALE)) {
      problems.push(`${label}: maximum-scale=${maximum} caps pinch-zoom below ${MIN_MAXIMUM_SCALE}x (${tag.trim()})`)
    }
  }
  return problems
}

/** Whether the last compound selector of `selector` is html, body or :root (with classes, ids, attributes or pseudos). */
const isPageSelector = (selector) => {
  const last = selector.trim().split(/[\s>+~]+/).pop() ?? ''
  return /^(?:html|body|:root)(?![\w-])/i.test(last)
}

/** A `touch-action` value that leaves the browser no way to start a pinch: no `pinch-zoom`, `manipulation` or `auto`. */
const blocksPinch = (value) => {
  const tokens = value.trim().toLowerCase().split(/\s+/)
  return !tokens.some((token) => ['pinch-zoom', 'manipulation', 'auto', 'inherit', 'initial', 'unset'].includes(token))
}

/**
 * What is wrong with `touch-action` on the page itself (html, body, :root) in a piece of CSS.
 * @param {string} css
 * @param {string} [label] shown in front of every message
 * @returns {string[]}
 */
export function rootTouchActionProblems(css, label = 'stylesheet') {
  const problems = []
  for (const [, selectors, body] of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const pageSelectors = selectors.split(',').filter(isPageSelector)
    if (pageSelectors.length === 0) continue
    for (const [, value] of body.matchAll(/(?:^|;|\s)touch-action\s*:\s*([^;!}]+)/gi)) {
      if (blocksPinch(value)) {
        problems.push(
          `${label}: \`touch-action: ${value.trim()}\` on ${pageSelectors.map((s) => s.trim()).join(', ')} blocks pinch-zoom for every touch; put it on the canvas that owns the gesture`,
        )
      }
    }
  }
  return problems
}

/**
 * The same `touch-action` rule for a `style` attribute on <html> or <body>.
 * @param {string} html
 * @param {string} [label] shown in front of every message
 * @returns {string[]}
 */
export function inlineRootStyleProblems(html, label = 'page') {
  return [...stripHtmlComments(html).matchAll(/<(html|body)(?=[\s>])[^>]*?\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].flatMap(
    ([, tag, double, single]) => rootTouchActionProblems(`${tag} { ${double ?? single} }`, `${label} (style attribute)`),
  )
}

/**
 * A handler for iOS Safari's gesturestart / gesturechange / gestureend that cancels it. One message per file.
 * @param {string} source HTML or script text
 * @param {string} [label] shown in front of the message
 * @returns {string[]}
 */
export function gestureProblems(source, label = 'script') {
  for (const match of source.matchAll(/['"`](gesture(?:start|change|end))['"`]/g)) {
    if (/preventDefault\s*\(/.test(source.slice(match.index, match.index + 400))) {
      return [`${label}: cancels ${match[1]} with preventDefault, which blocks pinch-zoom in iOS Safari`]
    }
  }
  return []
}

/** Input types that take no typed text. iOS Safari does not zoom into these. */
const NON_TEXT_INPUT = new Set(['checkbox', 'radio', 'range', 'file', 'hidden', 'button', 'submit', 'reset', 'image', 'color'])

/**
 * Whether the page's own markup (not its styles or scripts) holds a field that takes typed text.
 * @param {string} html
 * @returns {boolean}
 */
export function hasTextFields(html) {
  const markup = stripHtmlComments(html).replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, '')
  for (const [tag, name] of markup.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    if (name.toLowerCase() !== 'input') return true
    const type = /\stype\s*=\s*["']?([\w-]+)/i.exec(tag)?.[1].toLowerCase() ?? 'text'
    if (!NON_TEXT_INPUT.has(type)) return true
  }
  return false
}

/**
 * Whether the page's own <style> blocks hold an `@media (pointer: coarse)` rule that sets an input, select or
 * textarea to MIN_FIELD_PX or more (px or rem). It does not say that the rule wins over another one on the same field.
 * @param {string} html
 * @returns {boolean}
 */
export function hasCoarsePointerFieldFloor(html) {
  const css = stripComments([...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n'))
  for (const open of css.matchAll(/@media[^{]*\(\s*pointer\s*:\s*coarse\s*\)[^{]*\{/gi)) {
    // The block's body runs from the brace that opens the @media rule to the one that closes it.
    const start = open.index + open[0].length
    let depth = 1
    let end = start
    for (; end < css.length && depth > 0; end++) {
      if (css[end] === '{') depth++
      else if (css[end] === '}') depth--
    }
    for (const [, selectors, body] of css.slice(start, end - 1).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\b(?:input|select|textarea)\b/i.test(selectors)) continue
      const size = /(?:^|[;\s])font-size\s*:\s*([\d.]+)(px|rem)\b/i.exec(body)
      if (size && Number(size[1]) * (size[2].toLowerCase() === 'rem' ? 16 : 1) >= MIN_FIELD_PX) return true
    }
  }
  return false
}

/**
 * A page with text fields and no touch-screen 16px floor for them.
 * @param {string} html
 * @param {string} [label] shown in front of the message
 * @returns {string[]}
 */
export function focusZoomProblems(html, label = 'page') {
  if (!hasTextFields(html) || hasCoarsePointerFieldFloor(html)) return []
  return [
    `${label}: has text fields but no \`@media (pointer: coarse)\` rule that sets input, select and textarea to ${MIN_FIELD_PX}px or more; iOS Safari zooms into a focused field under that, and nothing stops it once the page can be pinch-zoomed`,
  ]
}

/**
 * All the checks on one HTML document: its viewport tags, its inline <style> blocks and style attributes, its
 * scripts and its text fields.
 * @param {string} html
 * @param {string} label
 * @returns {string[]}
 */
export function htmlZoomProblems(html, label) {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1])
  return [
    ...viewportProblems(html, label),
    ...styles.flatMap((css) => rootTouchActionProblems(css, label)),
    ...inlineRootStyleProblems(html, label),
    ...gestureProblems(html, label),
    ...focusZoomProblems(html, label),
  ]
}

/**
 * Every .html and .css file under `target` (a file or a directory), and every script under its src/ and
 * subsystems/, checked.
 * @param {string} target
 * @param {string} [base] paths in messages are relative to this
 * @returns {string[]}
 */
export function zoomProblemsIn(target, base = target) {
  const problems = []
  if (statSync(target).isDirectory()) {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      const path = join(target, entry.name)
      if (entry.isSymbolicLink()) {
        // A Dirent describes the link, not what it points at, so isDirectory() is false for a symlinked node_modules
        // and the name skip below never fires. Never walk through a link into a directory (a worktree's linked
        // node_modules, a cycle); a link to a file is read, a dangling one is ignored.
        const stat = statSync(path, { throwIfNoEntry: false })
        if (!stat || stat.isDirectory()) continue
      } else if (entry.isDirectory() && (SKIP_DIRS.has(entry.name) || entry.name.startsWith('dist-'))) continue
      problems.push(...zoomProblemsIn(path, base))
    }
    return problems
  }
  const label = relative(base, target) || basename(target)
  if (/\.html?$/i.test(target)) problems.push(...htmlZoomProblems(readFileSync(target, 'utf8'), label))
  else if (/\.css$/i.test(target)) problems.push(...rootTouchActionProblems(readFileSync(target, 'utf8'), label))
  else if (/\.(?:[cm]?[jt]sx?)$/i.test(target) && /^(?:src|subsystems)\//.test(label)) {
    problems.push(...gestureProblems(readFileSync(target, 'utf8'), label))
  }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const targets = process.argv.slice(2).length ? process.argv.slice(2).map((t) => resolve(t)) : [root]
  const problems = targets.flatMap((target) => zoomProblemsIn(target, statSync(target).isDirectory() ? target : dirname(target)))
  if (problems.length) {
    console.error('FAIL: a page blocks pinch-zoom, or lets iOS zoom into a small field (WCAG 1.4.4):')
    for (const problem of problems) console.error(`      - ${problem}`)
    console.error('      Remove user-scalable / maximum-scale from the viewport tag and any gesture* preventDefault;')
    console.error('      keep touch-action: none on canvases only; keep text fields at 16px on touch screens.')
    process.exit(1)
  }
  console.log('ok: no page blocks pinch-zoom, and pages with text fields keep them at 16px on touch screens (viewport tags, root touch-action, gesture* handlers, field sizes)')
}
