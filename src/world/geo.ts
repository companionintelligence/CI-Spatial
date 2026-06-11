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

export function matrixTranslation(matrix: number[]): Vec3 {
  return {
    x: Number(matrix[12] ?? 0),
    y: Number(matrix[13] ?? 0),
    z: Number(matrix[14] ?? 0),
  }
}
