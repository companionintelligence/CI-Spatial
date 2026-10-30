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
 *      sets them to 16px or more, and the rule has to reach every kind of field the page declares. What counts:
 *        - the media query is a positive `(pointer: coarse)` (`screen and`, `only` and other conditions beside it are
 *          fine; `not`, `or`, `(pointer: fine)` and a list with any other query are not), and the rule sits directly in
 *          that block, not in an at-rule nested inside it;
 *        - the size is `px` or `rem`, 16px or more (the last `font-size` in the rule wins);
 *        - the selector stands alone and is one of `input`, `input[type=x]`, `input:not([type=a], [type=b], ...)`,
 *          `select` or `textarea`. `input[type=text]` does not take an <input> with no type attribute, as in CSS.
 *          An ancestor, a class, a pseudo-class or a `:not` that names anything but a type is not counted, and the
 *          message says which selector was ignored.
 *      The kinds a page declares are read from its own markup: each <input> by its type (none, text, search, ...), each
 *      <select> and each <textarea>; checkboxes, radios, sliders, files, buttons, colours and hidden inputs take no typing.
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
 *   - runtime-built fields and the tripod exclusion are held by a named test, not by the generic rule: script creates
 *     index.html's fields, so they are invisible here, and the page names itself in tests/unit/node/viewport_zoom.test.ts,
 *     which also checks that its floor still leaves the 22px tripod distance fields out (`input:not(..., .tripod-unit input)`);
 *     a floor that would shrink a field that is already bigger is not noticed anywhere else;
 *   - whether the 16px rule beats a more specific rule on the same field (measure it), and `<style media="...">`.
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

/** `[type=x]`, `[type="x"]` or `[type='x']`: the one attribute selector a field floor may use. */
const TYPE_ATTRIBUTE = /^\[\s*type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s"']+))\s*\]$/i

/**
 * The parts of `text` between separator characters, ignoring a separator inside (...), [...] or a quoted string.
 * Empty parts are dropped.
 * @param {string} text
 * @param {(char: string) => boolean} isSeparator
 * @returns {string[]}
 */
function splitOutsideBrackets(text, isSeparator) {
  const parts = []
  let depth = 0
  let quote = ''
  let current = ''
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '(' || char === '[') {
      depth++
    } else if (char === ')' || char === ']') {
      depth--
    } else if (depth === 0 && isSeparator(char)) {
      if (current.trim()) parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/**
 * The `prelude { body }` blocks directly inside `css`. A block's body is returned as text, not looked into.
 * @param {string} css comments already stripped
 * @returns {Array<{ prelude: string, body: string }>}
 */
function blocksIn(css) {
  const blocks = []
  let depth = 0
  let quote = ''
  let prelude = ''
  let body = ''
  for (const char of css) {
    if (depth === 0) {
      if (char === '{') {
        depth = 1
        body = ''
      } else if (char === ';') {
        prelude = '' // a statement such as `@charset "utf-8";`
      } else {
        prelude += char
      }
      continue
    }
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) {
        blocks.push({ prelude: prelude.trim(), body })
        prelude = ''
        continue
      }
    }
    body += char
  }
  return blocks
}

/**
 * The size the last `font-size` declaration in a rule sets, in px, or undefined when it is not px or rem.
 * @param {string} declarations
 * @returns {number | undefined}
 */
function lastFontSizePx(declarations) {
  const values = [...declarations.matchAll(/(?:^|[;\s])font-size\s*:\s*([^;}]+)/gi)].map((m) => m[1].trim())
  const size = /^([\d.]+)(px|rem)\b/i.exec(values.at(-1) ?? '')
  return size ? Number(size[1]) * (size[2].toLowerCase() === 'rem' ? 16 : 1) : undefined
}

/**
 * Whether an `@media` rule applies on touch screens and nowhere else: every query in its list is a positive
 * `(pointer: coarse)` one, for `all` or `screen`, with no `not` and no `or`.
 * @param {string} prelude e.g. `@media screen and (pointer: coarse)`
 * @returns {boolean}
 */
function isTouchOnlyMedia(prelude) {
  const queries = splitOutsideBrackets(prelude.replace(/^@media\b/i, ''), (char) => char === ',')
  return (
    queries.length > 0 &&
    queries.every((query) => {
      if (/(?:^|\s)(?:not|or)(?=[\s(])/i.test(query)) return false
      const mediaType = /^(?:only\s+)?([a-z-]+)\b/i.exec(query)?.[1].toLowerCase()
      if (mediaType !== undefined && mediaType !== 'all' && mediaType !== 'screen') return false
      return /\(\s*pointer\s*:\s*coarse\s*\)/i.test(query)
    })
  )
}

/**
 * The selectors of the rules in the page's own <style> blocks that apply on touch screens only and set a size of
 * MIN_FIELD_PX or more, whatever they select. Whitespace is collapsed.
 * @param {string} html
 * @returns {string[]}
 */
export function coarsePointerFloorSelectors(html) {
  const css = stripComments([...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n'))
  const selectors = []
  for (const media of blocksIn(css)) {
    if (!/^@media\b/i.test(media.prelude) || !isTouchOnlyMedia(media.prelude)) continue
    for (const rule of blocksIn(media.body)) {
      // An at-rule inside the block narrows its condition again (`@media (max-width: 400px)`), so its rules are not the floor.
      if (rule.prelude.startsWith('@')) continue
      const px = lastFontSizePx(rule.body)
      if (px === undefined || px < MIN_FIELD_PX) continue
      selectors.push(...splitOutsideBrackets(rule.prelude, (char) => char === ',').map((selector) => selector.replace(/\s+/g, ' ')))
    }
  }
  return selectors
}

/**
 * The kinds of field that take typed text (or a pick, for a select) which the page's own markup declares, named the
 * way a selector would name them: `input (no type attribute)`, `input[type=search]`, `select`, `textarea`. Sorted.
 * @param {string} html
 * @returns {string[]}
 */
export function fieldKinds(html) {
  const markup = stripHtmlComments(html).replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, '')
  const kinds = new Set()
  for (const [tag, name] of markup.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const element = name.toLowerCase()
    if (element !== 'input') {
      kinds.add(element)
      continue
    }
    const type = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag)
    const value = type ? (type[1] ?? type[2] ?? type[3]).toLowerCase() : undefined
    if (value !== undefined && NON_TEXT_INPUT.has(value)) continue
    kinds.add(value === undefined ? 'input (no type attribute)' : `input[type=${value}]`)
  }
  return [...kinds].sort()
}

/**
 * Whether the page's own markup (not its styles or scripts) holds a field that takes typed text.
 * @param {string} html
 * @returns {boolean}
 */
export function hasTextFields(html) {
  return fieldKinds(html).length > 0
}

/**
 * Whether the page's own <style> blocks hold an `@media (pointer: coarse)` rule, for touch screens only, that sets
 * MIN_FIELD_PX or more (px or rem) on a selector ending in input, select or textarea. It does not say that the rule
 * reaches every kind of field (see uncoveredFieldKinds) or that it wins over another rule on the same field.
 * @param {string} html
 * @returns {boolean}
 */
export function hasCoarsePointerFieldFloor(html) {
  return coarsePointerFloorSelectors(html).some((selector) => /^(?:input|select|textarea)(?![\w-])/i.test(lastCompound(selector)))
}

/**
 * The last compound selector of a complex one: `.row input[type=text]` gives `input[type=text]`.
 * @param {string} selector
 * @returns {string}
 */
function lastCompound(selector) {
  return splitOutsideBrackets(selector, (char) => /[\s>+~]/.test(char)).at(-1) ?? ''
}

/**
 * What a floor selector takes, when it is one of the forms this check reads: `select`, `textarea`, `input`,
 * `input[type=x]` and `input:not([type=a], [type=b], ...)`, each standing alone. Undefined for any other selector:
 * one with an ancestor or sibling in front, a class, a pseudo-class, or a `:not` that names something but a type.
 * @param {string} selector
 * @returns {{ tag: string, only?: string, except: Set<string> } | undefined}
 */
function fieldSelectorCoverage(selector) {
  const parts = splitOutsideBrackets(selector, (char) => /[\s>+~]/.test(char))
  if (parts.length !== 1) return undefined
  const tag = /^(input|select|textarea)(?![\w-])/i.exec(parts[0])?.[1].toLowerCase()
  if (!tag) return undefined
  const rest = parts[0].slice(tag.length)
  if (rest === '') return { tag, except: new Set() }
  if (tag !== 'input') return undefined
  const only = TYPE_ATTRIBUTE.exec(rest)
  if (only) return { tag, only: (only[1] ?? only[2] ?? only[3]).toLowerCase(), except: new Set() }
  const not = /^:not\(([\s\S]*)\)$/i.exec(rest)
  if (!not) return undefined
  const except = new Set()
  for (const entry of splitOutsideBrackets(not[1], (char) => char === ',')) {
    const type = TYPE_ATTRIBUTE.exec(entry)
    if (!type) return undefined
    except.add((type[1] ?? type[2] ?? type[3]).toLowerCase())
  }
  return except.size > 0 ? { tag, except } : undefined
}

/**
 * Whether a floor selector, read by fieldSelectorCoverage, takes a kind of field named by fieldKinds.
 * @param {{ tag: string, only?: string, except: Set<string> }} floor
 * @param {string} kind
 * @returns {boolean}
 */
function floorTakes(floor, kind) {
  if (kind === 'select' || kind === 'textarea') return floor.tag === kind
  if (floor.tag !== 'input') return false
  const type = kind === 'input (no type attribute)' ? undefined : kind.slice('input[type='.length, -1)
  if (floor.only !== undefined) return type === floor.only
  return type === undefined || !floor.except.has(type)
}

/**
 * The kinds of field the page declares that its touch-screen floor does not reach. Only selectors this check can
 * read count; the others cover nothing.
 * @param {string} html
 * @returns {string[]}
 */
export function uncoveredFieldKinds(html) {
  const floors = coarsePointerFloorSelectors(html).map(fieldSelectorCoverage).filter((floor) => floor !== undefined)
  return fieldKinds(html).filter((kind) => !floors.some((floor) => floorTakes(floor, kind)))
}

/**
 * A page with text fields and no touch-screen 16px floor for them, or a floor that leaves a kind of field out.
 * @param {string} html
 * @param {string} [label] shown in front of the message
 * @returns {string[]}
 */
export function focusZoomProblems(html, label = 'page') {
  if (!hasTextFields(html)) return []
  if (!hasCoarsePointerFieldFloor(html)) {
    return [
      `${label}: has text fields but no \`@media (pointer: coarse)\` rule that sets input, select and textarea to ${MIN_FIELD_PX}px or more; iOS Safari zooms into a focused field under that, and nothing stops it once the page can be pinch-zoomed`,
    ]
  }
  const uncovered = uncoveredFieldKinds(html)
  if (uncovered.length === 0) return []
  const ignored = [...new Set(coarsePointerFloorSelectors(html).filter((selector) => fieldSelectorCoverage(selector) === undefined))]
  const unread = ignored.length > 0 ? ` (not counted, because this check cannot read it: ${ignored.map((selector) => `\`${selector}\``).join(', ')})` : ''
  return [
    `${label}: the \`@media (pointer: coarse)\` rule that sets fields to ${MIN_FIELD_PX}px does not cover ${uncovered.join(', ')}; iOS Safari zooms into a focused field under that. Name each kind the page declares on its own, as input, input[type=x], input:not([type=a], [type=b]), select or textarea${unread}`,
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
