/**
 * Stale-Place guards, cleanup and copy in the viewer (src/viewer/viewer.ts), third pass.
 *
 * viewer.ts runs its DOM code when it is imported, so node cannot load it. These checks read
 * the source and pin the rules a regression would break, each one scoped to the function it
 * belongs to. The behaviour behind them is for the browser specs, which are not run here.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-v3-viewer-guards.test.ts
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../../../src/viewer/viewer.ts', import.meta.url), 'utf8')

/** One top-level function, from its declaration to the closing brace at column 0. */
function fnBody(name: string): string {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('))
  assert.notEqual(start, -1, name + ' is declared in viewer.ts')
  const end = source.indexOf('\n}\n', start)
  assert.notEqual(end, -1, name + ' closes at column 0')
  return source.slice(start, end)
}

test('V3-1: a 4D frame shown for a Place that was left does not attach its root to the Place on screen', () => {
  // createSplat4DLayer shows its first frame before it returns, so the Place check has to sit
  // inside the onFrame closure, ahead of ensureScanRootInWorld.
  assert.match(
    fnBody('ensureSplat4DLayer'),
    /onFrame: \(mesh\) => \{\n\s*if \(!mesh\) return\n[\s\S]*?if \(gen !== worldGen\) return\n[\s\S]*?const root = ensureScanRootInWorld\(scan\)/,
  )
})

test('V3-2: the 4D catch in the splat panel returns first when the Place has changed', () => {
  assert.match(
    fnBody('refreshSplatLayerPanel'),
    /\} catch \(e\) \{\n\s*if \(gen !== worldGen\) return\n\s*console\.error\('\[viewer\] 4D layer failed:'/,
  )
})

test('V3-4: a queued GLB load checks for a Place switch before it writes its status line', () => {
  assert.match(
    fnBody('loadScanIntoWorld'),
    /if \(isStale\(\)\) return\n\s*setScanStatus\(scan\.scanId, 'Loading GLB\.\.\.'\)/,
  )
})

test('V3-5: a stale overlay fetch frees what it loaded before it returns', () => {
  assert.match(
    fnBody('refreshSplatLayerPanel'),
    /if \(gen !== worldGen\) \{\n(?:\s*\/\/[^\n]*\n)?\s*if \(fetched\) disposeScanSplatLayer\(fetched\)\n\s*return\n\s*\}/,
  )
  assert.match(
    fnBody('refreshLingBotMapPanel'),
    /if \(gen !== worldGen\) \{\n\s*if \(fetched\) \{\n\s*disposeOverlayGeometry\(fetched\.pointsGroup\)\n\s*disposeOverlayGeometry\(fetched\.pathGroup\)\n\s*\}\n\s*return\n\s*\}/,
  )
  assert.match(
    fnBody('refreshSplatDetectPanel'),
    /if \(gen !== worldGen\) \{\n\s*if \(fetched\) disposeOverlayGeometry\(fetched\.boxesGroup\)\n\s*return\n\s*\}/,
  )
  assert.match(
    fnBody('ensureScanPanopticLayer'),
    /if \(gen !== worldGen\) \{\n\s*if \(layer\) disposeOverlayGeometry\(layer\.markerGroup\)\n\s*return null\n\s*\}/,
  )
  // Geometry only: an overlay's materials are module-level and shared by every overlay of its kind.
  assert.doesNotMatch(fnBody('disposeOverlayGeometry'), /material/)
})

test('V3-6: a Place switch clears the LingBot stats, splat stats and panoptic reasons with the other overlay panels', () => {
  const reset = fnBody('resetScanOverlayPanels')
  for (const id of ['lingbot-map-stats', 'splat-layer-stats', 'panoptic-objects-reasons']) {
    assert.ok(reset.includes("'" + id + "'"), id + ' is cleared on a Place switch')
  }
})

test('V3-7: a failed share-link fetch from a Place that was left does not write the new Place panel', () => {
  assert.match(
    fnBody('loadShareLinks'),
    /\} catch \(error\) \{\n(?:\s*\/\/[^\n]*\n)?\s*if \(gen !== worldGen\) return\n\s*target\.innerHTML = /,
  )
})

test('V3-8: an HTML error page carries no HTTP status, so a pending edit keeps retrying through an outage', () => {
  const body = fnBody('httpError')
  const htmlLine = body.split('\n').find(line => line.includes('if (isHtml)'))
  assert.ok(htmlLine, 'the HTML branch is in httpError')
  assert.match(htmlLine, /return new Error\(/)
  assert.doesNotMatch(htmlLine, /\{ status:/)
  assert.match(body, /Object\.assign\(new Error\(/, 'every other error still carries its status')
})

test('V3-9: Save Tags names a refused edit as refused, and promises a retry only for a transient failure', () => {
  assert.doesNotMatch(source, /Not saved\. Retry/)
  assert.ok(source.includes("'Not saved. The server refused this change.'"))
  assert.ok(source.includes("'Not saved. Save again to retry.'"))
  const start = source.indexOf("getElementById('btn-flush-tags')!.addEventListener")
  assert.notEqual(start, -1, 'the Save Tags listener is in viewer.ts')
  const flush = source.slice(start, source.indexOf('\n})\n', start))
  assert.match(flush, /editSaves\.refusedCount > 0/)
  assert.match(flush, /flashButton\('btn-flush-tags', saved \? 'Saved' : notSaved/)
})

test('V3-10: a box the exporter could only place is labelled as an estimate, not as a measured size', () => {
  const inspector = fnBody('showInspector')
  assert.match(inspector, /obj\.userData\['dimensionsEstimated'\] === true \? 'Estimated size' : 'Size'/)
  assert.match(inspector, /rowHtml\(sizeLabel,/)
})
