/**
 * Whether the scanner starts on the native AR runtime (ARKit on iOS, ARCore on Android)
 * instead of the web runtimes (8th Wall, then WebXR). Kept pure so the rule is tested without
 * a device.
 *
 * The web runtimes keep their URL switches: `?ar=webxr` and `?ar=8thwall` never pick native,
 * whatever the device can do. Otherwise native wins whenever the native layer reports that a
 * session can start. A native session that fails to start falls back to the web runtimes inside
 * NativeARProvider.start(), so this choice is not final.
 */
export interface NativeRuntimeChoice {
  /** The `?ar=` query value, if any. */
  forced: string | null
  /** The native layer reported that an AR session can start on this device. */
  nativeSupported: boolean
}

export function preferNativeRuntime(choice: NativeRuntimeChoice): boolean {
  if (choice.forced === 'webxr' || choice.forced === '8thwall') return false
  return choice.nativeSupported
}
