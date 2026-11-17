/**
 * The small dialogs and controls the native shells add to the scanner and the
 * editor: the Scan server address (src/ui/server-setting.ts) and the legal
 * notices (src/ui/legal-notices.ts).
 *
 * The hosted web app never draws any of this, so the styles live here and are
 * added to the page the first time a shell draws one of them. The two pages
 * share the CI design tokens (--background, --card, --primary), and every rule
 * is scoped to a `cs-` class, so nothing here can restyle the page around it.
 */

const STYLE_ID = 'cs-shell-ui-styles'

const CSS = `
.cs-dialog {
  width: min(560px, calc(100vw - 32px)); max-height: min(720px, calc(100vh - 32px));
  padding: 0; border: 1px solid rgba(114,221,212,.32); border-radius: 14px;
  background: var(--card, #0c323c); color: var(--primary, #c5e8dc);
  box-shadow: 0 18px 48px rgba(0,0,0,.45); font: inherit; overflow: hidden;
}
.cs-dialog::backdrop { background: rgba(4,22,32,.72); }
.cs-dialog[open] { display: flex; flex-direction: column; }
.cs-dialog-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 14px 16px; border-bottom: 1px solid rgba(239,240,240,.12);
}
.cs-dialog-head h2 { margin: 0; font-size: 17px; font-weight: 700; color: #eff0f0; }
.cs-dialog-body { padding: 16px; overflow: auto; display: grid; gap: 14px; font-size: 14px; line-height: 1.55; }
.cs-dialog-body p { margin: 0; }
.cs-dialog-body h3 { margin: 4px 0 0; font-size: 14px; font-weight: 700; color: #eff0f0; }
.cs-dialog-body a { color: #72ddd4; }
.cs-btn {
  min-height: 44px; padding: 0 18px; border-radius: 999px; cursor: pointer;
  border: 1px solid rgba(114,221,212,.7); background: transparent; color: #72ddd4;
  font: inherit; font-size: 14px; font-weight: 700; -webkit-tap-highlight-color: transparent;
}
.cs-btn:disabled { opacity: .55; cursor: default; }
.cs-btn-primary { background: #72ddd4; color: #041620; }
.cs-btn-quiet { border-color: rgba(239,240,240,.2); color: #eff0f0; }
.cs-icon-btn { min-width: 44px; min-height: 44px; border: 0; background: transparent; color: #eff0f0; font-size: 18px; cursor: pointer; }
.cs-server-form { display: grid; gap: 10px; width: 100%; text-align: left; }
.cs-server-form label { display: grid; gap: 6px; font-weight: 700; color: #eff0f0; }
.cs-server-form input {
  min-height: 44px; padding: 0 12px; border-radius: 10px; font: inherit; font-size: 16px;
  border: 1px solid rgba(239,240,240,.24); background: rgba(4,22,32,.7); color: #eff0f0;
}
.cs-server-form input:focus-visible, .cs-btn:focus-visible, .cs-icon-btn:focus-visible { outline: 2px solid #72ddd4; outline-offset: 2px; }
.cs-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.cs-result { min-height: 1.5em; margin: 0; color: rgba(239,240,240,.78); }
.cs-result[data-tone="good"] { color: #34d399; }
.cs-result[data-tone="bad"] { color: #f4a4a4; }
.cs-notice { padding: 12px; border-radius: 10px; background: rgba(4,22,32,.55); border: 1px solid rgba(239,240,240,.12); }
.cs-notices-text {
  max-height: 46vh; margin: 0; padding: 12px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  border-radius: 10px; background: rgba(4,22,32,.7); color: #eff0f0; font-size: 12px; line-height: 1.45;
}
.ftue-control { margin-top: 6px; }
.ftue-row .cs-server-form { margin-top: 10px; }
`

/** Adds the shell UI styles to the page once. */
export function ensureShellStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  doc.head.append(style)
}

let dialogCount = 0

/**
 * Opens a modal dialog titled `title`, with `body` inside it, and returns it. The
 * dialog is removed from the page when it closes, by its button, Escape, or code.
 */
export function openShellDialog(title: string, body: Node[], doc: Document = document): HTMLDialogElement {
  ensureShellStyles(doc)
  dialogCount += 1
  const titleId = `cs-dialog-title-${dialogCount}`
  const dialog = doc.createElement('dialog')
  dialog.className = 'cs-dialog'
  dialog.setAttribute('aria-labelledby', titleId)

  const head = doc.createElement('div')
  head.className = 'cs-dialog-head'
  const heading = doc.createElement('h2')
  heading.id = titleId
  heading.textContent = title
  const close = doc.createElement('button')
  close.type = 'button'
  close.className = 'cs-icon-btn'
  close.setAttribute('aria-label', 'Close')
  close.textContent = '✕'
  close.addEventListener('click', () => dialog.close())
  head.append(heading, close)

  const content = doc.createElement('div')
  content.className = 'cs-dialog-body'
  content.append(...body)

  dialog.append(head, content)
  dialog.addEventListener('close', () => dialog.remove())
  doc.body.append(dialog)
  // Every WebView the shells ship has showModal(); the fallback only keeps an old one usable.
  if (typeof dialog.showModal === 'function') dialog.showModal()
  else dialog.setAttribute('open', '')
  return dialog
}
