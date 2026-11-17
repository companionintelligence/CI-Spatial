/**
 * Whether the lingbot point cloud route may serve a cloud, from its manifest verdict
 * (server/wp-a-cloud-verdict.ts). A degenerate cloud is refused with 409; anything else is served.
 * The manifest the viewer's panel reads carries a degenerate run's fix inside its error.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { degenerateCloudRefusal, lingBotManifestForViewer } from '../../../server/wp-a-cloud-verdict.ts'

Deno.test('a manifest with no verdict is served, since there is nothing to act on', () => {
  assertEquals(degenerateCloudRefusal(null), null, 'no manifest')
  assertEquals(degenerateCloudRefusal({ status: 'ok' }), null, 'no quality block')
  assertEquals(degenerateCloudRefusal({ quality: 'not a record' }), null)
})

Deno.test('a cloud the verdict does not call degenerate is served', () => {
  assertEquals(degenerateCloudRefusal({ quality: { degenerate: false, reasons: [] } }), null)
})

Deno.test('a degenerate cloud is refused with the verdict, its reasons and the fix', () => {
  const refusal = degenerateCloudRefusal({
    status: 'error',
    error: 'The reconstruction collapsed.',
    remediation: 'Walk the room again, slower.',
    quality: { degenerate: true, reasons: ['too-few-points', 'collapsed-extent'], status: 'needs-rescan' },
  })
  assertEquals(refusal, {
    error: 'The reconstruction collapsed.',
    reasons: ['too-few-points', 'collapsed-extent'],
    remediation: 'Walk the room again, slower.',
  })
})

Deno.test('a degenerate cloud without a stated error or fix still gets a refusal with a readable error', () => {
  const refusal = degenerateCloudRefusal({ quality: { degenerate: true, reasons: [42, 'too-few-points'] } })
  assertEquals(refusal, {
    error: 'The point cloud is too sparse or collapsed to use.',
    reasons: ['too-few-points'],
    remediation: null,
  })
})

Deno.test('the manifest the viewer reads carries a degenerate run\'s fix inside its error', () => {
  const manifest = {
    status: 'error',
    error: 'The 3D reconstruction collapsed.',
    remediation: 'Walk the room again, slower.',
    quality: { degenerate: true, reasons: ['collapsed-extent'] },
  }
  const served = JSON.parse(lingBotManifestForViewer(JSON.stringify(manifest)))
  assertEquals(served.error, 'The 3D reconstruction collapsed. Walk the room again, slower.')
  assertEquals(served.remediation, 'Walk the room again, slower.', 'the fix is still its own field')
  assertEquals(served.quality, manifest.quality)
})

Deno.test('a failed manifest with no problem text reads as the fix alone', () => {
  const served = JSON.parse(lingBotManifestForViewer(JSON.stringify({ status: 'error', remediation: 'Walk again.' })))
  assertEquals(served.error, 'Walk again.')
})

Deno.test('a manifest that is not a failed run, or has no fix, is served exactly as it was', () => {
  const ok = JSON.stringify({ status: 'ok', pointCount: 5 })
  assertEquals(lingBotManifestForViewer(ok), ok)
  const noFix = JSON.stringify({ status: 'error', error: 'worker exit 3' })
  assertEquals(lingBotManifestForViewer(noFix), noFix)
  assertEquals(lingBotManifestForViewer('not json'), 'not json')
})

Deno.test('a fix already inside the error is not joined on a second time', () => {
  const text = JSON.stringify({ status: 'error', error: 'Collapsed. Walk again.', remediation: 'Walk again.' })
  assertEquals(lingBotManifestForViewer(text), text)
})
