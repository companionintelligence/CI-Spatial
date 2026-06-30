/**
 * Convert a LingBot-Map binary PLY into a GLB POINTS primitive so the
 * reconstruction can be loaded by the existing desktop viewer pipeline
 * (GLTFLoader + DRACO + KHR_mesh_quantization) without a custom PLY decoder.
 *
 * The output GLB carries:
 *   - one mesh / one POINTS primitive with POSITION (+ optional COLOR_0)
 *   - one node named "lingbot-map" with a single asset extra
 *   - asset.extras.lingbotMap = { sourceManifest, pointCount, poseCount }
 *
 * After quantization the PLY -> GLB conversion is roughly half the original
 * PLY's byte size, and the result loads in three.js without a Draco decoder
 * (point primitives are not Draco-compressible per the KHR spec).
 */
import { Document, NodeIO, Primitive } from '@gltf-transform/core'
import { KHRMeshQuantization } from '@gltf-transform/extensions'
import { prune, quantize } from '@gltf-transform/functions'

import { parseLingBotMapPLY } from './lingbot_map_ply.ts'

export interface LingBotMapGlbExtras {
  source: 'lingbot-map'
  pointCount: number
  poseCount: number
  sessionId: string
  manifestPath: string
}

export interface LingBotMapGlbResult {
  bytes: Uint8Array
  pointCount: number
  quantized: boolean
}

let ioPromise: Promise<NodeIO> | null = null

async function getIO(): Promise<NodeIO> {
  ioPromise ??= (async () => {
    return new NodeIO().registerExtensions([KHRMeshQuantization])
  })()
  return ioPromise
}

export async function buildLingBotMapGlb(
  ply: Uint8Array,
  extras: LingBotMapGlbExtras,
): Promise<LingBotMapGlbResult> {
  const parsed = parseLingBotMapPLY(ply)
  const io = await getIO()
  const doc = new Document()
  doc.createBuffer()

  // Copy into freshly-allocated typed arrays so the underlying ArrayBuffer
  // satisfies @gltf-transform's `ArrayBuffer` (not `ArrayBufferLike`) constraint.
  const xyzOwned = new Float32Array(parsed.xyz.length)
  xyzOwned.set(parsed.xyz)
  const positionAcc = doc.createAccessor('POSITION')
    .setType('VEC3')
    .setArray(xyzOwned)
    .setBuffer(doc.getRoot().listBuffers()[0])

  const prim = doc.createPrimitive()
    .setMode(Primitive.Mode.POINTS)
    .setAttribute('POSITION', positionAcc)

  if (parsed.rgb) {
    const colors = new Float32Array(parsed.count * 3)
    for (let i = 0; i < colors.length; i++) colors[i] = parsed.rgb[i] / 255
    const colorAcc = doc.createAccessor('COLOR_0')
      .setType('VEC3')
      .setArray(colors)
      .setBuffer(doc.getRoot().listBuffers()[0])
    prim.setAttribute('COLOR_0', colorAcc)
  }

  const mesh = doc.createMesh('lingbot-map-points').addPrimitive(prim)
  const node = doc.createNode('lingbot-map').setMesh(mesh)
  doc.createScene('lingbot-map-scene').addChild(node)

  doc.getRoot().setExtras({ lingbotMap: extras })

  let quantized = true
  try {
    await doc.transform(prune(), quantize({ quantizePosition: 14, quantizeColor: 8 }))
  } catch {
    quantized = false
  }
  const bytes = await io.writeBinary(doc)
  return { bytes, pointCount: parsed.count, quantized }
}
