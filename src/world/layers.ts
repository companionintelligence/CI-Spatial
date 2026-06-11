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
]

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
  semanticMasks: 'Semantic masks',
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
    return {
      id: `layer-${type}`,
      type,
      label: LAYER_LABELS[type],
      visibleByDefault: !future,
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
