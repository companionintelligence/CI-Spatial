/**
 * What a native release depends on in the repository: one version across the desktop and Android
 * apps (scripts/native/check-versions.mjs), and an Android release build that is signed only from
 * the environment or the git-ignored keystore.properties, and is never debuggable.
 *
 * Run: npm run test:native-release
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { androidVersionCode, appVersions, versionProblems } from '../../../scripts/native/check-versions.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

test('the desktop and Android apps are both 0.2.0, written the same in all six places', () => {
  const versions = appVersions()
  assert.equal(Object.keys(versions).length, 6)
  for (const [file, version] of Object.entries(versions)) assert.equal(version, '0.2.0', file)
  assert.equal(androidVersionCode(), 2, 'versionCode rises with each release; 1 was the scaffold')
  assert.deepEqual(versionProblems(), [])
})

test('a release tag must be v and the apps\' version, with no suffix the MSI installer would refuse', () => {
  assert.deepEqual(versionProblems('v0.2.0'), [])
  assert.match(versionProblems('v0.2.1').join(), /does not match the apps' version 0\.2\.0/)
  assert.match(versionProblems('0.2.0').join(), /is not v and a plain x\.y\.z version/)
  assert.match(versionProblems('v0.2.0-alpha.1').join(), /is not v and a plain x\.y\.z version/)
})

test('the Android release build signs only from the environment or keystore.properties, all or nothing', () => {
  const gradle = read('mobile/android/app/build.gradle')
  for (const name of ['ANDROID_SIGNING_STORE_FILE', 'ANDROID_SIGNING_STORE_PASSWORD', 'ANDROID_SIGNING_KEY_ALIAS', 'ANDROID_SIGNING_KEY_PASSWORD']) {
    assert.ok(gradle.includes(`'${name}'`), name)
  }
  assert.match(gradle, /rootProject\.file\('keystore\.properties'\)/, 'the local path still works')
  assert.match(gradle, /throw new GradleException\("Release signing from the environment is incomplete/, 'half a configuration fails loudly')
  assert.match(gradle, /if \(releaseSigning\) \{\s*signingConfig signingConfigs\.release/, 'the config applies only when set')
  assert.doesNotMatch(gradle, /storePassword\s+['"][^'"]+['"]/, 'no password in the file')
  assert.match(read('mobile/.gitignore'), /^android\/keystore\.properties$/m)
  assert.match(read('mobile/.gitignore'), /^\*\.jks$/m)
})

test('the Android release build is not debuggable', () => {
  const release = read('mobile/android/app/build.gradle').match(/buildTypes \{\s*release \{([\s\S]*?)\n {8}\}/)?.[1] ?? ''
  assert.match(release, /debuggable false/)
  assert.doesNotMatch(read('mobile/android/app/src/main/AndroidManifest.xml'), /android:debuggable/)
})
