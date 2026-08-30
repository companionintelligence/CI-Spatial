/**
 * Convert a sparse-reconstruction binary PLY into a GLB POINTS primitive so the
 * reconstruction can be loaded by the existing desktop viewer pipeline
 * (GLTFLoader + DRACO + KHR_mesh_quantization) without a custom PLY decoder.
 *
 * The output GLB carries:
 *   - one mesh / one POINTS primitive with POSITION (+ optional COLOR_0)
 *   - one node tagged `type: 'slam_feature_points'` carrying node-level
 *     provenance (`NODE_PROVENANCE_KEYS`), the same tag and the same keys
 *     `src/export/gltf.ts` puts on a client-exported cloud
 *   - scene extras with the same provenance, for readers that look there
 *   - asset.extras.pointCloud = { source, pointCount, poseCount, … }
 *
 * Two producers write that PLY layout: the LingBot-Map worker and COLMAP
 * (`server/colmap/colmap_model.ts`'s `pointsToPly` emits byte-identical
 * `float x/y/z + uchar red/green/blue`). One writer serves both rather than a
 * second GLB writer being forked for COLMAP (ADR 0001) — hence `extras.source`.
 *
 * After quantization the PLY -> GLB conversion is roughly half the original
 * PLY's byte size, and the result loads in three.js without a Draco decoder
 * (point primitives are not Draco-compressible per the KHR spec).
 */
import { Document, NodeIO, Primitive } from '@gltf-transform/core'
import { KHRMeshQuantization } from '@gltf-transform/extensions'
import { prune, quantize } from '@gltf-transform/functions'

import { parseLingBotMapPLY } from '../../src/shared/lingbot_map_ply.ts'
import type { ScanProvenance } from '../../src/shared/provenance.ts'

export interface LingBotMapGlbExtras {
  /**
   * Which producer solved the cloud. Not cosmetic: it names the node, the mesh
   * and the scene, so a merged document says which pipeline each cloud came
   * from without consulting a sidecar.
   */
  source: 'lingbot-map' | 'colmap'
  pointCount: number
  poseCount: number
  sessionId: string
  manifestPath: string
  /**
   * Node-level provenance, written onto the point-cloud NODE (never onto the
   * mesh, primitive or accessors — see NODE_PROVENANCE_KEYS' header: those five
   * are the optimize pass's dedup candidates, so a key parked on one would let
   * two walkthroughs of the same room cross-attribute their geometry).
   * `scanId` is optional for the same reason it is optional on `ScanProvenance`:
   * only the server knows it, and only once the scan has a stored filename.
   */
  scanId?: string
  /** ISO-8601 capture time. Defaults to now when the caller has none. */
  capturedAt?: string
}

export interface LingBotMapGlbOptions {
  /**
   * Quantize POSITION/COLOR_0 (default true — what the LingBot-Map sidecar has
   * always done).
   *
   * Pass false for a cloud that IS the scan's GLB rather than a preview sidecar.
   * Quantization moves the metric scale out of the accessor and into the node's
   * TRS, which is correct glTF and which every transform-aware reader handles
   * (three.js, and `panoptic_lift.ts`'s `collectPointPositions`, which composes
   * the node matrix and calls `getElement`). A reader that takes the accessor at
   * face value does not: `scripts/audit-scan-glb.mjs` reported the 9362-point
   * COLMAP cloud from sess-video-20260830-033839 as spanning
   * 58430 x 35692 x 65534 m — the int16 range — where the float positions span
   * 18.93 x 11.56 x 21.23. For a 9k-point sparse cloud the saving that buys is
   * ~115 KB, which is not worth making the canonical artifact's coordinates
   * unreadable without the node transform.
   */
  quantize?: boolean
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
  options: LingBotMapGlbOptions = {},
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

  // `sessionId: string | null` on purpose — that is `ScanProvenance`'s own
  // shape, and an empty string would claim a session that does not exist.
  const provenance: ScanProvenance = {
    sessionId: extras.sessionId || null,
    capturedAt: extras.capturedAt ?? new Date().toISOString(),
    ...(extras.scanId ? { scanId: extras.scanId } : {}),
  }

  const mesh = doc.createMesh(`${extras.source}-points`).addPrimitive(prim)
  const node = doc.createNode(extras.source).setMesh(mesh)
  // `slam_feature_points` is the tag src/export/gltf.ts already puts on a
  // client-exported cloud, and what the viewer's point layer and
  // scripts/audit-scan-glb.mjs both look for. A sparse SfM cloud is the same
  // kind of thing from a different solver, so it reuses the tag (ADR 0001)
  // rather than introducing a second name for "the point cloud".
  node.setExtras({ type: 'slam_feature_points', count: parsed.count, ...provenance })
  const scene = doc.createScene(`${extras.source}-scene`).addChild(node)

  // `pointCount` is written from the parse, not from the caller: the caller
  // passes what it believes the worker produced, and the LingBot-Map path has
  // always passed 0 there. The parsed count is the one that describes the bytes
  // in this file.
  const written = { ...extras, pointCount: parsed.count }
  doc.getRoot().setExtras({
    pointCloud: written,
    // Back-compat: `lingbotMap` is the key every GLB written before COLMAP
    // reused this writer carries. Kept for the source that has always written
    // it so an existing reader keeps working; not extended to COLMAP, where the
    // name would be a lie.
    ...(extras.source === 'lingbot-map' ? { lingbotMap: written } : {}),
  })
  scene.setExtras({ ...provenance, source: extras.source })

  let quantized = false
  if (options.quantize ?? true) {
    quantized = true
    try {
      await doc.transform(prune(), quantize({ quantizePosition: 14, quantizeColor: 8 }))
    } catch {
      quantized = false
    }
  } else {
    await doc.transform(prune())
  }
  const bytes = await io.writeBinary(doc)
  return { bytes, pointCount: parsed.count, quantized }
}
