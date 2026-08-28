/**
 * Generate the ADE20K-150 "thing" label list from its authoritative source.
 *
 *   node scripts/fetch-ade20k-things.mjs
 *   → server/panoptic/ade20k-things.json
 *
 * Why a generator instead of a checked-in hand-written list: the panoptic worker
 * refuses to guess which classes are discrete objects, because the checkpoint
 * carries no `thing_ids` and a wrong entry marking `wall` a thing is exactly the
 * failure `panoptic_segments.ts` exists to prevent (thing_match throws at
 * MAX_THINGS_PER_WORLD and nothing prunes). A list transcribed by hand would be
 * a second, silently-wrong copy of the dataset's own metadata — the hazard ADR
 * 0001 is about. This reads the flags from the Mask2Former repo that trained the
 * checkpoint we default to, so the list and the weights agree by construction.
 *
 * The generated file is committed so a clone needs no network; re-run this to
 * refresh it, and the `_source` field records where it came from.
 */
import { writeFile } from 'node:fs/promises'
import process from 'node:process'

const SOURCE =
  'https://raw.githubusercontent.com/facebookresearch/Mask2Former/main/mask2former/data/datasets/register_ade20k_panoptic.py'
const OUT = new URL('../server/panoptic/ade20k-things.json', import.meta.url)

const res = await fetch(SOURCE)
if (!res.ok) {
  console.error(`fetch ${SOURCE} -> ${res.status}`)
  process.exit(1)
}
const text = await res.text()

// Each entry looks like:
//   {"color": [120, 120, 120], "id": 0, "isthing": 0, "name": "wall"},
// but longer names are black-formatted across several lines WITH a trailing
// comma before the brace, so both the newlines and that comma are optional here
// — an earlier stricter pattern silently matched only 141 of 150.
// Parsed with a regex rather than by evaluating Python: the file also builds
// Detectron2 MetadataCatalog entries, which are not ours to execute.
const ENTRY = /\{\s*"color":\s*\[[^\]]*\],\s*"id":\s*(\d+),\s*"isthing":\s*(\d+),\s*"name":\s*"([^"]+)",?\s*\}/g

const all = []
for (const m of text.matchAll(ENTRY)) {
  all.push({ id: Number(m[1]), isthing: m[2] === '1', name: m[3] })
}

if (all.length !== 150) {
  // ADE20K-150 has exactly 150 classes. A different count means the upstream
  // format moved and this parser is now reading something else — fail loudly
  // rather than emit a plausible, wrong list.
  console.error(`expected 150 ADE20K categories, parsed ${all.length} — upstream format changed?`)
  process.exit(1)
}

// The worker matches on the model's own label strings, which for this checkpoint
// are the same names. ADE20K names carry comma-separated synonyms
// ("computer, computing machine, ..."); the model's id2label uses the full
// string, so keep it verbatim AND add the leading alias, and match on either.
const things = []
for (const c of all.filter((c) => c.isthing)) {
  things.push(c.name)
  const head = c.name.split(',')[0].trim()
  if (head && head !== c.name) things.push(head)
}

const payload = {
  _source: SOURCE,
  _generatedBy: 'scripts/fetch-ade20k-things.mjs',
  _note:
    'ADE20K-150 classes flagged isthing=1 upstream, plus the leading synonym of ' +
    'each comma-separated name. Consumed by scripts/panoptic_worker.py --thing-labels.',
  count: things.length,
  things: things.sort((a, b) => a.localeCompare(b)),
}

await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n')
console.log(`${all.length} categories → ${all.filter((c) => c.isthing).length} things (${things.length} with synonyms)`)
console.log(`wrote ${OUT.pathname}`)
