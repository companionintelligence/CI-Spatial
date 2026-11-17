/**
 * The share-link QR caption must not promise revocation (src/viewer/viewer.ts).
 *
 * No code path revokes a share link, and links never expire, so the caption says so
 * (see the F82 audit finding). Revocation itself is out of scope for this change.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-d-share-caption.test.ts
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../../../src/viewer/viewer.ts', import.meta.url), 'utf8')

test('the QR caption states that links do not expire and cannot be revoked', () => {
  const caption = source.split('\n').find(line => line.includes('class="qr-caption"'))

  assert.ok(caption, 'the QR caption is in viewer.ts')
  assert.match(caption, /Links do not expire and cannot be revoked\./)
  assert.doesNotMatch(caption, /until the link is revoked/)
})
