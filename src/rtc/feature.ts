/**
 * Live WebRTC is intentionally opt-in until its device-to-editor connection
 * path is reliable. Both scanner and editor read this build-time flag.
 */
export const WEBRTC_LIVE_ENABLED =
  import.meta.env?.VITE_ENABLE_WEBRTC_LIVE === 'true'
