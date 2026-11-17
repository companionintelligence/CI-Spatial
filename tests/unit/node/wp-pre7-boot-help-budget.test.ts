/**
 * PRE7-1, PRE7-3 and PRE7-4: the start screen's worst case, with the boot-written
 * `#ar-help` line counted.
 *
 * startup_word_budget.test.ts pins the screen as drawn (its worst is 130), and
 * its ceiling check is on that number. This file adds the line the boot writes
 * into `#ar-help`, from the same probe and the same no-runtime path main.ts
 * runs, and holds the sum to the same 142.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-pre7-boot-help-budget.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { DeviceCapture } from '../../../src/capture/capture-intent.ts'
import { probeVerdict } from '../../../src/ar/preflight.ts'
import {
  MOCK_CASE,
  SHOW_AR_HELP_LINES,
  SUBJECTS,
  WORDS_BEFORE_CAMERA_MAX,
  bootCases,
  bootHelpWords,
  countWords,
  probeDevices,
  showArHelpLinesMissingFrom,
  showArHelpWordsMax,
  wordsBeforeCamera,
} from '../../support/startup-budget.ts'

/** The device classes the boot text is pinned for, named as the start screen names them. */
const NATIVE_ADVERTISED: DeviceCapture = { secureContext: true, nativeAr: 'unknown', browserAr: 'no' }
const NO_LIVE: DeviceCapture = { secureContext: true, nativeAr: 'no', browserAr: 'no' }
const INSECURE: DeviceCapture = { secureContext: false, nativeAr: 'unknown', browserAr: 'yes' }
const ENGINE: DeviceCapture = { secureContext: true, nativeAr: 'no', browserAr: 'yes' }
const ENGINE_AND_NATIVE: DeviceCapture = { secureContext: true, nativeAr: 'unknown', browserAr: 'yes' }

function where(c: { subject: string, deviceName: string }): string {
  return c.subject + ' / ' + c.deviceName
}

test('the worst screen, with its boot line counted, is at the ceiling and not over it', () => {
  const cases = bootCases()
  for (const c of cases) {
    assert.ok(
      c.words.withBootHelp <= WORDS_BEFORE_CAMERA_MAX,
      where(c) + ': ' + c.words.withBootHelp + ' words before the camera, budget ' + WORDS_BEFORE_CAMERA_MAX
      + ' (screen ' + c.words.total + ' + boot line ' + c.words.bootHelp + ')',
    )
  }
  // Pinned to the measured worst, so a copy change moves this on purpose. The
  // worst screen is the native-advertised page, whose caveat is twelve words.
  const worst = cases[0]!
  assert.equal(
    worst.words.withBootHelp, 142,
    'the worst screen is ' + where(worst) + ' at ' + worst.words.withBootHelp + ' words, not 142',
  )
  assert.equal(worst.deviceName, 'secure page, native advertised, no in-browser engine')
  assert.equal(worst.words.total, 130, 'the screen before the boot line is the one startup_word_budget.test.ts pins')
  assert.equal(worst.words.bootHelp, 12)
})

test('the boot line each device class can draw, worst case', () => {
  // Each class is named with the writer that sets its count. The writers are
  // checked one by one in the two tests below.
  assert.equal(bootHelpWords(NATIVE_ADVERTISED), 12, 'the advertised caveat (12), or the no-runtime line (12)')
  assert.equal(bootHelpWords(NO_LIVE), 14, 'the boot no-AR line (14), which is longer than the no-runtime line (12)')
  assert.equal(
    bootHelpWords(INSECURE), 10,
    'the HTTPS line (10), charged on every insecure page though main.ts never writes it at boot',
  )
  assert.equal(bootHelpWords(ENGINE), 0, 'the engine loaded: nothing is written at boot')
  assert.equal(bootHelpWords(ENGINE_AND_NATIVE), 0, 'the engine loaded on an advertised page: nothing is written')
})

test('the native-advertised page is charged each boot writer by name, with its own count (PRE7-4, PRE8-2)', () => {
  // Writer 1, the boot caveat: applyPreflightToStartScreen() writes probeVerdict()'s
  // detail for the one probe state that is advertised but unproven.
  const caveat = probeVerdict({ secureContext: true, xr8Loaded: false, webxrApi: true, immersiveArAdvertised: true })
  assert.equal(caveat.detail, 'AR is unproven. If it fails, other capture options need no AR.')
  assert.equal(countWords(caveat.detail), 12, 'the boot caveat is ' + countWords(caveat.detail) + ' words, not 12')

  // Writer 2, the no-runtime line: showArHelp() writes this line on the same class,
  // and it must still be in main.ts (showArHelpLinesMissingFrom() checks that).
  const noRuntime = 'Reload the page. If it keeps failing, the server may be down'
  assert.ok(
    SHOW_AR_HELP_LINES.some((entry) => entry.line === noRuntime),
    'showArHelp() no longer carries "' + noRuntime + '": update SHOW_AR_HELP_LINES',
  )
  assert.equal(countWords(noRuntime), 12, 'the no-runtime line is ' + countWords(noRuntime) + ' words, not 12')
  assert.equal(
    showArHelpWordsMax(), countWords(noRuntime),
    'the longest showArHelp line is ' + showArHelpWordsMax() + ' words, not the ' + countWords(noRuntime) + ' of "' + noRuntime + '"',
  )

  // The writers never both run in one boot, so the class is charged the longer of the two.
  assert.equal(
    bootHelpWords(NATIVE_ADVERTISED), Math.max(countWords(caveat.detail), countWords(noRuntime)),
    'the native-advertised class is charged the larger of the boot caveat and the no-runtime line',
  )
})

test('the no-AR class is charged the boot no-AR line by name, with its own count (PRE8-1, PRE8-2)', () => {
  // Writer 3, the boot no-AR line: both probe states that report no AR write this
  // line, one with no WebXR API and one with an API that declines an immersive session.
  const noApi = probeVerdict({ secureContext: true, xr8Loaded: false, webxrApi: false, immersiveArAdvertised: false })
  const noSession = probeVerdict({ secureContext: true, xr8Loaded: false, webxrApi: true, immersiveArAdvertised: false })
  assert.equal(noSession.detail, noApi.detail, 'both no-AR probe states write the same boot line')
  assert.equal(
    noApi.detail, 'No live scan. Try a tripod sweep, or video or photos, which catalogues nothing.',
    'the boot no-AR line is not the text pinned here',
  )
  assert.equal(countWords(noApi.detail), 14, 'the boot no-AR line is ' + countWords(noApi.detail) + ' words, not 14')

  // The no-runtime line (showArHelp, twelve words) is the other writer on this class.
  assert.equal(showArHelpWordsMax(), 12, 'the longest showArHelp line is twelve words')
  assert.equal(
    bootHelpWords(NO_LIVE), Math.max(countWords(noApi.detail), showArHelpWordsMax()),
    'the no-AR class is charged the larger of the boot no-AR line and the no-runtime line',
  )
  assert.equal(bootHelpWords(NO_LIVE), 14)
})

test('the mirrored showArHelp lines are still in main.ts', () => {
  assert.deepEqual(
    showArHelpLinesMissingFrom(), [],
    'main.ts no longer carries these showArHelp lines: update SHOW_AR_HELP_LINES in tests/support/startup-budget.ts',
  )
})

test('the longest no-runtime line is twelve words', () => {
  assert.equal(showArHelpWordsMax(), 12)
})

test('the mock screen is charged nothing, and stays at 119 words', () => {
  const mock = wordsBeforeCamera(MOCK_CASE.subject, MOCK_CASE.device)
  assert.equal(mock.bootHelp, 0)
  assert.equal(mock.withBootHelp, mock.total)
  assert.equal(mock.total, 119, 'the mock screen before the camera; startup_word_budget.test.ts pins the same figure')
})

test('the boot writer covers every device class the probe can produce', () => {
  // Eight classes: secure or not, native advertised or not, engine loaded or not,
  // with native proven unreachable from a probe. A change to deviceFromProbe()
  // that adds a class is what this count is for.
  assert.equal(probeDevices().length, 8)
  assert.equal(bootCases().length, SUBJECTS.length * probeDevices().length)
})
