/**
 * Whole-Place glTF export: the composer behind the `export-world` WorldJob.
 *
 * One glTF scene, in the Place frame:
 *   - one node per scan that has a GLB, named by the scan's name, whose matrix
 *     is `scan.localToWorld`. The scan's own default scene hangs under it,
 *     unchanged, so every node the scan already carries keeps its provenance.
 *   - one node per Thing, named `<canonicalLabel>-<last six of thingId>`,
 *     translated to `thing.position` (already in the Place frame, see the
 *     thing-correspondence job), with extras
 *     `{ tagId, thingId, label, observationCount, scanIds }`.
 *   - scene extras `{ worldId, frame: 'place', exportedAt, scanCount,
 *     thingCount, missingScans }`.
 *
 * A scan whose GLB is not supplied is never dropped silently: its scanId is
 * listed in `missingScans`, written to the scene extras, and warned about.
 *
 * This module does no file I/O. The job runner in server/main.ts reads each
 * scan GLB the way the viewer does and writes the returned bytes, so the
 * composer is testable on its own (tests/unit/deno/world_export.test.ts).
 *
 * Merging uses `mergeDocuments` from @gltf-transform/functions. Core only has
 * per-property `copy`/`clone`, which keep references into the source document;
 * `mergeDocuments` is the installed facility that copies a whole document in
 * and leaves the source untouched. pipeline.ts already imports that package.
 *
 * Reuses the existing domain types (ADR 0001): WorldProject, ScanManifest,
 * Thing and ThingObservation from src/world/types.ts. Nothing new is defined
 * here except the result shape.
 */
import { Document, type mat4, type Node as GltfNode, NodeIO, type Scene } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions'
import { mergeDocuments, prune, unpartition } from '@gltf-transform/functions'
// @ts-ignore — draco3dgltf ships no type declarations (pipeline.ts does the same)
import draco3d from 'draco3dgltf'
import type { ScanManifest, Thing, ThingObservation, Vec3, WorldProject } from '../src/world/types.ts'

export interface WorldExportResult {
  /** The `.world.glb` file contents. */
  bytes: Uint8Array
  /** Scans whose GLB was supplied, and so is in the file. */
  scanCount: number
  /** Thing nodes written. */
  thingCount: number
  /** scanIds of scans with no GLB supplied, in world order. */
  missingScans: string[]
  /** Human-readable notes for the job result: missing scans, empty output, unusable data. */
  warnings: string[]
}

export interface ComposeWorldExportOptions {
  /** The one timestamp shared by the whole export. Defaults to now. */
  exportedAt?: string
}

const IDENTITY_MATRIX: mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

let readIoPromise: Promise<NodeIO> | null = null

/**
 * Reads one scan GLB as it is stored on disk.
 *
 * The optimizer's output is quantized and Draco-compressed (pipeline.ts), so
 * the decoder must be registered, and so must every extension: glTF-Transform
 * silently drops an extension the IO has not registered, at read time. This
 * is the same setup panoptic_lift.ts uses for its read-only GLB access.
 */
export function readScanGlb(bytes: Uint8Array): Promise<Document> {
  readIoPromise ??= (async () => {
    const decoder = await draco3d.createDecoderModule({})
    return new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'draco3d.decoder': decoder })
  })()
  return readIoPromise.then((io) => io.readBinary(bytes))
}

/**
 * Builds the whole-Place glTF for `world`. `scanGlbs` maps each scanId to its
 * already-read GLB document; a scan absent from the map is reported missing.
 * The source documents are not modified.
 */
export async function composeWorldExport(
  world: WorldProject,
  scanGlbs: ReadonlyMap<string, Document>,
  options: ComposeWorldExportOptions = {},
): Promise<WorldExportResult> {
  const exportedAt = options.exportedAt ?? new Date().toISOString()
  const warnings: string[] = []
  const missingScans: string[] = []

  const doc = new Document()
  const scene = doc.createScene(world.name)
  doc.getRoot().setDefaultScene(scene)

  let scanCount = 0
  for (const scan of world.scans) {
    const label = scanLabel(scan)
    const source = scanGlbs.get(scan.scanId)
    if (!source) {
      missingScans.push(scan.scanId)
      warnings.push(`No GLB for scan "${label}" (${scan.scanId}); it is listed in missingScans and is not in this export.`)
      continue
    }
    scanCount += 1
    const root = doc.createNode(label)
      .setMatrix(scanMatrix(scan, label, warnings))
      .setExtras({
        scanId: scan.scanId,
        sessionId: scan.sessionId,
        filename: scan.filename,
        capturedAt: scan.capturedAt,
      })
    scene.addChild(root)
    attachScanGeometry(doc, root, source, label, warnings)
  }

  const observationsByThing = groupObservations(world.thingObservations)
  let thingCount = 0
  for (const thing of world.things) {
    if (!isFinitePoint(thing.position)) {
      warnings.push(`Thing ${thing.thingId} has no finite position; it is not in this export.`)
      continue
    }
    const { observationCount, scanIds } = thingProvenance(thing, observationsByThing.get(thing.thingId) ?? [])
    const node = doc.createNode(`${thing.canonicalLabel}-${thing.thingId.slice(-6)}`)
      .setTranslation([thing.position.x, thing.position.y, thing.position.z])
      .setExtras({
        tagId: thing.thingId,
        thingId: thing.thingId,
        label: thing.canonicalLabel,
        observationCount,
        scanIds,
      })
    scene.addChild(node)
    thingCount += 1
  }

  if (scanCount === 0) {
    warnings.push(world.scans.length === 0
      ? 'This world has no scans, so the export holds only its Things.'
      : 'No scan GLB was available, so the export holds only its Things.')
  }

  // glTF does not allow an empty scene node list, and glTF-Transform writes one
  // as `nodes: []`. A Place with no scan GLBs and no Things gets one bare node,
  // named for the Place, so the file stays valid. It is never added otherwise.
  if (scene.listChildren().length === 0) {
    scene.addChild(doc.createNode(world.name).setExtras({ worldId: world.worldId, placeholder: true }))
  }

  scene.setExtras({
    worldId: world.worldId,
    frame: 'place',
    exportedAt,
    scanCount,
    thingCount,
    missingScans,
  })

  // mergeDocuments copies every node of a source, including any that no scene
  // draws, and dropped scenes leave their nodes behind too. Only nodes that
  // hang off this scene's graph are kept. Each kept node has the Scene or a
  // parent node as its parent, so it survives; keepLeaves stops prune from
  // trimming childless nodes, which Things and empty scan roots are.
  // GLB allows at most one buffer, and each merged scan brought its own.
  await doc.transform(
    prune({ keepAttributes: true, keepLeaves: true, keepExtras: false, keepSolidTextures: true }),
    unpartition(),
  )
  // mergeDocuments lists each scan's Draco extension on `doc`, but the geometry
  // was decoded on read, so there is nothing left for it to describe. A writer
  // that finds it listed refuses to run without a Draco encoder. Dropping it
  // here, on the target, writes the decoded geometry and leaves the sources alone.
  for (const extension of doc.getRoot().listExtensionsUsed()) {
    if (extension.extensionName === KHRDracoMeshCompression.EXTENSION_NAME) extension.dispose()
  }
  const bytes = await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(doc)
  return { bytes, scanCount, thingCount, missingScans, warnings }
}

function scanLabel(scan: ScanManifest): string {
  return scan.name || scan.filename
}

/**
 * The scan's matrix in the Place frame. Anything that is not 16 finite numbers
 * is not a placement. The viewer leaves such a root at identity (`applyMatrix`
 * in viewer.ts returns early for a wrong length), and so does this, with a
 * warning.
 */
function scanMatrix(scan: ScanManifest, label: string, warnings: string[]): mat4 {
  const m = scan.localToWorld
  if (m.length === 16 && m.every(Number.isFinite)) return m as mat4
  warnings.push(`Scan "${label}" has no usable localToWorld; it is placed at the Place origin.`)
  return IDENTITY_MATRIX
}

/**
 * Moves the scan's default scene under its root node. `mergeDocuments` copies
 * the source's scenes into `doc`; `addChild` takes each child out of the copied
 * scene, which is then disposed, so `doc` ends up with one scene graph for the
 * whole Place.
 *
 * Only the default scene is drawn, matching the viewer, which takes
 * `gltf.scene`. Any other scene in the source is left out and warned about.
 */
function attachScanGeometry(
  doc: Document,
  root: GltfNode,
  source: Document,
  label: string,
  warnings: string[],
): void {
  const sourceRoot = source.getRoot()
  const sourceScenes = sourceRoot.listScenes()
  const sourceDefault = sourceRoot.getDefaultScene() ?? sourceScenes[0] ?? null
  const copies = mergeDocuments(doc, source)

  if (!sourceDefault) {
    warnings.push(`Scan "${label}" GLB has no scene, so its geometry is empty in this export.`)
  }
  for (const sourceScene of sourceScenes) {
    const copy = copies.get(sourceScene) as Scene | undefined
    if (!copy) continue
    if (sourceScene === sourceDefault) {
      for (const child of copy.listChildren()) root.addChild(child)
    }
    copy.dispose()
  }
  if (sourceScenes.length > 1) {
    warnings.push(`Scan "${label}" GLB has ${sourceScenes.length} scenes; only its default scene is exported, as the viewer draws it.`)
  }
}

function isFinitePoint(p: Vec3): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

function groupObservations(observations: ThingObservation[]): Map<string, ThingObservation[]> {
  const byThing = new Map<string, ThingObservation[]>()
  for (const observation of observations) {
    const list = byThing.get(observation.thingId)
    if (list) list.push(observation)
    else byThing.set(observation.thingId, [observation])
  }
  return byThing
}

/**
 * Observation count and contributing scans for one Thing. Read from its
 * ThingObservation rows; a Thing with no rows falls back to the two scans the
 * Thing itself records as first and last seen.
 */
function thingProvenance(thing: Thing, rows: ThingObservation[]): { observationCount: number; scanIds: string[] } {
  if (rows.length === 0) {
    return {
      observationCount: 0,
      scanIds: [...new Set([thing.firstSeenScanId, thing.lastSeenScanId])],
    }
  }
  return {
    observationCount: rows.length,
    scanIds: [...new Set(rows.map((row) => row.scanId))],
  }
}
