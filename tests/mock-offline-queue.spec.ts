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
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { OFFLINE_QUEUE_DB_NAME, ONBOARDING_KEY } from '../src/shared/storage-keys'
import { NO_QUEUE_HEADER, QUEUED_OFFLINE_HEADER } from '../src/shared/offline-queue'
import type { Project, ProjectSpatialFrame } from '../src/world/types'

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

/** The keys in the worker's queue, oldest first. Each is `<ms>-<kind>-<random>`. */
async function queueKeys(page: Page): Promise<string[]> {
  return await page.evaluate((dbName) => new Promise<string[]>((resolve) => {
    const req = indexedDB.open(dbName)
    req.onerror = () => resolve([])
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('requests')) return resolve([])
      const keys = db.transaction('requests', 'readonly').objectStore('requests').getAllKeys()
      keys.onsuccess = () => resolve((keys.result as string[]).slice().sort())
      keys.onerror = () => resolve([])
    }
  }), OFFLINE_QUEUE_DB_NAME)
}

test.describe('what the queue keeps and says', () => {
  test.setTimeout(120_000)

  test('a Place write is still queued after the queue has taken more scan uploads than it holds', async ({ page, context }) => {
    await serviceWorkerReady(page)
    await context.setOffline(true)
    try {
      // The oldest write of an offline session: a rename or a hierarchy save, which the worker replays whole.
      // (A calibration's frame is not one of these: the page keeps it itself, and asks the worker not to queue it.)
      const status = await page.evaluate(async () => {
        const res = await fetch('/projects/proj-queue-probe', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'zz-queue-probe', floors: [] }),
        })
        return res.status
      })
      expect(status).toBe(202)

      await postQueueable(page, MAX_QUEUE_ITEMS + 12)

      const keys = await queueKeys(page)
      expect(keys.length).toBeLessThanOrEqual(MAX_QUEUE_ITEMS)
      expect(keys.filter((key) => key.split('-')[1] === 'place'), 'the Place write is the one that stays').toHaveLength(1)
    } finally {
      await context.setOffline(false)
    }
  })

  test('a write that asks not to be queued fails at once offline, and leaves nothing in the queue to replay later', async ({ page, context }) => {
    await serviceWorkerReady(page)
    const before = await queueKeys(page)
    await context.setOffline(true)
    try {
      // Creating a Place (the person is told it needs a connection, so it must not be made after the fact) and a
      // Place's frame (the page keeps it in its own database, so the worker must not hold a second copy of it).
      for (const [method, path, body] of [
        ['POST', '/projects', { name: 'zz-never-created' }],
        ['PUT', '/projects/proj-queue-probe/spatial-frame', { frame: {}, expectedRevision: 0 }],
      ] as const) {
        const outcome = await page.evaluate(async ([verb, url, payload, header]) => {
          try {
            const res = await fetch(url, {
              method: verb,
              headers: { 'Content-Type': 'application/json', [header]: '1' },
              body: JSON.stringify(payload),
            })
            return { status: res.status }
          } catch (error) {
            return { failed: error instanceof TypeError }
          }
        }, [method, path, body, NO_QUEUE_HEADER] as const)
        expect(outcome, `${method} ${path}: a network error, not a 202`).toEqual({ failed: true })
      }
      expect(await queueKeys(page)).toEqual(before)
    } finally {
      await context.setOffline(false)
    }
  })

  test('the drop notice says what was dropped', async ({ page, context }) => {
    await serviceWorkerReady(page)
    await page.evaluate(() => {
      ;(window as unknown as { __dropped: string[] }).__dropped = []
      navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
        if (event.data?.type === 'offline-dropped') (window as unknown as { __dropped: string[] }).__dropped.push(String(event.data.message))
      })
    })
    await context.setOffline(true)
    try {
      await postQueueable(page, MAX_QUEUE_ITEMS + 12)
      await expect
        .poll(async () => await page.evaluate(() => (window as unknown as { __dropped: string[] }).__dropped.length), { timeout: 20_000 })
        .toBeGreaterThan(0)
      const messages = await page.evaluate(() => (window as unknown as { __dropped: string[] }).__dropped)
      // The writes this test queued are scan uploads, so those are what is named. Whatever else the page
      // itself had queued is named too, and never as the unnamed "upload(s)" the worker used to say.
      expect(messages.some((message) => /scan uploads?/.test(message))).toBe(true)
      for (const message of messages) expect(message).not.toContain('upload(s)')
    } finally {
      await context.setOffline(false)
    }
  })
})

const LAT = 33.51466
const LNG = -117.72159

/**
 * A calibration made with no connection reaches the server when the connection returns.
 *
 * The frame is the Place's one durable reference, and it used to be a whole-record PUT that the worker
 * queued and answered 202: counted as delivered, evictable by about 22 captures, and sent as a stale
 * copy. It is now a revisioned write that the page keeps in IndexedDB until the server has it (the worker is
 * asked not to queue it), sends again when the connection returns, and says "Alignment not synced yet"
 * about meanwhile. Its photos go after it, from the copies the page keeps.
 *
 * Needs the isolated test box: the dev server's self-signed certificate and the worker are what make
 * `setOffline` queue instead of fail. Mirrors the flow in mock-two-point-calibration.spec.ts.
 */
test.describe('a calibration made offline', () => {
  test.setTimeout(240_000)

  test.beforeEach(async ({ context }) => {
    await context.addInitScript((key) => {
      window.localStorage.setItem(key, '1')
    }, ONBOARDING_KEY)
    await context.grantPermissions(['geolocation'])
    await context.setGeolocation({ latitude: LAT, longitude: LNG })
  })

  async function createPlace(request: APIRequestContext): Promise<{ id: string; name: string }> {
    const name = `zz-offline-frame-${Date.now()}`
    const res = await request.post('/projects', {
      data: { name, placeType: 'room', geoPose: { lat: LAT, lng: LNG, altitudeM: null, bearing: null, accuracyM: 5 } },
    })
    expect(res.ok(), `POST /projects failed: ${res.status()}`).toBeTruthy()
    const body = await res.json()
    return { id: body.project?.projectId ?? body.projectId, name }
  }

  async function tapCanvas(page: Page, nx: number, ny: number): Promise<void> {
    const box = await page.locator('canvas').first().boundingBox()
    if (!box) throw new Error('no AR canvas')
    await page.mouse.click(box.x + box.width * nx, box.y + box.height * ny)
    await page.waitForTimeout(800)
  }

  /** The Places database's waiting frames, read as the page's own store holds them. */
  async function waitingFrames(page: Page): Promise<Array<{ projectId: string; syncState: string }>> {
    return await page.evaluate(() => new Promise<Array<{ projectId: string; syncState: string }>>((resolve) => {
      const req = indexedDB.open('ci-xr-projects')
      req.onerror = () => resolve([])
      req.onsuccess = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('pendingFrame')) return resolve([])
        const all = db.transaction('pendingFrame', 'readonly').objectStore('pendingFrame').getAll()
        all.onsuccess = () => resolve(all.result as Array<{ projectId: string; syncState: string }>)
        all.onerror = () => resolve([])
      }
    }))
  }

  test('is kept on the phone with its revision, says it is not synced, and is on the server, photos after it, once the connection is back', async ({ page, context, request }) => {
    await serviceWorkerReady(page)
    const place = await createPlace(request)
    try {
      await page.goto('/?mock=xr8')
      await page.locator('#start-ar-btn').waitFor({ state: 'attached', timeout: 30_000 })
      await page.waitForFunction(() => !(document.getElementById('start-ar-btn') as HTMLButtonElement | null)?.disabled, null, { timeout: 30_000 })
      await page.click('#start-ar-btn')
      await page.locator('#place-nearby-btn').click()
      await expect(async () => {
        const picked = await page.evaluate((wanted) => {
          const row = Array.from(document.querySelectorAll('button,li,[role=button]')).find((el) => (el.textContent ?? '').includes(wanted))
          if (!row) return false
          ;(row as HTMLElement).click()
          return true
        }, place.name)
        expect(picked, `nearby list has no row for ${place.name}`).toBeTruthy()
      }).toPass({ timeout: 20_000 })
      await page.locator('#place-continue-btn').click()
      await page.locator('#project-calibration').waitFor({ state: 'attached', timeout: 30_000 })

      // The ground stage, as mock-two-point-calibration.spec.ts gets through it.
      const status = page.locator('#project-calibration-status')
      await expect(async () => {
        const text = (await status.textContent()) ?? ''
        if (/place the landmark/i.test(text)) return
        const override = page.locator('#project-calibration-skip-ground')
        if (await override.isVisible().catch(() => false)) await override.click()
        throw new Error(`still on the ground stage: ${text}`)
      }).toPass({ timeout: 60_000 })

      // Offline from here: the two taps, the commit, and everything the commit sends.
      await context.setOffline(true)
      await page.evaluate(() => (window as unknown as Record<string, { freezeAt(n: number): number }>)['XR8'].freezeAt(300))
      // Let the provider read the frozen pose before tapping: a tap inside the frame after the freeze is made from the
      // pose the mock had before it, and the photo taken later from the frozen one then reads as a phone that moved (WP-07).
      await page.waitForTimeout(100)
      // 0.28 and 0.72, not the screen's edges: the tap sampler reads no spot beyond 3 m, and the mock's edges are past it
      // (see TAP_A in mock-two-point-calibration.spec.ts).
      await tapCanvas(page, 0.28, 0.92)
      await page.locator('#project-calibration-confirm').click()
      await tapCanvas(page, 0.72, 0.92)
      // A first calibration is offered a check point after the heading marker (WP-04b); this test is about the pair's frame, so it skips the step.
      await page.locator('#project-calibration-check').click()
      const commit = page.locator('#project-calibration-commit')
      await expect(commit).toBeEnabled()
      await commit.click()
      await expect(page.locator('#project-calibration')).toHaveCount(0)

      // Not delivered, and not said to be. The phone holds it, and so do its photos; the worker holds neither.
      await expect(page.locator('#status-text')).toContainText('Alignment not synced yet', { timeout: 10_000 })
      await expect.poll(async () => (await waitingFrames(page)).map((row) => [row.projectId, row.syncState]), { timeout: 15_000 })
        .toEqual([[place.id, 'failed']])
      expect((await queueKeys(page)).some((key) => key.split('-')[1] === 'place'), 'the worker holds nothing for it').toBe(false)
      const before = (await (await request.get(`/projects/${place.id}`)).json()) as Project
      expect(before.spatialFrame ?? null, 'the server has nothing yet').toBeNull()

      // The connection returns: the page sends the frame again (the event is sent by hand as well, so that this
      // does not depend on the browser raising it for a context that was switched back on).
      const posts: string[] = []
      page.on('request', (sent) => {
        if (sent.method() === 'POST') posts.push(new URL(sent.url()).pathname)
      })
      await context.setOffline(false)
      await page.evaluate(() => window.dispatchEvent(new Event('online')))
      let frameId = ''
      await expect(async () => {
        const saved = (await (await request.get(`/projects/${place.id}`)).json()) as Project
        expect(saved.spatialFrame?.method).toBe('two-point-ground')
        const stored = saved.spatialFrame as Extract<ProjectSpatialFrame, { method: 'two-point-ground' }>
        expect(stored.landmark).toEqual({ x: 0, y: 0, z: 0 })
        expect(saved.spatialFrameRevision, 'counted once, however many times it was sent').toBe(1)
        // A frame with an id (WP-08) keeps its photos with it: the record carries the paths its photos are served from, which is
        // where they go once it is saved.
        expect(typeof stored.frameId, 'the frame has an id').toBe('string')
        frameId = stored.frameId!
        for (const role of ['landmark', 'headingMarker'] as const) {
          expect(stored.referencePhotos?.[role].url, `${role} photo URL`).toBe(`/projects/${place.id}/frames/${frameId}/ref-${role === 'headingMarker' ? 'heading' : role}.jpg`)
        }
      }).toPass({ timeout: 45_000 })
      // The photos then go to that frame's route, and never to the Place's own, which the server closes once the frame has an id.
      await expect.poll(() => posts.filter((path) => path === `/projects/${place.id}/frames/${frameId}/reference-photos`).length, {
        message: 'a photo of each marker was sent to the frame\'s route',
        timeout: 45_000,
      }).toBeGreaterThanOrEqual(2)
      expect(posts).not.toContain(`/projects/${place.id}/reference-photos`)
      // The page's copy of the intent goes once the server holds the frame and its photos. A server with no route for a frame's
      // photos (one built before ADR 0011) holds the frame, and the page keeps the row for the photos alone, to send them when it has.
      await expect.poll(async () => (await waitingFrames(page)).every((row) => row.syncState === 'photos'), { timeout: 45_000 }).toBe(true)
    } finally {
      await context.setOffline(false)
      await request.delete(`/projects/${place.id}`).catch(() => {})
    }
  })
})
