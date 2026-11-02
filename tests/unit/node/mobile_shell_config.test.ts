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

test('the bundle is the one scripts build into mobile/www', () => {
  assert.equal(config.webDir, 'www')
})

test('the Capacitor app id matches the Android applicationId and the iOS bundle id', () => {
  assert.equal(config.appId, 'com.companionintelligence.scan')
  assert.match(read('mobile/android/app/build.gradle'), /applicationId "com\.companionintelligence\.scan"/)
  assert.match(read('mobile/ios/App/App.xcodeproj/project.pbxproj'), /PRODUCT_BUNDLE_IDENTIFIER = com\.companionintelligence\.scan;/)
})
