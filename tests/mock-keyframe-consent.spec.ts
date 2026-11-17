/**
 * Sending camera frames needs this device's yes (WP-15b, decision D15).
 *
 * The scanner streams pose-tagged camera photos to its Scan server so reconstruction jobs can build a model of the
 * room. A photograph of the inside of a home is personal data, so the stream asks first, stops at once when it is
 * turned off, and starts by itself only for a scan in a Place on a device that has already said yes. The rules are
 * unit-tested without a browser (tests/unit/node/wp-15b-*.test.ts); what needs one is that the real page asks, that
 * a no sends nothing, that a yes starts the stream and is kept with the Scan server it was given for, that turning the
 * switch off in the side panel stops the requests, and that a scan outside a Place does not stream on its own even with
 * a yes on record.
 *
 * The browser tests count the requests the page makes to the server's session routes, rather than trusting the
 * button's colour.
 *
 * Run: npx playwright test --project=chromium-mock mock-keyframe-consent
 */
import { test, expect, type Page } from '@playwright/test'
import { KEYFRAME_CONSENT_KEY } from '../src/shared/storage-keys'
import { KEYFRAME_CONSENT_COPY, KEYFRAME_CONSENT_COPY_VERSION } from '../src/capture/keyframe-consent'
import { startArScan } from './support/start-scan'

test.use({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})

/** The POSTs the page makes to open a capture session and to send a frame. */
function watchSessionRequests(page: Page): { opened: () => number; frames: () => number } {
  let opened = 0
  let frames = 0
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    const path = new URL(request.url()).pathname
    if (path === '/sessions') opened += 1
    else if (/^\/sessions\/[^/]+\/keyframes$/.test(path)) frames += 1
  })
  return { opened: () => opened, frames: () => frames }
}

const storedConsent = (page: Page): Promise<{ state?: string; server?: string } | null> =>
  page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) as { state?: string; server?: string } : null
  }, KEYFRAME_CONSENT_KEY)

test.describe('sending camera frames', () => {
  test.setTimeout(90_000)

  test('a tap on Stream asks first, and Not now sends nothing and keeps nothing', async ({ page }) => {
    const requests = watchSessionRequests(page)
    await startArScan(page)

    await page.click('#stream-btn')
    const dialog = page.locator('dialog.cs-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(KEYFRAME_CONSENT_COPY.title)
    await expect(dialog).toContainText(KEYFRAME_CONSENT_COPY.line)
    await expect(dialog).toContainText('Server:')

    await page.click('#keyframe-consent-decline')
    await expect(dialog).toHaveCount(0)
    await page.waitForTimeout(2_000)
    expect(requests.opened(), 'no session was opened for a no').toBe(0)
    await expect(page.locator('#stream-btn')).not.toHaveClass(/active/)
    expect(await storedConsent(page), 'declining records nothing: the person is not asked to decide twice by accident').toBeNull()
  })

  test('Allow starts the stream and the answer is kept on this device', async ({ page }) => {
    const requests = watchSessionRequests(page)
    await startArScan(page)

    await page.click('#stream-btn')
    await page.click('#keyframe-consent-allow')
    await expect(page.locator('#stream-btn')).toHaveClass(/active/, { timeout: 15_000 })
    expect(requests.opened()).toBe(1)
    expect((await storedConsent(page))?.state).toBe('granted')
    expect((await storedConsent(page))?.server, 'the yes names the Scan server it was given for').toBe(new URL(page.url()).origin)

    // The side panel's row says the same, and the switch is on.
    await page.click('#panel-toggle')
    await expect(page.locator('#keyframe-consent-switch')).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('#keyframe-consent-line')).toHaveText(KEYFRAME_CONSENT_COPY.line)
  })

  test('turning the switch off in the side panel stops sending at once and says what became of what was sent', async ({ page }) => {
    const requests = watchSessionRequests(page)
    await startArScan(page)
    await page.click('#stream-btn')
    await page.click('#keyframe-consent-allow')
    await expect(page.locator('#stream-btn')).toHaveClass(/active/, { timeout: 15_000 })

    await page.click('#panel-toggle')
    const toggle = page.locator('#keyframe-consent-switch')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(page.locator('#stream-btn')).not.toHaveClass(/active/)
    await expect(page.locator('#keyframe-consent-result')).toHaveText(KEYFRAME_CONSENT_COPY.stopped)
    expect((await storedConsent(page))?.state).toBe('withdrawn')

    const sentAtStop = requests.frames()
    await page.waitForTimeout(3_000)
    expect(requests.frames(), 'not one more frame left the phone after it was turned off').toBe(sentAtStop)
  })

  test('with a yes on record, a scan outside a Place does not stream on its own', async ({ page }) => {
    // A yes is for the Scan server the dialog named, which here is the page's own: the record names it, as an Allow does.
    await page.addInitScript(([key, copyVersion]) => {
      window.localStorage.setItem(key as string, JSON.stringify({
        state: 'granted',
        at: '2026-11-16T09:00:00.000Z',
        copyVersion,
        server: window.location.origin,
      }))
    }, [KEYFRAME_CONSENT_KEY, KEYFRAME_CONSENT_COPY_VERSION])
    const requests = watchSessionRequests(page)
    await startArScan(page)
    await page.waitForTimeout(3_000)
    // startArScan skips the Place picker, so this scan is in no Place: default-on is for a scan in a Place.
    expect(requests.opened()).toBe(0)
    await expect(page.locator('#stream-btn')).not.toHaveClass(/active/)
    await page.click('#panel-toggle')
    await expect(page.locator('#keyframe-consent-switch')).toHaveAttribute('aria-checked', 'true')
  })
})
