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
