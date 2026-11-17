/**
 * Detection parsing: the box forms a vision model actually returns, and what each one
 * becomes. The prompt asks for "bbox" as 0–1 fractions. The model sometimes answers in its
 * grounding format instead ("bbox_2d" or "box_2d", on a 0–1000 grid), and sometimes mixes
 * the two in one reply. Every form must come out on the same 0–1 scale, and a reply in
 * grid form must not come back empty.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { parseDetections } from '../../../server/prompt.ts'

const reply = (...items: unknown[]) => '```json\n' + JSON.stringify(items) + '\n```'

Deno.test('bbox as 0-1 fractions, the prompt shape, is read unchanged', () => {
  const out = parseDetections(reply(
    { label: 'sofa', bbox: [0.12, 0.3, 0.64, 0.72], confidence: 0.97, description: 'red sofa' },
  ))
  assertEquals(out.map((d) => d.bbox), [[0.12, 0.3, 0.64, 0.72]])
})

Deno.test('bbox_2d on the 0-1000 grid is read as the same box', () => {
  const out = parseDetections(reply(
    { label: 'sofa', bbox_2d: [120, 300, 640, 720], confidence: 0.97, description: 'red sofa' },
  ))
  assertEquals(out.map((d) => d.bbox), [[0.12, 0.3, 0.64, 0.72]])
})

Deno.test('box_2d is read the same way', () => {
  const out = parseDetections(reply(
    { label: 'sofa', box_2d: [120, 300, 640, 720], confidence: 0.97, description: 'red sofa' },
  ))
  assertEquals(out.map((d) => d.bbox), [[0.12, 0.3, 0.64, 0.72]])
})

Deno.test('a reply in grid form keeps every object instead of coming back empty', () => {
  const out = parseDetections(reply(
    { label: 'sofa', bbox_2d: [120, 300, 640, 720], confidence: 0.97, description: 'red sofa' },
    { label: 'lamp', bbox_2d: [700, 100, 760, 260], confidence: 0.91, description: 'brass floor lamp' },
  ))
  assertEquals(out.map((d) => d.label), ['sofa', 'lamp'])
})

Deno.test('a box that mixes fractions with grid values is dropped, not pinned as a sliver', () => {
  const out = parseDetections(reply(
    { label: 'table', bbox: [0.83, 444, 1.05, 829], confidence: 0.93, description: 'table' },
    { label: 'sofa', bbox: [0.12, 0.3, 0.64, 0.72], confidence: 0.97, description: 'red sofa' },
  ))
  assertEquals(out.map((d) => d.label), ['sofa'])
  assertEquals(out[0].bbox, [0.12, 0.3, 0.64, 0.72])
})
