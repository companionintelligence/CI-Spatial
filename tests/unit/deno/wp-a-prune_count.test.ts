/**
 * The prune guard counts only the world's own scans (server/wp-a-prune-count.ts), so each Place's
 * manifest rows are judged against that Place's own files, not against the scans other Places hold
 * in the scans directory. These tests use two Places: Place A's files are gone, and Place B's fill
 * the directory.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { eligibleOnDiskForWorld } from '../../../server/wp-a-prune-count.ts'
import { pruneScansMissingFromDisk } from '../../../server/world/world_prune.ts'

type Stored = { filename: string; size: number; meta: Record<string, unknown> }

const stored = (filename: string, projectId?: string): Stored => ({
  filename,
  size: 10_000,
  meta: projectId ? { projectId } : {},
})

// Stands in for the size and geo predicate that main.ts applies to every scan.
const inAnyPlace = () => true

// Place A's .glb files are gone from scans/. Place B's three scans fill the directory.
const onDisk: Stored[] = [stored('b1.glb', 'place-b'), stored('b2.glb', 'place-b'), stored('b3.glb', 'place-b')]
const onDiskNames = new Set(onDisk.map(scan => scan.filename))
const placeAManifest = [{ filename: 'a1.glb' }, { filename: 'a2.glb' }]
const placeAManifestNames = new Set(placeAManifest.map(scan => scan.filename))

Deno.test('a Place whose files are gone is not pruned because another Place fills the directory', () => {
  const eligible = eligibleOnDiskForWorld('place-a', onDisk, inAnyPlace, placeAManifestNames)
  assertEquals(eligible, 0, 'Place A has no scans on disk')

  const result = pruneScansMissingFromDisk(placeAManifest, onDiskNames, eligible)
  assertEquals(result.pruned, 0)
  assertEquals(result.skipped, 'listing-thinner-than-manifest')
  assertEquals(result.scans.length, 2, 'both of Place A\'s rows are kept')
})

Deno.test('counting every Place would have pruned that manifest (the defect this guards)', () => {
  // A count of every Place's scans, not this world's own, would be three here. That is not thinner than
  // Place A's two-row manifest, so the guard would pass and both rows would be pruned.
  const everyPlace = onDisk.length
  const result = pruneScansMissingFromDisk(placeAManifest, onDiskNames, everyPlace)
  assertEquals(result.pruned, 2, 'the old count let both rows go')
})

Deno.test('a Place whose own files are all present counts its own, whatever other Places hold', () => {
  const disk = [...onDisk, stored('a1.glb', 'place-a'), stored('a2.glb', 'place-a')]
  const eligible = eligibleOnDiskForWorld('place-a', disk, inAnyPlace, placeAManifestNames)
  assertEquals(eligible, 2)

  const result = pruneScansMissingFromDisk(placeAManifest, new Set(disk.map(scan => scan.filename)), eligible)
  assertEquals(result.skipped, null)
  assertEquals(result.pruned, 0, 'nothing is stale, so nothing is pruned')
})

Deno.test('a Place with a stale row beside its complete files keeps that row: the guard stays conservative', () => {
  // With a per-Place count, any stale row makes the on-disk count fall below the manifest length,
  // so the guard skips pruning. Revisit world_prune.ts's comparison before relying on self-heal.
  const manifest = [{ filename: 'a1.glb' }, { filename: 'a2.glb' }, { filename: 'gone.glb' }]
  const disk = [...onDisk, stored('a1.glb', 'place-a'), stored('a2.glb', 'place-a')]
  const eligible = eligibleOnDiskForWorld('place-a', disk, inAnyPlace, new Set(manifest.map(scan => scan.filename)))
  assertEquals(eligible, 2)

  const result = pruneScansMissingFromDisk(manifest, new Set(disk.map(scan => scan.filename)), eligible)
  assertEquals(result.skipped, 'listing-thinner-than-manifest')
  assertEquals(result.pruned, 0)
})
