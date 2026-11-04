/**
 * The static build on Cloudflare Pages (docs/operations/DEPLOY.md). Pages falls
 * back to index.html with a 200 for every unknown path unless the build has a
 * 404.html. With one, a link to a path that only the Deno server knows opens the
 * 404 page, so every link the pages ship has to resolve without that server.
 *
 * Run: npm run test:public-site
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/** Source path, Pages path: `_redirects` lines, skipping comments. */
function rewrites(): Map<string, string> {
  const lines = read('public/_redirects').split('\n').filter((l) => l.trim() && !l.startsWith('#'))
  return new Map(lines.map((l) => {
    const [from, to, status] = l.trim().split(/\s+/)
    assert.equal(status, '200', `${l}: a rewrite keeps the address, so the page can read its own URL`)
    return [from!, to!]
  }))
}

test('the build has a top-level 404 page, which is what turns the Pages fallback off', () => {
  assert.ok(existsSync(join(ROOT, 'public/404.html')))
})

test('/editor is rewritten to a page the build produces', () => {
  const target = rewrites().get('/editor')
  assert.ok(target, '/editor must be in public/_redirects')
  assert.match(read('vite.config.ts'), new RegExp(`'${target!.slice(1)}\\.html'`), `${target} is not a Vite entry`)
})

test('every same-origin link in the shipped pages resolves without the Deno server', () => {
  const known = rewrites()
  for (const page of ['index.html', 'viewer.html', 'webxr.html', 'public/smoke.html']) {
    for (const [, path] of read(page).matchAll(/href="(\/[^"?#]*)/g)) {
      // viewer.ts removes the one sign-in link when the server has no such route.
      if (path!.startsWith('/authenticate/')) continue
      const resolves = path === '/' || known.has(path!) || existsSync(join(ROOT, 'public', path!)) || existsSync(join(ROOT, path!))
      assert.ok(resolves, `${page} links to ${path}, which Pages would answer with the 404 page`)
    }
  }
})
