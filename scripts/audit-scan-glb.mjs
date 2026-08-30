/**
 * Audit a scan GLB — structure, geometry, provenance, and cross-artifact coherence —
 * without opening the editor.
 *
 *   node scripts/audit-scan-glb.mjs <file.glb|url>
 *   node scripts/audit-scan-glb.mjs scans/*.glb --summary   # one line per file
 *   node scripts/audit-scan-glb.mjs --scan <scanId>          # via the running server
 *   node scripts/audit-scan-glb.mjs <file.glb> --json        # machine-readable
 *
 * Why this exists: "does the scan look right?" was previously only answerable by loading it in
 * the viewer and eyeballing it, which cannot see the things that actually break downstream —
 * empty primitives, NaN bounds, a missing floor plane, or provenance that failed to survive the
 * optimize pass. Those are exactly what the splat/COLMAP stages choke on later.
 *
 * A scan is no longer one file, though, and that is the second half of this script. Since the
 * pipelines landed, a capture is a GLB PLUS a spread of sidecars — `<base>.splat-train.
 * manifest.json`, `<base>.panoptic-lift.manifest.json`, `sessions/<id>/colmap-poses.manifest.
 * json`, and so on. Each stage writes its own status independently, and nothing on disk checks
 * that the set agrees with itself. A scan can be a perfectly healthy GLB and an incoherent
 * *set*: a splat manifest saying `ok` beside a COLMAP verdict saying the solve was degenerate,
 * a stage reporting `ok` whose declared output is a zero-byte file, a lift whose own counts do
 * not add up to its own segment total. Those are the shape of this repo's recurring defect —
 * reporting success it has not earned — so they are errors here, not prose in a doc.
 *
 * Reuses the existing domain contract rather than inventing one (ADR 0001): NODE_PROVENANCE_KEYS
 * from src/shared/provenance.ts is the single source of truth for which keys must be present,
 * and for the node-only invariant checked below; the manifest field names checked in
 * `coherenceFindings` are the ones declared in src/world/manifests.ts, and the lift's count
 * invariants are the ones that file's own doc comment states.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { NodeIO, Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import draco3d from 'draco3dgltf'
import { NODE_PROVENANCE_KEYS } from '../src/shared/provenance.ts'

/**
 * A room-sized capture that reports a 60m extent is not a big room, it is drift: tracking
 * slipped and flung outliers across the map. It still looks plausible in the viewer (the cloud
 * is centred and the labels sit on it), and it still passes every structural check below —
 * but it destroys metric scale, so splat-align has nothing true to fit against and COLMAP
 * inherits a garbage initialisation. Measured on a real gimbal dome, 2026-08-27: a single
 * living-room capture reported 63.41 x 38.96 x 31.54 m.
 *
 * Only meaningful against a cloud that is actually in metres — see `extentUnits` below.
 */
export const ROOM_EXTENT_SANITY_M = 30

/**
 * The other end of the same question, and the one that actually caught something tonight.
 *
 * A reconstruction can collapse instead of drifting: every point lands in a knot at the origin,
 * the count stays enormous, and the manifest reports a triumphant `ok`. Measured 2026-08-30 on
 * sess-video-20260830-054518: `lingbot-map.manifest.json` says `status: ok, pointCount: 2436672`,
 * and `lingbot-map.point-cloud.ply` puts all 2,436,672 of those points inside a 3.7 cm cube
 * (bounds x 0.0465..0.0835, y -0.0113..0.0251, z -0.0916..-0.0549) — read straight out of the
 * PLY, so this is not a GLB-quantization artifact. COLMAP's cloud for the SAME session spans
 * ~20 units. A 3.7 cm room is not a room at any scale a viewer can show.
 *
 * Deliberately below anything a real capture reaches: the smallest honest extent among the 405
 * readable GLBs in scans/ is 3.3 units.
 */
export const COLLAPSED_EXTENT = 0.25

/** Two clouds of one session differing by more than this are not the same room at any scale. */
export const CLOUD_SCALE_DISAGREEMENT = 20

/** POINTS mode is 0 in glTF; anything else is real surface geometry. */
const MODE_POINTS = Primitive.Mode.POINTS

// ── Geometry ────────────────────────────────────────────────────────────────

const IDENTITY_4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]

/** glTF node matrices are column-major; row-major is what the multiply below expects. */
function nodeMatrixRowMajor(m) {
  return [
    [m[0], m[4], m[8], m[12]],
    [m[1], m[5], m[9], m[13]],
    [m[2], m[6], m[10], m[14]],
    [m[3], m[7], m[11], m[15]],
  ]
}

function mul4(a, b) {
  const out = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c] + a[r][3] * b[3][c]
    }
  }
  return out
}

/**
 * World-space bounds of the POINTS geometry.
 *
 * Two corrections that this script got wrong for its whole life, both measured tonight, both of
 * the "plausible wrong number" kind that is worse than an error:
 *
 *  - `accessor.getElement()`, not `getArray()`. On a KHR_mesh_quantization POSITION, `getArray`
 *    hands back the raw normalized integers. Every quantized artifact in scans/ therefore
 *    reported an extent of ~65534 "m" — 295 of the 405 readable GLBs, including
 *    `sess-video-20260830-054518.lingbot.glb` (2,436,672 points) — and every one of them
 *    tripped the drift warning above. `getElement` denormalizes.
 *  - the node's accumulated world matrix. `quantize()` parks the dequantization scale/offset on
 *    the NODE: in `1787789921923_home-00-studio-a.opt.glb` the point-cloud node carries scale
 *    2.470 and translation (0, 1.300, 0), so raw positions are 2.47x out from the origin.
 *
 * This is the same traversal `server/panoptic/panoptic_lift.ts:225` (`collectPointPositions`)
 * performs, for the same measured reason, and it is deliberately a second implementation rather
 * than an import: that module resolves `@std/path`, a JSR specifier node cannot load. Same
 * situation as `vite.config.ts`'s `resolveHostname()` against `server/main.ts`'s copy — parallel
 * implementations across two runtimes, not a missing shared module. Keep them in step.
 */
export function pointCloudBounds(doc) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let count = 0
  let nonFinite = 0
  const el = [0, 0, 0]

  const walk = (node, parent) => {
    const world = mul4(parent, nodeMatrixRowMajor(node.getMatrix()))
    const mesh = node.getMesh()
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== MODE_POINTS) continue
        const acc = prim.getAttribute('POSITION')
        if (!acc) continue
        for (let i = 0, n = acc.getCount(); i < n; i++) {
          acc.getElement(i, el)
          const p = [
            world[0][0] * el[0] + world[0][1] * el[1] + world[0][2] * el[2] + world[0][3],
            world[1][0] * el[0] + world[1][1] * el[1] + world[1][2] * el[2] + world[1][3],
            world[2][0] * el[0] + world[2][1] * el[1] + world[2][2] * el[2] + world[2][3],
          ]
          if (!p.every(Number.isFinite)) { nonFinite += 1; continue }
          count += 1
          for (let a = 0; a < 3; a++) {
            if (p[a] < min[a]) min[a] = p[a]
            if (p[a] > max[a]) max[a] = p[a]
          }
        }
      }
    }
    for (const child of node.listChildren()) walk(child, world)
  }
  for (const scene of doc.getRoot().listScenes()) {
    for (const node of scene.listChildren()) walk(node, IDENTITY_4)
  }
  if (!count) return { count, nonFinite, min: null, max: null, size: null }
  return { count, nonFinite, min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] }
}

// ── Cross-artifact coherence ────────────────────────────────────────────────

/**
 * Which sidecars sit next to a scan, and where each one's declared outputs live.
 *
 * `dir` says which directory the manifest's relative artifact paths resolve against: the
 * per-session stages write theirs into `scans/sessions/<id>/`, the per-scan stages write theirs
 * next to the GLB in `scans/`. Getting that wrong is how `splat_train_dataset.ts:158` lost every
 * run it ever attempted, so it is data here rather than a guess at the call site.
 */
export const SIDECAR_SPECS = [
  { key: 'colmap-poses', dir: 'session', file: 'colmap-poses.manifest.json', artifacts: ['posesPath', 'pointCloudPath'] },
  { key: 'panoptic', dir: 'session', file: 'panoptic.manifest.json', artifacts: ['segmentsPath'] },
  { key: 'lingbot-map', dir: 'session', file: 'lingbot-map.manifest.json', artifacts: ['artifacts.pointCloud', 'artifacts.poses'] },
  { key: 'splat-train', dir: 'scan', file: '.splat-train.manifest.json', artifacts: ['plyPath', 'compressedPlyPath'] },
  { key: 'splat-align', dir: 'scan', file: '.splat-align.manifest.json', artifacts: [] },
  { key: 'splat-detect', dir: 'scan', file: '.splat-detect.manifest.json', artifacts: ['interactionsPath'] },
  { key: 'splat-finish', dir: 'scan', file: '.splat-finish.manifest.json', artifacts: ['sogPath', 'compressedPlyPath'] },
  { key: 'panoptic-lift', dir: 'scan', file: '.panoptic-lift.manifest.json', artifacts: ['detectionsPath'] },
]

/** The one count that makes each stage's `ok` mean anything. Zero here with status ok is a lie. */
const PRINCIPAL_COUNT = {
  'colmap-poses': 'registeredImages',
  'panoptic': 'framesSegmented',
  'lingbot-map': 'pointCount',
  'splat-train': 'gaussianCount',
  'splat-detect': 'objectCount',
  'splat-finish': 'gaussianCount',
  // panoptic-lift is deliberately absent: `confidentCount: 0` with a full `reasons` breakdown is
  // an honest answer about the room, not an empty success. Its invariants are checked instead.
}

function readPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

/**
 * Whether a lift record actually carries a position.
 *
 * `worldPos` is a `Vec3` — the `{x, y, z}` object src/shared/panoptic_lift.ts:65 declares — not a
 * three-element array. Checking `Array.isArray` here read 0 placed objects out of a sidecar that
 * holds 6, and reported the lift as lying when the lift was right. Worth the named helper: an
 * auditor that manufactures findings is worse than no auditor.
 */
function hasWorldPos(rec) {
  const p = rec?.worldPos
  return !!p && typeof p === 'object' && ['x', 'y', 'z'].every((k) => Number.isFinite(p[k]))
}

/**
 * Everything wrong with a scan's artifact SET, given what is already on disk.
 *
 * Pure — takes a context object, touches no filesystem — so the invariants below can be tested
 * against constructed manifests rather than against whatever happens to be in scans/ tonight.
 * See tests/unit/node/scan_coherence.test.ts.
 *
 * ctx: {
 *   glbBase, sessionId, pointVertices, detectionsInGlb,
 *   sidecars: { <key>: { path, json, unreadable? } },
 *   files:    { <absolute path>: { exists, bytes } },
 *   detectionsSidecar: { path, json } | null,
 * }
 */
export function coherenceFindings(ctx) {
  const out = []
  const note = (severity, message) => out.push({ severity, message })
  const sidecars = ctx.sidecars ?? {}
  const files = ctx.files ?? {}
  const present = (key) => sidecars[key]?.json ?? null
  const fileState = (p) => files[p] ?? { exists: false, bytes: 0 }

  for (const [key, entry] of Object.entries(sidecars)) {
    if (entry?.unreadable) {
      note('error', `${key} manifest at ${entry.path} exists but is not readable JSON — a stage wrote a manifest it cannot read back`)
    }
  }

  const spec = Object.fromEntries(SIDECAR_SPECS.map((s) => [s.key, s]))

  for (const [key, entry] of Object.entries(sidecars)) {
    const m = entry?.json
    if (!m) continue

    // 1. Optional tooling degrades as `skipped` WITH a remediation — the contract
    //    server/colmap/colmap_poses.ts:132 and server/splat/splat_train.ts:168 set. A skip with
    //    no way out is indistinguishable from a stage that simply gave up.
    if (m.status === 'skipped' && !m.remediation) {
      note('warn', `${key} was skipped with no remediation — nothing tells an operator how to make it run`)
    }
    if (m.status === 'error' && !m.error) {
      note('warn', `${key} reports status "error" with no error text`)
    }

    if (m.status !== 'ok') continue

    // 2. An `ok` whose declared output is absent or empty. This is the exact failure mode the
    //    repo keeps producing (enable_point=False returning 0 points with status ok), so it is
    //    an error and not a warning.
    for (const field of spec[key]?.artifacts ?? []) {
      const rel = readPath(m, field)
      if (!rel) continue
      const abs = join(entry.baseDir, String(rel))
      const st = fileState(abs)
      if (!st.exists) {
        note('error', `${key} reports ok and names ${field}="${rel}", but that file does not exist`)
      } else if (st.bytes === 0) {
        note('error', `${key} reports ok and names ${field}="${rel}", but that file is zero bytes`)
      }
    }

    // 3. An `ok` with nothing in it.
    const countField = PRINCIPAL_COUNT[key]
    if (countField) {
      const n = m[countField]
      if (n === 0) note('error', `${key} reports ok with ${countField}=0 — an empty result presented as a success`)
      else if (n == null) note('warn', `${key} reports ok but never states ${countField}`)
    }

    // 4. Provenance agreement. A manifest naming a different session than the GLB's scene means
    //    two captures' artifacts have been mixed in one directory, which is precisely what the
    //    node-only provenance invariant above exists to prevent at the geometry level.
    if (ctx.sessionId && m.sessionId && m.sessionId !== ctx.sessionId) {
      note('error', `${key} names session "${m.sessionId}" but the GLB's scene says "${ctx.sessionId}"`)
    }
  }

  // 5. A degenerate solve feeding downstream stages that report success.
  //
  //    The COLMAP driver already computes the verdict (`quality.degenerate`, `quality.status`)
  //    and nothing downstream reads it. On sess-a7e2f642 the gate correctly called a 3-of-17
  //    registration degenerate — and a splat was trained on it anyway, and reported ok. A trained
  //    splat is not evidence that the poses were real.
  const colmap = present('colmap-poses')
  const q = colmap?.quality
  if (q && (q.degenerate === true || (q.status && q.status !== 'ready'))) {
    const ratio = typeof q.registrationRatio === 'number' ? ` (${(q.registrationRatio * 100).toFixed(0)}% of frames registered)` : ''
    for (const key of ['splat-train', 'splat-finish', 'splat-detect', 'panoptic-lift']) {
      if (present(key)?.status === 'ok') {
        note('error', `${key} reports ok, but the pose solve it stands on was rejected by the quality gate${ratio} — the result is built on poses the pipeline itself does not trust`)
      }
    }
  }
  if (colmap?.status === 'ok' && typeof colmap.registeredImages === 'number' && typeof colmap.frameCount === 'number'
    && colmap.registeredImages < colmap.frameCount) {
    note('warn', `pose solve registered ${colmap.registeredImages} of ${colmap.frameCount} frames — the rest contributed nothing`)
  }

  // 6. The cloud the GLB carries vs the cloud a stage says it produced. `colmap-poses` names the
  //    GLB it wrote; if the point counts disagree, the GLB on disk is from a different run and
  //    every number derived from it is attributed to the wrong solve.
  if (colmap?.status === 'ok' && typeof colmap.pointCount === 'number' && typeof ctx.pointVertices === 'number'
    && colmap.glbPath && basename(String(colmap.glbPath)) === `${ctx.glbBase}.glb`
    && colmap.pointCount !== ctx.pointVertices) {
    note('error', `pose solve says it wrote ${colmap.pointCount} points into this GLB, which holds ${ctx.pointVertices} — the GLB is from a different run`)
  }

  // 7. Gaussian counts must survive compression unchanged; splat-finish re-encodes, it does not
  //    resample. A drift here means the .sog on disk is not the .ply that was trained.
  const train = present('splat-train')
  const finish = present('splat-finish')
  if (train?.status === 'ok' && finish?.status === 'ok'
    && typeof train.gaussianCount === 'number' && typeof finish.gaussianCount === 'number'
    && train.gaussianCount !== finish.gaussianCount) {
    note('error', `the compressed splat holds ${finish.gaussianCount} gaussians but training produced ${train.gaussianCount} — they are not the same splat`)
  }

  // 8. A splat with no alignment is not measurable. SplatAlignManifest exists because monocular
  //    SfM has no metres in it (src/world/manifests.ts); until that fit lands, every distance
  //    taken off the splat is in arbitrary units.
  if (train?.status === 'ok' && !present('splat-align')) {
    note('warn', 'a splat exists with no alignment fit — it sits in structure-from-motion units, so nothing measured against it is in metres')
  }

  // 9. Objects were seen and never placed. `panoptic` counts what the segmenter found;
  //    `panoptic-lift` is the only thing that turns those into a place. Without it the scan
  //    contributes no Things at all, however many the segmenter reports.
  const pano = present('panoptic')
  const lift = present('panoptic-lift')
  if (pano?.status === 'ok' && (pano.thingCount ?? 0) > 0 && !lift) {
    note('warn', `${pano.thingCount} object segments were found in this session and never lifted to positions — nothing from this scan can reach the world until a lift runs`)
  }
  if (pano?.status === 'ok' && pano.thingLabelsUsed === false) {
    note('warn', 'the segmenter ran with no thing-label list, so every segment came back unknown — read its thing/stuff split as "not asked", not as "an empty room"')
  }

  // 10. The lift's own arithmetic. src/world/manifests.ts states these as invariants
  //     (`confidentCount + undeterminedCount === segmentCount`, `reasons` sums to
  //     `undeterminedCount`, `lowConfidenceCount` is a SUBSET not a third bucket). A manifest
  //     that breaks them is describing a run that did not happen.
  if (lift && lift.status === 'ok') {
    const seg = lift.segmentCount
    const conf = lift.confidentCount
    const undet = lift.undeterminedCount
    if (typeof seg === 'number' && typeof conf === 'number' && typeof undet === 'number') {
      if (conf + undet !== seg) {
        note('error', `lift counts do not partition: ${conf} placed + ${undet} unplaced != ${seg} segments`)
      }
      if (lift.reasons) {
        const sum = Object.values(lift.reasons).reduce((a, b) => a + b, 0)
        if (sum !== undet) note('error', `lift reasons sum to ${sum} but ${undet} segments went unplaced`)
      } else if (undet > 0) {
        note('error', `${undet} segments went unplaced with no reasons recorded — the manifest cannot say why`)
      }
      if (typeof lift.lowConfidenceCount === 'number' && lift.lowConfidenceCount > undet) {
        note('error', `lift reports ${lift.lowConfidenceCount} low-confidence segments but only ${undet} unplaced — low-confidence is a subset of unplaced, not a third bucket`)
      }
      if (seg > 0 && conf === 0) {
        note('warn', `${seg} object segments were lifted and none produced a trusted position — this scan places nothing, whatever the stage's status says`)
      }
    }
    if (typeof lift.pointCount === 'number' && typeof ctx.pointVertices === 'number'
      && lift.pointCount !== ctx.pointVertices) {
      note('warn', `the lift cast against a ${lift.pointCount}-point cloud; this GLB holds ${ctx.pointVertices} — it ran against a different artifact`)
    }
  }

  // 11. Two reconstructions of one session that cannot both be describing the same room.
  //
  //     COLMAP and LingBot-Map deliberately write interchangeable outputs (ColmapPosesManifest's
  //     doc comment: "its outputs intentionally mirror LingBot-Map's, so buildBrushDataset reads
  //     either producer through one code path"). Interchangeable in FORMAT is not interchangeable
  //     in FRAME. Nothing on disk relates the two, so a viewer showing both is showing one of
  //     them at the wrong size — and a downstream stage that picks whichever it finds first will
  //     silently get a different answer per run.
  if (ctx.extent && ctx.siblingCloud?.extent) {
    const a = Math.max(...ctx.extent)
    const b = Math.max(...ctx.siblingCloud.extent)
    const ratio = a > 0 && b > 0 ? Math.max(a / b, b / a) : Infinity
    if (ratio > CLOUD_SCALE_DISAGREEMENT) {
      note('error', `this cloud spans ${a.toFixed(2)} and ${ctx.siblingCloud.name} spans ${b.toFixed(2)} `
        + `for the same session — a ${ratio.toFixed(0)}x scale disagreement between two reconstructions `
        + 'of one room, with no alignment fit on disk relating them')
    }
  }

  // 12. The detections sidecar against the manifest that claims to have written it.
  const det = ctx.detectionsSidecar?.json
  if (lift?.status === 'ok' && det) {
    const rows = Array.isArray(det.detections) ? det.detections : null
    if (!rows) {
      note('error', 'the lift\'s detections sidecar has no detections array')
    } else {
      if (typeof lift.segmentCount === 'number' && rows.length !== lift.segmentCount) {
        note('warn', `detections sidecar holds ${rows.length} records for ${lift.segmentCount} segments`)
      }
      const placed = rows.filter(hasWorldPos).length
      if (typeof lift.confidentCount === 'number' && placed !== lift.confidentCount) {
        note('error', `the lift claims ${lift.confidentCount} placed objects but its sidecar carries ${placed} positions`)
      }
      // src/shared/panoptic_lift.ts:190-196 pins the pairing: `confidence` is null exactly when
      // `worldPos` is, and `reason` is present exactly when it is. A record that breaks it is
      // either a placement with nothing backing it or an abstention that cannot say why.
      const unexplained = rows.filter((r) => !hasWorldPos(r) && !r?.reason).length
      if (unexplained) note('error', `${unexplained} detection records have neither a position nor a reason`)
      const unbacked = rows.filter((r) => hasWorldPos(r) && typeof r?.confidence !== 'number').length
      if (unbacked) note('error', `${unbacked} detection records carry a position with no confidence`)
    }
  }
  if (lift?.status === 'ok' && !det && (lift.confidentCount ?? 0) > 0) {
    note('error', 'the lift claims placed objects but no detections sidecar is on disk')
  }

  return out
}

// ── Report ──────────────────────────────────────────────────────────────────

async function fileState(path) {
  try {
    const st = await stat(path)
    return { exists: st.isFile(), bytes: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return { exists: false, bytes: 0, mtimeMs: 0 }
  }
}

async function readJson(path) {
  try {
    return { path, json: JSON.parse(await readFile(path, 'utf8')) }
  } catch (err) {
    const st = await fileState(path)
    if (!st.exists) return null
    return { path, json: null, unreadable: true, why: String(err?.message ?? err) }
  }
}

/**
 * Gather every sidecar a local scan GLB has, and the on-disk state of everything they name.
 *
 * Returns null for a URL target: the coherence half is about files that sit beside each other on
 * one disk, and half-answering it from an HTTP fetch would be exactly the unearned success this
 * script is here to catch.
 */
export async function collectCoherenceContext(glbPath, report) {
  if (/^https?:\/\//.test(glbPath)) return null
  const scansDir = dirname(resolve(glbPath))
  const glbBase = basename(glbPath).replace(/\.glb$/, '')
  const sessionId = report.sessionId ?? null
  const sessionDir = sessionId ? join(scansDir, 'sessions', sessionId) : null

  const sidecars = {}
  const files = {}
  for (const s of SIDECAR_SPECS) {
    const baseDir = s.dir === 'session' ? sessionDir : scansDir
    if (!baseDir) continue
    const path = s.dir === 'session' ? join(baseDir, s.file) : join(baseDir, `${glbBase}${s.file}`)
    const entry = await readJson(path)
    if (!entry) continue
    sidecars[s.key] = { ...entry, baseDir }
    for (const field of s.artifacts) {
      const rel = readPath(entry.json ?? {}, field)
      if (!rel) continue
      const abs = join(baseDir, String(rel))
      files[abs] = await fileState(abs)
    }
  }

  const detPath = sidecars['panoptic-lift']?.json?.detectionsPath
    ? join(scansDir, String(sidecars['panoptic-lift'].json.detectionsPath))
    : join(scansDir, `${glbBase}.panoptic.detections.json`)
  const detectionsSidecar = await readJson(detPath)

  // The sibling cloud, when the same session produced two. Only ever one extra GLB read, and
  // only when it exists — check 11 below is the reason.
  let siblingCloud = null
  const siblingName = /\.lingbot\.glb$/.test(glbPath) ? `${glbBase.replace(/\.lingbot$/, '')}.glb` : `${glbBase}.lingbot.glb`
  const siblingPath = join(scansDir, siblingName)
  if ((await fileState(siblingPath)).exists) {
    const sib = await auditGlb(siblingPath)
    if (sib.readable && sib.pointCloudExtent) siblingCloud = { name: siblingName, extent: sib.pointCloudExtent }
  }

  return {
    glbBase,
    siblingCloud,
    sessionId,
    sessionDir,
    pointVertices: report.counts.pointVertices,
    detectionsInGlb: report.counts.detections,
    sidecars,
    files,
    detectionsSidecar,
  }
}

let ioPromise = null
function getIO() {
  ioPromise ??= (async () =>
    new NodeIO()
      // ALL_EXTENSIONS, not a hand-picked pair. Registering only Draco + quantization made two
      // real scans unauditable: 1787809909608_autosave-room-scan-2026-08-27T05-51-51{,.opt}.glb
      // use KHR_materials_unlit, and gltf-transform throws "Missing optional extension" on read
      // — the script died with a raw stack trace and exit 1, which is indistinguishable from
      // "this scan has errors". server/panoptic/panoptic_lift.ts already reads with
      // ALL_EXTENSIONS for the same reason.
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'draco3d.encoder': await draco3d.createEncoderModule(),
      }))()
  return ioPromise
}

/** Full audit of one GLB. Never throws: an unreadable file is a report with an error in it. */
export async function auditGlb(target) {
  const io = await getIO()
  let bytes
  try {
    bytes = /^https?:\/\//.test(target)
      ? await (async () => {
        const res = await fetch(target)
        if (!res.ok) throw new Error(`GET ${target} -> ${res.status}`)
        return new Uint8Array(await res.arrayBuffer())
      })()
      : new Uint8Array(await readFile(target))
  } catch (err) {
    return unreadable(target, 0, `cannot read: ${err?.message ?? err}`)
  }

  let doc
  try {
    doc = await io.readBinary(bytes)
  } catch (err) {
    // A 1-byte file named .glb is not a corrupt scan, it is not a scan — scans/ holds 21 of them
    // (`*_probe.glb`, 1 and 7 bytes, from upload smoke tests). Saying so beats a stack trace.
    const why = bytes.length < 32
      ? `not a GLB — only ${bytes.length} byte(s) on disk`
      : `unreadable GLB: ${err?.message ?? err}`
    return unreadable(target, bytes.length, why)
  }

  const root = doc.getRoot()
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  const issues = []
  const note = (severity, message) => issues.push({ severity, message })
  const nodes = root.listNodes()

  let pointVerts = 0
  let triVerts = 0
  let emptyPrims = 0

  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')
      const n = pos ? pos.getCount() : 0
      if (n === 0) emptyPrims += 1
      if (prim.getMode() === MODE_POINTS) pointVerts += n
      else triVerts += n
    }
  }

  if (pointVerts === 0) note('error', 'no POINTS geometry — the scan has no point cloud')
  if (emptyPrims) note('warn', `${emptyPrims} primitive(s) have zero vertices`)

  // A NaN in POSITION poisons every downstream bound computation, and it survives silently
  // through the optimize pass — worth catching here rather than as an empty viewer.
  const bounds = pointCloudBounds(doc)
  if (bounds.nonFinite) {
    note('error', `${bounds.nonFinite} POINTS vertices have non-finite coordinates`)
  }

  // ── Scene-level metadata ──────────────────────────────────────────────────
  const sceneExtras = scene?.getExtras() ?? {}
  for (const key of ['capturedAt', 'sessionId']) {
    if (!sceneExtras[key]) note('warn', `scene extras missing "${key}"`)
  }

  // ── Semantic nodes the pipeline expects ───────────────────────────────────
  const byType = new Map()
  for (const node of nodes) {
    const t = node.getExtras()?.type ?? node.getExtras()?.objectType
    if (t) byType.set(t, (byType.get(t) ?? 0) + 1)
  }
  if (!byType.has('slam_feature_points')) note('warn', 'no node tagged slam_feature_points')
  if (!byType.has('estimated_floor')) note('warn', 'no estimated_floor node — alignment has no ground reference')
  if (!byType.has('camera_trajectory')) note('warn', 'no camera_trajectory node — no poses for splat-align to fit against')

  // ── Detections ────────────────────────────────────────────────────────────
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

  // ── Provenance invariant ──────────────────────────────────────────────────
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
    // Primitives are dedup candidates too, and they are not reachable from any
    // root.list*() call — they hang off their Mesh, so a key parked here would
    // have slipped past the four containers above.
    ['Primitive', root.listMeshes().flatMap((mesh) => mesh.listPrimitives())],
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

  const extensions = root.listExtensionsUsed().map((e) => e.extensionName)
  // "Any extension in use" was the old test for an optimized artifact, and it was wrong:
  // sess-video-20260830-054518.lingbot.glb uses KHR_mesh_quantization because
  // server/lingbot-map/lingbot_map_glb.ts writes it that way, has never been near the optimize
  // pass, and was told off nightly for missing a scanId only that pass stamps. Draco compression
  // and the .opt/.lodN names are the optimize pass's own signatures.
  const looksOptimized = /\.(opt|lod\d+)\.glb$/.test(target) || extensions.includes('KHR_draco_mesh_compression')
  if (looksOptimized && perKey.scanId === 0) {
    note('warn', 'optimized artifact carries no node-level scanId — the optimize pass should stamp it')
  }

  return {
    source: target,
    readable: true,
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
    // toPrecision, not toFixed: a collapsed cloud rounds to 0.00 at two decimals and the
    // number that shows the defect disappears from the report.
    pointCloudExtent: bounds.size ? bounds.size.map((n) => Number(n.toPrecision(4))) : null,
    extensions,
    nodeTypes: Object.fromEntries(byType),
    detections,
    issues,
  }
}

function unreadable(source, bytes, why) {
  return {
    source,
    readable: false,
    bytes,
    scene: null,
    capturedAt: null,
    sessionId: null,
    scanId: null,
    counts: {
      nodes: 0, meshes: 0, materials: 0, pointVertices: 0,
      triangleVertices: 0, detections: 0, nodesWithProvenance: 0,
    },
    provenanceByKey: {},
    pointCloudExtent: null,
    extensions: [],
    nodeTypes: {},
    detections: [],
    issues: [{ severity: 'error', message: why }],
  }
}

/**
 * Decide whether the cloud's numbers are metres.
 *
 * A COLMAP cloud is reconstructed only up to an unknown scale — that is why SplatAlignManifest
 * exists at all (src/world/manifests.ts) and why the panoptic lift refuses to use solved poses
 * against a metric cloud (server/panoptic/panoptic_lift.ts). Printing "20.7 x 10.8 x 17.4 m" for
 * one, and then judging it against a 30 m room threshold, is a measurement this script has not
 * earned: the units are arbitrary, so both the number and the verdict are meaningless.
 */
/**
 * Verdicts on the point cloud's size, once its units are known.
 *
 * Pure and separate from the walk so both thresholds can be tested against constructed numbers.
 */
export function extentFindings(extent, units, pointCount) {
  if (!extent) return []
  const out = []
  const [w, h, d] = extent
  const worst = Math.max(w, h, d)
  if (units === 'm' && worst > ROOM_EXTENT_SANITY_M) {
    out.push({
      severity: 'warn',
      message: `point cloud spans ${w.toFixed(1)} x ${h.toFixed(1)} x ${d.toFixed(1)} m — larger than a `
        + `room (> ${ROOM_EXTENT_SANITY_M}m on an axis). Usually tracking drift throwing outliers, `
        + 'which breaks metric scale for splat-align and COLMAP even though the scan looks fine in '
        + 'the viewer.',
    })
  }
  if (worst < COLLAPSED_EXTENT && pointCount > 0) {
    const unit = units === 'sfm' ? 'structure-from-motion units' : 'm'
    out.push({
      // A metric claim this small is simply false; in unfitted SfM units it is merely unusable,
      // because nothing downstream can scale it back up without an alignment fit.
      severity: units === 'm' ? 'error' : 'warn',
      message: `${pointCount.toLocaleString()} points inside a ${w.toFixed(3)} x ${h.toFixed(3)} x `
        + `${d.toFixed(3)} ${unit} box — the reconstruction collapsed. The count looks like a `
        + 'success and there is no room in here.',
    })
  }
  return out
}

export function extentUnits(ctx) {
  const colmap = ctx?.sidecars?.['colmap-poses']?.json
  if (colmap && colmap.glbPath && basename(String(colmap.glbPath)) === `${ctx.glbBase}.glb`) {
    return 'sfm'
  }
  return 'm'
}

async function auditOne(target) {
  const report = await auditGlb(target)
  const ctx = report.readable ? await collectCoherenceContext(target, report) : null
  const units = ctx ? extentUnits(ctx) : 'm'
  report.extentUnits = units
  report.issues.push(...extentFindings(report.pointCloudExtent, units, report.counts.pointVertices))
  report.coherence = ctx ? coherenceFindings({ ...ctx, extent: report.pointCloudExtent }) : []
  report.sidecars = ctx
    ? Object.fromEntries(Object.entries(ctx.sidecars).map(([k, v]) => [k, v.json?.status ?? (v.unreadable ? 'unreadable' : null)]))
    : {}
  report.issues.push(...report.coherence)
  return report
}

function printReport(report) {
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`
  const { counts, issues } = report
  console.log(`\n  ${report.source}`)
  if (!report.readable) {
    console.log(`  ${kb(report.bytes)} · UNREADABLE`)
    for (const i of issues) console.log(`    [${i.severity}] ${i.message}`)
    console.log('')
    return
  }
  console.log(`  ${kb(report.bytes)} · scene "${report.scene}" · captured ${report.capturedAt ?? '—'}`)
  console.log(`  session ${report.sessionId ?? '—'} · scan ${report.scanId ?? '—'}`)
  console.log(`\n  GEOMETRY`)
  console.log(`    ${counts.pointVertices.toLocaleString()} point vertices · ${counts.triangleVertices.toLocaleString()} surface vertices`)
  console.log(`    ${counts.meshes} meshes · ${counts.nodes} nodes · ${counts.materials} materials`)
  if (report.pointCloudExtent) {
    const [w, h, d] = report.pointCloudExtent
    const dp = Math.max(w, h, d) < 1 ? 4 : 1
    const unit = report.extentUnits === 'sfm' ? 'structure-from-motion units (NOT metres — no scale has been fitted)' : 'm'
    console.log(`    extent: ${w.toFixed(dp)} x ${h.toFixed(dp)} x ${d.toFixed(dp)} ${unit}`)
  }
  console.log(`    extensions: ${report.extensions.length ? report.extensions.join(', ') : '(none)'}`)
  console.log(`\n  STRUCTURE`)
  for (const [t, n] of Object.entries(report.nodeTypes)) console.log(`    ${t}: ${n}`)
  console.log(`\n  DETECTIONS (${report.detections.length})`)
  for (const d of report.detections.slice(0, 15)) {
    const c = typeof d.confidence === 'number' ? `${(d.confidence * 100).toFixed(0)}%` : '—'
    console.log(`    ${String(d.label ?? '?').padEnd(14)} ${c.padStart(5)}  ${d.name}`)
  }
  if (report.detections.length > 15) console.log(`    … ${report.detections.length - 15} more`)
  console.log(`\n  PROVENANCE`)
  console.log(`    ${counts.nodesWithProvenance}/${counts.nodes} nodes carry provenance keys`)
  for (const [k, n] of Object.entries(report.provenanceByKey)) console.log(`      ${k.padEnd(15)} ${n}/${counts.nodes}`)
  const stages = Object.entries(report.sidecars)
  console.log(`\n  PIPELINE SIDECARS (${stages.length})`)
  if (!stages.length) console.log('    none found beside this scan')
  for (const [k, s] of stages) console.log(`    ${k.padEnd(14)} ${s}`)
  console.log(`\n  ISSUES (${report.issues.length})`)
  if (!report.issues.length) console.log('    none')
  for (const i of report.issues) console.log(`    [${i.severity}] ${i.message}`)
  console.log('')
}

function printSummaryRow(report) {
  const err = report.issues.filter((i) => i.severity === 'error').length
  const warn = report.issues.filter((i) => i.severity === 'warn').length
  const ext = report.pointCloudExtent
    ? report.pointCloudExtent.map((n) => n.toFixed(Math.max(...report.pointCloudExtent) < 1 ? 4 : 1)).join('x') + (report.extentUnits === 'sfm' ? ' sfm' : ' m')
    : '—'
  const verdict = err ? 'ERROR' : warn ? 'warn ' : 'ok   '
  console.log([
    verdict,
    String(report.counts.pointVertices).padStart(9),
    ext.padStart(24),
    `${err}e/${warn}w`.padStart(7),
    report.source,
  ].join('  '))
}

async function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const asSummary = args.includes('--summary')
  const scanFlag = args.indexOf('--scan')
  const positional = args.filter((a) => !a.startsWith('--'))
  const SERVER = process.env.SERVER_URL ?? 'http://localhost:8000'

  if (!positional.length) {
    console.error('usage: node scripts/audit-scan-glb.mjs <file.glb|url> [more.glb …] [--json|--summary]')
    console.error('       node scripts/audit-scan-glb.mjs --scan <scanId> [--json]')
    return 2
  }

  const targets = scanFlag !== -1
    ? [`${SERVER}/scans/${positional[0]}`]
    : positional

  const reports = []
  for (const t of targets) reports.push(await auditOne(t))

  if (asJson) {
    console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2))
  } else if (asSummary) {
    console.log('VERDICT     POINTS                    EXTENT   COUNTS  SOURCE')
    for (const r of reports) printSummaryRow(r)
    const bad = reports.filter((r) => r.issues.some((i) => i.severity === 'error')).length
    console.log(`\n  ${reports.length} audited · ${bad} with errors`)
  } else {
    for (const r of reports) printReport(r)
  }

  return reports.some((r) => r.issues.some((i) => i.severity === 'error')) ? 1 : 0
}

// Only run the CLI when invoked as one — the pure halves above are imported by
// tests/unit/node/scan_coherence.test.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
