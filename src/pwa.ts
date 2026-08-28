import { SW_SYNC_TAG } from './shared/storage-keys'

export function registerPWA(): void {
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator)) return
  if (!window.isSecureContext) return

  window.addEventListener('load', () => {
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
        window.addEventListener('online', flush)
        flush()
      })
      .catch((error) => {
        console.warn('[pwa] Service worker registration failed:', error)
      })
  }, { once: true })

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
