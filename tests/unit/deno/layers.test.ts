import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { LAYER_ORDER, LAYERS_HIDDEN_BY_DEFAULT, defaultLayerIndex } from '../../../src/world/layers.ts'
import type { LayerType } from '../../../src/world/types.ts'

/**
 * The editor's runtime visibility state and the manifest's `visibleByDefault`
 * are two readers of one decision. They disagreed about `anchor`: the manifest
 * recorded it hidden while the editor rendered it on every scan. These tests
 * pin the shared set as the single source, so a new layer type cannot be added
 * to one reader and forgotten in the other.
 */

/** Mirrors how src/viewer/viewer.ts seeds `globalLayerVisible`. */
function viewerDefaults(): Record<LayerType, boolean> {
  return LAYER_ORDER.reduce((acc, type) => {
    acc[type] = !LAYERS_HIDDEN_BY_DEFAULT.has(type)
    return acc
  }, {} as Record<LayerType, boolean>)
}

Deno.test('anchor layers are hidden by default — they are an alignment aid, not scan geometry', () => {
  assertEquals(LAYERS_HIDDEN_BY_DEFAULT.has('anchor'), true)
  assertEquals(viewerDefaults().anchor, false)
  const anchor = defaultLayerIndex({}).find((layer) => layer.type === 'anchor')
  assertEquals(anchor?.visibleByDefault, false)
})

Deno.test('manifest visibleByDefault matches the editor default for every layer type', () => {
  const viewer = viewerDefaults()
  // A scan that carries keyframes — the case where the two used to diverge,
  // because `hasFrames` flipped rgbFrames visible in the manifest only.
  for (const meta of [{}, { pointCount: 100, detectionCount: 2, poseCount: 40, keyframeCount: 12 }]) {
    for (const layer of defaultLayerIndex(meta)) {
      assertEquals(
        layer.visibleByDefault,
        viewer[layer.type],
        `${layer.type} disagrees: manifest=${layer.visibleByDefault} editor=${viewer[layer.type]}`,
      )
    }
  }
})

Deno.test('every hidden-by-default type is a real layer type in LAYER_ORDER', () => {
  for (const type of LAYERS_HIDDEN_BY_DEFAULT) {
    assertEquals(LAYER_ORDER.includes(type), true, `${type} is not in LAYER_ORDER`)
  }
})

Deno.test('defaultLayerIndex still reports a sidecar source for keyframe layers', () => {
  // Hiding rgbFrames by default must not erase the fact that the sidecar exists.
  const withFrames = defaultLayerIndex({ keyframeCount: 9 })
  const rgb = withFrames.find((layer) => layer.type === 'rgbFrames')
  assertEquals(rgb?.source, 'sidecar')
  assertEquals(rgb?.count, 9)
  assertEquals(rgb?.visibleByDefault, false)
})
