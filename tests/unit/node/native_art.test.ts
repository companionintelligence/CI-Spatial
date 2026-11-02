import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The icons and launch screens are generated from public/icon-512.png by
// mobile/scripts/native-art.sh. These checks catch a regeneration that drops a size,
// adds an alpha channel the store rejects, or brings the Capacitor template back.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** Width, height and colour type from a PNG's IHDR chunk. Colour type 2 is RGB, with no alpha. */
function png(path: string): { width: number; height: number; colorType: number } {
  const bytes = readFileSync(ROOT + path)
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', `${path} is not a PNG`)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25]! }
}

function size(path: string): string {
  const { width, height } = png(path)
  return `${width}x${height}`
}

test('iOS app icon: one 1024 px RGB image, no alpha', () => {
  const icon = png('mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')
  assert.equal(`${icon.width}x${icon.height}`, '1024x1024')
  assert.equal(icon.colorType, 2, 'App Store icons must not carry an alpha channel')
})

test('iOS launch screen: three scales of the 2732 px square', () => {
  for (const file of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    assert.equal(size(`mobile/ios/App/App/Assets.xcassets/Splash.imageset/${file}`), '2732x2732', file)
  }
})

test('Android launcher icons: square and round, per density', () => {
  const legacy: Record<string, number> = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 }
  for (const [dir, px] of Object.entries(legacy)) {
    for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
      assert.equal(size(`mobile/android/app/src/main/res/mipmap-${dir}/${name}`), `${px}x${px}`, `${dir}/${name}`)
    }
  }
})

test('Android adaptive icon: foreground at 108 dp per density, background is the brand dark', () => {
  const foreground: Record<string, number> = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 }
  for (const [dir, px] of Object.entries(foreground)) {
    assert.equal(
      size(`mobile/android/app/src/main/res/mipmap-${dir}/ic_launcher_foreground.png`),
      `${px}x${px}`,
      dir,
    )
  }
  const background = readFileSync(
    ROOT + 'mobile/android/app/src/main/res/values/ic_launcher_background.xml',
    'utf8',
  )
  assert.match(background, /name="ic_launcher_background">#061A24</, 'the adaptive background must match the mark')
})

test('Android launch screens keep their folder sizes', () => {
  const screens: Record<string, string> = {
    'drawable/splash.png': '480x320',
    'drawable-port-mdpi/splash.png': '320x480',
    'drawable-port-hdpi/splash.png': '480x800',
    'drawable-port-xhdpi/splash.png': '720x1280',
    'drawable-port-xxhdpi/splash.png': '960x1600',
    'drawable-port-xxxhdpi/splash.png': '1280x1920',
    'drawable-land-mdpi/splash.png': '480x320',
    'drawable-land-hdpi/splash.png': '800x480',
    'drawable-land-xhdpi/splash.png': '1280x720',
    'drawable-land-xxhdpi/splash.png': '1600x960',
    'drawable-land-xxxhdpi/splash.png': '1920x1280',
  }
  for (const [path, expected] of Object.entries(screens)) {
    assert.equal(size(`mobile/android/app/src/main/res/${path}`), expected, path)
  }
})

test('web icons: apple touch icon at 180, and maskable icons with the mark in the safe zone', () => {
  assert.equal(size('public/apple-touch-icon.png'), '180x180')
  assert.equal(size('public/icon-maskable-192.png'), '192x192')
  assert.equal(size('public/icon-maskable-512.png'), '512x512')
  assert.equal(size('public/icon-192.png'), '192x192')
  assert.equal(size('public/icon-512.png'), '512x512')
})

test('manifest: each icon has one purpose, and the maskable ones are listed as maskable', () => {
  const manifest = JSON.parse(readFileSync(ROOT + 'public/manifest.json', 'utf8')) as {
    icons: Array<{ src: string; purpose: string }>
  }
  for (const icon of manifest.icons) {
    assert.ok(['any', 'maskable'].includes(icon.purpose), `${icon.src}: "${icon.purpose}"`)
    assert.ok(readFileSync(ROOT + 'public' + icon.src).length > 0, `${icon.src} is missing`)
  }
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable' && icon.src.endsWith('512.png')))
})
