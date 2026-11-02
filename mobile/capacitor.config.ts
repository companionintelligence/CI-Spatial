import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the Scan iOS + Android shell.
 *
 * SCAFFOLD, NOT FOR STORE SUBMISSION. README.md lists the gates: a device
 * measurement step, the xr.js licence check, and Apple 4.2 and 4.2.1.
 *
 * The shell ships the web build as it is. `npm run build` in this directory
 * builds ../src with VITE_DISABLE_PWA set (no service worker, no manifest) into
 * www/, then runs `cap sync`. The bundle is the app: there is no remote `url`.
 */
const config: CapacitorConfig = {
  appId: 'com.companionintelligence.scan',
  appName: 'Scan',
  webDir: 'www',
  server: {
    // Android serves the bundle from https://localhost (iOS: capacitor://localhost).
    androidScheme: 'https',
    // HTTPS only: no cleartext to any host.
    cleartext: false,
  },
  // Scan night-space background (--background in index.html, the theme colour).
  backgroundColor: '#041620',
  ios: {
    // Pinch-zoom stays on (WCAG 1.4.4). Capacitor defaults this to false.
    zoomEnabled: true,
  },
  android: {
    zoomEnabled: true,
    // HTTPS pages may not load HTTP subresources.
    allowMixedContent: false,
  },
  plugins: {
    // No HTTP bridge: fetch and XHR go straight to the WebView, so the HTTPS-only rule holds.
    CapacitorHttp: { enabled: false },
  },
};

export default config;
