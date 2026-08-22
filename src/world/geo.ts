import type { GeoPose, Vec3 } from './types'

const EARTH_RADIUS_M = 6_378_137
const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

export function identityMatrix(): number[] {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]
}

export function hasGeoPose(pose: GeoPose | null | undefined): pose is GeoPose & { lat: number; lng: number } {
  return typeof pose?.lat === 'number'
    && typeof pose.lng === 'number'
    && !(pose.lat === 0 && pose.lng === 0)
}

export function geoToEnu(origin: GeoPose, pose: GeoPose): Vec3 {
  if (!hasGeoPose(origin) || !hasGeoPose(pose)) {
    return { x: 0, y: 0, z: 0 }
  }

  const lat0 = origin.lat * DEG_TO_RAD
  const lat = pose.lat * DEG_TO_RAD
  const dLat = lat - lat0
  const dLng = (pose.lng - origin.lng) * DEG_TO_RAD
  const east = dLng * Math.cos((lat + lat0) * 0.5) * EARTH_RADIUS_M
  const north = dLat * EARTH_RADIUS_M
  const up = (pose.altitudeM ?? 0) - (origin.altitudeM ?? 0)

  return { x: east, y: up, z: north }
}

export function distanceM(a: GeoPose, b: GeoPose): number | null {
  if (!hasGeoPose(a) || !hasGeoPose(b)) return null
  const delta = geoToEnu(a, b)
  return Math.sqrt(delta.x ** 2 + delta.z ** 2)
}

export function enuToGeo(origin: GeoPose, local: Vec3): GeoPose {
  if (!hasGeoPose(origin)) {
    return { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
  }

  const lat0 = origin.lat * DEG_TO_RAD
  const lat = origin.lat + (local.z / EARTH_RADIUS_M) * RAD_TO_DEG
  const lng = origin.lng + (local.x / (EARTH_RADIUS_M * Math.cos(lat0))) * RAD_TO_DEG
  return {
    ...origin,
    lat,
    lng,
    altitudeM: (origin.altitudeM ?? 0) + local.y,
  }
}

export function composeYUpTransform(translation: Vec3, bearingDeg: number | null | undefined, scale = 1): number[] {
  const yaw = ((bearingDeg ?? 0) * DEG_TO_RAD)
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)

  return [
    c * scale, 0, -s * scale, 0,
    0, scale, 0, 0,
    s * scale, 0, c * scale, 0,
    translation.x, translation.y, translation.z, 1,
  ]
}

/**
 * Builds a `ScanCalibration.sessionToProject` matrix for the one-tap
 * ground-plus-compass calibration: `tapPos` (a hit-tested point in the AR
 * session's local coordinates) must map to project-space origin (0,0,0) —
 * the same invariant the old 3-point reference-triangle system already
 * established (its first tapped point always zeroed out by construction).
 *
 * Reuses composeYUpTransform's own rotation construction so the yaw
 * convention can't drift between the GPS-fallback placement path and this
 * one — but inverts the translation: composeYUpTransform positions a scan's
 * local origin AT `translation`; this instead solves for the translation
 * that puts `tapPos` itself at zero, i.e. T = -R(bearing)·tapPos.
 */
export function anchorToProjectTransform(tapPos: Vec3, bearingDeg: number | null): number[] {
  const rotation = composeYUpTransform({ x: 0, y: 0, z: 0 }, bearingDeg, 1)
  // Column-major (THREE.Matrix4.fromArray convention, matching composeYUpTransform's
  // own return layout): column 0 = indices [0,1,2], column 1 = [4,5,6], column 2 = [8,9,10].
  const r00 = rotation[0]!, r01 = rotation[4]!, r02 = rotation[8]!
  const r10 = rotation[1]!, r11 = rotation[5]!, r12 = rotation[9]!
  const r20 = rotation[2]!, r21 = rotation[6]!, r22 = rotation[10]!

  rotation[12] = -(r00 * tapPos.x + r01 * tapPos.y + r02 * tapPos.z)
  rotation[13] = -(r10 * tapPos.x + r11 * tapPos.y + r12 * tapPos.z)
  rotation[14] = -(r20 * tapPos.x + r21 * tapPos.y + r22 * tapPos.z)
  return rotation
}

export function matrixTranslation(matrix: number[]): Vec3 {
  return {
    x: Number(matrix[12] ?? 0),
    y: Number(matrix[13] ?? 0),
    z: Number(matrix[14] ?? 0),
  }
}
