/**
 * Writing an uploaded scan so that nothing can read it half made.
 *
 * Every read of a world lists the `.glb` files in the scans directory and builds a row for any it has not seen,
 * from the `.glb` and its sidecar `.json`. The upload route used to create the `.glb`, write its bytes, and only then
 * write the sidecar. A world read that fell between the last two steps (the optimize job pump reads the world on its
 * own, and so does every open editor) listed a scan whose calibration it could not see yet, froze its row at the GPS or
 * grid placement, and the stamp that "Reset to calibrated" goes back to (`ScanManifest.calibratedLocalToWorld`) was
 * taken from that wrong row for good.
 *
 * So the order here is the reverse of what a reader needs to never see a half-made scan:
 *
 *   1. claim the name with a `<name>.glb.part` file (exclusive create, so two uploads cannot take one name),
 *   2. write the bytes into it,
 *   3. write the sidecar to a temporary name and rename it into place,
 *   4. rename the `.part` to `.glb`.
 *
 * A reader lists `.glb` files only, so until step 4 there is nothing to list, and when the `.glb` appears it is
 * whole and its sidecar is already there. A rename is atomic on one filesystem, so there is no moment in between.
 *
 * A crash between the steps leaves a `.part` (and perhaps a sidecar) that nothing reads: no half-made scan, but some
 * bytes on disk until someone deletes them.
 *
 * Deno APIs live here and not in patch_validate.ts, which the browser's rules (ADR 0002) keep Deno-free.
 */

/** The ending of a scan that is still being written. It is not `.glb`, so no listing of scans includes it. */
export const PART_SUFFIX = '.part'

/** Where the write has got to, for a test that wants to look at the scans directory between two steps. */
export type StoreStep = 'claimed' | 'bytes-written' | 'sidecar-written' | 'published'

export interface StoreRequest {
  dir: string
  /** The timestamp the file name starts with. */
  ts: number
  /** The name the sender gave the file, already made safe, with or without `.glb`. */
  safeName: string
  bytes: Uint8Array
  /** The text of the sidecar, or null when the upload carried none. */
  sidecar: string | null
  /** Called after each step and before the next one. An error it throws is the write's error. */
  observe?: (step: StoreStep) => void | Promise<void>
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false
    throw error
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await Deno.remove(path)
  } catch {
    // Already gone, or not ours to worry about: the write's own error is the one worth reporting.
  }
}

/** Every byte of `bytes`: a single `write` may take fewer than it is given. */
export async function writeAll(handle: Pick<Deno.FsFile, 'write'>, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) offset += await handle.write(bytes.subarray(offset))
}

/** Stores the scan and returns the file name it was given: `<ts>_<name>.glb`, or with a suffix when that name was taken. */
export async function storeUploadedScan(request: StoreRequest): Promise<string> {
  const { dir, ts, bytes, sidecar, observe } = request
  const stem = request.safeName.replace(/\.glb$/, '')

  // The name is claimed by the filesystem and not by a check followed by a write, which two uploads can both win.
  let filename: string | null = null
  let handle: Deno.FsFile | null = null
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = attempt === 0 ? '' : `-${crypto.randomUUID().slice(0, 8)}`
    const candidate = `${ts}_${stem}${suffix}.glb`
    let claim: Deno.FsFile
    try {
      claim = await Deno.open(`${dir}/${candidate}${PART_SUFFIX}`, { write: true, createNew: true })
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) continue
      throw error
    }
    // An upload that finished before this claim has no `.part` left to collide with, but its `.glb` is there.
    if (await exists(`${dir}/${candidate}`)) {
      claim.close()
      await removeQuietly(`${dir}/${candidate}${PART_SUFFIX}`)
      continue
    }
    filename = candidate
    handle = claim
    break
  }
  if (!filename || !handle) throw new Error(`could not allocate a unique filename for ${request.safeName} after 8 attempts`)

  const claimedFile: Deno.FsFile = handle
  const final = `${dir}/${filename}`
  const part = `${final}${PART_SUFFIX}`
  const sidecarPath = final.replace(/\.glb$/, '.json')
  const sidecarTemp = `${sidecarPath}.${crypto.randomUUID()}.tmp`
  let sidecarStored = false
  let published = false
  let open = true
  const closeClaim = (): void => {
    if (!open) return
    open = false
    claimedFile.close()
  }
  try {
    await observe?.('claimed')
    try {
      await writeAll(claimedFile, bytes)
    } finally {
      closeClaim()
    }
    await observe?.('bytes-written')
    if (sidecar !== null) {
      await Deno.writeTextFile(sidecarTemp, sidecar)
      await Deno.rename(sidecarTemp, sidecarPath)
      sidecarStored = true
    }
    await observe?.('sidecar-written')
    await Deno.rename(part, final)
    published = true
    await observe?.('published')
    return filename
  } catch (error) {
    // Nothing of a scan that did not arrive is left behind for a reader to find. One that did arrive keeps what it has.
    closeClaim()
    if (!published) {
      await removeQuietly(part)
      await removeQuietly(sidecarTemp)
      if (sidecarStored) await removeQuietly(sidecarPath)
    }
    throw error
  }
}
