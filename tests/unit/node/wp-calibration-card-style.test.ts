/**
 * The calibration card's stylesheet (index.html), held to the markup and the states the card is built from
 * (src/ar/project-calibration.ts, WP-04b).
 *
 * The card is a DOM state machine whose looks are decided by CSS that no unit test of the copy or the flow can see, and a rule that is
 * missing says nothing: the readout of how three points sit against the stored ones shipped without one, so its lines ran together into
 * a single 16 px paragraph and a mismatch looked the same as a match. The stand-in documents the other tests use have no stylesheet, and
 * Playwright's `toContainText` collapses whitespace. So this file reads the two sources:
 *
 *  - every class the card's markup gives an element has a rule of its own in the page's stylesheet;
 *  - the readout keeps each sentence on a line of its own and is coloured by the verdict's state (ok, warn, mismatch), and the progress
 *    dot of a step that was skipped has a look of its own;
 *  - the card can never be taller than the screen, and a short phone (the check point's step and the readout made the card taller) is given
 *    a compact card, so that the camera view above it is left to tap on. tests/mock-two-point-calibration.spec.ts measures that in a
 *    browser at the phones' sizes.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-calibration-card-style.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const modal = readFileSync(join(ROOT, 'src/ar/project-calibration.ts'), 'utf8')
const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
/** The page's stylesheet, with its comments taken out. */
const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)![1]!.replace(/\/\*[\s\S]*?\*\//g, '')

/** The markup the card builds, with the template's own substitutions left as they are. */
const template = /overlay\.innerHTML = `([\s\S]*?)`\n\s+document\.body\.appendChild/.exec(modal)![1]!

/** Every flat rule of the stylesheet, media blocks' included, as its selectors (whitespace made single) and its body. */
const RULES = [...css.matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1]!.split(',').map((selector) => selector.trim().replace(/\s+/g, ' ')),
  body: match[2]!,
}))

/** The bodies of the rules that have exactly this selector among theirs. */
const rulesFor = (selector: string): string[] => RULES.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body)

const classesOf = (markup: string): string[] =>
  [...new Set([...markup.matchAll(/\bclass="([^"]+)"/g)].flatMap((match) => match[1]!.split(/\s+/)))].filter((name) => name.startsWith('project-calibration'))

test('every class the card\'s markup gives an element has a rule of its own in the page\'s stylesheet', () => {
  const classes = classesOf(template)
  assert.ok(classes.length >= 10, 'the card has classes to hold')
  assert.ok(classes.includes('project-calibration-fit'), 'the readout is one of them')
  const bare = classes.filter((name) => rulesFor(`.${name}`).length === 0)
  assert.deepEqual(bare, [], `no rule in index.html for: ${bare.join(', ')}`)
})

test('the readout keeps each sentence on a line of its own and is coloured by the verdict\'s state', () => {
  const [base] = rulesFor('.project-calibration-fit')
  assert.ok(base, 'a rule for the readout')
  assert.match(base, /white-space:\s*pre-line/, 'the copy puts each sentence on a line with a newline, and a plain block runs them into one paragraph')
  assert.match(base, /font-size:\s*12px/, 'beside its neighbours, not at the page\'s 16px')
  const colour = (state: string): string => {
    const [rule] = rulesFor(`.project-calibration-fit[data-state='${state}']`)
    assert.ok(rule, `a rule for the readout in state ${state}`)
    const found = /\bcolor:\s*(#[0-9a-fA-F]{6})/.exec(rule)
    assert.ok(found, `state ${state} sets a colour`)
    return found[1]!.toLowerCase()
  }
  const colours = [/\bcolor:\s*(#[0-9a-fA-F]{6})/.exec(base)![1]!.toLowerCase(), colour('warn'), colour('mismatch')]
  assert.equal(new Set(colours).size, 3, `ok, warn and mismatch are three colours: ${colours.join(', ')}`)
  // The states the readout can be in are the ones the stylesheet has ('ok' is the base rule).
  assert.match(readFileSync(join(ROOT, 'src/ar/constellation-copy.ts'), 'utf8'), /state: 'ok' \| 'warn' \| 'mismatch'/)
})

test('the dot of a step that was skipped has a look of its own, and the states the dots take are the ones the stylesheet knows', () => {
  const states = [...readFileSync(join(ROOT, 'src/ar/constellation-flow.ts'), 'utf8').matchAll(/export type StepState = ([^\n]+)/g)][0]![1]!
    .split('|').map((name) => name.trim().replace(/'/g, ''))
  assert.deepEqual(states, ['active', 'done', 'todo', 'skipped', 'hidden'])
  for (const state of ['active', 'done', 'skipped']) {
    assert.ok(rulesFor(`.project-calibration-steps li[data-state='${state}']`).length > 0, `a rule for a dot that is ${state}`)
  }
  // To do is the base look, and hidden is the attribute the card sets, which the browser honours.
  assert.ok(rulesFor('.project-calibration-steps li').length > 0)
  const [skipped] = rulesFor(`.project-calibration-steps li[data-state='skipped']`)
  assert.match(skipped!, /line-through|dashed|opacity/, 'it reads as passed over, not as a step to come')
})

test('the card can never be taller than the screen, so its title is not cut off by the top of it', () => {
  const [card] = rulesFor('.project-calibration-card')
  assert.ok(card)
  assert.match(card, /max-height:\s*calc\(100dvh - [^;]+\)/, 'dynamic viewport units: the visible screen, not the one behind the address bar')
  assert.match(card, /max-height:\s*calc\(100vh - [^;]+\)[\s\S]*max-height:\s*calc\(100dvh/, 'with a fallback before it for a browser without them')
  assert.match(card, /overflow-y:\s*auto/, 'what does not fit scrolls inside it')
})

test('a short phone is given a compact card: its air goes before the camera view does', () => {
  // The page has other rules for phones this tall (the panel's): the card's is the one that names the card.
  const block = [...css.matchAll(/@media \(max-height: 700px\)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].map((match) => match[1]!).find((rules) => rules.includes('.project-calibration-card'))
  assert.ok(block, 'a rule for phones 700px tall and under')
  const compact = block.replace(/\s+/g, ' ')
  assert.match(compact, /\.project-calibration-card \{[^}]*padding: 12px 14px/)
  assert.match(compact, /\.project-calibration-eyebrow \{ display: none/)
  assert.match(compact, /\.project-calibration-card h2 \{[^}]*font-size: 20px/)
  assert.match(compact, /\.project-calibration-fit \{/, 'the readout is tightened with the separation line')
  // The 16px floor on text fields is the viewport rule's, and a compact card does not set the label field's text size below it.
  assert.doesNotMatch(compact, /label-field input[^}]*font-size/)
})
