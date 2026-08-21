/**
 * Ambient types for the WebXR "raw camera access" module feature
 * (https://immersive-web.github.io/raw-camera-access/), used by
 * src/ar/webxr.ts to read capture-button frames off the same camera session
 * ARCore already claims for tracking (see that file's header comment for
 * why).
 *
 * @types/webxr@0.5.24 (pinned in package.json) declares `XRWebGLBinding`
 * (for layers) and its depth-sensing extension, but not this module: no
 * `XRCamera`, no `XRView.camera`, no `XRWebGLBinding.getCameraImage()`. This
 * file is a global ambient script (no import/export) so these interfaces
 * merge with the ones @types/webxr already declares globally, the same way
 * @types/webxr's own depth-sensing extension augments XRWebGLBinding and
 * XRFrame in-place.
 */

interface XRCamera {
  readonly width: number
  readonly height: number
}

interface XRView {
  /** Populated only when the 'camera-access' optional feature was granted. */
  readonly camera?: XRCamera | null
}

interface XRWebGLBinding {
  /**
   * Returns an opaque WebGLTexture (bound to the TEXTURE_2D target) holding
   * this frame's camera image. Owned by the session — never delete it.
   */
  getCameraImage(camera: XRCamera): WebGLTexture
}
