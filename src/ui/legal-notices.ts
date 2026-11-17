/**
 * Legal notices, inside the native apps: Companion Scan's own licence, the notice the
 * Niantic Spatial XR Engine licence asks for, the disclosure Google asks of an app that
 * uses ARCore (the Android app only), and the licences of the other software in the bundle.
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
 * The Android app also runs ARCore. That is Google's and proprietary: the SDK is under the
 * ARCore Additional Terms of Service, not an open-source licence. Google's user privacy
 * requirements (https://developers.google.com/ar/develop/privacy-requirements) ask an app that
 * uses ARCore to say so prominently, where it is easy to find (a main menu or notice screen),
 * with links to Google Play Services for AR and the Google Privacy Policy. This view is that
 * notice screen. iOS runs ARKit and the desktop app has no AR, so neither shows it.
 *
 * The first-run Legal notices row (src/ui/ftue-status.ts) and the editor's Navigate
 * menu (src/viewer/shell-menu.ts) open this. The hosted web app never shows it.
 * tests/unit/node/legal_notices.test.ts holds the notice to the engine's own header, and the
 * ARCore notice to the one THIRD-PARTY-NOTICES.txt carries.
 */
import { isAndroidShell, isDesktopShell } from '../shared/api-base.ts'
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

/**
 * What Google asks an app that uses ARCore to tell its people, and the terms the SDK is under. The sentence goes
 * on a main menu or notice screen, with links to Google Play Services for AR and the Google Privacy Policy
 * (https://developers.google.com/ar/develop/privacy-requirements). The SDK is under the ARCore Additional Terms
 * of Service. They are proprietary, so they are linked and not reproduced, as the XR Engine's Agreement is. Only
 * the Android app runs ARCore. scripts/native/third-party-notices.mjs prints the same words in
 * THIRD-PARTY-NOTICES.txt (its ARCORE_NOTICE) and tests/unit/node/legal_notices.test.ts holds the two together:
 * compare the sentence with Google's page before a store build.
 *
 * The sentence is Google's own, word for word. It was compared with the page on 2026-11-16 (the page's footer
 * read "Last updated 2024-10-31") and an earlier draft that said "provided by Google LLC" was corrected to the
 * page's "provided by Google". The words are held in three places that must change together: `disclosure` below,
 * ARCORE_NOTICE in scripts/native/third-party-notices.mjs, and ARCORE_SENTENCE in
 * tests/unit/node/legal_notices.test.ts. Compare it with Google's page again before a store build: the page can change.
 */
export const ARCORE_NOTICE = {
  name: 'Google Play Services for AR (ARCore)',
  disclosure: 'This application runs on Google Play Services for AR (ARCore), which is provided by Google and governed by the Google Privacy Policy.',
  licence: 'The ARCore SDK is licensed under the ARCore Additional Terms of Service, not under the licence of this app.',
  links: [
    { text: 'Google Play Services for AR', href: 'https://play.google.com/store/apps/details?id=com.google.ar.core' },
    { text: 'Google Privacy Policy', href: 'https://policies.google.com/privacy' },
    { text: 'ARCore Additional Terms of Service', href: 'https://developers.google.com/ar/develop/terms' },
  ],
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
 * leaves the XR Engine out. `arcoreBundled` is true for the Android app alone, the one that
 * runs ARCore.
 */
export function legalSections(engineBundled: boolean, arcoreBundled = false): LegalSection[] {
  const sections: LegalSection[] = [{
    heading: APP_NOTICE.name,
    paragraphs: [APP_NOTICE.copyright, APP_NOTICE.licence],
    links: [{ text: 'PolyForm Noncommercial License 1.0.0', href: APP_NOTICE.licenceUrl }],
  }]
  // ARCore goes ahead of the engine: Google asks for its sentence to be prominent, and the engine's five
  // paragraphs fill a phone's first screen, which would leave the sentence below the fold.
  if (arcoreBundled) {
    sections.push({
      heading: ARCORE_NOTICE.name,
      paragraphs: [ARCORE_NOTICE.disclosure, ARCORE_NOTICE.licence],
      links: ARCORE_NOTICE.links.map((link) => ({ ...link })),
    })
  }
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
    heading: 'Third-party software',
    paragraphs: ['This app includes third-party software. Each piece keeps its own licence, listed below.'],
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

/**
 * Opens the legal notices in a dialog. In the desktop app the engine notice is left out, as is the engine.
 * The ARCore notice is shown in the Android app alone, which is the one shell that runs ARCore.
 */
export function openLegalNotices(engineBundled = !isDesktopShell(), arcoreBundled = isAndroidShell()): HTMLDialogElement {
  const doc = document
  const body: Node[] = []
  for (const section of legalSections(engineBundled, arcoreBundled)) {
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
    fileDisclosure(doc, 'Show third-party licences', NOTICES_FILE),
    fileDisclosure(doc, 'Show the Companion Scan licence', LICENSE_FILE),
  )
  return openShellDialog('Legal notices', body)
}
