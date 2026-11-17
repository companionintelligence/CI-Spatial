/**
 * F93, colour part: colorPrimaryDark, colorAccent and colorPrimary, and the page gradient
 * (mobile/android/app/src/main/res/values/colors.xml, styles.xml, public/manifest.json, index.html).
 * The checks: colorPrimaryDark is defined, equals the manifest theme_color, and AppTheme maps it to the
 * status bar. colorAccent is defined and is --aqua-light in index.html. colorPrimary is defined, is #072433,
 * and starts the page gradient. A missing colour fails. Comments are removed before matching, so a
 * commented-out colour does not count.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-e2-android-colors.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const VALUES = new URL('../../../mobile/android/app/src/main/res/values/', import.meta.url)

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

test('colorPrimaryDark is the manifest theme colour and AppTheme maps it; colorAccent is --aqua-light; the page gradient starts at colorPrimary', () => {
  const defined = definedColors()
  const manifest = JSON.parse(readFileSync(new URL('../../../public/manifest.json', import.meta.url), 'utf8')) as { theme_color?: string }
  const index = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8').toLowerCase()
  assert.ok(defined.has('colorPrimaryDark'), 'colorPrimaryDark is defined in values/')
  // AppCompat paints the status bar with the theme's colorPrimaryDark, so AppTheme must map that name to it.
  // The launch activity does not use AppTheme: MainActivity uses AppTheme.NoActionBarLaunch (AndroidManifest.xml),
  // whose parent is Theme.SplashScreen, so this mapping does not reach its status bar. The device check for that
  // status bar is left to the Android owner; this test does not cover it.
  // Comments are cut out first. The AppTheme opening tag must not be self-closing, and the match stops at the next style,
  // so a commented-out or self-closing AppTheme cannot pass.
  const styles = readFileSync(new URL('styles.xml', VALUES), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  assert.match(styles, /<style name="AppTheme"[^>]*(?<!\/)>(?:(?!<\/style>|<style[\s>])[\s\S])*?<item name="colorPrimaryDark">@color\/colorPrimaryDark<\/item>/, 'AppTheme maps colorPrimaryDark to the status bar')
  assert.ok(manifest.theme_color, 'the manifest names a theme colour')
  assert.equal(defined.get('colorPrimaryDark'), manifest.theme_color.toLowerCase())
  assert.ok(defined.has('colorAccent'), 'colorAccent is defined in values/')
  assert.ok(index.includes(`--aqua-light: ${defined.get('colorAccent')}`), 'colorAccent is --aqua-light in index.html')
  assert.ok(defined.has('colorPrimary'), 'colorPrimary is defined in values/')
  assert.equal(defined.get('colorPrimary'), '#072433', 'colorPrimary is the top colour of the page gradient')
  assert.ok(index.includes('#072433 0%'), 'the page background gradient starts at colorPrimary, #072433')
})
