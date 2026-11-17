/**
 * `ci-xr-projects` v1 → v3 and v2 → v3: v2 is the upgrade wave 09 ticket 0007
 * introduced, and v3 adds the `pendingFrame` store (src/project/frame-sync.ts).
 *
 * This database holds the **Place records themselves** — not regenerable session
 * data. A botched `onupgradeneeded` makes an existing user's Places unreadable, and
 * there is no server copy of a Place that was never synced. The ticket calls this out
 * as a risk and asks for the upgrade to be tested against a **populated old
 * database**, not just a fresh one, because a fresh database exercises the
 * creation path and nothing else — every store is missing, so the `contains()`
 * guards that protect real data never even run.
 *
 * tests/unit/node/wp-place-frame-sync.test.ts runs the same upgrades against an
 * in-memory IndexedDB on every `npm run verify` (through `test:wave`, which globs `wp-*.test.ts`).
 * This file is the browser's own.
 *
 * The database name is on CLAUDE.md's protected-identifier list: renaming it
 * orphans every existing user's Places. This test would keep passing through
 * such a rename, so it asserts the name explicitly too.
 *
 * Run: npx playwright test --project=chromium-mock mock-project-store-upgrade
 */
import { test, expect } from '@playwright/test'
import { ONBOARDING_KEY } from '../src/shared/storage-keys'

const DB_NAME = 'ci-xr-projects'

/** A Place and a scan as v1 wrote them — the records that must survive. */
const V1_PROJECT = {
  projectId: 'proj-1700000000000',
  name: 'zz-upgrade-fixture',
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  floors: [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [{ roomId: 'room-1', name: 'Kitchen' }] }],
}

const V1_SCAN = {
  scanId: 'scan-1700000000000-abcd',
  projectId: 'proj-1700000000000',
  sessionId: 'sess-1700000000000-aaaaaa',
  capturedAt: 1700000000000,
  status: 'complete',
}

test.describe('ci-xr-projects v1 → v3', () => {
  test.setTimeout(120_000)

  test('an existing v1 database keeps its Places and gains the referencePhotos and pendingFrame stores', async ({ page }) => {
    await page.context().addInitScript((key) => {
      window.localStorage.setItem(key, '1')
    }, ONBOARDING_KEY)

    // A page on the app's origin that does NOT boot the app, so the v1 fixture
    // is in place before anything opens the database at v2.
    await page.goto('/camera-check.html')

    const seeded = await page.evaluate(async ({ dbName, project, scan }) => {
      await new Promise<void>((resolve, reject) => {
        const del = indexedDB.deleteDatabase(dbName)
        del.onsuccess = () => resolve()
        del.onerror = () => reject(del.error)
        del.onblocked = () => resolve()
      })
      // Exactly the v1 schema, written by hand — importing the current
      // ProjectStore would create v2 and test nothing.
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1)
        req.onupgradeneeded = () => {
          const d = req.result
          d.createObjectStore('projects', { keyPath: 'projectId' })
          const s = d.createObjectStore('scans', { keyPath: 'scanId' })
          s.createIndex('byProject', 'projectId', { unique: false })
          s.createIndex('bySession', 'sessionId', { unique: false })
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['projects', 'scans'], 'readwrite')
        tx.objectStore('projects').put(project)
        tx.objectStore('scans').put(scan)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      const version = db.version
      db.close()
      return version
    }, { dbName: DB_NAME, project: V1_PROJECT, scan: V1_SCAN })

    expect(seeded, 'fixture must really be at v1').toBe(1)

    // Boot the app. `ProjectStore.open()` runs during startup and is what
    // performs the upgrade.
    await page.goto('/?mock=xr8')
    await page.locator('#start-ar-btn').waitFor({ state: 'attached', timeout: 30_000 })
    await page.waitForFunction(
      () => !(document.getElementById('start-ar-btn') as HTMLButtonElement | null)?.disabled,
      null,
      { timeout: 30_000 },
    )

    const after = await page.evaluate(async (dbName) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const read = <T>(store: string, key: string) =>
        new Promise<T | null>((resolve, reject) => {
          const req = db.transaction(store, 'readonly').objectStore(store).get(key)
          req.onsuccess = () => resolve((req.result ?? null) as T | null)
          req.onerror = () => reject(req.error)
        })
      const byIndex = <T>(store: string, index: string, key: string) =>
        new Promise<T[]>((resolve, reject) => {
          const req = db.transaction(store, 'readonly').objectStore(store).index(index).getAll(key)
          req.onsuccess = () => resolve(req.result as T[])
          req.onerror = () => reject(req.error)
        })

      const result = {
        version: db.version,
        stores: Array.from(db.objectStoreNames),
        project: await read<{ name: string; floors: unknown[] }>('projects', 'proj-1700000000000'),
        scan: await read<{ sessionId: string }>('scans', 'scan-1700000000000-abcd'),
        scansByProject: (await byIndex<{ scanId: string }>('scans', 'byProject', 'proj-1700000000000')).length,
        photoIndexes: Array.from(
          db.transaction('referencePhotos', 'readonly').objectStore('referencePhotos').indexNames,
        ),
        photoKeyPath: db.transaction('referencePhotos', 'readonly').objectStore('referencePhotos').keyPath,
      }
      db.close()
      return result
    }, DB_NAME)

    expect(after.version).toBe(3)
    expect(after.stores.sort()).toEqual(['pendingFrame', 'projects', 'referencePhotos', 'scans'])

    // The existing data is the whole point. A v1 Place must come through byte
    // for byte, not merely "the store still exists".
    expect(after.project).toEqual(V1_PROJECT)
    expect(after.scan).toEqual(V1_SCAN)
    // Indexes are re-derived on upgrade in some implementations; a lookup
    // proves the scan is still reachable the way the app reaches it.
    expect(after.scansByProject).toBe(1)

    // And the new stores match what the schema promises.
    expect(after.photoKeyPath).toBe('localKey')
    expect(after.photoIndexes).toEqual(['byProject'])
  })
})

test.describe('ci-xr-projects v2 → v3', () => {
  test.setTimeout(120_000)

  test('an existing v2 database keeps its Places and reference photos and gains the pendingFrame store', async ({ page }) => {
    await page.context().addInitScript((key) => {
      window.localStorage.setItem(key, '1')
    }, ONBOARDING_KEY)
    await page.goto('/camera-check.html')

    const frame = {
      version: 1, createdAt: '2026-11-10T08:00:00.000Z', method: 'two-point-ground', landmark: { x: 0, y: 0, z: 0 },
      headingMarker: { x: 0, y: 0, z: 2.5 }, separationM: 2.5, toleranceM: 0.15, anchorBearingDeg: null,
    }
    const project = { ...V1_PROJECT, spatialFrame: frame }
    const photoBytes = 'jpeg bytes standing in for a reference photo'

    const seeded = await page.evaluate(async ({ dbName, project, scan, photoBytes }) => {
      await new Promise<void>((resolve, reject) => {
        const del = indexedDB.deleteDatabase(dbName)
        del.onsuccess = () => resolve()
        del.onerror = () => reject(del.error)
        del.onblocked = () => resolve()
      })
      // Exactly the v2 schema, written by hand: importing the current ProjectStore would create v3 and test nothing.
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, 2)
        req.onupgradeneeded = () => {
          const d = req.result
          d.createObjectStore('projects', { keyPath: 'projectId' })
          const s = d.createObjectStore('scans', { keyPath: 'scanId' })
          s.createIndex('byProject', 'projectId', { unique: false })
          s.createIndex('bySession', 'sessionId', { unique: false })
          const p = d.createObjectStore('referencePhotos', { keyPath: 'localKey' })
          p.createIndex('byProject', 'projectId', { unique: false })
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['projects', 'scans', 'referencePhotos'], 'readwrite')
        tx.objectStore('projects').put(project)
        tx.objectStore('scans').put(scan)
        tx.objectStore('referencePhotos').put({
          localKey: `${project.projectId}:landmark`,
          projectId: project.projectId,
          role: 'landmark',
          blob: new Blob([photoBytes], { type: 'image/jpeg' }),
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          capturedAt: '2026-11-10T08:00:00.000Z',
        })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      const version = db.version
      db.close()
      return version
    }, { dbName: DB_NAME, project, scan: V1_SCAN, photoBytes })
    expect(seeded, 'fixture must really be at v2').toBe(2)

    await page.goto('/?mock=xr8')
    await page.locator('#start-ar-btn').waitFor({ state: 'attached', timeout: 30_000 })
    await page.waitForFunction(
      () => !(document.getElementById('start-ar-btn') as HTMLButtonElement | null)?.disabled,
      null,
      { timeout: 30_000 },
    )

    const after = await page.evaluate(async (dbName) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const read = <T>(store: string, key: string) =>
        new Promise<T | null>((resolve, reject) => {
          const req = db.transaction(store, 'readonly').objectStore(store).get(key)
          req.onsuccess = () => resolve((req.result ?? null) as T | null)
          req.onerror = () => reject(req.error)
        })
      const photo = await read<{ blob: Blob }>('referencePhotos', 'proj-1700000000000:landmark')
      const result = {
        version: db.version,
        stores: Array.from(db.objectStoreNames),
        project: await read<unknown>('projects', 'proj-1700000000000'),
        scan: await read<unknown>('scans', 'scan-1700000000000-abcd'),
        photoText: photo ? await photo.blob.text() : null,
        pendingKeyPath: db.transaction('pendingFrame', 'readonly').objectStore('pendingFrame').keyPath,
      }
      db.close()
      return result
    }, DB_NAME)

    expect(after.version).toBe(3)
    expect(after.stores.sort()).toEqual(['pendingFrame', 'projects', 'referencePhotos', 'scans'])
    expect(after.project, 'the Place and its frame, byte for byte').toEqual(project)
    expect(after.scan).toEqual(V1_SCAN)
    expect(after.photoText, 'the reference photo bytes').toBe(photoBytes)
    expect(after.pendingKeyPath).toBe('projectId')
  })
})
