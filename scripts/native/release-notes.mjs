#!/usr/bin/env node
/**
 * The names of a native release's files, and its notes.
 *
 *   node scripts/native/release-notes.mjs --asset <kind> --version 0.2.0 [--signing <mode>]
 *     prints one file name: windows-setup, windows-msi, macos-dmg, linux-deb, linux-rpm or
 *     android-apk (whose name says how it is signed: release-key, throwaway-key or unsigned).
 *   node scripts/native/release-notes.mjs --notes --version 0.2.0 --signing <mode>
 *        [--cert <sha256>] [--commit <sha>] --out notes.md
 *     fills .github/native-release-notes.md.
 *
 * .github/workflows/native-release.yml names every file with --asset, so the files and the
 * notes that list them cannot drift apart.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** How the APK is signed, as the workflow's android_signing input resolves: auto becomes one of these. */
export const SIGNING_MODES = ['keystore', 'throwaway', 'skip']

const APK_LABEL = { keystore: 'release-key', throwaway: 'throwaway-key', skip: 'unsigned' }

/** The release file name of each kind. */
export function assetName(kind, version, signing) {
  const stem = `companion-scan_${version}`
  switch (kind) {
    case 'windows-setup': return `${stem}_windows-x64-setup.exe`
    case 'windows-msi': return `${stem}_windows-x64.msi`
    case 'macos-dmg': return `${stem}_macos-universal.dmg`
    case 'linux-deb': return `${stem}_linux-amd64.deb`
    case 'linux-rpm': return `${stem}_linux-x86_64.rpm`
    case 'android-apk': {
      const label = APK_LABEL[signing]
      if (!label) throw new Error(`unknown signing mode "${signing}": use one of ${SIGNING_MODES.join(', ')}`)
      return `${stem}_android-${label}.apk`
    }
    default: throw new Error(`unknown release file kind "${kind}"`)
  }
}

/** What the notes say about the APK's signature. */
export function androidSigningText(signing, cert) {
  const fingerprint = cert ? ` (certificate SHA-256 \`${cert}\`)` : ''
  switch (signing) {
    case 'keystore':
      return `The APK is signed with the project's release key${fingerprint}, so later releases signed with that key install over it.`
    case 'throwaway':
      return `The APK is signed with a throwaway key made for this release alone${fingerprint}; no later build will carry the same key.`
    case 'skip':
      return 'This APK is unsigned, and Android will not install it until someone signs it.'
    default:
      throw new Error(`unknown signing mode "${signing}"`)
  }
}

/** The release notes, from .github/native-release-notes.md. */
export function releaseNotes({ version, signing, cert, commit }) {
  const values = {
    VERSION: version,
    WINDOWS_SETUP: assetName('windows-setup', version),
    WINDOWS_MSI: assetName('windows-msi', version),
    MACOS_DMG: assetName('macos-dmg', version),
    LINUX_DEB: assetName('linux-deb', version),
    LINUX_RPM: assetName('linux-rpm', version),
    ANDROID_APK: assetName('android-apk', version, signing),
    ANDROID_SIGNING: androidSigningText(signing, cert),
    COMMIT: commit ? `commit ${commit}` : 'this repository',
  }
  const template = readFileSync(join(ROOT, '.github', 'native-release-notes.md'), 'utf8').replace(/\r\n/g, '\n')
  const notes = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`the notes template uses {{${key}}}, which nothing fills`)
    return values[key]
  })
  return notes
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    args[key] = next && !next.startsWith('--') ? argv[++i] : true
  }
  return args
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2))
  if (!/^\d+\.\d+\.\d+$/.test(String(args.version ?? ''))) throw new Error('--version must be x.y.z')
  if (args.asset) {
    console.log(assetName(args.asset, args.version, args.signing))
  } else if (args.notes) {
    const notes = releaseNotes({ version: args.version, signing: args.signing, cert: args.cert, commit: args.commit })
    if (args.out) writeFileSync(args.out, notes)
    else process.stdout.write(notes)
  } else {
    throw new Error('use --asset <kind> or --notes')
  }
}
