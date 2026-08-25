/**
 * Storage usage/quota via the StorageManager API — one implementation shared
 * by every caller that needs it, per ADR 0001 ("reuse, don't duplicate").
 *
 * Originally lived only as a method on src/scene/store.ts's DetectionStore.
 * Wave 05 ticket 0002 (docs/factory/05-on-device-inference/0002-browser-model-provisioning.md)
 * needed the exact same call — the model cache and scan data draw on one
 * shared origin quota, and `checkStorageQuota` (src/main.ts) has to reason
 * about both together — so this is the extraction rather than a second copy.
 * DetectionStore.quotaStatus() now delegates here; its public method and
 * return shape are unchanged.
 */
export interface QuotaStatus {
  usage: number
  quota: number
}

/** Null when the StorageManager API is unavailable, or estimate() fails/returns partial data. */
export async function quotaStatus(): Promise<QuotaStatus | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
  try {
    const { usage, quota } = await navigator.storage.estimate()
    if (usage === undefined || quota === undefined) return null
    return { usage, quota }
  } catch {
    return null
  }
}
