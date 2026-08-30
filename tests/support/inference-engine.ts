/**
 * Is the `/infer` engine behind this run able to look at a picture at all?
 *
 * Four specs drive a mock scan, tap capture, and then poll `#panel-toggle`'s
 * `data-count` for 45-60 s waiting for a detection to land. Every one of them
 * assumes the server is running the deterministic colour-blob engine their
 * headers name (`INFERENCE_MODE=mock`), because the mock 8th Wall runtime
 * paints colour blobs for exactly that engine to find.
 *
 * Measured 2026-08-29 against the shared dev server: it was running
 * `INFERENCE_MODE=ollama` with `gemma3:1b`, a text-only model, so every
 * `/infer` answered
 *
 *   500 {"error":"Error: Ollama API error: 500 {\"error\":\"Failed to create
 *   new sequence: failed to process inputs: this model is missing data
 *   required for image input\"}"}
 *
 * No detection can ever reach the store on that server. The nine tests across
 * those four specs each burned their full poll timeout and then reported
 * `Expected: > 0 / Received: 0` — nine identical timeouts, ~7 minutes of wall
 * clock, and not one of them naming the engine.
 *
 * This probe does NOT skip or soften anything: the specs still fail, because a
 * server that cannot infer is a broken precondition and hiding it would let the
 * detection path go untested indefinitely. It only makes them fail in about a
 * second, saying which engine answered and what to do about it, instead of
 * failing blind three quarters of a minute later.
 */
/**
 * Same default as playwright.config.ts's `api` project. These specs drive the
 * page, which reaches `/infer` through Vite's proxy to the same server, so one
 * address covers both.
 */
const API_URL = process.env['API_URL'] ?? 'http://localhost:8000'

/** A 1x1 PNG. Enough to make the engine attempt image input, and nothing more. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** Probed once per worker: the answer cannot change mid-run. */
let probe: Promise<string | null> | null = null

async function describeEngineFailure(): Promise<string | null> {
  let mode = 'unknown'
  let model = 'unknown'
  try {
    const health = await fetch(`${API_URL}/health`)
    if (health.ok) {
      const body = await health.json() as { mode?: string; model?: string }
      mode = body.mode ?? mode
      model = body.model ?? model
    }
  } catch {
    return `No server answered ${API_URL}/health. Start it: npm start`
  }

  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(ONE_PIXEL_PNG)], { type: 'image/png' }), 'probe.png')
  let res: Response
  try {
    // A working vision model is allowed to be slow, and a slow answer is not
    // evidence of a broken one: on abort this returns null and the spec runs
    // its real assertions. Only a definite non-2xx accuses the engine.
    res = await fetch(`${API_URL}/infer`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return null
    return `POST ${API_URL}/infer threw (${String(e)}). Engine mode "${mode}", model "${model}".`
  }
  if (res.ok) return null

  const detail = (await res.text()).slice(0, 300)
  return [
    `The /infer engine cannot process an image, so no detection can ever reach the store.`,
    `Server ${API_URL} reports mode "${mode}", model "${model}"; a probe POST answered ${res.status}: ${detail}`,
    `These specs need the deterministic colour-blob engine their header names —`,
    `restart the API with INFERENCE_MODE=mock, or point OLLAMA_MODEL at a vision model`,
    `(gemma3:1b is text-only; see npm run setup:models).`,
  ].join('\n')
}

/**
 * Fail immediately, with the reason, when `/infer` cannot see an image.
 *
 * Called from the "scan until a detection lands" helper inside each spec rather
 * than from a `beforeAll`, so it only speaks for the tests that actually depend
 * on a detection — `mock-xr8-scan`'s SLAM-points test shares a describe with a
 * detection test and passes fine on a server with no vision engine, and a
 * file-level hook would have failed it too.
 */
export async function requireUsableInferenceEngine(): Promise<void> {
  probe ??= describeEngineFailure()
  const failure = await probe
  if (failure) throw new Error(failure)
}
