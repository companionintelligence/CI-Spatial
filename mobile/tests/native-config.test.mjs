import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = await readFile(path.join(here, '../capacitor.config.ts'), 'utf8');

test('Scan mobile bundles the app and uses the permanent-candidate identifier', () => {
  assert.match(config, /appId:\s*'com\.companionintelligence\.scan'/);
  assert.match(config, /appName:\s*'Scan'/);
  assert.match(config, /webDir:\s*'www'/);
  assert.doesNotMatch(config, /server:\s*\{[^}]*url:/s);
});

test('Scan mobile denies cleartext networking and enables readable text zoom', () => {
  assert.match(config, /cleartext:\s*false/);
  assert.match(config, /zoomEnabled:\s*true/);
  assert.match(config, /CapacitorHttp:\s*\{\s*enabled:\s*false\s*\}/);
});

test('a shell build may leave VITE_API_BASE unset; a value it is given must be an https origin', async () => {
  const { apiBaseProblem } = await import('../scripts/check-api-base.mjs');
  assert.equal(apiBaseProblem(undefined), null, 'unset: the app asks for its server on first run');
  assert.equal(apiBaseProblem(''), null);
  assert.equal(apiBaseProblem('https://scan.example.ts.net'), null);
  assert.equal(apiBaseProblem('https://scan.example.ts.net/'), null);
  for (const bad of ['http://scan.example.ts.net', 'https://scan.example.ts.net/editor', 'https://scan.example.ts.net/?x=1', 'scan.example.ts.net']) {
    assert.match(apiBaseProblem(bad) ?? '', /https origin|origin, for example/, bad);
  }
});
