export function registerPWA(): void {
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator)) return
  if (!window.isSecureContext) return

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
      console.warn('[pwa] Service worker registration failed:', error)
    })
  }, { once: true })
}
