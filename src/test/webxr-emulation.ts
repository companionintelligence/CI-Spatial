/**
 * WebXR emulation hook for automated tests — installs Meta's Immersive Web
 * Emulation Runtime (iwer, the engine behind the immersive-web-emulator
 * browser extension) so `navigator.xr` exists in headless browsers.
 *
 * Activated by src/main.ts when the page is opened with ?mock=webxr.
 * The emulated device is exposed as `window.__iwerDevice` so Playwright can
 * drive head pose / input from the test.
 *
 * Dev/test-only: loaded via dynamic import, so iwer never lands in the
 * production bundle for normal sessions.
 */
import { XRDevice, metaQuest3 } from 'iwer'

declare global {
  interface Window {
    __iwerDevice?: InstanceType<typeof XRDevice>
  }
}

export async function installWebXREmulation(): Promise<void> {
  if (window.__iwerDevice) return
  const device = new XRDevice(metaQuest3)
  device.installRuntime()
  // Mono rendering is closer to handheld AR and cheaper in CI
  device.stereoEnabled = false
  device.ipd = 0
  window.__iwerDevice = device
  console.log('[webxr-emulation] iwer runtime installed (emulated Quest 3)')
}
