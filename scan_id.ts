/**
 * Id-derivation primitives shared by `main.ts` and the one-shot migrations.
 *
 * They live in their own module, rather than in `main.ts`, for exactly the
 * reason `world_prune.ts` and `scan_index.ts` do: `main.ts` cannot be imported
 * without running its unconditional top-level side effects (hostname
 * resolution, VLM engine load, `Deno.serve`), and `migrate_scan_ids.ts` needs
 * the *identical* derivation — not a second copy of it that can drift.
 * Per ADR 0001, one derivation point, not two.
 *
 * Deno-API-free on purpose (ADR 0002), though nothing in `src/` should import
 * it: the server owns scan identity.
 */
import type { ScanManifest } from './src/world/types.ts'

/**
 * Lowercase `raw` into the `[a-z0-9_-]` alphabet, collapsing runs of the
 * replacement character and trimming it from both ends.
 *
 * Lossy by construction: every character outside the alphabet maps to `-`, so
 * `a.b` and `a-b` slug identically. Any caller minting an *identifier* from a
 * filesystem- or user-controlled string must therefore assert uniqueness of
 * the results itself rather than assume it — `migrate_scan_ids.ts` does, and
 * fails loudly rather than silently deduping.
 */
export function safeSlug(raw: string | undefined, fallback = 'default'): string {
  const slug = (raw ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || fallback
}

/**
 * The single derivation of `ScanManifest.scanId`: one id per **uploaded
 * scan**, taken from that upload's filename.
 *
 * It deliberately does not consult `meta.sessionId`. It used to — a scan with
 * a sessionId got `scan-${safeSlug(sessionId)}` — which made the id name the
 * *walkthrough* instead of the scan. `DetectionStore` mints one sessionId per
 * browser tab (`src/scene/store.ts`) while `runAutoSave()` (`src/main.ts`)
 * uploads a fresh GLB every time it fires, so every autosave in a single
 * walkthrough collided onto one id. Observed live: four distinct GLBs with
 * four distinct detection counts sharing `scan-session-1787174216556`, three
 * of them silently dropped by the viewer's `loadedScans` map while the HUD
 * reported "1 scan loaded". See
 * docs/factory/07-scan-identity/0001-unique-scan-id-per-upload.md.
 *
 * The filename is unique by construction: `createScanFileExclusive`
 * (`main.ts`) creates it exclusively as `${ts}_${stem}${suffix}.glb`, with a
 * random suffix appended only on a genuine same-millisecond collision. So
 * `scanId` is *derived* rather than random — unlike `jobId` and `patchId`,
 * which use `crypto.randomUUID()` — which is what lets the same upload always
 * yield the same id and makes the migration idempotent by construction.
 *
 * Session-backed (video/photo-ingest) scans are deliberately unaffected:
 * `registerSessionScan` gives them the synthetic filename `${sessionId}.glb`,
 * so this returns `scan-${safeSlug(sessionId)}` for them — byte-identical to
 * what the old sessionId branch produced. Only multi-upload AR sessions are
 * re-identified.
 */
export function scanIdFor(filename: string): string {
  return `scan-${safeSlug(filename.replace(/\.glb$/, ''))}`
}

/**
 * The id a scan carried under the OLD (pre-0001) derivation: one id per
 * **capture session** rather than per upload — see `scanIdFor`'s doc comment
 * for what that meant in practice.
 *
 * Read from `ScanManifest.sessionId`, which ticket 0001 leaves untouched,
 * rather than from the stored `scanId` field: `refreshWorldScans` (`main.ts`)
 * self-heals a scan's own `scanId` to the new derivation on read, so by the
 * time anything asks "what was this scan's old id", the stored field may
 * already have moved. Reconstructing it from `sessionId` instead makes this
 * correct regardless of whether that self-heal has already run. A scan with
 * no `sessionId` always took the filename branch under the old derivation
 * too, so its id never moved and this returns the same value as `scanIdFor`.
 */
export function legacyScanId(scan: Pick<ScanManifest, 'sessionId' | 'filename'>): string {
  return scan.sessionId ? `scan-${safeSlug(scan.sessionId)}` : scanIdFor(scan.filename)
}
