/**
 * model-provisioning.ts — pure-helper tests, plus the manifest sync check.
 *
 * Only the parts of src/inference/model-provisioning.ts that don't touch
 * IndexedDB/fetch/navigator are exercised here, the same discipline
 * detection_store.test.ts uses (constructs DetectionStore without calling
 * open() so `db` stays null): this repo's Node test runner has no browser
 * globals and no fake-indexeddb polyfill, so importing the module is safe
 * only as long as nothing at module scope touches them, and only the pure
 * exports (MODEL_FILES, formatBytes, parseContentRangeTotal, overallState)
 * are called.
 *
 * The manifest-sync test mirrors sync.test.ts's approach (repo root) for
 * public/sw.js vs src/shared/storage-keys.ts: download_models.py is Python
 * and this module is TypeScript, so the two file lists are hand-kept in
 * sync rather than shared via import (see model-provisioning.ts's header)
 * — this test reads download_models.py's source and asserts they agree.
 *
 * Run: npm run test:model-provisioning
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MODEL_FILES,
  MODEL_META_FILES,
  MODEL_ONNX_FILES,
  MODEL_ID,
  formatBytes,
  parseContentRangeTotal,
  overallState,
} from '../../../src/inference/model-provisioning.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function extractPythonStringList(source: string, varName: string): string[] {
  const match = source.match(new RegExp(`${varName}\\s*=\\s*\\[([\\s\\S]*?)\\]`))
  assert.ok(match, `${varName} not found in download_models.py`)
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

test('MODEL_META_FILES + MODEL_ONNX_FILES match download_models.py exactly', () => {
  const source = readFileSync(`${REPO_ROOT}download_models.py`, 'utf-8')
  const pyMeta = extractPythonStringList(source, 'META')
  const pyOnnx = extractPythonStringList(source, 'ONNX_FILES')

  assert.deepEqual(
    [...MODEL_META_FILES],
    pyMeta,
    'MODEL_META_FILES has drifted from download_models.py\'s META list — keep them hand-in-sync (see model-provisioning.ts header)',
  )
  assert.deepEqual(
    [...MODEL_ONNX_FILES],
    pyOnnx,
    'MODEL_ONNX_FILES has drifted from download_models.py\'s ONNX_FILES list — keep them hand-in-sync (see model-provisioning.ts header)',
  )
  assert.equal(source.includes(MODEL_ID), true, 'download_models.py no longer references MODEL_ID — did the model change?')
})

test('MODEL_FILES is META followed by ONNX_FILES, with no duplicates', () => {
  assert.deepEqual([...MODEL_FILES], [...MODEL_META_FILES, ...MODEL_ONNX_FILES])
  assert.equal(new Set(MODEL_FILES).size, MODEL_FILES.length)
})

test('formatBytes: null/NaN read as unknown, not 0', () => {
  assert.equal(formatBytes(null), 'unknown size')
  assert.equal(formatBytes(Number.NaN), 'unknown size')
})

test('formatBytes: renders GB above the 0.1 GB threshold, MB below it', () => {
  assert.equal(formatBytes(2_372_813_312), '2.2 GB') // the measured decoder-shard-scale total
  assert.equal(formatBytes(500_000), '1 MB') // rounds up rather than reading as "0 MB"
  assert.equal(formatBytes(50 * 1024 * 1024), '50 MB') // well under the 0.1 GB (~107 MB) threshold
  assert.equal(formatBytes(150 * 1024 * 1024), '0.1 GB') // over the threshold, so GB even though it reads oddly short
})

test('parseContentRangeTotal: reads the total after the slash', () => {
  assert.equal(parseContentRangeTotal('bytes 0-0/2372813312'), 2372813312)
})

test('parseContentRangeTotal: "*" and missing headers are unknown, not 0', () => {
  assert.equal(parseContentRangeTotal('bytes 0-0/*'), null)
  assert.equal(parseContentRangeTotal(null), null)
})

test('overallState: absent until at least one file has started', () => {
  assert.equal(overallState([{ state: 'absent' }, { state: 'absent' }]), 'absent')
})

test('overallState: partial once any file has started but not every file is ready', () => {
  assert.equal(overallState([{ state: 'ready' }, { state: 'absent' }]), 'partial')
  assert.equal(overallState([{ state: 'ready' }, { state: 'partial' }]), 'partial')
})

test('overallState: ready only once every file is ready, and empty is not ready', () => {
  assert.equal(overallState([{ state: 'ready' }, { state: 'ready' }]), 'ready')
  assert.equal(overallState([]), 'absent')
})
