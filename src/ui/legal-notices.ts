/**
 * Legal notices, inside the native apps: Companion Scan's own licence, the notice the
 * Niantic Spatial XR Engine licence asks for, and the open-source licences of the
 * software in the bundle.
 *
 * The XR Engine (public/xr.js, xr-slam.js, xr-face.js and public/resources/) ships in
 * the Android and iOS apps, unmodified. Its licence (section 1.3.2 of the XR Engine
 * License Agreement) asks any material that uses it to name Niantic Spatial as its
 * creator, carry its copyright notice, say it is licensed under that Agreement with a
 * link to it, and refer to the Agreement's disclaimer of warranties. Niantic asks a
 * packaged app to show this somewhere a person can find it. The desktop app is the
 * editor and viewer only and leaves the engine out of its bundle, so it shows no
 * engine notice.
 *
 * The first-run Legal notices row (src/ui/ftue-status.ts) and the editor's Navigate
 * menu (src/viewer/shell-menu.ts) open this. The hosted web app never shows it.
 * tests/unit/node/legal_notices.test.ts holds the notice to the engine's own header.
 */
import { isDesktopShell } from '../shared/api-base.ts'
import { openShellDialog } from './shell-dialog.ts'

/** The XR Engine's notice, word for word from the header Niantic ships at the top of public/xr.js. */
export const XR_ENGINE_NOTICE = {
  name: 'Niantic Spatial XR Engine (8th Wall)',
  creator: 'This product includes the XR Engine software developed by Niantic Spatial, Inc.',
  copyright: 'Copyright © 2026 Niantic Spatial, Inc. All rights reserved.',
  licence: 'The XR Engine is licensed under the XR Engine License Agreement, not under the licence of this app.',
  licenceUrl: 'https://github.com/8thwall/engine/blob/main/LICENSE',
  disclaimer: 'Niantic Spatial provides the XR Engine "as is", without warranties of any kind. '
    + 'Section 4 (Disclaimers) of the XR Engine License Agreement sets out the disclaimer of warranties.',
  noEndorsement: 'Companion Scan is not made, sponsored or endorsed by Niantic Spatial.',
} as const

/** Companion Scan's own licence and Required Notice (LICENSE). */
export const APP_NOTICE = {
  name: 'Companion Scan',
  copyright: 'Copyright LifeScope INC, DBA Companion Intelligence (https://ci.computer).',
  licence: 'Licensed under the PolyForm Noncommercial License 1.0.0.',
  licenceUrl: 'https://polyformproject.org/licenses/noncommercial/1.0.0',
} as const

/** Where each bundle keeps its notices files (written by scripts/native/build-web.mjs). */
export const NOTICES_FILE = '/THIRD-PARTY-NOTICES.txt'
export const LICENSE_FILE = '/LICENSE.txt'

/** A section of the view: a heading, paragraphs, and links. */
export interface LegalSection {
  heading: string
  paragraphs: string[]
  links: Array<{ text: string, href: string }>
}

/**
 * The sections a build shows. `engineBundled` is false for the desktop app, whose bundle
 * leaves the XR Engine out.
 */
export function legalSections(engineBundled: boolean): LegalSection[] {
  const sections: LegalSection[] = [{
    heading: APP_NOTICE.name,
    paragraphs: [APP_NOTICE.copyright, APP_NOTICE.licence],
    links: [{ text: 'PolyForm Noncommercial License 1.0.0', href: APP_NOTICE.licenceUrl }],
  }]
  if (engineBundled) {
    sections.push({
      heading: XR_ENGINE_NOTICE.name,
      paragraphs: [
        XR_ENGINE_NOTICE.creator,
        XR_ENGINE_NOTICE.copyright,
        XR_ENGINE_NOTICE.licence,
        XR_ENGINE_NOTICE.disclaimer,
        XR_ENGINE_NOTICE.noEndorsement,
      ],
      links: [{ text: 'XR Engine License Agreement', href: XR_ENGINE_NOTICE.licenceUrl }],
    })
  }
  sections.push({
    heading: 'Open-source software',
    paragraphs: ['This app includes open-source software. Each piece keeps its own licence, listed in full below.'],
    links: [],
  })
  return sections
}

/** Reads a notices file from the app's own bundle, or null when this build has none. */
async function readBundled(path: string): Promise<string | null> {
  try {
    const res = await fetch(path, { cache: 'no-store' })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    // An unknown path can fall back to index.html in a shell. That is not a notices file.
    if (type.includes('html')) return null
    return await res.text()
  } catch {
    return null
  }
}

/** A button that loads a bundled text file into a scrolling block below it, once. */
function fileDisclosure(doc: Document, label: string, path: string): HTMLElement {
  const holder = doc.createElement('div')
  const button = doc.createElement('button')
  button.type = 'button'
  button.className = 'cs-btn cs-btn-quiet'
  button.textContent = label
  button.setAttribute('aria-expanded', 'false')
  const text = doc.createElement('pre')
  text.className = 'cs-notices-text'
  text.hidden = true
  text.tabIndex = 0
  button.addEventListener('click', async () => {
    if (!text.hidden) {
      text.hidden = true
      button.setAttribute('aria-expanded', 'false')
      return
    }
    if (!text.textContent) {
      button.disabled = true
      text.textContent = (await readBundled(path)) ?? `This build has no ${path.slice(1)}.`
      button.disabled = false
    }
    text.hidden = false
    button.setAttribute('aria-expanded', 'true')
  })
  holder.append(button, text)
  return holder
}

/** Opens the legal notices in a dialog. In the desktop app the engine notice is left out, as is the engine. */
export function openLegalNotices(engineBundled = !isDesktopShell()): HTMLDialogElement {
  const doc = document
  const body: Node[] = []
  for (const section of legalSections(engineBundled)) {
    const block = doc.createElement('section')
    block.className = 'cs-notice'
    const heading = doc.createElement('h3')
    heading.textContent = section.heading
    block.append(heading)
    for (const paragraph of section.paragraphs) {
      const p = doc.createElement('p')
      p.textContent = paragraph
      block.append(p)
    }
    for (const link of section.links) {
      const p = doc.createElement('p')
      const a = doc.createElement('a')
      a.href = link.href
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.textContent = link.text
      p.append(a)
      block.append(p)
    }
    body.push(block)
  }
  body.push(
    fileDisclosure(doc, 'Show open-source licences', NOTICES_FILE),
    fileDisclosure(doc, 'Show the Companion Scan licence', LICENSE_FILE),
  )
  return openShellDialog('Legal notices', body)
}
