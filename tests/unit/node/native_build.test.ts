/**
 * The web build the native shells ship (scripts/native/build-web.mjs): what it refuses to
 * build with, and what it checks the finished bundle for. The build itself runs in the shells'
 * own builds; these cases run on a scratch folder.
 *
 * Run: npm run test:native-build
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENGINE_FILES,
  NATIVE_EXCLUDED,
  OUT_DIRS,
  PWA_FILES,
  forbiddenInBundle,
  viteVariablesInEnvFiles,
} from '../../../scripts/native/build-web.mjs'

function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'native-build-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

test('each shell builds into its own folder, never the web build in dist/', () => {
  assert.deepEqual(OUT_DIRS, { desktop: 'desktop/dist', mobile: 'mobile/www' })
})

test('a .env file that sets a VITE_ variable is found, so a native build can refuse it', () => {
  const dir = scratch({
    '.env': '# VITE_HOSTNAME=commented.example\nOLLAMA_HOST=http://localhost:11434\nVITE_HOSTNAME=machine.tailnet.ts.net\n',
    '.env.production.local': 'export VITE_API_BASE=https://scan.example.ts.net\n',
    '.env.example': 'VITE_PORT=5173\n',
  })
  try {
    assert.deepEqual(viteVariablesInEnvFiles(dir), [['.env', 'VITE_HOSTNAME'], ['.env.production.local', 'VITE_API_BASE']])
    assert.deepEqual(viteVariablesInEnvFiles(scratch({ '.env': 'SESSION_SECRET=x\n' })), [], 'only VITE_ variables reach a bundle')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no app bundle may hold the on-device model weights, whose licence is unchecked, or the test-only files', () => {
  assert.deepEqual(Object.keys(NATIVE_EXCLUDED), ['models', 'real-camera-artifacts', 'test-fixtures'])
  assert.match(NATIVE_EXCLUDED.models, /LFM2\.5-VL/)
  const dir = scratch({ 'index.html': '', 'models/LFM2.5-VL-1.6B-ONNX/onnx/model.onnx': '', 'test-fixtures/room.jpg': '' })
  try {
    for (const shell of ['desktop', 'mobile'] as const) {
      assert.deepEqual(forbiddenInBundle(dir, shell), ['models', 'test-fixtures'], shell)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the desktop bundle may not hold the AR engine; neither bundle may hold the PWA files', () => {
  const dir = scratch({
    'index.html': '', 'viewer.html': '', 'xr.js': '', 'xr-slam.js': '', 'resources/media-worker.js': '', 'sw.js': '',
  })
  try {
    assert.deepEqual(ENGINE_FILES, ['xr.js', 'xr-slam.js', 'xr-face.js', 'resources'])
    assert.deepEqual(PWA_FILES, ['sw.js', 'manifest.json'])
    assert.deepEqual(forbiddenInBundle(dir, 'desktop'), ['sw.js', 'xr.js', 'xr-slam.js', 'resources'])
    assert.deepEqual(forbiddenInBundle(dir, 'mobile'), ['sw.js'], 'the Android app ships the engine, which it runs')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
