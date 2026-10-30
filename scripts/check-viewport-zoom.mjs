#!/usr/bin/env node
/**
 * Fail when a page cannot be pinch-zoomed (WCAG 1.4.4 Resize Text).
 *
 *     node scripts/check-viewport-zoom.mjs [file-or-dir ...]     (default: the repository)
 *     npm run test:viewport                                      (the same rules, with negative cases)
 *
 * A page locks zoom in three ways, and axe's `meta-viewport` rule only sees the first:
 *
 *   1. <meta name="viewport"> with `user-scalable` set to anything but yes/1, or a `maximum-scale` below 5
 *      (axe's `meta-viewport-large` threshold; WCAG itself needs 2).
 *   2. CSS `touch-action: none` (or pan-x / pan-y without pinch-zoom) on html, body or :root. Every touch has
 *      those in its ancestor chain, so the browser never starts a pinch whatever the viewport tag says.
 *      `touch-action: none` belongs on the canvas that owns the gesture, not on the page.
 *   3. A gesturestart / gesturechange / gestureend handler that calls preventDefault. Those are iOS Safari's
 *      pinch events; cancelling them was the way round a viewport tag Safari ignores.
 *
 * Reads HTML (viewport tags, inline <style> and <script> blocks), .css files, and script files under src/ and
 * subsystems/ (never public/, whose scripts are vendored engine bundles). Skips node_modules, build output and vendored code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directories that are not ours to fix: dependencies, build output, test output, vendored code, scan data. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'playwright-report', 'test-results', 'vendor', '.test-run', 'scans', 'worlds'])
/** The smallest `maximum-scale` a page may declare. */
export const MIN_MAXIMUM_SCALE = 5

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * What is wrong with the viewport meta tags in a piece of HTML.
 * @param {string} html
 * @param {string} [label] shown in front of every message
 * @returns {string[]}
 */
export function viewportProblems(html, label = 'page') {
  const problems = []
  const source = html.replace(/<!--[\s\S]*?-->/g, '')
  for (const [tag] of source.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\sname\s*=\s*["']?viewport["']?(?=[\s/>])/i.test(tag)) continue
    const content = /\scontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
    const text = content ? (content[1] ?? content[2]) : ''
    const entries = new Map(
      text
        .split(/[,;]/)
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

/**
 * All three checks on one HTML document: its viewport tags, its inline <style> blocks and its scripts.
 * @param {string} html
 * @param {string} label
 * @returns {string[]}
 */
export function htmlZoomProblems(html, label) {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1])
  return [
    ...viewportProblems(html, label),
    ...styles.flatMap((css) => rootTouchActionProblems(css, label)),
    ...gestureProblems(html, label),
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
      if (entry.isDirectory() && (SKIP_DIRS.has(entry.name) || entry.name.startsWith('dist-'))) continue
      problems.push(...zoomProblemsIn(join(target, entry.name), base))
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
    console.error('FAIL: a page blocks pinch-zoom (WCAG 1.4.4):')
    for (const problem of problems) console.error(`      - ${problem}`)
    console.error('      Remove user-scalable / maximum-scale from the viewport tag and any gesture* preventDefault;')
    console.error('      keep touch-action: none on canvases only.')
    process.exit(1)
  }
  console.log('ok: no page blocks pinch-zoom (viewport tags, root touch-action, gesture* handlers)')
}
