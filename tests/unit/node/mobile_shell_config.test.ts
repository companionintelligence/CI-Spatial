/**
 * The Capacitor shell's configuration (mobile/capacitor.config.ts): HTTPS only,
 * pinch-zoom on in both shells, the bundle from mobile/www, and the app id the
 * native projects build with.
 *
 * Run: npm run test:mobile-config
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../../../mobile/capacitor.config.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

test('the shell serves its bundle over HTTPS only', () => {
  assert.equal(config.server?.cleartext, false)
  assert.equal(config.server?.androidScheme, 'https')
  assert.equal(config.server?.url, undefined, 'a remote url would replace the bundled app')
  assert.equal(config.android?.allowMixedContent, false)
  assert.equal(config.plugins?.CapacitorHttp?.enabled, false, 'fetch and XHR go straight to the WebView')
})

test('pinch-zoom stays on in both shells (WCAG 1.4.4)', () => {
  assert.equal(config.ios?.zoomEnabled, true)
  assert.equal(config.android?.zoomEnabled, true)
})

test('both shells name the app to a tile host: one distinct, stable token in the User-Agent, with no version', () => {
  // OpenStreetMap's tile policy asks apps for a distinct, stable User-Agent that names the app. The top-level
  // option reaches iOS and Android, and a platform's own option would override it, so neither sets one.
  assert.equal(config.appendUserAgent, 'CompanionScan')
  assert.doesNotMatch(config.appendUserAgent ?? '', /\d|Mozilla|Safari|Chrome|AppleWebKit/, 'no version that changes with releases, and no browser it could be mistaken for')
  assert.equal(config.ios?.appendUserAgent, undefined)
  assert.equal(config.android?.appendUserAgent, undefined)
  assert.equal(config.ios?.overrideUserAgent, undefined, 'an override would make appendUserAgent disregarded')
  assert.equal(config.android?.overrideUserAgent, undefined)
})

test('the bundle is the one scripts build into mobile/www', () => {
  assert.equal(config.webDir, 'www')
})

test('the Android app stays out of backup and device-to-device transfer, which would copy its session token', () => {
  const manifest = read('mobile/android/app/src/main/AndroidManifest.xml')
  const application = manifest.match(/<application\b([^>]*)>/)?.[1] ?? ''
  assert.match(application, /android:allowBackup="false"/, 'Android 11 and earlier')
  assert.match(application, /android:dataExtractionRules="@xml\/data_extraction_rules"/, 'Android 12 and later')
  const rules = read('mobile/android/app/src/main/res/xml/data_extraction_rules.xml').replace(/<!--[\s\S]*?-->/g, '')
  assert.doesNotMatch(rules, /<include\b/, 'nothing is opted back in')
  const domains = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref']
  for (const section of ['cloud-backup', 'device-transfer']) {
    const body = rules.match(new RegExp(`<${section}>([\\s\\S]*?)</${section}>`))?.[1]
    assert.ok(body !== undefined, `${section} is configured`)
    const excluded = [...body.matchAll(/<exclude domain="([a-z_]+)" path="\." \/>/g)].map((m) => m[1])
    assert.deepEqual(excluded, domains, `${section}: every domain is excluded whole`)
  }
})

test('the Capacitor app id matches the Android applicationId and the iOS bundle id', () => {
  assert.equal(config.appId, 'com.companionintelligence.scan')
  assert.match(read('mobile/android/app/build.gradle'), /applicationId "com\.companionintelligence\.scan"/)
  assert.match(read('mobile/ios/App/App.xcodeproj/project.pbxproj'), /PRODUCT_BUNDLE_IDENTIFIER = com\.companionintelligence\.scan;/)
})
