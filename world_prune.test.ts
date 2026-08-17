/**
 * Tests for the world-manifest prune guard.
 *
 * The regression these exist for: a `scans/` directory holding one file next
 * to a manifest describing 253 took the manifest down to 1 on a single read.
 * `refuses to prune when the directory holds fewer scans than the manifest`
 * is that incident, at its real scale.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { pruneScansMissingFromDisk } from './world_prune.ts'

type Entry = { filename?: string; name?: string }

const entries = (...names: string[]): Entry[] => names.map(filename => ({ filename }))
const onDisk = (...names: string[]) => new Set(names)

Deno.test('pruneScansMissingFromDisk: drops a stale entry when the listing is complete', () => {
  const scans = entries('a.glb', 'b.glb')
  // Disk still holds two eligible scans — b was replaced by c, not lost.
  const result = pruneScansMissingFromDisk(scans, onDisk('a.glb', 'c.glb'), 2)

  assertEquals(result.skipped, null)
  assertEquals(result.pruned, 1)
  assertEquals(result.missing, 1)
  assertEquals(result.scans.map(s => s.filename), ['a.glb'])
})

Deno.test('pruneScansMissingFromDisk: refuses to prune when the directory holds fewer scans than the manifest', () => {
  // The real incident: 253 entries, one file left on disk.
  const scans = entries(...Array.from({ length: 253 }, (_, i) => `scan-${i}.glb`))
  const result = pruneScansMissingFromDisk(scans, onDisk('scan-0.glb'), 1)

  assertEquals(result.skipped, 'listing-thinner-than-manifest')
  assertEquals(result.pruned, 0)
  assertEquals(result.missing, 252)
  assertEquals(result.scans.length, 253, 'the manifest must survive a thin listing intact')
})

Deno.test('pruneScansMissingFromDisk: one missing file does not cost the manifest that entry', () => {
  // A single out-of-band deletion makes the listing thinner, so the entry
  // lingers rather than being dropped. Deliberate: DELETE /scans is the path
  // that removes entries, because it knows the file is gone.
  const scans = entries('a.glb', 'b.glb', 'c.glb')
  const result = pruneScansMissingFromDisk(scans, onDisk('a.glb', 'b.glb'), 2)

  assertEquals(result.skipped, 'listing-thinner-than-manifest')
  assertEquals(result.pruned, 0)
  assertEquals(result.missing, 1)
})

Deno.test('pruneScansMissingFromDisk: an empty listing is ambiguous and never prunes', () => {
  const scans = entries('a.glb', 'b.glb')
  const result = pruneScansMissingFromDisk(scans, onDisk(), 0)

  assertEquals(result.skipped, 'empty-listing')
  assertEquals(result.pruned, 0)
  assertEquals(result.scans.length, 2)
})

Deno.test('pruneScansMissingFromDisk: an entry with no filename is never a prune candidate', () => {
  const scans: Entry[] = [{ name: 'not file-backed' }, { filename: 'a.glb' }]
  const result = pruneScansMissingFromDisk(scans, onDisk('a.glb', 'b.glb'), 2)

  assertEquals(result.skipped, null)
  assertEquals(result.pruned, 0)
  assertEquals(result.missing, 0)
  assertEquals(result.scans.length, 2)
})

Deno.test('pruneScansMissingFromDisk: a listing richer than the manifest still prunes', () => {
  // Disk has grown past the manifest; it is credible, so a stale entry goes.
  const scans = entries('a.glb', 'gone.glb')
  const result = pruneScansMissingFromDisk(scans, onDisk('a.glb', 'b.glb', 'c.glb'), 3)

  assertEquals(result.skipped, null)
  assertEquals(result.pruned, 1)
  assertEquals(result.scans.map(s => s.filename), ['a.glb'])
})

Deno.test('pruneScansMissingFromDisk: an empty manifest is left alone', () => {
  const result = pruneScansMissingFromDisk([] as Entry[], onDisk('a.glb'), 1)

  assertEquals(result.skipped, null)
  assertEquals(result.pruned, 0)
  assertEquals(result.scans.length, 0)
})

Deno.test('pruneScansMissingFromDisk: does not mutate the input array', () => {
  const scans = entries('a.glb', 'gone.glb')
  pruneScansMissingFromDisk(scans, onDisk('a.glb', 'b.glb'), 2)

  assertEquals(scans.length, 2, 'caller’s array must be untouched')
})
