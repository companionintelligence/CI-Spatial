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
          syncRegistration.sync?.register('companion-scan-flush').catch(() => {
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
    const data = event.data as { type?: string; status?: number } | undefined
    const autosave = document.getElementById('autosave-status')
    const status = document.getElementById('status-text')
    if (data?.type === 'offline-queued') {
      if (autosave) autosave.textContent = 'Saved offline - sync pending'
      if (status) status.textContent = 'Offline - scan queued for sync'
    } else if (data?.type === 'offline-flushed') {
      if (autosave) autosave.textContent = data.status && data.status >= 400 ? 'Sync needs review' : 'Offline scan synced'
    }
  })
}
