/**
 * E5 guard for the colour tests in wp-e-android-colors.test.ts and wp-e2-android-colors.test.ts.
 * A check that cannot fail proves nothing. Each case copies the real tests into a temporary tree, breaks one
 * values file, and expects the test to fail on its own assertion. A copy of the real tree must pass.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-e5-android-colors-guards.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('../../../', import.meta.url)
const WP_E = 'tests/unit/node/wp-e-android-colors.test.ts'
const WP_E2 = 'tests/unit/node/wp-e2-android-colors.test.ts'
const STYLES = 'mobile/android/app/src/main/res/values/styles.xml'
const COLORS = 'mobile/android/app/src/main/res/values/colors.xml'

// AppTheme written as a self-closing tag, with the item in the next style.
const SELF_CLOSING_APPTHEME = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="Theme.AppCompat.Light.DarkActionBar" />
    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="colorPrimaryDark">@color/colorPrimaryDark</item>
    </style>
</resources>
`

// AppTheme with no closing tag before the next style, and the item sits in that next style.
const OPEN_APPTHEME_NO_CLOSE = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="Theme.AppCompat.Light.DarkActionBar">
    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="colorPrimaryDark">@color/colorPrimaryDark</item>
    </style>
</resources>
`

// colorPrimaryDark exists only inside a comment.
const COMMENTED_COLOR = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#072433</color>
    <!-- <color name="colorPrimaryDark">#041620</color> -->
    <color name="colorAccent">#72ddd4</color>
</resources>
`

/** Runs one test file in a copy of the real tree, with the given files replaced, and returns its exit status and output. */
function runCopy(testPath: string, replaced: Record<string, string>): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'wp-e5-guard-'))
  try {
    for (const path of [WP_E, WP_E2, 'public/manifest.json', 'index.html']) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      cpSync(new URL(path, REPO), join(root, path))
    }
    cpSync(new URL('mobile/android/app/src/main/res/values/', REPO), join(root, 'mobile/android/app/src/main/res/values'), { recursive: true })
    for (const [path, body] of Object.entries(replaced)) writeFileSync(join(root, path), body)
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
    const env = { ...process.env }
    // The test runner sets this for the tests it starts. A nested `node --test` that sees it exits without running anything.
    delete env.NODE_TEST_CONTEXT
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--test', join(root, testPath)], { encoding: 'utf8', env })
    return { status: run.status, output: run.stdout + run.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('a copy of the real tree passes both colour tests', () => {
  for (const testPath of [WP_E, WP_E2]) {
    const run = runCopy(testPath, {})
    assert.equal(run.status, 0, testPath + '\n' + run.output)
    assert.match(run.output, /^# pass [1-9]/m, testPath + ' ran no tests')
  }
})

test('a self-closing AppTheme fails wp-e2 on the AppTheme assertion', () => {
  const run = runCopy(WP_E2, { [STYLES]: SELF_CLOSING_APPTHEME })
  assert.notEqual(run.status, 0)
  assert.match(run.output, /AppTheme maps colorPrimaryDark to the status bar/)
})

test('an AppTheme with no close before the next style fails wp-e2 on the AppTheme assertion', () => {
  const run = runCopy(WP_E2, { [STYLES]: OPEN_APPTHEME_NO_CLOSE })
  assert.notEqual(run.status, 0)
  assert.match(run.output, /AppTheme maps colorPrimaryDark to the status bar/)
})

test('a colour defined only in a comment fails wp-e2 and wp-e', () => {
  const wpE2 = runCopy(WP_E2, { [COLORS]: COMMENTED_COLOR })
  assert.notEqual(wpE2.status, 0)
  assert.match(wpE2.output, /colorPrimaryDark is defined in values\//)
  const wpE = runCopy(WP_E, { [COLORS]: COMMENTED_COLOR })
  assert.notEqual(wpE.status, 0)
  assert.match(wpE.output, /@color\/colorPrimaryDark is used but not defined in values\//)
})
