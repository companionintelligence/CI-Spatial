/**
 * Whether this process can remove a file from a folder that has no write permission, which is true of root and defeats a
 * failure made with permissions. A test that needs that failure is declared with `ignore: !(await cannotRemoveFromReadOnlyFolder())`,
 * so that on such a machine it shows as ignored and not as a pass that tested nothing.
 *
 * Not a test file: the runner picks up only `*.test.ts`.
 */
export async function cannotRemoveFromReadOnlyFolder(): Promise<boolean> {
  const root = await Deno.makeTempDir({ prefix: 'read-only-probe-' })
  const folder = `${root}/probe`
  try {
    await Deno.mkdir(folder)
    await Deno.writeTextFile(`${folder}/file`, 'x')
    await Deno.chmod(folder, 0o555)
    try {
      await Deno.remove(`${folder}/file`)
      return false
    } catch {
      return true
    } finally {
      await Deno.chmod(folder, 0o755)
    }
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined)
  }
}
