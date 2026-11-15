/**
 * What the editor adds inside a native shell (Android, iOS and desktop): the Scan
 * server it talks to, in the Navigate menu, a prompt for one when none is set, and
 * Companion Account sign-in through the system browser.
 *
 * The hosted editor draws none of this. Its server is the origin that served it.
 * A shell has no server of its own, so the person's own Scan server (on their
 * Companion Hub, say) is set here or on the scanner's first-run screen, and kept on
 * the device by src/shared/api-base.ts.
 */
import { apiBase, isNativeShell } from '../shared/api-base.ts'
import { beginShellSignIn, initShellSignIn } from '../shared/shell-sign-in.ts'
import { openServerDialog } from '../ui/server-setting.ts'
import { ensureShellStyles } from '../ui/shell-dialog.ts'

/** How long a successful test stays on screen before the editor reloads from the new server. */
const RELOAD_AFTER_MS = 900

/**
 * Opens the server dialog. A saved address reloads the editor when the dialog closes,
 * because everything on screen was read from the old server (or from none). A server
 * that answered closes the dialog by itself.
 */
export function changeServer(): void {
  let saved = false
  const dialog = openServerDialog({
    onSaved: (_origin, check) => {
      saved = true
      if (check === 'ok') setTimeout(() => dialog.close(), RELOAD_AFTER_MS)
    },
  })
  dialog.addEventListener('close', () => {
    if (saved) location.reload()
  })
}

/** The Navigate menu entry: "Scan server", with the host it is set to. */
function serverMenuItem(doc: Document): HTMLButtonElement {
  const item = doc.createElement('button')
  item.type = 'button'
  item.id = 'shell-server-link'
  item.className = 'workspace-menu-link'
  item.style.textAlign = 'left'
  item.style.cursor = 'pointer'
  item.style.font = 'inherit'
  const title = doc.createElement('span')
  title.textContent = 'Scan server'
  const detail = doc.createElement('small')
  const origin = apiBase()
  detail.textContent = origin ? new URL(origin).host : 'None set. Places and scans live on one.'
  item.append(title, detail)
  item.addEventListener('click', () => {
    doc.getElementById('workspace-menu')?.removeAttribute('open')
    changeServer()
  })
  return item
}

/** The account chip's words while a sign-in is out in the browser, after one fails, and when this build cannot open a browser. */
export const CHIP_CONTINUE = 'Continue in your browser'
export const CHIP_FAILED = 'Sign-in failed. Try again.'
export const CHIP_UNAVAILABLE = 'Sign-in is not available in this app'

/**
 * In a shell the account chip signs in through the system browser (src/shared/shell-sign-in.ts).
 * Its href would load the server's sign-in page inside the app, where the session cannot follow.
 * A finished sign-in reloads the editor, which then reads everything with the new session. A
 * server with sign-in off has no chip: viewer.ts removes it when /authenticate/whoami is a 404.
 */
function wireAccountChip(doc: Document): void {
  const chip = doc.getElementById('account-chip')
  chip?.addEventListener('click', (event) => {
    event.preventDefault()
    beginShellSignIn().then(
      () => { chip.textContent = CHIP_CONTINUE },
      () => { chip.textContent = CHIP_UNAVAILABLE },
    )
  })
  void initShellSignIn((signedIn) => {
    if (signedIn) location.reload()
    else if (chip) chip.textContent = CHIP_FAILED
  })
}

/**
 * Adds the shell's entries to the Navigate menu, and asks for a server straight away
 * when none is set, since the editor can show nothing without one. Does nothing
 * outside a shell.
 */
export function mountShellMenu(doc: Document = document): void {
  if (!isNativeShell()) return
  ensureShellStyles(doc)
  const panel = doc.querySelector('#workspace-menu .workspace-menu-panel')
  if (panel) {
    const divider = panel.querySelector('.workspace-menu-divider')
    panel.insertBefore(serverMenuItem(doc), divider)
  }
  wireAccountChip(doc)
  if (!apiBase()) changeServer()
}
