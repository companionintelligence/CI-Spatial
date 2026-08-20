/**
 * Per-node provenance for exported scan GLBs: which walkthrough, which scan,
 * which capture event produced a given node.
 *
 * Provenance used to be written once, at scene level, plus `sourceScanIds` on
 * detection meshes. Every other node — the point cloud, the camera path, the
 * floor plane, the Floor/Room groups — carried only `roomName`/`floorName`,
 * which are *place labels*, not identity: two walkthroughs of the same room
 * both write `Room_Unknown`. Merge two such files and the geometry is
 * anonymous. See docs/factory/07-scan-identity/0003-node-level-glb-provenance.md.
 *
 * ADR 0002: this file is imported by browser code (`src/export/gltf.ts`,
 * `src/viewer/editor.ts`) *and* by repo-root Deno code (`pipeline.ts`), so it
 * must stay free of `Deno.*`, of the DOM, and of `three`. It exports runtime
 * values as well as types, which is why it lives in `src/shared/` rather than
 * `src/world/` — ticket 0004's pipeline guard needs the key names at runtime.
 *
 * Import extensions differ by runtime and are load-bearing:
 *   from `src/`      → `from '../shared/provenance'`      (no extension, Vite/tsc)
 *   from repo root   → `from './src/shared/provenance.ts'` (with extension, Deno/node)
 */

/**
 * Per-node scan provenance. Every field name is already a field of
 * `ScanManifest` (`src/world/types.ts`) — this is that identity projected onto
 * a node rather than a new concept (ADR 0001).
 */
export interface ScanProvenance {
  /**
   * The walkthrough this node was captured in — `ScanManifest.sessionId`.
   * Written client-side.
   *
   * Nullable, and deliberately so: since 07-scan-identity/0002 a capture with
   * no server-side keyframe session records `null` rather than a client-local
   * id that names no directory. (Ticket 0003 originally specified a bare
   * `string`; 0002 landed first and widened it, which that ticket's own Open
   * Q&A anticipated — "if they diverge, they win".)
   */
  sessionId: string | null
  /**
   * The uploaded GLB this node belongs to — `ScanManifest.scanId`.
   *
   * Absent in a raw upload and stamped SERVER-side during the optimize pass
   * (ticket 0004), because the client cannot know it: the id is derived from
   * the stored filename, which the server chooses. Mirroring that derivation
   * client-side would be a second parallel implementation of an id algorithm —
   * the hazard CLAUDE.md flags for `resolveHostname()`. So `.opt.glb` and the
   * LODs carry all three fields; the raw `.glb` carries two.
   *
   * This is invisible in practice inside this app: `assignStableObjectIds()`
   * (`src/viewer/viewer.ts`) fills it from the manifest at load time when it is
   * absent, and a baked-in value wins. It matters only for a raw `.glb` opened
   * outside the app.
   */
  scanId?: string
  /** ISO-8601. One value per export, shared with `scene.userData.capturedAt`. */
  capturedAt: string
}

/** Detection nodes carry the scan provenance plus their capture event. */
export interface DetectionProvenance extends ScanProvenance {
  /**
   * Which capture produced this detection — `WorldDetection.captureIndex`.
   * Omitted rather than written as `null` when the detection has none, so a
   * consumer can tell "not attributed" from "attributed to nothing".
   */
  captureIndex?: number
  /**
   * The scans this node's geometry came from. Plural on purpose: after a
   * future merge, one node may correspond to the same physical thing seen in
   * several walkthroughs. Widening a persisted key later would be a migration.
   */
  sourceScanIds: string[]
}

/**
 * The extras keys that must survive the optimize pipeline (ticket 0004's
 * guard). A runtime value, not just a type — `prune()` runs with
 * `keepExtras: false` and `quantize()` reshapes detection nodes, so something
 * has to name these explicitly.
 */
export const NODE_PROVENANCE_KEYS = [
  'sessionId',
  'scanId',
  'capturedAt',
  'captureIndex',
  'sourceScanIds',
] as const

export type NodeProvenanceKey = typeof NODE_PROVENANCE_KEYS[number]
