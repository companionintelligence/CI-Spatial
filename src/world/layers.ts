import type { LayerManifest, LayerType } from './types'

export const LAYER_ORDER: LayerType[] = [
  'points',
  'mesh',
  'floor',
  'detections',
  'labels',
  'cameraPath',
  'cameraFrustums',
  'rgbFrames',
  'depth',
  'semanticMasks',
  'splat',
  'splat4d',
  'anchor',
]

/**
 * Layer types that start hidden. Lives here, beside LAYER_ORDER, because two
 * places decide this and they disagreed: `defaultLayerIndex` below wrote
 * `visibleByDefault: false` for `anchor` (with a comment explaining why), while
 * the editor's own runtime state derived visibility from a separate hardcoded
 * list that omitted `anchor` — so calibration anchors rendered on every scan,
 * which is the opposite of what the manifest recorded. One set, both readers
 * (ADR 0001).
 *
 * `rgbFrames`/`depth`/`semanticMasks`/`splat` are heavy or usually absent;
 * `anchor` is a deliberate alignment aid, not core scan geometry.
 */
export const LAYERS_HIDDEN_BY_DEFAULT: ReadonlySet<LayerType> = new Set<LayerType>([
  'rgbFrames',
  'depth',
  'semanticMasks',
  'splat',
  'splat4d',
  'anchor',
])

export const LAYER_LABELS: Record<LayerType, string> = {
  points: 'Point cloud',
  mesh: 'Meshes',
  floor: 'Floors',
  detections: 'Detections',
  labels: 'Labels',
  cameraPath: 'Camera path',
  cameraFrustums: 'Camera frustums',
  rgbFrames: 'RGB frames',
  depth: 'Depth',
  splat: 'Gaussian splat',
  splat4d: '4D person',
  semanticMasks: 'Semantic masks',
  anchor: 'Calibration anchors',
}

export function defaultLayerIndex(meta: Record<string, unknown>): LayerManifest[] {
  const pointCount = asNumber(meta['pointCount'])
  const detectionCount = asNumber(meta['detectionCount'])
  const poseCount = asNumber(meta['poseCount'])
  const keyframeCount = asNumber(meta['keyframeCount'])

  return LAYER_ORDER.map((type) => {
    const encodedInGlb = type === 'points'
      || type === 'mesh'
      || type === 'floor'
      || type === 'detections'
      || type === 'labels'
      || type === 'cameraPath'
    const hasFrames = (type === 'rgbFrames' || type === 'cameraFrustums') && (keyframeCount ?? 0) > 0
    const future = !hasFrames && (type === 'rgbFrames' || type === 'depth' || type === 'splat' || type === 'semanticMasks')
    // `hasFrames` still decides `source` below (a scan with keyframes really does
    // have an rgbFrames sidecar), but it no longer forces the layer visible: the
    // editor has never shown RGB frames by default, so claiming otherwise here
    // made the manifest describe a view the app does not render.
    const visibleByDefault = !LAYERS_HIDDEN_BY_DEFAULT.has(type) && !future
    return {
      id: `layer-${type}`,
      type,
      label: LAYER_LABELS[type],
      visibleByDefault,
      encodedInGlb,
      source: hasFrames ? 'sidecar' : future ? 'future' : encodedInGlb ? 'glb' : 'derived',
      count: layerCount(type, pointCount, detectionCount, poseCount, keyframeCount),
    }
  })
}

function layerCount(
  type: LayerType,
  pointCount: number | null,
  detectionCount: number | null,
  poseCount: number | null,
  keyframeCount: number | null,
): number | null {
  if (type === 'points') return pointCount
  if (type === 'detections' || type === 'labels') return detectionCount
  if (type === 'cameraFrustums' || type === 'rgbFrames') return keyframeCount ?? poseCount
  if (type === 'cameraPath') return poseCount
  return null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
