// A shell build may name the Scan server it starts with, in VITE_API_BASE. It does not have to:
// without one the app asks for the person's own Scan server on its first-run screen and keeps the
// address on the device (src/shared/api-base.ts). When the variable is set it must be the server's
// https origin, because the shells send nothing in clear text and the server's routes sit at the
// root of its origin. Run before the shell's web build; exits 1 on a value that cannot work.
import { pathToFileURL } from 'node:url'

/** Why `value` cannot be a shell's default server, or null when it can (unset counts as fine). */
export function apiBaseProblem(value) {
  if (value === undefined || value === '') return null
  let origin = null
  try {
    origin = new URL(value)
  } catch {
    // Not a URL: reported below.
  }
  if (!origin || origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
    return 'VITE_API_BASE must be the Scan server origin, for example https://scan.example.ts.net, or unset'
  }
  return null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const value = process.env.VITE_API_BASE
  const problem = apiBaseProblem(value)
  if (problem) {
    console.error(problem)
    process.exit(1)
  }
  console.log(value
    ? `Default Scan server for this build: ${new URL(value).origin}`
    : 'No VITE_API_BASE: the app asks for its Scan server on first run.')
}
