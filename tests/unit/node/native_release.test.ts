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

// ── The build workflows ─────────────────────────────────────────────────────────────────────

test('the desktop builds: Windows NSIS and MSI, a universal ad-hoc signed macOS dmg, Linux deb and rpm', () => {
  for (const file of ['.github/workflows/desktop-build.yml']) {
    const wf = read(file).replace(/\r\n/g, '\n')
    assert.match(wf, /os: windows-latest\n.*\n {12}tauri-args: --bundles nsis,msi/, `${file}: Windows`)
    assert.match(wf, /os: macos-latest\n.*aarch64-apple-darwin x86_64-apple-darwin\n {12}tauri-args: --target universal-apple-darwin --bundles app,dmg/, `${file}: macOS universal`)
    assert.match(wf, /os: ubuntu-22\.04\n.*\n {12}tauri-args: --bundles deb,rpm/, `${file}: Linux`)
    assert.match(wf, /libwebkit2gtk-4\.1-dev/, `${file}: WebKitGTK 4.1`)
    assert.doesNotMatch(wf, /appimage/i, `${file}: no AppImage`)
    for (const m of wf.matchAll(/uses: (\S+)/g)) assert.match(m[1]!, /^actions\/[\w-]+@[0-9a-f]{40}$/, `${file}: ${m[1]}`)
  }
  const tauri = JSON.parse(read('desktop/src-tauri/tauri.conf.json'))
  assert.equal(tauri.bundle.macOS.signingIdentity, '-', 'ad-hoc signed, so Apple silicon offers Open Anyway')
  assert.deepEqual(tauri.bundle.targets, ['nsis', 'msi', 'app', 'dmg', 'deb', 'rpm'])
})

test('the mobile build workflow pins its actions, uses no third-party action, and bakes no server in', () => {
  for (const file of ['.github/workflows/mobile-build.yml', '.github/workflows/desktop-build.yml']) {
    const wf = read(file)
    for (const m of wf.matchAll(/uses: (\S+)/g)) assert.match(m[1]!, /^actions\/[\w-]+@[0-9a-f]{40}$/, `${file}: ${m[1]}`)
    assert.doesNotMatch(wf, /^\s*VITE_API_BASE\s*:/m, `${file}: no server address built in`)
    assert.doesNotMatch(wf, /android-actions\/setup-android|dtolnay\/rust-toolchain/, `${file}: no third-party action`)
  }
})
