/**
 * F93, colour part (mobile/android/app/src/main/res): every @color name the Android resources use must
 * be defined in a values file, or the release resources step cannot resolve it. The second test checks
 * that colorPrimaryDark equals the manifest theme_color, that colorAccent is --aqua-light in index.html,
 * and that colorPrimary is defined and the index.html page gradient starts at #072433.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-e-android-colors.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const RES = new URL('../../../mobile/android/app/src/main/res/', import.meta.url)
const VALUES = new URL('values/', RES)

/** The colour definitions in every values file, by name, as lowercase hex. */
function definedColors(): Map<string, string> {
  const defined = new Map<string, string>()
  for (const file of readdirSync(VALUES)) {
    if (!file.endsWith('.xml')) continue
    const xml = readFileSync(new URL(file, VALUES), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    for (const m of xml.matchAll(/<color name="([A-Za-z0-9_]+)">(#[0-9A-Fa-f]{6,8})<\/color>/g)) {
      defined.set(m[1]!, m[2]!.toLowerCase())
    }
  }
  return defined
}

test('every colour the Android resources use is defined', () => {
  const used = new Set<string>()
  for (const file of readdirSync(RES, { recursive: true }) as string[]) {
    if (!file.endsWith('.xml')) continue
    for (const m of readFileSync(new URL(file, RES), 'utf8').matchAll(/@color\/([A-Za-z0-9_]+)/g)) used.add(m[1]!)
  }
  const defined = definedColors()
  assert.ok(used.has('colorPrimary'), 'the theme names its colours')
  for (const name of used) assert.ok(defined.has(name), `@color/${name} is used but not defined in values/`)
})

test('colorPrimaryDark is the web app theme colour, and the accent is the aqua the screens use', () => {
  const defined = definedColors()
  const manifest = JSON.parse(readFileSync(new URL('../../../public/manifest.json', import.meta.url), 'utf8')) as { theme_color?: string }
  const index = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8').toLowerCase()
  assert.ok(defined.has('colorPrimaryDark'), 'colorPrimaryDark is defined in values/')
  assert.equal(defined.get('colorPrimaryDark'), manifest.theme_color?.toLowerCase())
  assert.ok(index.includes(`--aqua-light: ${defined.get('colorAccent')}`), 'colorAccent is --aqua-light in index.html')
  assert.ok(defined.has('colorPrimary'), 'colorPrimary is defined in values/')
  assert.ok(index.includes('#072433 0%'), 'the page background gradient starts at colorPrimary, #072433')
})
