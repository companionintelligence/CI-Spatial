/**
 * The Niantic Spatial XR Engine ships unmodified (scripts/native/check-xr-engine.mjs): the files in
 * public/ are the bytes Niantic publishes, and .gitattributes keeps a checkout from converting them.
 * On a Windows clone made before .gitattributes, the first test fails until the three .js files are
 * checked out again, which is the point: that copy is not the engine Niantic licenses.
 *
 * Run: npm run test:xr-engine
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENGINE_PACKAGE, ENGINE_SHA256, engineProblems } from '../../../scripts/native/check-xr-engine.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

test('the engine files in public/ are the bytes Niantic publishes', () => {
  assert.equal(ENGINE_PACKAGE, '@8thwall/engine-binary@1.0.0')
  assert.equal(Object.keys(ENGINE_SHA256).length, 12, 'xr.js, xr-slam.js, xr-face.js and the nine files in resources/')
  assert.deepEqual(engineProblems(join(ROOT, 'public')), [])
})

test('.gitattributes keeps every engine file from line-ending conversion', () => {
  const files = Object.keys(ENGINE_SHA256).map((file) => `public/${file}`)
  const out = execFileSync('git', ['check-attr', 'text', '--', ...files], { cwd: ROOT, encoding: 'utf8' })
  const lines = out.trim().split(/\r?\n/)
  assert.equal(lines.length, files.length)
  for (const line of lines) assert.match(line, /: text: unset$/, line)
})

test('a copy with converted line endings, or a missing file, is caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xr-engine-'))
  try {
    for (const file of Object.keys(ENGINE_SHA256)) {
      mkdirSync(join(dir, file, '..'), { recursive: true })
      copyFileSync(join(ROOT, 'public', file), join(dir, file))
    }
    assert.deepEqual(engineProblems(dir), [])
    writeFileSync(join(dir, 'xr.js'), readFileSync(join(dir, 'xr.js'), 'utf8').replace(/\n/g, '\r\n'))
    rmSync(join(dir, 'resources/powered-by.svg'))
    assert.deepEqual(engineProblems(dir).map(([file, problem]) => [file, problem.split(' ')[0]]), [
      ['xr.js', 'sha256'],
      ['resources/powered-by.svg', 'missing'],
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
