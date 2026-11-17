import { SW_SYNC_TAG } from './shared/storage-keys'
import { whenPageLoaded } from './shared/page-load'

export function registerPWA(options: { flushQueue?: boolean } = {}): void {
  // Only a page that owns the scan store flushes the offline queue. A read-only
  // scanner tab passes flushQueue: false, so it cannot resend a writer's uploads.
  const flushQueue = options.flushQueue !== false
  // The native shell is built with VITE_DISABLE_PWA set; see pwaSwitch() in vite.config.ts.
  if (import.meta.env.VITE_DISABLE_PWA) return
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator)) return
  if (!window.isSecureContext) return

  // Not a bare 'load' listener: the scanner awaits its writer-role check before it calls this, so the
  // page may already have loaded, and a listener added after `load` never runs (see shared/page-load.ts).
  whenPageLoaded(window, document, () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((registration) => {
        const flush = () => {
          const syncRegistration = registration as ServiceWorkerRegistration & {
            sync?: { register(tag: string): Promise<void> }
          }
          registration.active?.postMessage({ type: 'flushQueue' })
          syncRegistration.sync?.register(SW_SYNC_TAG).catch(() => {
            // Background Sync is not available in every browser, especially iOS.
          })
        }
        if (flushQueue) {
          window.addEventListener('online', flush)
          flush()
        }
      })
      .catch((error) => {
        console.warn('[pwa] Service worker registration failed:', error)
      })
  })

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: string; status?: number; message?: string } | undefined
    if (!data?.type) return

    // registerPWA() runs in two documents — scanner (index.html) and the editor
    // (viewer.html, via src/viewer.ts) — and only the scanner has
    // #autosave-status, so the three worker messages that mean a queued upload
    // was lost reached no UI at all in the editor. Every loss case is written to
    // #status-text too, and a document with neither element simply shows
    // nothing rather than throwing inside the message listener.
    const show = (autosaveText: string, statusText?: string): void => {
      const autosave = document.getElementById('autosave-status')
      if (autosave) autosave.textContent = autosaveText
      if (statusText === undefined) return
      const status = document.getElementById('status-text')
      if (status) status.textContent = statusText
    }

    switch (data.type) {
      case 'offline-queued':
        show('Saved offline - sync pending', 'Offline - scan queued for sync')
        break
      case 'offline-flushed':
        // sw.js only posts this for a delivered upload now; an older worker
        // still controlling the page can post a 4xx through it.
        if (typeof data.status === 'number' && data.status >= 400) show('Sync needs review', `Queued upload rejected (${data.status})`)
        else show('Offline scan synced')
        break
      case 'offline-queue-failed':
        show('Not saved - storage full', data.message ?? 'Could not save this upload for later - device storage is full.')
        break
      case 'offline-dropped':
        show('Queue full - oldest uploads dropped', data.message ?? 'Dropped queued upload(s) - the offline queue is full.')
        break
      case 'offline-gave-up':
        show('Upload failed - not synced', data.message ?? 'Gave up on a queued upload after repeated failures.')
        break
      case 'offline-rejected':
        show('Upload rejected - not synced', data.message ?? 'The server rejected a queued upload - it could not be saved.')
        break
    }
  })
}
