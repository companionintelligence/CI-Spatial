/**
 * Generates 24 deterministic test-home scan GLBs matching the mobile
 * exporter's schema (point cloud + camera path + floor plane + detection
 * boxes with userData extras + geo metadata).
 *
 *   node scripts/generate-test-homes.mjs            → test-data/homes/
 *
 * Outputs per home:
 *   home-NN-<slug>.glb        scan in exporter format
 *   home-NN-<slug>.meta.json  server companion metadata (/upload-scan shape)
 * Plus:
 *   index.json                home inventory
 *   expected.json             ground truth (dims, furniture, counts) for tests
 *
 * Deterministic: same bytes every run (seeded PRNG, fixed timestamps).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Document, NodeIO } from '@gltf-transform/core'
import { buildTestHomes, mulberry32 } from '../src/shared/test-homes.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'test-data', 'homes')
mkdirSync(outDir, { recursive: true })

const FIXED_TIMESTAMP = '2026-01-15T12:00:00.000Z'
const io = new NodeIO()
const homes = buildTestHomes()

/** Sample points on the surfaces of an axis-aligned box */
function sampleBox(rand, cx, cy, cz, w, h, d, count, jitter, out) {
  for (let i = 0; i < count; i++) {
    const face = Math.floor(rand() * 6)
    const u = rand() - 0.5
    const v = rand() - 0.5
    let x, y, z
    if (face === 0) { x = -0.5; y = u; z = v }       // -X
    else if (face === 1) { x = 0.5; y = u; z = v }   // +X
    else if (face === 2) { x = u; y = -0.5; z = v }  // -Y
    else if (face === 3) { x = u; y = 0.5; z = v }   // +Y
    else if (face === 4) { x = u; y = v; z = -0.5 }  // -Z
    else { x = u; y = v; z = 0.5 }                   // +Z
    out.push(
      cx + x * w + (rand() - 0.5) * jitter,
      cy + y * h + (rand() - 0.5) * jitter,
      cz + z * d + (rand() - 0.5) * jitter,
    )
  }
}

/** Sample a vertical wall plane with patchy coverage (simulates SLAM gaps) */
function sampleWall(rand, axis, fixed, len, height, count, jitter, out) {
  for (let i = 0; i < count; i++) {
    if (rand() < 0.25) continue // coverage gaps
    const along = (rand() - 0.5) * len
    const y = rand() * height
    const x = axis === 'x' ? fixed : along
    const z = axis === 'x' ? along : fixed
    out.push(
      x + (rand() - 0.5) * jitter,
      y + (rand() - 0.5) * jitter,
      z + (rand() - 0.5) * jitter,
    )
  }
}

function buildHomeGlb(home) {
  const rand = mulberry32(0xBEEF + home.index * 104729)
  const [W, H, D] = home.dims
  const jitter = 0.03

  // ── Point cloud ─────────────────────────────────────────────────────────
  const pts = []
  const floorCount = Math.floor(home.pointTarget * 0.3)
  for (let i = 0; i < floorCount; i++) {
    pts.push((rand() - 0.5) * W, rand() * 0.02, (rand() - 0.5) * D)
  }
  const wallCount = Math.floor(home.pointTarget * 0.12)
  sampleWall(rand, 'x', -W / 2, D, H, wallCount, jitter, pts)
  sampleWall(rand, 'x', W / 2, D, H, wallCount, jitter, pts)
  sampleWall(rand, 'z', -D / 2, W, H, wallCount, jitter, pts)
  sampleWall(rand, 'z', D / 2, W, H, wallCount, jitter, pts)
  for (const item of home.furniture) {
    const [cx, cy, cz] = item.position
    const [w, h, d] = item.size
    const density = Math.max(300, Math.floor(w * h * d * 4500))
    sampleBox(rand, cx, cy, cz, w, h, d, density, jitter * 0.6, pts)
  }

  const count = Math.floor(pts.length / 3)
  const positions = new Float32Array(pts)
  // Height heatmap colours (matches the mobile exporter)
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const t = Math.max(0, Math.min(1, positions[i * 3 + 1] / H))
    colors[i * 3] = t
    colors[i * 3 + 1] = 1 - Math.abs(t * 2 - 1)
    colors[i * 3 + 2] = 1 - t
  }

  // ── Document assembly ───────────────────────────────────────────────────
  const doc = new Document()
  const buffer = doc.createBuffer()
  const scene = doc.createScene('room-scan')

  const sessionId = `session-test-home-${String(home.index).padStart(2, '0')}`
  scene.setExtras({
    generator: 'ci-xr-scan-test-data',
    version: '2.0',
    capturedAt: FIXED_TIMESTAMP,
    sessionId,
    scanName: home.name,
    floorName: 'Floor_Ground',
    roomName: `Room_${home.slug}`,
    pointCount: count,
    detectionCount: home.furniture.length,
    boundingBox: {
      min: { x: -W / 2, y: 0, z: -D / 2 },
      max: { x: W / 2, y: H, z: D / 2 },
    },
    floorY: 0,
    geoLat: home.geo.lat,
    geoLng: home.geo.lng,
    geoBearing: home.geo.bearing,
    geoAddress: home.geo.address,
    geoFixedAt: FIXED_TIMESTAMP,
  })

  const roomNode = doc.createNode(`Room_${home.slug}`)
    .setExtras({ type: 'room', roomName: `Room_${home.slug}`, floorName: 'Floor_Ground' })
  const floorGroup = doc.createNode('Floor_Ground')
    .setExtras({ type: 'floor', floorName: 'Floor_Ground' })
  floorGroup.addChild(roomNode)
  scene.addChild(floorGroup)

  // Point cloud (mode 0 = POINTS)
  const posAcc = doc.createAccessor('positions').setType('VEC3').setArray(positions).setBuffer(buffer)
  const colAcc = doc.createAccessor('colors').setType('VEC3').setArray(colors).setBuffer(buffer)
  const cloudPrim = doc.createPrimitive().setMode(0)
    .setAttribute('POSITION', posAcc).setAttribute('COLOR_0', colAcc)
  const cloudNode = doc.createNode('point-cloud')
    .setMesh(doc.createMesh('point-cloud').addPrimitive(cloudPrim))
    .setExtras({ type: 'slam_feature_points', count })
  roomNode.addChild(cloudNode)

  // Camera path (mode 3 = LINE_STRIP): elliptical walk at eye height
  const pathSteps = 48
  const path = new Float32Array(pathSteps * 3)
  for (let i = 0; i < pathSteps; i++) {
    const a = (i / pathSteps) * Math.PI * 2
    path[i * 3] = Math.cos(a) * W * 0.3
    path[i * 3 + 1] = 1.5 + Math.sin(a * 3) * 0.05
    path[i * 3 + 2] = Math.sin(a) * D * 0.3
  }
  const pathAcc = doc.createAccessor('path').setType('VEC3').setArray(path).setBuffer(buffer)
  const pathPrim = doc.createPrimitive().setMode(3).setAttribute('POSITION', pathAcc)
  roomNode.addChild(doc.createNode('camera-path')
    .setMesh(doc.createMesh('camera-path').addPrimitive(pathPrim))
    .setExtras({ type: 'camera_trajectory', poseCount: pathSteps }))

  // Floor plane (two triangles)
  const fw = W / 2 + 0.4, fd = D / 2 + 0.4
  const floorVerts = new Float32Array([-fw, 0, -fd, fw, 0, -fd, fw, 0, fd, -fw, 0, fd])
  const floorIdx = new Uint16Array([0, 2, 1, 0, 3, 2])
  const floorMat = doc.createMaterial('floor-mat')
    .setBaseColorFactor([0.15, 0.19, 0.22, 0.45]).setAlphaMode('BLEND').setDoubleSided(true)
  const floorPrim = doc.createPrimitive().setMode(4)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(floorVerts).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(floorIdx).setBuffer(buffer))
    .setMaterial(floorMat)
  roomNode.addChild(doc.createNode('floor-plane')
    .setMesh(doc.createMesh('floor-plane').addPrimitive(floorPrim))
    .setExtras({ objectType: 'estimated_floor', tag: 'floor', y: 0, widthM: fw * 2, depthM: fd * 2 }))

  // Detection boxes
  const detectionsNode = doc.createNode('detections').setExtras({ type: 'detections' })
  roomNode.addChild(detectionsNode)
  const cube = unitCube(doc, buffer)
  home.furniture.forEach((item, i) => {
    const name = `${item.label}_${String(i + 1).padStart(3, '0')}`
    const mat = doc.createMaterial(`${name}-mat`)
      .setBaseColorFactor([item.rgb[0] / 255, item.rgb[1] / 255, item.rgb[2] / 255, 0.3])
      .setAlphaMode('BLEND').setDoubleSided(true)
    const prim = doc.createPrimitive().setMode(4)
      .setAttribute('POSITION', cube.pos).setIndices(cube.idx).setMaterial(mat)
    const node = doc.createNode(name)
      .setMesh(doc.createMesh(name).addPrimitive(prim))
      .setTranslation(item.position)
      .setScale(item.size)
      .setExtras({
        objectId: name,
        objectType: 'detection',
        label: item.label,
        tag: item.label,
        confidence: item.confidence,
        description: `test fixture ${item.label} (${home.name})`,
        worldPos: { x: item.position[0], y: item.position[1], z: item.position[2] },
        dimensions: { w: item.size[0], h: item.size[1], d: item.size[2] },
        sourceScanIds: [sessionId],
      })
    detectionsNode.addChild(node)
  })

  return doc
}

/** Shared unit cube accessors (scaled per detection via node transforms) */
function unitCube(doc, buffer) {
  const v = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ])
  const idx = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ])
  return {
    pos: doc.createAccessor('cube-pos').setType('VEC3').setArray(v).setBuffer(buffer),
    idx: doc.createAccessor('cube-idx').setType('SCALAR').setArray(idx).setBuffer(buffer),
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const index = []
const expected = {}
let totalBytes = 0

for (const home of homes) {
  const baseName = `home-${String(home.index).padStart(2, '0')}-${home.slug}`
  const doc = buildHomeGlb(home)
  const glb = await io.writeBinary(doc)
  writeFileSync(join(outDir, `${baseName}.glb`), glb)
  totalBytes += glb.byteLength

  const labels = home.furniture.map((f) => f.label)
  const meta = {
    sessionId: `session-test-home-${String(home.index).padStart(2, '0')}`,
    scanName: home.name,
    detectionCount: home.furniture.length,
    labels,
    pointCount: Math.floor(home.pointTarget),
    exportedAt: FIXED_TIMESTAMP,
    capturedAt: FIXED_TIMESTAMP,
    geoLat: home.geo.lat,
    geoLng: home.geo.lng,
    geoBearing: home.geo.bearing,
    geoAddress: home.geo.address,
    geoFixedAt: FIXED_TIMESTAMP,
  }
  writeFileSync(join(outDir, `${baseName}.meta.json`), JSON.stringify(meta, null, 2))

  index.push({
    file: `${baseName}.glb`,
    meta: `${baseName}.meta.json`,
    name: home.name,
    slug: home.slug,
    bytes: glb.byteLength,
    detections: home.furniture.length,
  })
  expected[baseName] = {
    name: home.name,
    dims: home.dims,
    furniture: home.furniture.map(({ label, position, size, confidence }) => ({ label, position, size, confidence })),
    labels,
  }
  console.log(`  ${baseName}.glb  ${(glb.byteLength / 1024).toFixed(0)} KB  ${home.furniture.length} detections`)
}

writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2))
writeFileSync(join(outDir, 'expected.json'), JSON.stringify(expected, null, 2))
console.log(`\n[test-homes] ${homes.length} homes → ${outDir} (${(totalBytes / 1024 / 1024).toFixed(1)} MB total)`)
