/**
 * End-to-end test for the PLY → GLB sidecar pipeline. Builds a synthetic
 * binary PLY (16 RGB points), runs the converter, asserts the GLB header is
 * valid, and round-trips back through gltf-transform to confirm the POINTS
 * primitive shape — XYZ + COLOR_0 — survives quantisation.
 *
 * Runs under Node because @gltf-transform/functions depends on `sharp`,
 * whose native binary is npm-installed (not Deno-permissioned). Invoke via:
 *
 *     node --experimental-strip-types --test lingbot_map_glb.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NodeIO, Primitive } from '@gltf-transform/core'
import { KHRMeshQuantization } from '@gltf-transform/extensions'

import { buildLingBotMapGlb } from '../../../server/lingbot-map/lingbot_map_glb.ts'
import { parseLingBotMapPLY } from '../../../src/shared/lingbot_map_ply.ts'
import { NODE_PROVENANCE_KEYS } from '../../../src/shared/provenance.ts'

function syntheticPly(count: number, withRgb: boolean): Uint8Array {
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${count}`,
    'property float x',
    'property float y',
    'property float z',
    ...(withRgb ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
    'end_header\n',
  ].join('\n')
  const headerBytes = new TextEncoder().encode(header)
  const stride = withRgb ? 15 : 12
  const body = new Uint8Array(count * stride)
  const view = new DataView(body.buffer)
  for (let i = 0; i < count; i++) {
    const off = i * stride
    view.setFloat32(off + 0, i * 0.05, true)
    view.setFloat32(off + 4, Math.sin(i * 0.3) * 0.5, true)
    view.setFloat32(off + 8, Math.cos(i * 0.3) * 0.5, true)
    if (withRgb) {
      body[off + 12] = (i * 17) & 0xff
      body[off + 13] = (i * 31) & 0xff
      body[off + 14] = (i * 53) & 0xff
    }
  }
  const out = new Uint8Array(headerBytes.length + body.length)
  out.set(headerBytes, 0)
  out.set(body, headerBytes.length)
  return out
}

test('parseLingBotMapPLY reads XYZ + RGB blocks', () => {
  const ply = syntheticPly(8, true)
  const parsed = parseLingBotMapPLY(ply)
  assert.equal(parsed.count, 8)
  assert.ok(parsed.rgb !== null)
  assert.equal(parsed.xyz.length, 24)
  assert.equal(parsed.rgb!.length, 24)
  assert.equal(parsed.xyz[0], 0)
})

test('parseLingBotMapPLY rejects ASCII PLY', () => {
  const ascii = new TextEncoder().encode([
    'ply',
    'format ascii 1.0',
    'element vertex 1',
    'property float x',
    'property float y',
    'property float z',
    'end_header',
    '0 0 0',
  ].join('\n'))
  assert.throws(() => parseLingBotMapPLY(ascii))
})

test('buildLingBotMapGlb produces a valid glTF Binary file', async () => {
  const ply = syntheticPly(16, true)
  const result = await buildLingBotMapGlb(ply, {
    source: 'lingbot-map',
    pointCount: 16,
    poseCount: 0,
    sessionId: 'sess-test',
    manifestPath: '/tmp/none.json',
  })
  const dv = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength)
  assert.equal(dv.getUint32(0, true), 0x46546c67, 'glTF magic')
  assert.equal(dv.getUint32(4, true), 2, 'glTF version')
  assert.equal(dv.getUint32(8, true), result.bytes.byteLength, 'recorded length matches buffer length')
  assert.equal(result.pointCount, 16)

  const io = new NodeIO().registerExtensions([KHRMeshQuantization])
  const doc = await io.readBinary(result.bytes)
  const meshes = doc.getRoot().listMeshes()
  assert.equal(meshes.length, 1)
  const prim = meshes[0].listPrimitives()[0]
  assert.equal(prim.getMode(), Primitive.Mode.POINTS)
  const pos = prim.getAttribute('POSITION')
  assert.ok(pos !== null)
  assert.equal(pos!.getCount(), 16)
  const color = prim.getAttribute('COLOR_0')
  assert.ok(color !== null, 'COLOR_0 attribute should survive quantisation')

  const extras = doc.getRoot().getExtras() as Record<string, unknown>
  const lm = extras['lingbotMap'] as Record<string, unknown> | undefined
  assert.equal(lm?.sessionId, 'sess-test')
  assert.equal(lm?.source, 'lingbot-map')
})

test('buildLingBotMapGlb works without RGB block', async () => {
  const ply = syntheticPly(8, false)
  const result = await buildLingBotMapGlb(ply, {
    source: 'lingbot-map',
    pointCount: 8,
    poseCount: 0,
    sessionId: 'sess-test-no-rgb',
    manifestPath: '/tmp/none.json',
  })
  const io = new NodeIO().registerExtensions([KHRMeshQuantization])
  const doc = await io.readBinary(result.bytes)
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0]
  assert.equal(prim.getAttribute('COLOR_0'), null)
})

/**
 * The COLMAP path reuses this writer rather than forking one (ADR 0001):
 * `pointsToPly` in server/colmap/colmap_model.ts emits byte-identical
 * `float x/y/z + uchar rgb`, so only the extras differ. What must hold for the
 * result to be a *scan* GLB rather than a preview sidecar is checked here,
 * because these are the three things that were missing when a video-ingest scan
 * advertised geometry it did not have.
 */
test('a colmap scan GLB carries node-level provenance, and nothing else does', async () => {
  const ply = syntheticPly(64, true)
  const result = await buildLingBotMapGlb(ply, {
    source: 'colmap',
    pointCount: 64,
    poseCount: 32,
    sessionId: 'sess-video-20260830-033839',
    manifestPath: '/tmp/colmap-poses.manifest.json',
    scanId: 'scan-sess-video-20260830-033839',
    capturedAt: '2026-08-30T03:38:40.398Z',
  }, { quantize: false })

  const io = new NodeIO().registerExtensions([KHRMeshQuantization])
  const doc = await io.readBinary(result.bytes)
  const root = doc.getRoot()

  const nodes = root.listNodes()
  assert.equal(nodes.length, 1)
  const extras = nodes[0].getExtras() as Record<string, unknown>
  // The tag src/export/gltf.ts already uses for a cloud, so the viewer's point
  // layer and scripts/audit-scan-glb.mjs both recognise it.
  assert.equal(extras.type, 'slam_feature_points')
  assert.equal(extras.sessionId, 'sess-video-20260830-033839')
  assert.equal(extras.scanId, 'scan-sess-video-20260830-033839')
  assert.equal(extras.capturedAt, '2026-08-30T03:38:40.398Z')

  // The invariant NODE_PROVENANCE_KEYS' header states and audit-scan-glb.mjs
  // enforces: Mesh, Primitive, Accessor, Material and Texture are exactly the
  // optimize pass's dedup candidates, so a provenance key on any of them lets
  // two walkthroughs of one room cross-attribute their geometry.
  const containers = [
    ...root.listMeshes(),
    ...root.listMeshes().flatMap((mesh) => mesh.listPrimitives()),
    ...root.listAccessors(),
    ...root.listMaterials(),
    ...root.listTextures(),
  ]
  for (const item of containers) {
    const carried = NODE_PROVENANCE_KEYS.filter((key) => key in (item.getExtras() ?? {}))
    assert.deepEqual(carried, [], `${item.getName() || '(unnamed)'} must carry no provenance keys`)
  }

  // Scene-level metadata the audit and the editor both read.
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  const sceneExtras = scene.getExtras() as Record<string, unknown>
  assert.equal(sceneExtras.sessionId, 'sess-video-20260830-033839')
  assert.equal(sceneExtras.capturedAt, '2026-08-30T03:38:40.398Z')

  // `lingbotMap` would be a lie on a COLMAP cloud; `pointCloud` is the key that
  // describes what this file actually is, and it reports the parsed count
  // rather than whatever the caller believed.
  const rootExtras = root.getExtras() as Record<string, unknown>
  assert.equal(rootExtras.lingbotMap, undefined)
  const pc = rootExtras.pointCloud as Record<string, unknown>
  assert.equal(pc.source, 'colmap')
  assert.equal(pc.pointCount, 64)
  assert.equal(pc.poseCount, 32)
})

test('an unquantized cloud keeps its metric positions in the accessor', async () => {
  // Quantization moves the scale into the node TRS, which is correct glTF but
  // invisible to a reader that takes POSITION at face value:
  // scripts/audit-scan-glb.mjs read the 9362-point COLMAP cloud from
  // sess-video-20260830-033839 as spanning 58430 x 35692 x 65534 m — the int16
  // range — instead of 18.93 x 11.56 x 21.23. The scan's own GLB must not need
  // the node transform to report a sane room size.
  const ply = syntheticPly(64, true)
  const parsed = parseLingBotMapPLY(ply)
  const plain = await buildLingBotMapGlb(ply, {
    source: 'colmap',
    pointCount: 64,
    poseCount: 0,
    sessionId: 'sess-test',
    manifestPath: '/tmp/none.json',
  }, { quantize: false })
  assert.equal(plain.quantized, false)

  const io = new NodeIO().registerExtensions([KHRMeshQuantization])
  const doc = await io.readBinary(plain.bytes)
  assert.deepEqual(doc.getRoot().listExtensionsUsed().map((e) => e.extensionName), [])
  const node = doc.getRoot().listNodes()[0]
  assert.deepEqual(node.getMatrix(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  const arr = node.getMesh()!.listPrimitives()[0].getAttribute('POSITION')!.getArray()!
  const extentOf = (values: ArrayLike<number>, axis: number) => {
    let min = Infinity, max = -Infinity
    for (let i = axis; i < values.length; i += 3) {
      if (values[i] < min) min = values[i]
      if (values[i] > max) max = values[i]
    }
    return max - min
  }
  for (const axis of [0, 1, 2]) {
    assert.ok(
      Math.abs(extentOf(arr, axis) - extentOf(parsed.xyz, axis)) < 1e-4,
      `axis ${axis} extent must survive unchanged`,
    )
  }

  // The default is still the quantized sidecar the LingBot-Map path has always
  // written — this option opts out, it does not change the default.
  const quantized = await buildLingBotMapGlb(ply, {
    source: 'lingbot-map',
    pointCount: 64,
    poseCount: 0,
    sessionId: 'sess-test',
    manifestPath: '/tmp/none.json',
  })
  assert.equal(quantized.quantized, true)
  assert.ok(quantized.bytes.length < plain.bytes.length)
})
