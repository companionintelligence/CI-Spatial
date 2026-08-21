// Chrome-level UI: tab switching (direct/server pathway), the settings drawer, and a
// lightweight connection-status dot in the top bar. Deliberately independent of app.mjs and
// backend-client.mjs — it only ever reads their existing #status/#be-status text and toggles
// visibility via the body[data-pathway] attribute, so it can't break either client's own logic.

const body = document.body;
const tabs = [...document.querySelectorAll('.tab')];

function setPathway(pathway) {
  body.dataset.pathway = pathway;
  for (const tab of tabs) tab.classList.toggle('active', tab.dataset.panel === pathway);
  try {
    localStorage.setItem('osmo-pathway', pathway);
  } catch {
    /* private browsing / storage disabled — pathway just won't persist across reloads */
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => setPathway(tab.dataset.panel));
}

// Server (backend-mediated) is the default pathway — it's the one with a real, working BLE
// connection; Direct (Web Bluetooth) only works from a real Chrome/Edge tab with a Bluetooth
// adapter, not from most embedded/preview browsers.
let initialPathway = 'server';
try {
  initialPathway = localStorage.getItem('osmo-pathway') || 'server';
} catch {
  /* ignore */
}
setPathway(initialPathway);

// ---- Drawer (bottom sheet) ----
const drawer = document.getElementById('drawer');
const backdrop = document.getElementById('drawer-backdrop');
const menuBtn = document.getElementById('btn-menu');
const closeBtn = document.getElementById('btn-drawer-close');

function openDrawer() {
  drawer.classList.add('open');
  backdrop.classList.add('open');
}
function closeDrawer() {
  drawer.classList.remove('open');
  backdrop.classList.remove('open');
}
menuBtn.addEventListener('click', () => (drawer.classList.contains('open') ? closeDrawer() : openDrawer()));
closeBtn.addEventListener('click', closeDrawer);
backdrop.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

// ---- Status dots ----
// Both app.mjs and backend-client.mjs already write human-readable status text into
// #status/#be-status — rather than touch either module to also maintain a dot, just watch
// their text and classify it. Keeps this file a pure UI layer with no coupling to transport
// internals.
function classify(text) {
  const t = text.toLowerCase();
  if (/not reachable|not connected|disconnected/.test(t)) return false;
  if (/connected|paired/.test(t)) return true;
  return false;
}

function watchStatus(sourceId, dotId) {
  const source = document.getElementById(sourceId);
  const dot = document.getElementById(dotId);
  if (!source || !dot) return;
  const sync = () => dot.classList.toggle('on', classify(source.textContent || ''));
  sync();
  new MutationObserver(sync).observe(source, { characterData: true, childList: true, subtree: true });
}
watchStatus('status', 'dot-direct');
watchStatus('be-status', 'dot-server');

// ---- PWA service worker ----
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed:', err));
}
