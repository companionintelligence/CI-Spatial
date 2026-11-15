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

// ── The release itself: file names, notes, and the workflow that publishes them ─────────────

test('release files are named for their platform, and the APK for how it is signed', async () => {
  const { assetName, SIGNING_MODES } = await import('../../../scripts/native/release-notes.mjs')
  assert.deepEqual(SIGNING_MODES, ['keystore', 'throwaway', 'skip'])
  assert.equal(assetName('windows-setup', '0.2.0'), 'companion-scan_0.2.0_windows-x64-setup.exe')
  assert.equal(assetName('macos-dmg', '0.2.0'), 'companion-scan_0.2.0_macos-universal.dmg')
  assert.deepEqual(SIGNING_MODES.map((mode: string) => assetName('android-apk', '0.2.0', mode)), [
    'companion-scan_0.2.0_android-release-key.apk',
    'companion-scan_0.2.0_android-throwaway-key.apk',
    'companion-scan_0.2.0_android-unsigned.apk',
  ])
  assert.throws(() => assetName('android-apk', '0.2.0', 'auto'), /unknown signing mode/, 'auto is resolved before naming')
})

test('the notes say everything the release policy asks, whatever signed the APK', async () => {
  const { releaseNotes, SIGNING_MODES } = await import('../../../scripts/native/release-notes.mjs')
  for (const signing of SIGNING_MODES) {
    const notes: string = releaseNotes({ version: '0.2.0', signing, cert: 'ab'.repeat(32), commit: 'deadbeef' })
    assert.doesNotMatch(notes, /\{\{/, `${signing}: every placeholder filled`)
    const policy: Array<[RegExp, string]> = [
      [/pre-release, not a store build/, 'a pre-release, not a store build'],
      [/SmartScreen[\s\S]*More info\*\*, then \*\*Run anyway/, 'SmartScreen'],
      [/right-click \(or Control-click\)[\s\S]*\*\*Open\*\*[\s\S]*Open Anyway/, 'macOS Open and Open Anyway'],
      [/sudo apt install \.\/companion-scan_0\.2\.0_linux-amd64\.deb/, 'deb'],
      [/sudo dnf install \.\/companion-scan_0\.2\.0_linux-x86_64\.rpm/, 'rpm'],
      [/allow installs from the browser or file manager/, 'Android sideloading'],
      [/signed with a different key, uninstall this one first/, 'a differently signed build needs an uninstall'],
      [/need your own Scan server[\s\S]*docs\/operations\/COMPANION_HUB\.md/, 'the user\'s own Scan server, with the Hub docs'],
      [/AR capture in the Android app has not been tried on a phone yet/, 'AR untried on phones'],
      [/desktop app is the editor and viewer only/, 'desktop is the editor and viewer'],
    ]
    for (const [pattern, what] of policy) assert.match(notes, pattern, `${signing}: ${what}`)
  }
})

test('the release workflow: manual only, every build first, gh and no release action', () => {
  const wf = read('.github/workflows/native-release.yml').replace(/\r\n/g, '\n')
  assert.match(wf, /^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}tag:\n[\s\S]*?required: true/m)
  assert.match(wf, /android_signing:[\s\S]*?default: auto[\s\S]*?options:\n {10}- auto\n {10}- keystore\n {10}- throwaway\n {10}- skip\n/)
  assert.doesNotMatch(wf, /^ {2}(push|pull_request|schedule|release):/m, 'nothing but a dispatch starts it')
  assert.match(wf, /publish:\n[\s\S]*?needs: \[prepare, desktop, android\]/)
  assert.match(wf, /gh release create "\$TAG" out\/\*[\s\S]*?--prerelease[\s\S]*?--notes-file notes\.md/)
  const uses = [...wf.matchAll(/uses: (\S+)/g)].map((m) => m[1]!)
  assert.ok(uses.length > 0)
  for (const action of uses) assert.match(action, /^actions\/[\w-]+@[0-9a-f]{40}$/, `${action}: GitHub's own actions only, pinned to a commit`)
  assert.doesNotMatch(wf, /VITE_API_BASE|VITE_[A-Z_]+:/, 'no server address or other VITE_ value is built in')
  const secretLines = wf.split('\n').filter((line) => line.includes('secrets.'))
  assert.equal(secretLines.length, 4, 'the four release-key secrets, and nothing else')
  assert.ok(secretLines.every((line) => /\$\{\{ secrets\.ANDROID_KEY(STORE_BASE64|STORE_PASSWORD|_ALIAS|_PASSWORD) \}\}/.test(line)))
  assert.match(wf, /trap 'rm -f "\$keystore"' EXIT/, 'the keystore file is deleted when the step ends')
  assert.match(wf, /keytool -genkeypair/, 'a throwaway key is made in the job')
})

/** Each job's text under jobs:, by its id, in file order. */
function workflowJobs(wf: string): Record<string, string> {
  const jobs = wf.split(/^jobs:\n/m)[1] ?? ''
  return Object.fromEntries(jobs.split(/^ {2}(?=[\w-]+:\n)/m).filter(Boolean).map((job) => [job.slice(0, job.indexOf(':')), job]))
}

test('only the publish job can write, and no checkout keeps its token for the build code to read', () => {
  const wf = read('.github/workflows/native-release.yml').replace(/\r\n/g, '\n')
  const jobs = workflowJobs(wf)
  assert.deepEqual(Object.keys(jobs), ['prepare', 'desktop', 'android', 'publish'])
  assert.match(wf, /^permissions:\n {2}contents: read\n\n/m, 'every job reads by default')
  assert.match(jobs.publish ?? '', /^ {4}permissions:\n {6}contents: write\n {4}\S/m, 'the publish job writes releases, and asks for nothing more')
  assert.equal(wf.match(/^ *permissions:/gm)?.length, 2, 'no other job sets its own permissions')
  assert.equal(wf.match(/^ +[\w-]+: write$/gm)?.length, 1, 'write is granted once, to the publish job')
  for (const [id, job] of Object.entries(jobs)) {
    const checkouts = [...job.matchAll(/^( +)- uses: actions\/checkout@.*\n((?:\1 {2}.*\n)*)/gm)]
    assert.equal(checkouts.length, 1, `${id}: one checkout`)
    assert.match(checkouts[0]?.[2] ?? '', /^ +with:\n +persist-credentials: false\n/m, `${id}: the checkout leaves no token in .git/config`)
  }
})

test('no git tag may have the name: prepare checks it, and publish again right before gh release create', () => {
  const wf = read('.github/workflows/native-release.yml').replace(/\r\n/g, '\n')
  const jobs = workflowJobs(wf)
  const check = 'git ls-remote --exit-code --tags origin "refs/tags/$TAG" > /dev/null || status=$?'
  for (const id of ['prepare', 'publish']) {
    const job = jobs[id] ?? ''
    assert.equal(job.split(check).length - 1, 1, `${id}: one tag check`)
    const after = job.slice(job.indexOf(check))
    // Only exit code 2 means "no such ref"; 0 is a tag, and anything else is a failed check.
    assert.match(after, /^ +case "\$status" in\n +2\) ;;\n +0\) echo "::error::[^\n]*"; exit 1 ;;\n +\*\) echo "::error::[^\n]*"; exit 1 ;;\n +esac\n/m, `${id}: only exit code 2 lets the release go on`)
  }
  const publish = jobs.publish ?? ''
  const tagCheck = publish.indexOf(check)
  const create = publish.indexOf('gh release create "$TAG"')
  assert.ok(tagCheck > 0 && create > tagCheck, 'publish checks the tag first')
  assert.doesNotMatch(publish.slice(tagCheck, create), /^ +- (name|uses):/m, 'in the same step as gh release create, with nothing in between')
})

test('the desktop builds: Windows NSIS and MSI, a universal ad-hoc signed macOS dmg, Linux deb and rpm', () => {
  for (const file of ['.github/workflows/native-release.yml', '.github/workflows/desktop-build.yml']) {
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
