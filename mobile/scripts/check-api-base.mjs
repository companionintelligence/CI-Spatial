// The shell has no server of its own. Without an https VITE_API_BASE every request goes to
// capacitor://localhost or https://localhost and fails, so refuse to build that shell.
// See src/shared/api-base.ts.
let origin = null
try {
  origin = new URL(process.env.VITE_API_BASE ?? '')
} catch {
  // Not a URL: reported below.
}
if (!origin || origin.protocol !== 'https:' || origin.pathname !== '/') {
  console.error('VITE_API_BASE must be the Scan server origin, for example https://scan.example.ts.net')
  process.exit(1)
}
