import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(here, '../src-tauri/tauri.conf.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(here, '../package.json'), 'utf8'));

test('Scan desktop is a bundled Tauri app with a local development server', () => {
  assert.equal(config.productName, 'Companion Scan');
  assert.equal(config.build.devUrl, 'http://localhost:5173');
  assert.equal(path.basename(config.build.frontendDist), 'dist');
  assert.equal(config.app.security.capabilities.includes('default'), true);
  assert.equal(config.build.serverUrl, undefined);
  assert.equal(pkg.devDependencies['@tauri-apps/cli'], '2.12.4');
});

test('Scan desktop policy keeps TLS for remote services and WebAssembly for local inference', () => {
  const csp = config.app.security.csp;
  assert.match(csp, /connect-src[^;]*https:/);
  assert.match(csp, /script-src[^;]*wasm-unsafe-eval/);
});

test('desktop build generates all required platform icons', () => {
  assert.deepEqual(config.bundle.icon, ['icons/32x32.png', 'icons/128x128.png', 'icons/128x128@2x.png', 'icons/icon.icns', 'icons/icon.ico']);
  assert.match(pkg.scripts.icons, /^tauri icon /);
  assert.match(pkg.scripts.build, /npm run icons && tauri build/);
});
