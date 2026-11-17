/**
 * Which scanner page may write the scan store (MAIN9-1, publish-readiness wave 9).
 *
 * Two scanner pages on one origin used to write the same IndexedDB store at once, and
 * that is where the multi-tab races the reviews found came from. The first page to boot
 * takes a Web Lock and stays the writer for its whole life. A page that does not get the
 * lock is read-only: main.ts opens the store readOnly and starts nothing that writes.
 *
 * The lock is per origin and per browser profile. The browser releases it when the writer
 * closes or reloads. A read-only page never takes the role over on its own: it becomes the
 * writer only when it is reloaded (or a new page is opened) after the lock is free. See the
 * wave 9 report for the product decision this implies.
 *
 * No DOM and no store imports here, so the decision and the acquisition run under node tests.
 */

/** The Web Lock name, shared by every scanner page on the origin. */
export const SCANNER_WRITER_LOCK = 'companion-scanner-writer'

/**
 * How long the boot waits for the lock manager to answer (MAIN10-7). The browser answers an
 * `ifAvailable` request at once, so an answer this late is not coming.
 */
export const SCANNER_ROLE_TIMEOUT_MS = 3000

/** Whether this page writes the scan store. */
export type ScannerRole = 'writer' | 'readOnly'

/**
 * The page's role, given what it learned from the lock manager.
 *
 * - No Web Locks API: `writer`. That is how the page behaved before this change, and a
 *   browser without the API has no way to coordinate the tabs at all.
 * - Lock granted: `writer`.
 * - Lock not granted: `readOnly`.
 */
export function decideScannerRole(state: { lockApiAvailable: boolean; lockGranted: boolean }): ScannerRole {
  if (!state.lockApiAvailable) return 'writer'
  return state.lockGranted ? 'writer' : 'readOnly'
}

/** The part of `LockManager` this module calls. Structural, so a test can pass a stub. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>
}

/** The part of `navigator` this module reads. Structural, so a test can pass a stub. */
export interface NavigatorLike {
  readonly locks?: LockManagerLike | null
}

/**
 * Ask for the writer lock and resolve with this page's role.
 *
 * The request is made with `ifAvailable`, so the answer comes at once: the callback runs
 * with the lock, or with null when another page holds it. A page never queues behind the
 * writer.
 *
 * The writer's callback returns a promise that never settles. That keeps the lock for the
 * page's life. It also means the request promise never settles for the writer, so the
 * decision is taken inside the callback and this promise resolves from there.
 *
 * A request that throws, or that ends before the callback has decided (it rejects, or it
 * settles without calling the callback), resolves to `writer`, the same as a missing API. The
 * browser always calls the callback, so the last case only keeps a broken lock manager from
 * hanging the boot. A scanner that cannot coordinate with other tabs keeps behaving as it did
 * before this change, rather than turning the only open page read-only.
 *
 * A request still unanswered after `timeoutMs` (3 s by default, MAIN10-7) also resolves `writer`,
 * after one console warning, so a request that never answers cannot leave main() waiting. The
 * page then holds no lock, so another page could become a writer too. That is the trade for not
 * hanging, and the browser does not answer this late in practice.
 */
export function acquireScannerRole(
  nav: NavigatorLike | null | undefined,
  timeoutMs: number = SCANNER_ROLE_TIMEOUT_MS,
): Promise<ScannerRole> {
  const locks = nav?.locks
  if (!locks || typeof locks.request !== 'function') {
    return Promise.resolve(decideScannerRole({ lockApiAvailable: false, lockGranted: false }))
  }
  return new Promise<ScannerRole>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (role: ScannerRole): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(role)
    }
    const failed = (): void => settle(decideScannerRole({ lockApiAvailable: false, lockGranted: false }))
    timer = setTimeout(() => {
      console.warn('[scanner-lock] no answer from the lock manager within ' + timeoutMs + ' ms; this page takes the writer role')
      failed()
    }, timeoutMs)
    try {
      Promise.resolve(
        locks.request(SCANNER_WRITER_LOCK, { ifAvailable: true }, (lock) => {
          if (!lock) {
            settle(decideScannerRole({ lockApiAvailable: true, lockGranted: false }))
            return undefined
          }
          settle(decideScannerRole({ lockApiAvailable: true, lockGranted: true }))
          // Held for the page's life. This never settles, and the browser releases the lock when the page goes away.
          return new Promise<never>(() => {})
        }),
      ).then(failed, failed)
    } catch {
      failed()
    }
  })
}
