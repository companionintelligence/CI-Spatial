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

// ── Why the ids, and not only the names ──────────────────────────────────────
//
// The names above are NOT the names the checkpoint uses. Measured by diffing
// this file against `id2label` in the cached config of
// facebook/mask2former-swin-large-ade-panoptic: 140 of 150 agree and 10 are the
// same class under a different synonym. Two of those ten are isthing=0 either
// way and harmless ("pool"/"swimming pool", "falls"/"waterfall"). The other
// eight are all isthing=1 here, so a name compare filed every one of them as a
// room surface:
//
//     id   8  upstream "window "     → checkpoint "windowpane"
//     id  37  upstream "tub"         → checkpoint "bathtub"
//     id  38  upstream "rail"        → checkpoint "railing"
//     id  87  upstream "street lamp" → checkpoint "streetlight"
//     id  89  upstream "tv"          → checkpoint "television receiver"
//     id  90  upstream "plane"       → checkpoint "airplane"
//     id  92  upstream "clothes"     → checkpoint "apparel"
//     id 138  upstream "trash can"   → checkpoint "ashcan"
//
// Silent, and in the direction the split is deliberately biased toward, so it
// never looked like an error — a real phone capture lost 7 `windowpane` and 1
// `ashcan` sighting to it. The class *id* is the stable key: both sides are the
// canonical ADE20K-150 ordering, so `thingIds` is exact where a name compare is
// a guess. `names` ships alongside so the worker can prove the checkpoint is
// this taxonomy before trusting an id (see panoptic_worker.py) — an id means
// nothing on a COCO or Cityscapes checkpoint.
const thingIds = all.filter((c) => c.isthing).map((c) => c.id).sort((a, b) => a - b)
const names = Object.fromEntries(all.map((c) => [c.id, c.name]))

const payload = {
  _source: SOURCE,
  _generatedBy: 'scripts/fetch-ade20k-things.mjs',
  _note:
    'ADE20K-150 classes flagged isthing=1 upstream. `thingIds` is authoritative; ' +
    '`things` is the same set by name (plus the leading synonym of each ' +
    'comma-separated name) and is the fallback for a checkpoint whose taxonomy ' +
    'is not this one. `names` lets a consumer verify that first. ' +
    'Consumed by scripts/panoptic_worker.py --thing-labels.',
  count: things.length,
  thingIds,
  names,
  things: things.sort((a, b) => a.localeCompare(b)),
}

await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n')
console.log(`${all.length} categories → ${thingIds.length} things (${things.length} names with synonyms)`)
console.log(`wrote ${OUT.pathname}`)
