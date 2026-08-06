/**
 * The Companion Scan icon set — inline, monochrome, `currentColor`.
 *
 * Every one of these replaces an OS emoji. Emoji were doing icon duty on the
 * onboarding hero art, the start-screen paths, the AR action rail, the Review &
 * Export actions and the World Editor toolbar, and on a store listing they read
 * as placeholder for three separate reasons:
 *
 *   1. They render in the OS's own colour palette. A grey-and-white satellite
 *      dish and a sepia film strip inside teal-branded cards are the two loudest
 *      things on the start screen, and neither colour is ours.
 *   2. They are the OS's artwork, not the product's, so the app looks different
 *      on macOS, iOS, Android and Windows — a screenshot is not reproducible
 *      across capture machines.
 *   3. Several of them are near-illegible at the size we use them. The AR rail's
 *      44 px dark circles carried a dark 🖥 and a dark 🕒 that all but vanished.
 *
 * Inline SVG rather than an icon font or an npm dependency: no extra request, no
 * FOIT on a capture, nothing to resolve at build time, and the strokes inherit
 * the button's colour so hover/active states already work. Geometry follows the
 * lucide conventions CI-Spatial-Companion-WebXR standardised on (24-unit box,
 * 1.8 stroke, round caps and joins), so the two products read as one family.
 */

export type IconName =
  | 'camera'
  | 'sweep'
  | 'capture-modes'
  | 'gauge'
  | 'monitor'
  | 'broadcast'
  | 'film'
  | 'headset'
  | 'layers'
  | 'cloud-up'
  | 'clock'
  | 'pin'
  | 'map'
  | 'floorplan'
  | 'text-lines'
  | 'chart'
  | 'bolt'
  | 'ruler'
  | 'tag'
  | 'save'
  | 'cloud'
  | 'box'
  | 'points'
  | 'home'

/** Path/shape bodies, drawn in a 24x24 box. */
const PATHS: Record<IconName, string> = {
  // Onboarding 1 — camera & motion access
  camera:
    '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.7l1.2-2h6.2l1.2 2h2.7A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="11.75" cy="13" r="3.4"/>',
  // Onboarding 2 — sweep the room slowly
  sweep:
    '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20.4 4.2v4.2h-4.2"/><circle cx="12" cy="12" r="1.6"/>',
  // Onboarding 3 — three ways to capture
  'capture-modes':
    '<rect x="3" y="5" width="8.5" height="7" rx="1.4"/><rect x="14" y="5" width="7" height="7" rx="1.4"/><rect x="3" y="15" width="18" height="4.5" rx="1.4"/>',
  // Onboarding 4 — track scan quality live
  gauge:
    '<path d="M4 17a8.5 8.5 0 1 1 16 0"/><path d="m12 17 4-5.4"/><circle cx="12" cy="17" r="1.4"/>',
  // Onboarding 5 / viewer link / AI engine — desktop
  monitor:
    '<rect x="3" y="4.5" width="18" height="12" rx="1.6"/><path d="M9 20h6M12 16.5V20"/>',
  // Start path 1 / live stream — a signal going out
  broadcast:
    '<circle cx="12" cy="12" r="2.2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4"/><path d="M4.8 4.8a10.2 10.2 0 0 0 0 14.4M19.2 19.2a10.2 10.2 0 0 0 0-14.4"/>',
  // Start path 2 — upload a walkthrough video
  film:
    '<rect x="3" y="5" width="18" height="14" rx="1.8"/><path d="M8 5v14M16 5v14M3 9.7h5M3 14.3h5M16 9.7h5M16 14.3h5"/>',
  // WebXR runtime
  headset:
    '<path d="M3.4 9.6A1.7 1.7 0 0 1 5.1 8h13.8a1.7 1.7 0 0 1 1.7 1.6v4.3a1.7 1.7 0 0 1-1.7 1.7h-3.2l-1.9-2.2h-3.6l-1.9 2.2H5.1a1.7 1.7 0 0 1-1.7-1.7z"/>',
  // Detections panel
  layers:
    '<path d="m12 3.4 8.4 4.3-8.4 4.3-8.4-4.3z"/><path d="m4.4 12 7.6 3.9 7.6-3.9"/><path d="m4.4 16.2 7.6 3.9 7.6-3.9"/>',
  // Stream keyframes to the server
  'cloud-up':
    '<path d="M7 18.5a4 4 0 0 1-.3-8A5.2 5.2 0 0 1 17 10.9a3.8 3.8 0 0 1 .3 7.6"/><path d="M12 21v-7.4M9.4 15.8 12 13.2l2.6 2.6"/>',
  // Session history
  clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.2V12l3.2 2"/>',
  // Geo fix
  pin: '<path d="M12 21s6.4-5.6 6.4-10.2A6.4 6.4 0 0 0 5.6 10.8C5.6 15.4 12 21 12 21z"/><circle cx="12" cy="10.6" r="2.4"/>',
  map:
    '<path d="m3.4 6.6 5.6-2.2v13l-5.6 2.2z"/><path d="M9 4.4l6 2.2v13L9 17.4z"/><path d="m15 6.6 5.6-2.2v13L15 19.6z"/>',
  // Generate Floor Plan
  floorplan:
    '<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="1.4"/><path d="M3.4 13.4H12M12 3.4v17.2M16 13.4h4.6M12 8.6h8.6"/>',
  // Scene Description
  'text-lines': '<path d="M5 6.6h14M5 11h14M5 15.4h9M5 19.8h5"/>',
  // Object Report
  chart: '<path d="M4 20h16"/><rect x="5.6" y="11" width="3.4" height="6"/><rect x="10.3" y="6.6" width="3.4" height="10.4"/><rect x="15" y="13.6" width="3.4" height="3.4"/>',
  // WebGPU engine
  bolt: '<path d="M13.4 2.8 5 13.4h5.6L10 21.2 19 10.6h-5.6z"/>',
  // Measure distance
  ruler:
    '<rect x="1.8" y="8.4" width="20.4" height="7.2" rx="1.2" transform="rotate(-45 12 12)"/><path d="m9.2 7.8 1.6 1.6M12 5l1.6 1.6M14.8 2.2l1.6 1.6M6.4 10.6 8 12.2"/>',
  tag: '<path d="M11.2 3.4H20v8.8l-8.8 8.8-8.8-8.8z"/><circle cx="16.2" cy="7.8" r="1.5"/>',
  save:
    '<path d="M4.4 5.8a1.4 1.4 0 0 1 1.4-1.4h10l4 4v9.8a1.4 1.4 0 0 1-1.4 1.4H5.8a1.4 1.4 0 0 1-1.4-1.4z"/><path d="M8 4.4v5h7v-5M8 19.6v-5.4h8v5.4"/>',
  cloud: '<path d="M7.2 19a4.4 4.4 0 0 1-.3-8.8A5.6 5.6 0 0 1 17.6 11a4.2 4.2 0 0 1 .3 8z"/>',
  // Solid / bounds
  box: '<path d="m12 3 8 4.4v9.2L12 21l-8-4.4V7.4z"/><path d="M4 7.4 12 12l8-4.6M12 12v9"/>',
  // Point cloud
  points:
    '<circle cx="6.2" cy="7.4" r="1.5"/><circle cx="12" cy="4.8" r="1.5"/><circle cx="17.8" cy="7.8" r="1.5"/><circle cx="4.9" cy="14.2" r="1.5"/><circle cx="10.6" cy="11.6" r="1.5"/><circle cx="16.6" cy="14" r="1.5"/><circle cx="8" cy="19.2" r="1.5"/><circle cx="14.4" cy="19.4" r="1.5"/>',
  home: '<path d="M4 10.6 12 4l8 6.6V19a1.4 1.4 0 0 1-1.4 1.4H5.4A1.4 1.4 0 0 1 4 19z"/><path d="M9.8 20.4v-6h4.4v6"/>'
}

export interface IconOptions {
  /** CSS length for width and height. Default `1em`, so it tracks font-size. */
  size?: string
  /** Extra class on the <svg>. */
  className?: string
}

/**
 * Inline SVG markup for `name`. Safe to interpolate into innerHTML: the output
 * contains no interpolated user data, only the fixed geometry above plus the
 * caller's own size/class strings.
 */
export function icon(name: IconName, options: IconOptions = {}): string {
  const size = options.size ?? '1em'
  const cls = options.className ? ` class="${options.className}"` : ''
  return (
    `<svg${cls} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"` +
    ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"' +
    ` aria-hidden="true" focusable="false">${PATHS[name]}</svg>`
  )
}

/** `icon()` plus a label, laid out inline — the shape almost every button wants. */
export function iconLabel(name: IconName, label: string, options: IconOptions = {}): string {
  return `<span style="display:inline-flex;align-items:center;gap:7px;">${icon(name, options)}<span>${label}</span></span>`
}
