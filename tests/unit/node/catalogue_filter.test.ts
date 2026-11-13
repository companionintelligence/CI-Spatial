/**
 * Catalogue rules for the Things tab and Items tree: what a row is called, which
 * rows survive the search, label and scan filters, and which labels the label
 * filter offers.
 *
 * The labels are the kind the reconstruction produces: lower-case noun phrases,
 * a relabel that differs from the AI label, and one thing seen in two scans.
 *
 * Run: npm run test:catalogue-filter
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { displayLabel, filterCatalogue, labelOptions, type CatalogueItem } from '../../../src/viewer/catalogue-filter.ts'

const chair: CatalogueItem = { id: 'thing-chair', aiLabel: 'chair', userLabel: null, scanIds: ['scan-a', 'scan-b'] }
const lamp: CatalogueItem = { id: 'thing-lamp', aiLabel: 'lamp', userLabel: 'floor lamp', scanIds: ['scan-a'] }
const table: CatalogueItem = { id: 'thing-table', aiLabel: 'table', userLabel: null, scanIds: ['scan-b'] }
// Renamed away from its AI label, so only the AI label says "desk".
const desk: CatalogueItem = { id: 'thing-desk', aiLabel: 'desk', userLabel: 'writing table', scanIds: ['scan-b'] }
const catalogue = [chair, lamp, table]

const ids = (items: readonly CatalogueItem[]) => items.map(item => item.id)

test('a relabelled item shows its own label, and an item without one shows the AI label', () => {
  assert.equal(displayLabel(lamp), 'floor lamp')
  assert.equal(displayLabel(chair), 'chair')
})

test('a blank user label does not replace the AI label', () => {
  assert.equal(displayLabel({ aiLabel: 'chair', userLabel: '   ' }), 'chair')
  assert.equal(displayLabel({ aiLabel: 'chair', userLabel: '' }), 'chair')
})

test('a cleared user label, stored as null, reads the AI label again', () => {
  assert.equal(displayLabel({ aiLabel: 'lamp', userLabel: null }), 'lamp')
})

test('surrounding whitespace is trimmed from both labels', () => {
  assert.equal(displayLabel({ aiLabel: ' chair ', userLabel: ' armchair ' }), 'armchair')
  assert.equal(displayLabel({ aiLabel: ' chair ', userLabel: null }), 'chair')
})

test('label options are the distinct display labels, sorted, with case variants counted once', () => {
  const options = labelOptions([
    ...catalogue,
    { id: 'case-variant', aiLabel: 'Chair', userLabel: null, scanIds: ['scan-b'] },
    { id: 'case-variant-two', aiLabel: 'lamp', userLabel: 'Floor lamp', scanIds: ['scan-b'] },
  ])
  assert.deepEqual(options, ['chair', 'floor lamp', 'table'])
})

test('a label the user replaced is not offered, because no row shows it any more', () => {
  assert.equal(labelOptions([lamp]).includes('lamp'), false)
  assert.deepEqual(labelOptions([lamp]), ['floor lamp'])
})

test('label options skip blank labels and tolerate an empty catalogue', () => {
  assert.deepEqual(labelOptions([]), [])
  assert.deepEqual(labelOptions([{ id: 'blank', aiLabel: '  ', userLabel: null, scanIds: [] }]), [])
})

test('with no filter, every item comes back in its original order', () => {
  assert.deepEqual(ids(filterCatalogue(catalogue)), ['thing-chair', 'thing-lamp', 'thing-table'])
  assert.deepEqual(ids(filterCatalogue(catalogue, {})), ids(catalogue))
  assert.deepEqual(ids(filterCatalogue(catalogue, { query: '   ', scanId: '', label: '  ' })), ids(catalogue))
})

test('the search is a case-insensitive substring of the display label', () => {
  assert.deepEqual(ids(filterCatalogue(catalogue, { query: 'FLOOR' })), ['thing-lamp'])
  assert.deepEqual(ids(filterCatalogue(catalogue, { query: 'ab' })), ['thing-table'])
  assert.deepEqual(ids(filterCatalogue(catalogue, { query: 'zzz' })), [])
})

test('the search also reads the AI label, so a relabelled item is still found by what it was called', () => {
  assert.deepEqual(ids(filterCatalogue([desk, table], { query: 'desk' })), ['thing-desk'])
})

test('search terms are OR-ed and a leading dash hides, the same as the editor filter', () => {
  assert.deepEqual(ids(filterCatalogue(catalogue, { query: 'chair, table' })), ['thing-chair', 'thing-table'])
  assert.deepEqual(ids(filterCatalogue(catalogue, { query: 'chair -table' })), ['thing-chair'])
  assert.deepEqual(ids(filterCatalogue(catalogue, { query: '-lamp' })), ['thing-chair', 'thing-table'])
})

test('an exclusion checks the AI label too, so -desk hides the renamed desk', () => {
  assert.deepEqual(ids(filterCatalogue([desk, table], { query: '-desk' })), ['thing-table'])
})

test('the scan filter keeps the items seen in that scan', () => {
  assert.deepEqual(ids(filterCatalogue(catalogue, { scanId: 'scan-a' })), ['thing-chair', 'thing-lamp'])
  assert.deepEqual(ids(filterCatalogue(catalogue, { scanId: 'scan-b' })), ['thing-chair', 'thing-table'])
  assert.deepEqual(ids(filterCatalogue(catalogue, { scanId: 'scan-z' })), [])
})

test('the label filter matches the display label exactly, ignoring case, and not the AI label', () => {
  assert.deepEqual(ids(filterCatalogue(catalogue, { label: 'Floor Lamp' })), ['thing-lamp'])
  assert.deepEqual(ids(filterCatalogue(catalogue, { label: 'lamp' })), [])
  assert.deepEqual(ids(filterCatalogue(catalogue, { label: 'floor' })), [])
})

test('filters combine, so each one narrows the rows the others left', () => {
  assert.deepEqual(ids(filterCatalogue(catalogue, { scanId: 'scan-b', query: 'chair' })), ['thing-chair'])
  assert.deepEqual(ids(filterCatalogue(catalogue, { scanId: 'scan-a', label: 'table' })), [])
  assert.deepEqual(ids(filterCatalogue(catalogue, { scanId: 'scan-a', label: 'floor lamp', query: 'lamp' })), ['thing-lamp'])
})

test('filtering returns a new array and leaves the input unchanged', () => {
  const before = JSON.stringify(catalogue)
  const kept = filterCatalogue(catalogue, { query: 'chair', scanId: 'scan-a', label: 'chair' })
  assert.notEqual(kept, catalogue)
  assert.equal(JSON.stringify(catalogue), before)
})
