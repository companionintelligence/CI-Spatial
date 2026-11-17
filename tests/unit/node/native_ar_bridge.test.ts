/**
 * The ScanAR plugin lookup and capability probe (src/ar/native-bridge.ts), with the Capacitor
 * global stood in. Also the runtime choice (src/ar/runtime-select.ts): when native wins.
 *
 * Run: npm run test:native-ar
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { probeNativeAR, scanARPlugin } from '../../../src/ar/native-bridge.ts'
import { preferNativeRuntime } from '../../../src/ar/runtime-select.ts'

const SHELL = { isNativePlatform: () => true }

/** Installs a Capacitor stand-in for one test, then puts back whatever was there. */
async function withCapacitor(capacitor: unknown, body: () => Promise<void> | void): Promise<void> {
  const g = globalThis as unknown as { Capacitor?: unknown }
  const previous = g.Capacitor
  g.Capacitor = capacitor
  try {
    await body()
  } finally {
    if (previous === undefined) delete g.Capacitor
    else g.Capacitor = previous
  }
}

const CAPABILITIES = { platform: 'android', engine: 'arcore', supported: true, depth: true }

test('scanARPlugin is null outside the shell, even when a ScanAR object is present', async () => {
  await withCapacitor({ isNativePlatform: () => false, Plugins: { ScanAR: {} } }, () => {
    assert.equal(scanARPlugin(), null)
  })
  await withCapacitor(undefined, () => {
    assert.equal(scanARPlugin(), null)
  })
})

test('scanARPlugin returns the registered ScanAR plugin inside the shell', async () => {
  const plugin = { capabilities: async () => CAPABILITIES }
  await withCapacitor({ ...SHELL, Plugins: { ScanAR: plugin } }, () => {
    assert.equal(scanARPlugin(), plugin)
  })
  await withCapacitor({ ...SHELL, Plugins: {} }, () => {
    assert.equal(scanARPlugin(), null, 'a shell without the plugin reads as no native layer')
  })
})

test('probeNativeAR reports the capabilities, and null when there is no layer or it fails', async () => {
  assert.equal(await probeNativeAR(null), null)
  assert.deepEqual(await probeNativeAR({ capabilities: async () => CAPABILITIES } as never), CAPABILITIES)
  const failing = {
    capabilities: async () => {
      throw new Error('bridge closed')
    },
  }
  assert.equal(await probeNativeAR(failing as never), null)
})

test('preferNativeRuntime chooses native when the device can run it, and the web switches keep their runtime', () => {
  assert.equal(preferNativeRuntime({ forced: null, nativeSupported: true }), true)
  assert.equal(preferNativeRuntime({ forced: 'native', nativeSupported: true }), true)
  assert.equal(preferNativeRuntime({ forced: null, nativeSupported: false }), false)
  assert.equal(preferNativeRuntime({ forced: 'native', nativeSupported: false }), false)
  assert.equal(preferNativeRuntime({ forced: 'webxr', nativeSupported: true }), false)
  assert.equal(preferNativeRuntime({ forced: '8thwall', nativeSupported: true }), false)
})
