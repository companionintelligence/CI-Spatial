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

const capabilities = JSON.parse(await readFile(path.join(here, '../src-tauri/capabilities/default.json'), 'utf8'));
const cargoToml = await readFile(path.join(here, '../src-tauri/Cargo.toml'), 'utf8');
const mainRs = await readFile(path.join(here, '../src-tauri/src/main.rs'), 'utf8');

test('the Rust crates are pinned to published versions, tauri-build to the one Cargo.lock holds', async () => {
  const lock = await readFile(path.join(here, '../src-tauri/Cargo.lock'), 'utf8');
  const locked = (name) => lock.match(new RegExp(`name = "${name}"\r?\nversion = "([^"]+)"`))?.[1];
  for (const name of ['tauri', 'tauri-build', 'tauri-plugin-deep-link', 'tauri-plugin-opener', 'tauri-plugin-single-instance']) {
    const pinned = cargoToml.match(new RegExp(`^${name} = (?:\{ version = )?"=([^"]+)"`, 'm'))?.[1];
    assert.ok(pinned, `${name} is pinned with =`);
    assert.equal(locked(name), pinned, `${name}: Cargo.toml and Cargo.lock agree`);
  }
  assert.match(cargoToml, /tauri-plugin-single-instance = \{[^}]*features = \["deep-link"\]/, 'a second launch hands its link to the first');
});

test('sign-in comes back through the desktop app scheme, and the app opens only https pages outside itself', () => {
  assert.equal(config.app.withGlobalTauri, true, 'src/shared/shell-sign-in.ts reads window.__TAURI__');
  assert.deepEqual(config.plugins['deep-link'].desktop.schemes, ['computer.ci.scan.desktop']);
  assert.deepEqual(capabilities.windows, ['main']);
  const opener = capabilities.permissions.filter((p) => (typeof p === 'string' ? p : p.identifier).startsWith('opener:'));
  assert.deepEqual(opener, [{ identifier: 'opener:allow-open-url', allow: [{ url: 'https://*' }] }], 'no file paths, no plain http');
  assert.ok(capabilities.permissions.includes('deep-link:default'));
  const singleInstance = mainRs.indexOf('tauri_plugin_single_instance::init');
  assert.ok(singleInstance > 0 && singleInstance < mainRs.indexOf('tauri_plugin_deep_link::init'), 'single-instance is registered first');
});
