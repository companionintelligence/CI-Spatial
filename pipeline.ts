/**
 * Scan optimization pipeline — bytes in, bytes out.
 *
 * Takes a raw .glb exported by the mobile app and produces web-optimized
 * artifacts:
 *
 *   optimized  — dedup + prune + KHR_mesh_quantization (+ Draco on triangle
 *                meshes when possible).  Loads in three.js GLTFLoader with a
 *                DRACOLoader attached; quantization needs no decoder at all.
 *   lods[]     — coarse preview variants with the SLAM point cloud voxel-
 *                downsampled (e.g. 12 cm / 30 cm cells).  The viewer loads the
 *                coarsest LOD first, then swaps in the optimized full scan.
 *
 * KTX2 texture compression is intentionally absent: scan GLBs currently carry
 * no textures.  The `stats.textures` count is recorded so a KTX2 stage can be
 * gated on it when textured reconstruction meshes arrive.
 *
 * This module is runtime-agnostic (no Deno/Node globals) so the same code runs
 * in the Deno server and under Node for tests (`npm run smoke:pipeline`).
 */
import { Document, NodeIO, Primitive, type Accessor } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRDracoMeshCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { cloneDocument, dedup, prune, quantize, draco } from '@gltf-transform/functions'
// @ts-ignore — draco3dgltf ships no type declarations
import draco3d from 'draco3dgltf'

export interface PipelineStageLog {
  name: string
  ok: boolean
  ms: number
  note?: string
}

export interface PipelineArtifact {
  bytes: Uint8Array
  /** Point count after downsampling (LOD artifacts only) */
  points?: number
  /** Voxel cell size used for downsampling (LOD artifacts only) */
  voxelM?: number
  draco: boolean
  quantized: boolean
}

export interface PipelineStats {
  sourceBytes: number
  points: number
  triangles: number
  meshes: number
  nodes: number
  textures: number
}

export interface PipelineResult {
  optimized: PipelineArtifact
  /** Ordered coarsest-first: lods[0] is the fastest preview */
  lods: PipelineArtifact[]
  stats: PipelineStats
  stages: PipelineStageLog[]
}

export interface PipelineOptions {
  /** Voxel sizes (metres) for point-cloud LODs, coarsest first. Default [0.30, 0.12]. */
  lodVoxelsM?: number[]
  /** Skip LOD generation when the cloud has fewer points than this. Default 5000. */
  lodMinPoints?: number
}

const DEFAULT_LOD_VOXELS_M = [0.3, 0.12]
const DEFAULT_LOD_MIN_POINTS = 5000

// IO + Draco WASM modules are expensive to initialise — do it once per process.
let ioPromise: Promise<NodeIO> | null = null

function getIO(): Promise<NodeIO> {
  ioPromise ??= (async () => {
    const [encoder, decoder] = await Promise.all([
      draco3d.createEncoderModule({}),
      draco3d.createDecoderModule({}),
    ])
    // ALL_EXTENSIONS, not just the two this pipeline writes: glTF-Transform
    // discards any extension the IO has not registered, silently, at read time.
    // Registering only Draco and mesh-quantization meant every other extension
    // in a scan was dropped on the way through — KHR_materials_unlit sat on 10
    // of 19 materials in a real capture (the floor plane and every detection
    // wireframe) and was absent from the optimized file's extensionsUsed, so
    // those surfaces silently switched from flat to lit shading. Draco and
    // quantization are both in ALL_EXTENSIONS, so this is a superset.
    return new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'draco3d.encoder': encoder, 'draco3d.decoder': decoder })
  })()
  return ioPromise
}

export async function optimizeScan(
  glb: Uint8Array,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const lodVoxelsM = opts.lodVoxelsM ?? DEFAULT_LOD_VOXELS_M
  const lodMinPoints = opts.lodMinPoints ?? DEFAULT_LOD_MIN_POINTS
  const stages: PipelineStageLog[] = []
  const io = await getIO()

  const doc = await stage(stages, 'parse', () => io.readBinary(glb))
  const stats: PipelineStats = { ...collectStats(doc), sourceBytes: glb.byteLength }

  // ── Clean-up passes (shared by all artifacts) ──────────────────────────────
  await stage(stages, 'dedup+prune', async () => {
    await doc.transform(dedup(), prune())
  })

  // ── Point-cloud LODs — built BEFORE quantization while positions are still
  //    plain float32 in node-local space ──────────────────────────────────────
  const lods: PipelineArtifact[] = []
  if (stats.points >= lodMinPoints) {
    for (const voxelM of lodVoxelsM) {
      try {
        const t0 = Date.now()
        const lodDoc = cloneDocument(doc)
        const remaining = downsamplePointPrimitives(lodDoc, voxelM)
        await lodDoc.transform(prune(), quantize({ quantizePosition: 14, quantizeColor: 8 }))
        const bytes = await io.writeBinary(lodDoc)
        lods.push({ bytes, points: remaining, voxelM, draco: false, quantized: true })
        stages.push({ name: `lod@${voxelM}m`, ok: true, ms: Date.now() - t0, note: `${remaining} pts` })
      } catch (e) {
        stages.push({ name: `lod@${voxelM}m`, ok: false, ms: 0, note: errMsg(e) })
      }
    }
  } else {
    stages.push({
      name: 'lods', ok: true, ms: 0,
      note: `skipped — ${stats.points} pts < ${lodMinPoints} threshold`,
    })
  }

  // ── Quantize the full-quality document ─────────────────────────────────────
  await stage(stages, 'quantize', async () => {
    await doc.transform(quantize({ quantizePosition: 14, quantizeColor: 8, quantizeNormal: 8 }))
  })
  let optimizedBytes = await io.writeBinary(doc)
  let usedDraco = false

  // ── Draco — only meaningful when triangle meshes exist.  The KHR extension
  //    is defined for triangles, so point primitives are never compressed.
  //    Guarded: any encoder failure falls back to the quantized-only bytes. ──
  if (stats.triangles > 0) {
    try {
      const t0 = Date.now()
      const dracoDoc = cloneDocument(doc)
      await dracoDoc.transform(draco({ method: 'edgebreaker' }))
      const bytes = await io.writeBinary(dracoDoc)
      if (bytes.byteLength < optimizedBytes.byteLength) {
        optimizedBytes = bytes
        usedDraco = true
      }
      stages.push({
        name: 'draco', ok: true, ms: Date.now() - t0,
        note: usedDraco ? `${bytes.byteLength} bytes` : 'kept quantized-only (smaller)',
      })
    } catch (e) {
      stages.push({ name: 'draco', ok: false, ms: 0, note: errMsg(e) })
    }
  }

  // An extension the IO cannot round-trip disappears without raising anything,
  // and the symptom (surfaces shading differently) never points back here. Say
  // so instead — a vendor extension outside ALL_EXTENSIONS still drops.
  const keptExtensions = declaredExtensions(optimizedBytes)
  const lostExtensions = declaredExtensions(glb).filter((ext) => !keptExtensions.includes(ext))
  if (lostExtensions.length > 0) {
    stages.push({ name: 'extensions', ok: false, ms: 0, note: `dropped ${lostExtensions.join(', ')}` })
    console.warn(`[pipeline] optimization dropped glTF extension(s): ${lostExtensions.join(', ')}`)
  }

  return {
    optimized: { bytes: optimizedBytes, draco: usedDraco, quantized: true },
    lods,
    stats,
    stages,
  }
}

/**
 * `extensionsUsed` straight from a GLB's JSON chunk.
 *
 * Deliberately not a glTF parse: this has to report what the *file* declares,
 * including extensions the IO would discard on read — which is the whole point.
 * Returns nothing for a malformed file rather than throwing; this runs on the
 * reporting path, and a parse problem will surface with better context above.
 */
function declaredExtensions(glb: Uint8Array): string[] {
  try {
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
    const jsonLength = view.getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)))
    return Array.isArray(json.extensionsUsed) ? json.extensionsUsed : []
  } catch {
    return []
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function stage<T>(
  log: PipelineStageLog[],
  name: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const t0 = Date.now()
  try {
    const result = await fn()
    log.push({ name, ok: true, ms: Date.now() - t0 })
    return result
  } catch (e) {
    log.push({ name, ok: false, ms: Date.now() - t0, note: errMsg(e) })
    throw e
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function collectStats(doc: Document): Omit<PipelineStats, 'sourceBytes'> {
  const root = doc.getRoot()
  let points = 0
  let triangles = 0
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const count = prim.getAttribute('POSITION')?.getCount() ?? 0
      if (prim.getMode() === Primitive.Mode.POINTS) {
        points += count
      } else if (prim.getMode() === Primitive.Mode.TRIANGLES) {
        triangles += Math.floor((prim.getIndices()?.getCount() ?? count) / 3)
      }
    }
  }
  return {
    points,
    triangles,
    meshes: root.listMeshes().length,
    nodes: root.listNodes().length,
    textures: root.listTextures().length,
  }
}

/**
 * Voxel-downsample every POINTS primitive in the document (first point per
 * cell wins, matching the mobile accumulator).  Positions are assumed to be
 * metres in node-local ≈ world space, which holds for scans produced by the
 * app's exporter (identity node transforms).
 *
 * Returns the total remaining point count across all POINTS primitives.
 */
function downsamplePointPrimitives(doc: Document, voxelM: number): number {
  let remaining = 0
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()

  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== Primitive.Mode.POINTS) continue
      const posAcc = prim.getAttribute('POSITION')
      if (!posAcc) continue

      const pos = posAcc.getArray() as Float32Array
      const count = posAcc.getCount()
      const keep: number[] = []
      const occupied = new Set<string>()
      for (let i = 0; i < count; i++) {
        const key =
          `${Math.round(pos[i * 3] / voxelM)},` +
          `${Math.round(pos[i * 3 + 1] / voxelM)},` +
          `${Math.round(pos[i * 3 + 2] / voxelM)}`
        if (occupied.has(key)) continue
        occupied.add(key)
        keep.push(i)
      }

      prim.setAttribute('POSITION', subsetAccessor(doc, buffer, posAcc, keep))
      for (const semantic of prim.listSemantics()) {
        if (semantic === 'POSITION') continue
        const acc = prim.getAttribute(semantic)
        if (acc) prim.setAttribute(semantic, subsetAccessor(doc, buffer, acc, keep))
      }
      remaining += keep.length
    }
  }
  return remaining
}

/** Create a new accessor containing only the given element indices. */
function subsetAccessor(
  doc: Document,
  buffer: ReturnType<Document['createBuffer']>,
  acc: Accessor,
  keep: number[],
): Accessor {
  const elementSize = acc.getElementSize()
  const src = acc.getArray()!
  const ArrayCtor = src.constructor as new (len: number) => typeof src
  const dst = new ArrayCtor(keep.length * elementSize)
  for (let k = 0; k < keep.length; k++) {
    const s = keep[k] * elementSize
    for (let c = 0; c < elementSize; c++) dst[k * elementSize + c] = src[s + c]
  }
  return doc
    .createAccessor(acc.getName())
    .setType(acc.getType())
    .setNormalized(acc.getNormalized())
    .setArray(dst)
    .setBuffer(buffer)
}
