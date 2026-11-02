/**
 * The app's icons and launch screens (scripts/generate-icons.mjs writes
 * them): every surface uses the one night-space background, every size is
 * where the manifest, the HTML and the native projects expect it, and the store
 * images carry no alpha channel.
 *
 * Run: npm run test:app-icons
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const BACKGROUND = '#041620'
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/** Width, height and colour type from a PNG's IHDR chunk. Colour types 4 and 6 carry alpha. */
function pngInfo(path: string) {
  const bytes = readFileSync(join(ROOT, path))
  assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47], `${path} is not a PNG`)
  const colorType = bytes.readUInt8(25)
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    hasAlpha: colorType === 4 || colorType === 6,
  }
}

/** The colour a launch storyboard's sRGB components describe, as #rrggbb. */
function hexFromUnit(red: number, green: number, blue: number) {
  return '#' + [red, green, blue].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')
}

const manifest = JSON.parse(read('public/manifest.json')) as {
  theme_color: string
  background_color: string
  icons: Array<{ src: string, sizes: string, purpose: string }>
}

test('the manifest declares separate any and maskable icons, each the size it claims', () => {
  const purposes = manifest.icons.map((icon) => icon.purpose)
  assert.ok(!purposes.includes('any maskable'), 'a combined "any maskable" icon is cropped on Android')
  const declared = manifest.icons.map((icon) => `${icon.purpose} ${icon.sizes}`)
  assert.deepEqual(declared, ['any 192x192', 'any 512x512', 'maskable 512x512'])
  for (const icon of manifest.icons) {
    const [size] = icon.sizes.split('x').map(Number)
    const info = pngInfo(`public${icon.src}`)
    assert.deepEqual([info.width, info.height], [size, size], `${icon.src} is not ${icon.sizes}`)
  }
})

test('the maskable icon keeps the mark inside the central 80% safe circle', () => {
  // The generator draws the mark at 46% of the icon. The safe circle is 80% of the
  // width, so the mark's diagonal (46% * sqrt(2) ≈ 65%) stays inside it.
  const generator = read('scripts/generate-icons.mjs')
  const maskable = generator.match(/maskable-512\.png', width: 512, height: 512, mark: ([\d.]+)/)
  assert.ok(maskable, 'the generator writes public/icon-maskable-512.png')
  assert.ok(Number(maskable[1]) * Math.SQRT2 <= 0.8, `mark ${maskable[1]} overflows the 80% safe circle`)
})

test('one background colour: manifest, HTML, Capacitor, launch screens and the generator agree', () => {
  assert.equal(manifest.theme_color, BACKGROUND)
  assert.equal(manifest.background_color, BACKGROUND)
  assert.match(read('index.html'), new RegExp(`<meta name="theme-color" content="${BACKGROUND}"`))
  assert.match(read('mobile/capacitor.config.ts'), new RegExp(`backgroundColor: '${BACKGROUND}'`))
  assert.match(read('mobile/android/app/src/main/res/values/ic_launcher_background.xml'), new RegExp(`>${BACKGROUND}<`))
  assert.match(read('mobile/android/app/src/main/res/values/styles.xml'), new RegExp(`windowSplashScreenBackground">${BACKGROUND}<`))
  const storyboard = read('mobile/ios/App/App/Base.lproj/LaunchScreen.storyboard')
  const [, red, green, blue] = storyboard.match(/<color key="backgroundColor" red="([\d.]+)" green="([\d.]+)" blue="([\d.]+)"/) ?? []
  assert.ok(red, 'the launch storyboard sets an explicit background colour')
  assert.equal(hexFromUnit(Number(red), Number(green), Number(blue)), BACKGROUND)
  assert.match(read('scripts/generate-icons.mjs'), new RegExp(`const BG = '${BACKGROUND}'`))
})

test('the apple touch icon is 180 px, linked from the HTML, and opaque', () => {
  const link = read('index.html').match(/<link rel="apple-touch-icon" sizes="180x180" href="([^"]+)"/)
  assert.ok(link, 'index.html links an apple touch icon at 180x180')
  const info = pngInfo(`public${link[1]}`)
  assert.deepEqual([info.width, info.height], [180, 180])
  assert.equal(info.hasAlpha, false, 'iOS shows a transparent apple touch icon as black')
})

test('the iOS app icon and launch images are opaque and the sizes Xcode expects', () => {
  const icon = pngInfo('mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')
  assert.deepEqual([icon.width, icon.height], [1024, 1024])
  assert.equal(icon.hasAlpha, false, 'App Store builds reject an app icon with an alpha channel')
  for (const file of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    const image = pngInfo(`mobile/ios/App/App/Assets.xcassets/Splash.imageset/${file}`)
    assert.deepEqual([image.width, image.height], [2732, 2732], file)
    assert.equal(image.hasAlpha, false, file)
  }
})

test('every Android density has its launcher, round and foreground icons at the expected size', () => {
  const res = 'mobile/android/app/src/main/res'
  const legacy = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 }
  const foreground = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 }
  for (const [density, size] of Object.entries(legacy)) {
    const launcher = pngInfo(`${res}/mipmap-${density}/ic_launcher.png`)
    assert.deepEqual([launcher.width, launcher.height], [size, size], density)
    assert.equal(launcher.hasAlpha, false, `${density} launcher`)
    const round = pngInfo(`${res}/mipmap-${density}/ic_launcher_round.png`)
    assert.deepEqual([round.width, round.height], [size, size], density)
    assert.equal(round.hasAlpha, true, `${density} round launcher keeps transparent corners`)
  }
  for (const [density, size] of Object.entries(foreground)) {
    const layer = pngInfo(`${res}/mipmap-${density}/ic_launcher_foreground.png`)
    assert.deepEqual([layer.width, layer.height], [size, size], density)
    assert.equal(layer.hasAlpha, true, `${density} adaptive foreground is transparent around the mark`)
  }
})

test('the Android launch images exist for every portrait and landscape density', () => {
  const res = 'mobile/android/app/src/main/res'
  const sizes: Array<[string, number, number]> = [
    ['drawable', 480, 320],
    ['drawable-port-mdpi', 320, 480], ['drawable-land-mdpi', 480, 320],
    ['drawable-port-hdpi', 480, 800], ['drawable-land-hdpi', 800, 480],
    ['drawable-port-xhdpi', 720, 1280], ['drawable-land-xhdpi', 1280, 720],
    ['drawable-port-xxhdpi', 960, 1600], ['drawable-land-xxhdpi', 1600, 960],
    ['drawable-port-xxxhdpi', 1280, 1920], ['drawable-land-xxxhdpi', 1920, 1280],
  ]
  for (const [dir, width, height] of sizes) {
    const image = pngInfo(`${res}/${dir}/splash.png`)
    assert.deepEqual([image.width, image.height], [width, height], dir)
    assert.equal(image.hasAlpha, false, dir)
  }
})

test('the gen-icons script runs the generator that writes these files', () => {
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
  assert.equal(scripts['gen-icons'], 'node scripts/generate-icons.mjs')
})
