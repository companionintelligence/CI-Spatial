/**
 * The Docker image can build: every file under src/ that the server imports, directly or through
 * another file, is one the Dockerfile copies into the image.
 *
 * `RUN deno cache server/main.ts` stops with "Module not found" at the first import the image does
 * not hold, and nothing else notices: publishing is workflow_dispatch-only, so a missing COPY line
 * shows up at the next release and not in a pull request. It has happened twice (src/inference, in
 * the 2026-09-06 publish run, and src/geo/tile-source.ts, the module the maps and the server share
 * for the map tile setting). The Dockerfile copies `server/` whole and then names the parts of
 * `src/` the server reaches, so the list has to follow the imports. This follows them.
 *
 * Reads the Dockerfile, `.dockerignore` and the source; runs nothing. A file is followed through
 * every `import`, `export ... from` and `import()` with a relative `.ts` path, type-only imports
 * included, because `deno cache` resolves those too.
 *
 * Runs with `npm run test:wave` (the wp- prefix), or alone:
 *   node --experimental-strip-types --no-warnings --test tests/unit/node/wp-docker-server-imports.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** The text of a repo file, or null when it does not exist. */
type ReadRepoFile = (path: string) => string | null
const readFromDisk: ReadRepoFile = (path) => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), 'utf8') : null)

/** Every .ts file under `dir`, as a path from the repo root. */
function tsFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...tsFiles(path))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

/** The last stage of a Dockerfile: the Deno server, where `deno cache server/main.ts` runs. The web stage before it copies all of src/, and none of that is in this image. */
function lastStage(dockerfile: string): string {
  const stages = dockerfile.split(/^FROM\b.*$/m)
  return stages[stages.length - 1]!
}

/**
 * The repo paths the last stage's COPY lines put at the same path in the image: a directory (a
 * source ending in a slash), a single file, or a `*.ts` glob at the root. A `--from=` copy takes
 * files from another stage, not from the repo, and a path that does not land at its own place is
 * not counted.
 */
function copiedPaths(dockerfile: string): { directories: string[]; files: string[]; rootGlobs: string[] } {
  const directories: string[] = []
  const files: string[] = []
  const rootGlobs: string[] = []
  for (const line of lastStage(dockerfile).split('\n')) {
    const match = /^\s*COPY\s+(?!--from=)(.+)$/i.exec(line)
    if (!match) continue
    const words = match[1]!.trim().split(/\s+/)
    const destination = words.pop()!
    for (const source of words) {
      if (source.startsWith('--')) continue
      if (/^\*\.[a-z]+$/.test(source)) rootGlobs.push(source)
      else if (source.endsWith('/') && destination === `./${source}`) directories.push(source.slice(0, -1))
      else if (!source.includes('*') && (destination === `./${source}` || destination === './')) files.push(source)
    }
  }
  return { directories, files, rootGlobs }
}

/** The relative `.ts` paths a source file imports, resolved from the repo root. Comment lines are skipped. */
function relativeImports(path: string, text: string): string[] {
  const imports = new Set<string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    for (const match of line.matchAll(/\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"\n]+\.ts)['"]/g)) {
      imports.add(normalize(join(dirname(path), match[1]!)).replaceAll('\\', '/'))
    }
  }
  return [...imports]
}

/**
 * Every file the image would need that the Dockerfile does not copy: start from each file under
 * server/ (copied whole), follow the relative imports, and list the files reached that no COPY line
 * brings in. A file that is copied is followed too, because its own imports have to be there.
 */
function uncopiedImports(dockerfile: string, files: string[], read: ReadRepoFile): string[] {
  const copied = copiedPaths(dockerfile)
  const inImage = (path: string): boolean =>
    copied.directories.some((directory) => path === directory || path.startsWith(`${directory}/`))
    || copied.files.includes(path)
    || copied.rootGlobs.some((glob) => !path.includes('/') && path.endsWith(glob.slice(1)))
  const missing = new Set<string>()
  const seen = new Set<string>()
  const queue = [...files]
  while (queue.length > 0) {
    const path = queue.pop()!
    if (seen.has(path)) continue
    seen.add(path)
    const text = read(path)
    if (text === null) continue
    for (const imported of relativeImports(path, text)) {
      if (!inImage(imported)) missing.add(imported)
      queue.push(imported)
    }
  }
  return [...missing].sort()
}

test('every file under src/ that the server imports is copied into the Docker image', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
  const serverFiles = tsFiles('server')
  assert.ok(serverFiles.length > 20, `found the server's files (${serverFiles.length})`)
  assert.deepEqual(
    uncopiedImports(dockerfile, serverFiles, readFromDisk),
    [],
    'a file the server imports is not copied by the Dockerfile: `deno cache server/main.ts` fails with "Module not found" while the image builds. Add a COPY line for it.',
  )
})

test('the guard sees what it is there to see: the map tile setting is reached from the server, and each COPY form is read', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
  const reached = new Set<string>()
  for (const path of tsFiles('server')) for (const imported of relativeImports(path, readFromDisk(path)!)) reached.add(imported)
  assert.ok(reached.has('src/geo/tile-source.ts'), 'server/main.ts imports src/geo/tile-source.ts, the file the Docker build once missed')
  assert.ok(reached.has('src/world/types.ts'), 'and a file in a copied directory')

  const copied = copiedPaths(dockerfile)
  assert.ok(copied.files.includes('src/geo/tile-source.ts'), 'a single-file COPY is read')
  assert.ok(copied.directories.includes('src/world') && copied.directories.includes('server'), 'a directory COPY is read, without its trailing slash')
  assert.deepEqual(copied.rootGlobs, ['*.ts'], 'a root glob is read, from the last stage only: the web stage copies *.html and src/ whole')
  assert.equal(copied.directories.includes('src'), false, 'the web stage copies all of src/, and none of that is in the Deno image')
  assert.equal(copied.files.includes('web/dist'), false, 'a COPY --from=stage takes files from another stage, not from the repo')

  const without = dockerfile.replace(/^COPY src\/geo\/tile-source\.ts .*$/m, '')
  assert.notEqual(without, dockerfile, 'the line to remove is there')
  assert.deepEqual(
    uncopiedImports(without, tsFiles('server'), readFromDisk),
    ['src/geo/tile-source.ts'],
    'with that line gone, the guard names the file the build would stop on',
  )
})

test('the guard follows imports through a copied file, and ignores a comment that only mentions an import', () => {
  const dockerfile = 'FROM node AS web\nCOPY src/ ./src/\nFROM deno\nCOPY server/ ./server/\nCOPY src/a/ ./src/a/\n'
  const sources: Record<string, string> = {
    'server/main.ts': "import { a } from '../src/a/a.ts'\n// import { nope } from '../src/never/nope.ts'\n * from '../src/never/doc.ts'\n",
    'src/a/a.ts': "export { b } from '../b/b.ts'\nconst later = await import('../c/c.ts')\n",
    'src/b/b.ts': "import type { C } from '../c/c.ts'\n",
    'src/c/c.ts': '',
  }
  const read: ReadRepoFile = (path) => sources[path] ?? null
  assert.deepEqual(uncopiedImports(dockerfile, ['server/main.ts'], read), ['src/b/b.ts', 'src/c/c.ts'], 're-exports, type-only and dynamic imports count; comments do not')
})

test('.dockerignore does not exclude a file the server needs', () => {
  const ignored = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !/[*?!]/.test(line))
  const needed = new Set<string>()
  const queue = tsFiles('server')
  while (queue.length > 0) {
    const path = queue.pop()!
    if (needed.has(path)) continue
    needed.add(path)
    const text = readFromDisk(path)
    if (text !== null) queue.push(...relativeImports(path, text))
  }
  for (const path of needed) {
    const rule = ignored.find((entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, '')}/`))
    assert.equal(rule, undefined, `${relative(ROOT, join(ROOT, path))} is needed by the server, and .dockerignore excludes it with "${rule}"`)
  }
})
