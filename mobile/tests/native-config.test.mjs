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
