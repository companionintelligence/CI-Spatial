/**
 * WP-C / F50 and CAR-8: a camera refusal in the Capacitor shells points at the
 * app's own permission in Settings, without naming the app (its installed name
 * differs by platform). The browser copy keeps pointing at the site setting.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-c-sweep-copy.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAMERA_ON_LABEL, cameraRefusal } from '../../../src/capture/sweep-cadence.ts'

function setCapacitor(value: unknown): void {
  const g = globalThis as { Capacitor?: unknown }
  if (value === undefined) delete g.Capacitor
  else g.Capacitor = value
}

test('F50: in a browser, a denied camera points at the site setting', () => {
  setCapacitor(undefined)
  assert.match(cameraRefusal('denied'), /Allow the camera for this site, then press Photograph this sweep\./)
})

test('F50 and CAR-8: in a native shell, a denied camera points at the app in Settings, not a site setting', () => {
  setCapacitor({ isNativePlatform: () => true })
  try {
    const copy = cameraRefusal('denied')
    assert.equal(
      copy,
      'Camera access was refused, so the sweep cannot photograph anything. '
        + "Turn on Camera in this app's permissions in Settings, then come back and press Photograph this sweep. "
        + 'Photos taken another way can still be added below.',
    )
    assert.doesNotMatch(copy, /this site/)
    assert.doesNotMatch(copy, /Companion Scan/, 'the installed app name differs by platform, so the copy must not use it')
  } finally {
    setCapacitor(undefined)
  }
})

test('F50: the other refusals read the same in a native shell', () => {
  const expectedBusy = 'Something else on the phone is holding the camera. Close it, or reload this page, '
    + `then press ${CAMERA_ON_LABEL}. Photos taken another way can still be added below.`
  setCapacitor(undefined)
  const inBrowser = cameraRefusal('busy')
  setCapacitor({ isNativePlatform: () => true })
  try {
    assert.equal(cameraRefusal('busy'), inBrowser)
    assert.equal(cameraRefusal('busy'), expectedBusy)
  } finally {
    setCapacitor(undefined)
  }
})
