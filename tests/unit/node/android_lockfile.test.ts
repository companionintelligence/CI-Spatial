/**
 * The Android release build's dependency lock (mobile/android/app/gradle.lockfile) against what the app declares
 * and what the notices can name.
 *
 * The release build resolves releaseRuntimeClasspath under strict dependency locking (app/build.gradle), so a library
 * that build.gradle declares and the lockfile does not pin stops `assembleRelease`, and with it the release workflow's
 * publish job. The debug build is not locked, so building it alone would not show it. A pinned library
 * that third-party-notices.mjs has no licence for stops the notices instead. Neither needs an Android SDK to see.
 *
 * What this cannot see: the transitive libraries. Only Gradle resolves those, and the Mobile Build workflow's step
 * 'Check the release dependency lock against Gradle' confirms the lock when someone dispatches it: in mobile/android,
 * `./gradlew :app:dependencies --configuration releaseRuntimeClasspath --write-locks` must leave gradle.lockfile
 * unchanged.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/android_lockfile.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANDROID_LICENCES, ANDROID_LOCKFILE, lockedLibraries } from '../../../scripts/native/third-party-notices.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

const REGENERATE = 'in mobile/android: ./gradlew :app:dependencies --configuration releaseRuntimeClasspath --write-locks'

/** A library the app's build.gradle asks for by name and version. */
interface Declared {
  group: string
  artifact: string
  version: string
  /** Where the version came from, for the failure message: `arcoreVersion in variables.gradle`, or build.gradle itself. */
  from: string
}

/** The configurations whose libraries end up in releaseRuntimeClasspath, and so in the release APK. */
const IN_RELEASE_APK = new Set(['implementation', 'api', 'runtimeOnly', 'releaseImplementation', 'releaseApi', 'releaseRuntimeOnly'])

/** Gradle source without its comments. A `//` that follows a colon, as in a URL, is not a comment. */
function withoutComments(gradle: string): string {
  return gradle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
}

/** The body of the script's top-level `dependencies { ... }` block. */
function dependenciesBlock(gradle: string): string {
  const code = withoutComments(gradle)
  const open = code.search(/^dependencies\s*\{/m)
  assert.ok(open >= 0, 'app/build.gradle has a top-level dependencies block')
  const start = code.indexOf('{', open)
  let depth = 0
  for (let at = start; at < code.length; at++) {
    if (code[at] === '{') depth++
    else if (code[at] === '}' && --depth === 0) return code.slice(start + 1, at)
  }
  return assert.fail('the dependencies block in app/build.gradle is never closed')
}

/** The string values in variables.gradle's `ext { name = '1.2.3' }`, by name. */
function versionVariables(gradle: string): Map<string, string> {
  return new Map([...withoutComments(gradle).matchAll(/^\s*(\w+)\s*=\s*['"]([^'"]+)['"]\s*$/gm)].map((m): [string, string] => [m[1]!, m[2]!]))
}

/**
 * The libraries app/build.gradle declares for the release APK, by group, name and version. A project module is skipped,
 * since Gradle locks what it brings in, and so is the libs/ folder of local jars, which no lock can hold (a later test
 * asks that it hold none). Any other declaration stops the test, so a form it does not read cannot go unchecked.
 */
function declaredLibraries(): { declared: Declared[]; localJars: boolean } {
  const variables = versionVariables(read('mobile/android/variables.gradle'))
  const declared: Declared[] = []
  const unread: string[] = []
  let localJars = false
  for (const line of dependenciesBlock(read('mobile/android/app/build.gradle')).split('\n')) {
    const [, configuration, rest] = line.match(/^\s*(\w+)[\s(]\s*(.+?)\s*$/) ?? []
    if (!configuration || rest === undefined || !IN_RELEASE_APK.has(configuration)) continue
    if (/^project\(/.test(rest)) continue
    if (/^fileTree\(/.test(rest)) {
      localJars = true
      continue
    }
    // "group:artifact:$versionVar", "group:artifact:${versionVar}" or "group:artifact:1.2.3". Single quotes do not interpolate.
    const parts = rest.match(/^(["'])([^"':\s$]+):([^"':\s$]+):(?:\$\{?(\w+)\}?|([\w.+-]+))\1$/)
    if (!parts || (parts[1] === "'" && parts[4])) {
      unread.push(line.trim())
      continue
    }
    const [, , group, artifact, variable, literal] = parts
    const version = variable ? variables.get(variable) : literal
    assert.ok(version, `${group}:${artifact}: ${variable} is not a string in variables.gradle`)
    declared.push({ group: group!, artifact: artifact!, version, from: variable ? `${variable} in variables.gradle` : 'build.gradle' })
  }
  assert.deepEqual(unread, [], 'dependencies this test does not read: teach declaredLibraries() the form, so the lock still covers it')
  return { declared, localJars }
}

/** How version `a` orders against `b`: dotted numbers first, and a release above its own pre-release (1.4.0 over 1.4.0-rc01). */
function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const match = version.match(/^(\d+(?:\.\d+)*)(?:-(.+))?$/)
    assert.ok(match, `version ${version}: this test reads dotted numbers with an optional -qualifier`)
    return { numbers: match[1]!.split('.').map(Number), qualifier: match[2] ?? null }
  }
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(x.numbers.length, y.numbers.length); i++) {
    const difference = (x.numbers[i] ?? 0) - (y.numbers[i] ?? 0)
    if (difference) return Math.sign(difference)
  }
  if (x.qualifier === y.qualifier) return 0
  if (x.qualifier === null) return 1
  if (y.qualifier === null) return -1
  return x.qualifier < y.qualifier ? -1 : 1
}

/** What the lockfile pins for the release build. */
const locked = (): Array<{ group: string; artifact: string; version: string }> => lockedLibraries(readFileSync(ANDROID_LOCKFILE, 'utf8'))

test('versions order by their dotted numbers, and a release sorts above its own pre-release', () => {
  assert.equal(compareVersions('1.57.0', '1.57.0'), 0)
  assert.equal(compareVersions('2', '2.0.0'), 0, 'a missing number is zero')
  assert.equal(compareVersions('1.8.1', '1.3.0'), 1)
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1, 'numbers, not text')
  assert.equal(compareVersions('1.4.0', '1.4.0-rc01'), 1)
  assert.equal(compareVersions('1.4.0-alpha01', '1.4.0-beta01'), -1)
  assert.throws(() => compareVersions('latest', '1.0.0'), /dotted numbers/)
})

test('every library app/build.gradle declares is locked for the release build, at that version or a higher one', () => {
  const { declared } = declaredLibraries()
  const names = declared.map((d) => `${d.group}:${d.artifact}`)
  // The test is reading the file: these are in it, and ARCore is the one that was once declared and left out of the lock.
  for (const name of ['androidx.appcompat:appcompat', 'androidx.coordinatorlayout:coordinatorlayout', 'androidx.core:core-splashscreen', 'com.google.ar:core']) {
    assert.ok(names.includes(name), `${name} is read from app/build.gradle`)
  }
  const pins = locked()
  const problems: string[] = []
  for (const { group, artifact, version, from } of declared) {
    const pinned = pins.find((l) => l.group === group && l.artifact === artifact)
    if (!pinned) {
      problems.push(`${group}:${artifact}:${version} (${from}) is declared but not locked for releaseRuntimeClasspath, so assembleRelease stops`)
    } else if (compareVersions(pinned.version, version) < 0) {
      // A higher locked version is fine: Gradle takes the highest version any dependency asks for. A lower one cannot be what resolves.
      problems.push(`${group}:${artifact} is locked at ${pinned.version}, below the ${version} that ${from} asks for`)
    }
  }
  assert.deepEqual(problems, [], `regenerate the lock, ${REGENERATE}`)
})

test('no local jar goes into the release APK, since neither the lockfile nor the notices could name it', () => {
  const libs = join(ROOT, 'mobile/android/app/libs')
  const jars = declaredLibraries().localJars && existsSync(libs) ? readdirSync(libs).filter((name) => /\.jar$/i.test(name)) : []
  assert.deepEqual(jars, [])
})

test('every library the lockfile pins has a licence entry, so the notices can name it', () => {
  const pins = locked()
  assert.ok(pins.length > 20, 'the lockfile is read')
  // third-party-notices.mjs leaves a BOM out: it aligns versions and puts nothing in the APK.
  const unknown = pins
    .filter((l) => !l.artifact.endsWith('-bom') && !ANDROID_LICENCES.some((entry: { match: RegExp }) => entry.match.test(`${l.group}:${l.artifact}`)))
    .map((l) => `${l.group}:${l.artifact}:${l.version}`)
  assert.deepEqual(unknown, [], 'a pinned library with no licence entry stops the notices: check its licence, then add it to ANDROID_LICENCES in scripts/native/third-party-notices.mjs')
})
