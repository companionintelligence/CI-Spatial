/**
 * Drift guards for the classic (non-module) scripts that cannot import
 * shared/ constants and therefore keep hand-mirrored literal copies:
 *
 *   - public/test-fixtures/xr8-mock.js mirrors 4 of src/shared/cv-palette.ts's
 *     8 CV_PALETTE colours (its "keep in sync" comment, xr8-mock.js:19).
 *   - public/sw.js mirrors src/shared/storage-keys.ts's offline-queue DB
 *     name, cache name, and Background Sync tag.
 *
 * Both fixtures are read as text and their literals regex-extracted, in the
 * same spirit as scripts/generate-cv-images.mjs / generate-test-homes.mjs
 * reading src/shared/test-homes.ts — except here the fixture is the thing
 * being checked FOR drift, not the thing generating output.
 *
 *   deno test --allow-read sync.test.ts
 */
import { assertEquals, assertMatch } from 'jsr:@std/assert@1'
import { CV_PALETTE } from './src/shared/cv-palette.ts'
import {
  OFFLINE_QUEUE_DB_NAME,
  SW_CACHE_NAME,
  SW_SYNC_TAG,
} from './src/shared/storage-keys.ts'

async function readRepoFile(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, import.meta.url))
}

// ─── CV palette sync (xr8-mock.js ↔ cv-palette.ts) ─────────────────────────

Deno.test('xr8-mock.js: every SCENE_OBJECTS colour matches CV_PALETTE for its label', async () => {
  const src = await readRepoFile('./public/test-fixtures/xr8-mock.js')

  // Matches entries like: { label: 'sofa', color: 'rgb(255,109,0)', ... }
  const entryPattern = /\{\s*label:\s*'([a-z]+)',\s*color:\s*'rgb\((\d+),\s*(\d+),\s*(\d+)\)'/g
  const found = [...src.matchAll(entryPattern)]

  // If the fixture is ever rewritten such that this pattern no longer
  // matches, fail loudly instead of silently checking zero entries.
  if (found.length === 0) {
    throw new Error(
      'sync.test.ts could not find any SCENE_OBJECTS colour entries in ' +
        'xr8-mock.js — the fixture format changed; update the regex in ' +
        'sync.test.ts to match.',
    )
  }

  for (const [, label, r, g, b] of found) {
    const paletteEntry = CV_PALETTE.find((p) => p.label === label)
    if (!paletteEntry) {
      throw new Error(
        `xr8-mock.js SCENE_OBJECTS has a '${label}' entry with no matching ` +
          `CV_PALETTE label in src/shared/cv-palette.ts`,
      )
    }
    const mockRgb = [Number(r), Number(g), Number(b)]
    assertEquals(
      mockRgb,
      paletteEntry.rgb,
      `xr8-mock.js '${label}' colour rgb(${mockRgb.join(',')}) no longer matches ` +
        `CV_PALETTE's rgb(${paletteEntry.rgb.join(',')}) — update xr8-mock.js:43-46 ` +
        `to match src/shared/cv-palette.ts`,
    )
  }
})

// ─── Service-worker literal sync (sw.js ↔ storage-keys.ts) ─────────────────

function extractSingleQuoted(src: string, pattern: RegExp, what: string): string {
  const m = src.match(pattern)
  if (!m) {
    throw new Error(
      `sync.test.ts could not find ${what} in public/sw.js — the file ` +
        `changed shape; update the regex in sync.test.ts to match.`,
    )
  }
  return m[1]
}

Deno.test('sw.js: CACHE_VERSION matches SW_CACHE_NAME', async () => {
  const src = await readRepoFile('./public/sw.js')
  const cacheVersion = extractSingleQuoted(src, /const CACHE_VERSION = '([^']+)'/, 'CACHE_VERSION')
  assertEquals(cacheVersion, SW_CACHE_NAME)
})

Deno.test('sw.js: QUEUE_DB matches OFFLINE_QUEUE_DB_NAME', async () => {
  const src = await readRepoFile('./public/sw.js')
  const queueDb = extractSingleQuoted(src, /const QUEUE_DB = '([^']+)'/, 'QUEUE_DB')
  assertEquals(queueDb, OFFLINE_QUEUE_DB_NAME)
})

Deno.test('sw.js: both Background Sync tag occurrences match SW_SYNC_TAG', async () => {
  const src = await readRepoFile('./public/sw.js')

  const listenerTag = extractSingleQuoted(
    src,
    /event\.tag === '([^']+)'/,
    "the 'sync' event listener's tag check",
  )
  const registerTag = extractSingleQuoted(
    src,
    /self\.registration\.sync\.register\('([^']+)'\)/,
    'registerFlushSync()\'s sync.register(...) call',
  )

  assertEquals(listenerTag, SW_SYNC_TAG, "sw.js's sync-event tag check drifted from SW_SYNC_TAG")
  assertEquals(registerTag, SW_SYNC_TAG, "sw.js's sync.register(...) call drifted from SW_SYNC_TAG")
})

// ─── pwa.ts / sw.js sync-tag pair ───────────────────────────────────────────

Deno.test('pwa.ts: imports SW_SYNC_TAG (no re-typed literal) and it matches sw.js', async () => {
  const pwaSrc = await readRepoFile('./src/pwa.ts')

  // src/pwa.ts is a real ES module — it must import the shared constant
  // rather than keep its own copy of 'companion-scan-flush'. Assert the
  // import exists...
  assertMatch(
    pwaSrc,
    /import\s*\{[^}]*\bSW_SYNC_TAG\b[^}]*\}\s*from\s*['"]\.\/shared\/storage-keys['"]/,
    'src/pwa.ts must import SW_SYNC_TAG from ./shared/storage-keys instead of ' +
      'hardcoding the Background Sync tag',
  )
  // ...and that it's actually used (not just imported and ignored), and no
  // duplicate literal snuck back in.
  assertMatch(pwaSrc, /\.register\(SW_SYNC_TAG\)/, 'src/pwa.ts must call .register(SW_SYNC_TAG)')
  assertEquals(
    pwaSrc.includes(`'${SW_SYNC_TAG}'`),
    false,
    'src/pwa.ts must not re-type the Background Sync tag as a literal',
  )

  // Because pwa.ts's sync tag is definitionally SW_SYNC_TAG (via the import
  // just verified), the pair pwa.ts/sw.js is equal iff SW_SYNC_TAG equals
  // sw.js's literal — already asserted above, re-checked here so this test
  // stands alone as the "the pair that must stay equal" guard.
  const swSrc = await readRepoFile('./public/sw.js')
  const swTag = extractSingleQuoted(
    swSrc,
    /self\.registration\.sync\.register\('([^']+)'\)/,
    "sw.js's registerFlushSync() sync tag",
  )
  assertEquals(SW_SYNC_TAG, swTag, "src/pwa.ts's sync tag (via SW_SYNC_TAG) must equal public/sw.js's sync tag")
})
