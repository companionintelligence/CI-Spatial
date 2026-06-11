/**
 * Pipeline smoke test — runs under plain Node (type stripping), no AR
 * hardware or model files needed:
 *
 *   node scripts/smoke-pipeline.mjs
 *
 * Builds a synthetic scan GLB (point cloud + triangle box, mirroring what the
 * mobile exporter produces), runs pipeline.ts on it, and asserts that the
 * optimized artifact + LODs come back smaller, loadable, and stat-consistent.
 */
import assert from 'node:assert/strict'
import { Document, NodeIO } from '@gltf-transform/core'
import { KHRDracoMeshCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import draco3d from 'draco3dgltf'
import { optimizeScan } from '../pipeline.ts'

const POINT_COUNT = 20_000

function buildSyntheticScan() {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const scene = doc.createScene('room-scan')

  // Point cloud — clustered in a 4×2.5×4 m "room" so voxel LODs actually reduce
  const positions = new Float32Array(POINT_COUNT * 3)
  const colors = new Float32Array(POINT_COUNT * 3)
  for (let i = 0; i < POINT_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 4
    positions[i * 3 + 1] = Math.random() * 2.5
    positions[i * 3 + 2] = (Math.random() - 0.5) * 4
    colors[i * 3] = Math.random()
    colors[i * 3 + 1] = Math.random()
    colors[i * 3 + 2] = Math.random()
  }
  const posAcc = doc.createAccessor('positions').setType('VEC3').setArray(positions).setBuffer(buffer)
  const colAcc = doc.createAccessor('colors').setType('VEC3').setArray(colors).setBuffer(buffer)
  const pointsPrim = doc.createPrimitive().setMode(0 /* POINTS */)
    .setAttribute('POSITION', posAcc).setAttribute('COLOR_0', colAcc)
  const pointsMesh = doc.createMesh('point-cloud').addPrimitive(pointsPrim)
  scene.addChild(doc.createNode('point-cloud').setMesh(pointsMesh))

  // Detection box — 8-vertex indexed cube (12 triangles)
  const v = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ])
  const idx = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ])
  const boxPos = doc.createAccessor('box-pos').setType('VEC3').setArray(v).setBuffer(buffer)
  const boxIdx = doc.createAccessor('box-idx').setType('SCALAR').setArray(idx).setBuffer(buffer)
  const boxPrim = doc.createPrimitive().setMode(4 /* TRIANGLES */)
    .setAttribute('POSITION', boxPos).setIndices(boxIdx)
  const boxMesh = doc.createMesh('chair_001').addPrimitive(boxPrim)
  const boxNode = doc.createNode('chair_001').setMesh(boxMesh).setTranslation([1, 0, 1])
  boxNode.setExtras({ label: 'chair', confidence: 0.92 })
  scene.addChild(boxNode)

  return doc
}

const io = new NodeIO()
const source = await io.writeBinary(buildSyntheticScan())
console.log(`[smoke] synthetic scan: ${(source.byteLength / 1024).toFixed(0)} KB, ${POINT_COUNT} pts`)

const result = await optimizeScan(source, { lodMinPoints: 1000 })

console.log('\n[smoke] stages:')
for (const s of result.stages) {
  console.log(`  ${s.ok ? '✓' : '✗'} ${s.name} (${s.ms}ms)${s.note ? ` — ${s.note}` : ''}`)
}
console.log('\n[smoke] stats:', result.stats)
console.log(`[smoke] optimized: ${(result.optimized.bytes.byteLength / 1024).toFixed(0)} KB` +
  ` (draco=${result.optimized.draco}, quantized=${result.optimized.quantized})`)
for (const lod of result.lods) {
  console.log(`[smoke] lod@${lod.voxelM}m: ${(lod.bytes.byteLength / 1024).toFixed(0)} KB, ${lod.points} pts`)
}

// ── Assertions ────────────────────────────────────────────────────────────────
assert.equal(result.stats.points, POINT_COUNT, 'point count stat')
assert.equal(result.stats.triangles, 12, 'triangle count stat')
assert.ok(result.optimized.bytes.byteLength < source.byteLength, 'optimized smaller than source')
assert.ok(result.lods.length === 2, 'two LODs generated')
assert.ok(result.lods.every((l) => l.points > 0 && l.points < POINT_COUNT), 'LODs decimated')
assert.ok(result.lods.every((l) => l.bytes.byteLength < result.optimized.bytes.byteLength), 'LODs smaller than optimized')
assert.ok(result.stages.every((s) => s.ok), `all stages ok (${result.stages.filter(s => !s.ok).map(s => s.name)})`)

// Round-trip: every artifact must be loadable (as the viewer's GLTFLoader will)
const readIO = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression, KHRMeshQuantization])
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule({}) })
for (const [name, bytes] of [
  ['optimized', result.optimized.bytes],
  ...result.lods.map((l, i) => [`lod${i}`, l.bytes]),
]) {
  const reread = await readIO.readBinary(bytes)
  assert.ok(reread.getRoot().listMeshes().length >= 2, `${name} round-trips with meshes intact`)
}

const ratio = Math.round((result.optimized.bytes.byteLength / source.byteLength) * 100)
console.log(`\n[smoke] PASS — optimized is ${ratio}% of source, all artifacts round-trip\n`)
