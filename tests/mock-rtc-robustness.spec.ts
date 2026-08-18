/**
 * The live-feed pair must survive a hostile signalling channel.
 *
 * Three defects, all found by reading because the client pair had no tests:
 *
 *   - LiveFeed parsed relay frames with a bare `JSON.parse` inside the socket
 *     listener, so one malformed frame threw and took the session down. The
 *     broadcaster had always logged and ignored.
 *   - LiveFeed reconnected on a flat 2s timer forever — hammering a server
 *     that is simply down, with a status line that never said how long it had
 *     been failing.
 *   - RtcBroadcaster._createOffer() overwrote `this._pc` without closing it.
 *     'peer-ready' arrives on every viewer (re)connect and the viewer retries
 *     on any dropped socket, so each cycle stranded an RTCPeerConnection with
 *     live tracks and a running ICE agent.
 *
 * Run: npx playwright test --project=chromium-mock mock-rtc-robustness
 */
import { test, expect, type Page } from '@playwright/test'

/** Count RTCPeerConnection constructions and closes in the page. */
async function instrumentPeerConnections(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counters = { created: 0, closed: 0 }
    ;(window as unknown as { __pc: typeof counters }).__pc = counters
    const Native = window.RTCPeerConnection
    class Counted extends Native {
      constructor(...args: ConstructorParameters<typeof Native>) {
        super(...args)
        counters.created++
      }
      override close(): void {
        counters.closed++
        super.close()
      }
    }
    window.RTCPeerConnection = Counted as unknown as typeof Native
  })
}

/**
 * Record signalling sockets so a test can drop one.
 *
 * Playwright's `setOffline` blocks new requests but leaves an already-open
 * WebSocket alone, so it cannot simulate the link dying mid-session.
 */
async function recordSignalSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sockets: WebSocket[] = []
    ;(window as unknown as { __signalSockets: WebSocket[] }).__signalSockets = sockets
    const Native = window.WebSocket
    class Recorded extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (String(url).includes('/rtc-signal')) sockets.push(this)
      }
    }
    window.WebSocket = Recorded as unknown as typeof Native
  })
}

async function startBroadcasting(page: Page, room: string): Promise<void> {
  await page.goto(`/?mock=xr8&world=${encodeURIComponent(room)}`)
  await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
  await page.click('#start-ar-btn')
  await expect(page.locator('#scan-stats')).toHaveText(/\d+ pts/, { timeout: 30_000 })
  await page.click('#panel-toggle')
  await page.locator('#side-panel').waitFor({ state: 'visible', timeout: 10_000 })
  await page.click('#panel-stream-btn')
}

/** Join `room` as a peer, optionally send frames, then close. */
async function joinAndSend(page: Page, room: string, role: string, frames: string[]): Promise<void> {
  await page.evaluate(({ room, role, frames }) => new Promise<void>((resolve) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/rtc-signal?role=${role}&room=${encodeURIComponent(room)}`)
    ws.onopen = () => {
      for (const frame of frames) ws.send(frame)
      setTimeout(() => { ws.close(); resolve() }, 1_200)
    }
    ws.onerror = () => resolve()
  }), { room, role, frames })
}

test.describe('live-feed robustness', () => {
  test.setTimeout(150_000)

  test('a malformed relay frame does not break the viewer', async ({ page, context }) => {
    const room = 'rtc-malformed-test'
    const errors: string[] = []
    await page.goto(`/viewer.html?world=${room}`)
    page.on('pageerror', (err) => errors.push(err.message))
    await page.click('#btn-livefeed')

    // Garbage over the relay — the shape a buggy or hostile peer can send.
    const sender = await context.newPage()
    await sender.goto('/?mock=xr8')
    await joinAndSend(sender, room, 'phone', ['not json at all', '{"unterminated":'])

    await page.waitForTimeout(1_500)
    expect(errors.filter((e) => /JSON|Unexpected token/i.test(e)),
      'a malformed frame must be ignored, not thrown out of the listener').toEqual([])
  })

  test('an overlapping viewer does not strand the previous peer connection', async ({ page, context }) => {
    const room = 'rtc-leak-test'
    await instrumentPeerConnections(page)
    await startBroadcasting(page, room)

    // Two viewers whose sessions OVERLAP. 'peer-left' already tears the peer
    // down when a viewer goes away cleanly, so a leave-then-rejoin never
    // leaked — the gap is a second 'peer-ready' arriving while the first
    // viewer is still present, which happens with two tabs on the same world
    // or a reconnect racing its own close.
    const viewer = await context.newPage()
    await viewer.goto('/?mock=xr8')
    await viewer.evaluate((r) => new Promise<void>((resolve) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const open = (n: number) => new Promise<void>((done) => {
        const ws = new WebSocket(
          `${proto}://${location.host}/rtc-signal?role=viewer&room=${encodeURIComponent(r)}`)
        ;(window as unknown as Record<string, unknown>)[`__v${n}`] = ws
        ws.onopen = () => done()
        ws.onerror = () => done()
      })
      // Hold both open — neither sends peer-left.
      void open(1).then(() => new Promise((r2) => setTimeout(r2, 800)))
        .then(() => open(2))
        .then(() => new Promise((r3) => setTimeout(r3, 1_500)))
        .then(() => resolve())
    }), room)

    await expect
      .poll(async () => await page.evaluate(
        () => (window as unknown as { __pc: { created: number } }).__pc.created),
        { timeout: 30_000, message: 'expected two negotiations' })
      .toBeGreaterThanOrEqual(2)

    const counts = await page.evaluate(
      () => (window as unknown as { __pc: { created: number; closed: number } }).__pc)

    // Every superseded connection must be closed, or each overlap strands one
    // with its tracks and ICE agent still running.
    expect(counts.closed, `created ${counts.created}, closed ${counts.closed}`)
      .toBeGreaterThanOrEqual(counts.created - 1)
  })

  test('a dropped signal socket backs off instead of hammering', async ({ page }) => {
    await recordSignalSockets(page)
    await page.goto('/viewer.html?world=rtc-backoff-test')
    // #btn-livefeed opens the panel and connects; clicking Connect again toggles off.
    await page.click('#btn-livefeed')
    await expect(page.locator('#livefeed-status-badge')).toContainText(/Waiting|Connecting/, { timeout: 15_000 })

    // Drop the link out from under the panel.
    await page.evaluate(() => {
      const sockets = (window as unknown as { __signalSockets: WebSocket[] }).__signalSockets
      sockets[sockets.length - 1]?.close()
    })

    // The notice must say which attempt and how long. A flat "reconnecting…"
    // every 2s gave no way to tell a stuck panel from a slow one, and hammered
    // a server that was simply down.
    await expect(page.locator('#livefeed-status-badge'))
      .toContainText(/retrying in \d+s \(attempt \d+\)/, { timeout: 20_000 })
  })
})
