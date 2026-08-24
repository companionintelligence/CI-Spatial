import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { belongsToWorldProject, scanProjectId, shouldIncludeStoredScanInWorld } from '../../../server/world/world_membership.ts'

Deno.test('project world includes only scans for that project', () => {
  assertEquals(belongsToWorldProject('proj-a', 'proj-a'), true)
  assertEquals(belongsToWorldProject('proj-a', 'proj-b'), false)
  assertEquals(belongsToWorldProject('proj-a', null), false)
})

Deno.test('legacy world keeps existing scans and accepts unassigned scans', () => {
  const existing = new Set(['kept.glb'])
  assertEquals(belongsToWorldProject(null, 'proj-a', existing, 'kept.glb'), true)
  assertEquals(belongsToWorldProject(null, null, existing, 'new.glb'), true)
  assertEquals(belongsToWorldProject(null, 'proj-a', existing, 'new.glb'), false)
})

Deno.test('stored scan membership preserves base predicate', () => {
  const scan = { filename: 'a.glb', size: 1, meta: { projectId: 'proj-a' } }
  assertEquals(shouldIncludeStoredScanInWorld('proj-a', scan, () => true), true)
  assertEquals(shouldIncludeStoredScanInWorld('proj-a', scan, () => false), false)
  assertEquals(scanProjectId({ projectId: '' }), null)
})
