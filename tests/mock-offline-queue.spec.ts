/**
 * The offline upload queue must stay bounded.
 *
 * `public/sw.js` queues writes it cannot deliver. It had no count, byte, or
 * age cap and never read the `attempts` it incremented, so nothing was ever
 * dropped. Autosave exports a full GLB 1.2s after every capture and
 * auto-capture fires every 2.5s, so ten minutes offline meant hundreds of
 * multi-MB bodies in IndexedDB — and when that hit quota the write rejected
 * inside networkOrQueue(), rejecting event.respondWith() with it, so the page
 * saw a bare network error while silently losing the scan.
 *
 * These drive the real worker rather than a stub. That is newly possible: the
 * dev server's self-signed cert made Chromium refuse the service-worker script
 * fetch regardless of `ignoreHTTPSErrors`, so the worker was never installed
 * to test against. playwright.config.ts now passes --ignore-certificate-errors
 * to the chromium-mock project.
 *
 * Run: npx playwright test --project=chromium-mock mock-offline-queue
 */
import { test, expect, type Page } from '@playwright/test'
import { OFFLINE_QUEUE_DB_NAME } from '../src/shared/storage-keys'
import { QUEUED_OFFLINE_HEADER } from '../src/shared/offline-queue'

/** Mirrors MAX_QUEUE_ITEMS in public/sw.js. */
const MAX_QUEUE_ITEMS = 24

async function serviceWorkerReady(page: Page): Promise<void> {
  await page.goto('/?mock=xr8')
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 30_000 })
}

/** How many requests are sitting in the worker's queue. */
async function queueDepth(page: Page): Promise<number> {
  return await page.evaluate((dbName) => new Promise<number>((resolve) => {
    const req = indexedDB.open(dbName)
    req.onerror = () => resolve(-1)
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('requests')) return resolve(0)
      const count = db.transaction('requests', 'readonly').objectStore('requests').count()
      count.onsuccess = () => resolve(count.result)
      count.onerror = () => resolve(-1)
    }
  }), OFFLINE_QUEUE_DB_NAME)
}

/** POST `n` small queueable writes, in order. */
async function postQueueable(page: Page, n: number): Promise<number[]> {
  return await page.evaluate(async (count) => {
    const statuses: number[] = []
    for (let i = 0; i < count; i++) {
      const form = new FormData()
      form.append('file', new Blob([`body-${i}`]), `probe-${i}.glb`)
      const resp = await fetch('/upload-scan', { method: 'POST', body: form })
      statuses.push(resp.status)
    }
    return statuses
  }, n)
}

test.describe('offline queue bounds', () => {
  test.setTimeout(120_000)

  test('queued writes answer 202 and flag themselves as queued', async ({ page, context }) => {
    await serviceWorkerReady(page)
    await context.setOffline(true)
    try {
      const probe = await page.evaluate(async (header) => {
        const form = new FormData()
        form.append('file', new Blob(['x']), 'probe.glb')
        const resp = await fetch('/upload-scan', { method: 'POST', body: form })
        return { status: resp.status, ok: resp.ok, queued: resp.headers.get(header) }
      }, QUEUED_OFFLINE_HEADER)

      // The trap the whole contract exists for: queued, and also `ok`.
      expect(probe.status).toBe(202)
      expect(probe.ok).toBe(true)
      expect(probe.queued).toBe('1')
    } finally {
      await context.setOffline(false)
    }
  })

  test('the queue stops growing at the item cap', async ({ page, context }) => {
    await serviceWorkerReady(page)
    await context.setOffline(true)
    try {
      // Comfortably past the cap — unbounded, this would store every one.
      await postQueueable(page, MAX_QUEUE_ITEMS + 12)

      const depth = await queueDepth(page)
      expect(depth).toBeGreaterThan(0)
      expect(depth, `queue must not exceed ${MAX_QUEUE_ITEMS} items`).toBeLessThanOrEqual(MAX_QUEUE_ITEMS)
    } finally {
      await context.setOffline(false)
    }
  })

  test('eviction is announced to the page, not silent', async ({ page, context }) => {
    await serviceWorkerReady(page)

    // Listen before overfilling — the worker posts to controlled clients.
    await page.evaluate(() => {
      ;(window as unknown as { __dropped: unknown[] }).__dropped = []
      navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
        if (event.data?.type === 'offline-dropped') {
          ;(window as unknown as { __dropped: unknown[] }).__dropped.push(event.data)
        }
      })
    })

    await context.setOffline(true)
    try {
      await postQueueable(page, MAX_QUEUE_ITEMS + 12)

      // Dropping a user's queued upload is real data loss; it must be visible.
      await expect
        .poll(async () => await page.evaluate(
          () => (window as unknown as { __dropped: unknown[] }).__dropped.length),
          { timeout: 20_000, message: 'expected an offline-dropped notification' })
        .toBeGreaterThan(0)
    } finally {
      await context.setOffline(false)
    }
  })
})
