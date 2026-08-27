/**
 * Audit a scan GLB — structure, geometry and provenance — without opening the editor.
 *
 *   node scripts/audit-scan-glb.mjs <file.glb|url>
 *   node scripts/audit-scan-glb.mjs --scan <scanId>          # via the running server
 *   node scripts/audit-scan-glb.mjs <file.glb> --json        # machine-readable
 *
 * Why this exists: "does the scan look right?" was previously only answerable by loading it in
 * the viewer and eyeballing it, which cannot see the things that actually break downstream —
 * empty primitives, NaN bounds, a missing floor plane, or provenance that failed to survive the
 * optimize pass. Those are exactly what the splat/COLMAP stages choke on later.
 *
 * Reuses the existing domain contract rather than inventing one (ADR 0001): NODE_PROVENANCE_KEYS
 * from src/shared/provenance.ts is the single source of truth for which keys must be present,
 * and for the node-only invariant checked below.
 */
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { NodeIO } from '@gltf-transform/core'
import { KHRDracoMeshCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import draco3d from 'draco3dgltf'
import { NODE_PROVENANCE_KEYS } from '../src/shared/provenance.ts'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const scanFlag = args.indexOf('--scan')
const positional = args.filter((a) => !a.startsWith('--'))
const SERVER = process.env.SERVER_URL ?? 'http://localhost:8000'

if (!positional.length) {
  console.error('usage: node scripts/audit-scan-glb.mjs <file.glb|url> [--json]')
  console.error('       node scripts/audit-scan-glb.mjs --scan <scanId> [--json]')
  process.exit(2)
}

const target = scanFlag !== -1
  ? `${SERVER}/scans/${positional[0]}`
  : positional[0]

async function loadBytes(src) {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src)
    if (!res.ok) throw new Error(`GET ${src} -> ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }
  return new Uint8Array(await readFile(src))
}

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression, KHRMeshQuantization])
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  })

const bytes = await loadBytes(target)
const doc = await io.readBinary(bytes)
const root = doc.getRoot()
const scene = root.getDefaultScene() ?? root.listScenes()[0]

const issues = []
const note = (severity, message) => issues.push({ severity, message })

/** Walk every node once; the tree is small enough that a flat list is simpler than recursion. */
const nodes = root.listNodes()

// ── Geometry ────────────────────────────────────────────────────────────────
// POINTS mode is 0 in glTF; anything else here is real surface geometry. The distinction
// matters because the splat/COLMAP stages want the point cloud, while the editor renders both.
const MODE_POINTS = 0
let pointVerts = 0
let triVerts = 0
let emptyPrims = 0
const modes = new Map()

for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION')
    const n = pos ? pos.getCount() : 0
    const mode = prim.getMode()
    modes.set(mode, (modes.get(mode) ?? 0) + n)
    if (n === 0) emptyPrims += 1
    if (mode === MODE_POINTS) pointVerts += n
    else triVerts += n

    // A NaN in POSITION poisons every downstream bound computation, and it survives silently
    // through the optimize pass — worth catching here rather than as an empty viewer.
    if (pos) {
      const arr = pos.getArray()
      if (arr && arr.some((v) => !Number.isFinite(v))) {
        note('error', `non-finite POSITION values in mesh "${mesh.getName() || '(unnamed)'}"`)
      }
    }
  }
}

if (pointVerts === 0) note('error', 'no POINTS geometry — the scan has no point cloud')
if (emptyPrims) note('warn', `${emptyPrims} primitive(s) have zero vertices`)

// ── Point-cloud extent ──────────────────────────────────────────────────────
// A room-sized capture that reports a 60m extent is not a big room, it is drift: tracking
// slipped and flung outliers across the map. It still looks plausible in the viewer (the cloud
// is centred and the labels sit on it), and it still passes every structural check above —
// but it destroys metric scale, so splat-align has nothing true to fit against and COLMAP
// inherits a garbage initialisation. Measured on a real gimbal dome, 2026-08-27: a single
// living-room capture reported 63.41 x 38.96 x 31.54 m.
const ROOM_EXTENT_SANITY_M = 30
let extent = null
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== MODE_POINTS) continue
    const pos = prim.getAttribute('POSITION')
    const arr = pos?.getArray()
    if (!arr) continue
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < arr.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = arr[i + a]
        if (!Number.isFinite(v)) continue
        if (v < min[a]) min[a] = v
        if (v > max[a]) max[a] = v
      }
    }
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    extent = { min, max, size }
  }
}
if (extent) {
  const [w, h, d] = extent.size
  const worst = Math.max(w, h, d)
  if (worst > ROOM_EXTENT_SANITY_M) {
    note('warn',
      `point cloud spans ${w.toFixed(1)} x ${h.toFixed(1)} x ${d.toFixed(1)} m — larger than a `
      + `room (> ${ROOM_EXTENT_SANITY_M}m on an axis). Usually tracking drift throwing outliers, `
      + 'which breaks metric scale for splat-align and COLMAP even though the scan looks fine in '
      + 'the viewer.')
  }
}

// ── Scene-level metadata ────────────────────────────────────────────────────
const sceneExtras = scene?.getExtras() ?? {}
for (const key of ['capturedAt', 'sessionId']) {
  if (!sceneExtras[key]) note('warn', `scene extras missing "${key}"`)
}

// ── Semantic nodes the pipeline expects ─────────────────────────────────────
const byType = new Map()
for (const node of nodes) {
  const t = node.getExtras()?.type ?? node.getExtras()?.objectType
  if (t) byType.set(t, (byType.get(t) ?? 0) + 1)
}
if (!byType.has('slam_feature_points')) note('warn', 'no node tagged slam_feature_points')
if (!byType.has('estimated_floor')) note('warn', 'no estimated_floor node — alignment has no ground reference')
if (!byType.has('camera_trajectory')) note('warn', 'no camera_trajectory node — no poses for splat-align to fit against')

// ── Detections ──────────────────────────────────────────────────────────────
const detections = nodes
  .filter((n) => (n.getExtras()?.objectType) === 'detection')
  .map((n) => {
    const e = n.getExtras() ?? {}
    return { name: n.getName(), label: e.label, confidence: e.confidence, sourceScanIds: e.sourceScanIds }
  })

for (const d of detections) {
  if (typeof d.confidence !== 'number' || d.confidence < 0 || d.confidence > 1) {
    note('warn', `detection "${d.name}" has out-of-range confidence: ${d.confidence}`)
  }
  if (!d.label) note('warn', `detection "${d.name}" has no label`)
}

// ── Provenance invariant ────────────────────────────────────────────────────
// The contract in src/shared/provenance.ts: these keys live on NODES only. Mesh, Primitive,
// Accessor, Material and Texture are exactly the dedup candidates in the optimize pass, so a
// provenance key hung off one of those lets two walkthroughs of the same room merge and
// attribute one session's geometry to the other. Verify it rather than trust it.
const misplaced = []
const containers = [
  ['Mesh', root.listMeshes()],
  ['Material', root.listMaterials()],
  ['Accessor', root.listAccessors()],
  ['Texture', root.listTextures()],
]
for (const [kind, list] of containers) {
  for (const item of list) {
    const extras = item.getExtras() ?? {}
    for (const key of NODE_PROVENANCE_KEYS) {
      if (key in extras) misplaced.push(`${kind} "${item.getName() || '(unnamed)'}" carries "${key}"`)
    }
  }
}
if (misplaced.length) {
  note('error', `provenance keys found off-node (dedup would cross-attribute these): ${misplaced.join('; ')}`)
}

const withProvenance = nodes.filter((n) => {
  const e = n.getExtras() ?? {}
  return NODE_PROVENANCE_KEYS.some((k) => k in e)
}).length

// Per-key coverage. src/shared/provenance.ts documents an asymmetry worth being able to SEE:
// a raw upload carries sessionId + capturedAt, while `scanId` is stamped server-side during the
// optimize pass (the client cannot know it — the id derives from the stored filename). So
// "scanId missing" is expected on a raw .glb and a real defect on a .opt.glb.
const perKey = Object.fromEntries(NODE_PROVENANCE_KEYS.map((key) => [
  key,
  nodes.filter((n) => key in (n.getExtras() ?? {})).length,
]))

const looksOptimized = root.listExtensionsUsed().length > 0 || /\.opt\.glb$/.test(target)
if (looksOptimized && perKey.scanId === 0) {
  note('warn', 'optimized artifact carries no node-level scanId — the optimize pass should stamp it')
}

// ── Report ──────────────────────────────────────────────────────────────────
const report = {
  source: target,
  bytes: bytes.length,
  scene: scene?.getName() ?? null,
  capturedAt: sceneExtras.capturedAt ?? null,
  sessionId: sceneExtras.sessionId ?? null,
  scanId: sceneExtras.scanId ?? null,
  counts: {
    nodes: nodes.length,
    meshes: root.listMeshes().length,
    materials: root.listMaterials().length,
    pointVertices: pointVerts,
    triangleVertices: triVerts,
    detections: detections.length,
    nodesWithProvenance: withProvenance,
  },
  provenanceByKey: perKey,
  pointCloudExtentM: extent ? extent.size.map((n) => Number(n.toFixed(2))) : null,
  extensions: root.listExtensionsUsed().map((e) => e.extensionName),
  nodeTypes: Object.fromEntries(byType),
  detections,
  issues,
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`
  console.log(`\n  ${target}`)
  console.log(`  ${kb(bytes.length)} · scene "${report.scene}" · captured ${report.capturedAt ?? '—'}`)
  console.log(`  session ${report.sessionId ?? '—'} · scan ${report.scanId ?? '—'}`)
  console.log(`\n  GEOMETRY`)
  console.log(`    ${pointVerts.toLocaleString()} point vertices · ${triVerts.toLocaleString()} surface vertices`)
  console.log(`    ${report.counts.meshes} meshes · ${report.counts.nodes} nodes · ${report.counts.materials} materials`)
  if (extent) {
    const [w, h, d] = extent.size
    console.log(`    extent: ${w.toFixed(1)} x ${h.toFixed(1)} x ${d.toFixed(1)} m`)
  }
  console.log(`    extensions: ${report.extensions.length ? report.extensions.join(', ') : '(none)'}`)
  console.log(`\n  STRUCTURE`)
  for (const [t, n] of byType) console.log(`    ${t}: ${n}`)
  console.log(`\n  DETECTIONS (${detections.length})`)
  for (const d of detections.slice(0, 15)) {
    const c = typeof d.confidence === 'number' ? `${(d.confidence * 100).toFixed(0)}%` : '—'
    console.log(`    ${String(d.label ?? '?').padEnd(14)} ${c.padStart(5)}  ${d.name}`)
  }
  if (detections.length > 15) console.log(`    … ${detections.length - 15} more`)
  console.log(`\n  PROVENANCE`)
  console.log(`    ${withProvenance}/${nodes.length} nodes carry provenance keys`)
  for (const [k, n] of Object.entries(perKey)) console.log(`      ${k.padEnd(15)} ${n}/${nodes.length}`)
  console.log(`\n  ISSUES (${issues.length})`)
  if (!issues.length) console.log('    none')
  for (const i of issues) console.log(`    [${i.severity}] ${i.message}`)
  console.log('')
}

process.exit(issues.some((i) => i.severity === 'error') ? 1 : 0)
