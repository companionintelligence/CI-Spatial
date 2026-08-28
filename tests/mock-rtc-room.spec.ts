/**
 * Phone and editor must name the live-feed room the same way.
 *
 * Regression: the scanner hardcoded `new RtcBroadcaster('default')` while the
 * editor used the world it was viewing (`query.get('world') || 'default'`).
 * `?world=` was read only by the viewer, so opening any share link for a
 * non-default world left the editor on "Waiting for phone…" forever with no
 * error. The panel made it worse by displaying a hardcoded `value="default"` —
 * a room the code was not using, which the Connect handler then read back,
 * turning the wrong label into the real room the moment anyone clicked it.
 *
 * The room is only a rendezvous key. Where scans land is a separate thing:
 * uploads park in the default world by design (ADR 0003), which is why the
 * "View in 3D" links still point there.
 *
 * This is the first automated coverage of the signalling rendezvous — the
 * client pair had none.
 *
 * Run: npx playwright test --project=chromium-mock mock-rtc-room
 */
import { test, expect, type Page } from '@playwright/test'
import { startArScan } from './support/start-scan'

/** Open a signalling socket as the viewer and report the first message. */
async function firstSignallingMessage(page: Page, room: string, timeoutMs = 15_000): Promise<string> {
  return await page.evaluate(({ room, timeoutMs }) => new Promise<string>((resolve) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(
      `${proto}://${location.host}/rtc-signal?role=viewer&room=${encodeURIComponent(room)}`,
    )
    const timer = setTimeout(() => { ws.close(); resolve('(no message)') }, timeoutMs)
    ws.onmessage = (event) => {
      clearTimeout(timer)
      const data = typeof event.data === 'string' ? event.data : '(binary)'
      ws.close()
      resolve(data)
    }
    ws.onerror = () => { clearTimeout(timer); resolve('(socket error)') }
  }), { room, timeoutMs })
}

/** Start a scan in `room` and begin broadcasting from it. */
async function startBroadcasting(page: Page, room: string): Promise<void> {
  await startArScan(page, { url: `/?mock=xr8&world=${encodeURIComponent(room)}` })
  await page.click('#panel-toggle')
  await page.locator('#side-panel').waitFor({ state: 'visible', timeout: 10_000 })
  await page.click('#panel-stream-btn')
}

test.describe('live-feed room rendezvous', () => {
  test.setTimeout(150_000)

  test('the phone joins the room named by ?world=, not "default"', async ({ page, context }) => {
    const room = 'rtc-rendezvous-test'
    await startBroadcasting(page, room)

    // The server announces peer-ready to a viewer joining a room that already
    // has a phone in it. Before the fix the phone sat in 'default' and this
    // timed out — which is exactly what the user saw as "Waiting for phone…".
    const observer = await context.newPage()
    await observer.goto('/?mock=xr8')
    const message = await firstSignallingMessage(observer, room)

    expect(message, 'the phone should be waiting in the room the editor names').toContain('peer-ready')
  })

  test('a different room does not see that phone', async ({ page, context }) => {
    // Guards the assertion above: peer-ready must mean "this room", not
    // "any phone anywhere", or the test would pass on the old code too.
    await startBroadcasting(page, 'rtc-room-a')

    const observer = await context.newPage()
    await observer.goto('/?mock=xr8')
    const message = await firstSignallingMessage(observer, 'rtc-room-b', 6_000)

    expect(message).not.toContain('peer-ready')
  })

  test('the editor shows the room it is actually using', async ({ page }) => {
    await page.goto('/viewer.html?world=some-other-world')
    await page.click('#btn-livefeed')

    // Hardcoded "default" here was not cosmetic: the Connect handler reads
    // this field back into the room id.
    await expect(page.locator('#livefeed-room-input')).toHaveValue('some-other-world')
  })
})
