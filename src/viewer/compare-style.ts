/**
 * Telling two scans apart while one is being moved onto the other: a tint per scan, and a see-through
 * (ghost) mode at half strength.
 *
 * It restyles materials, so three things keep it from damaging anything:
 *
 *   - Never in place. The editor builds proxy furniture from a cache whose clones share their
 *     materials (`loadSemanticAsset` in assets.ts), so tinting a shared material would tint every scan
 *     that has a chair. Each styled node gets its own copy of its material, made from the one it had,
 *     and the original is never touched.
 *   - Reversible. A copy remembers the material it came from, so clearing the style puts that one back
 *     and frees the copy (disposing a material leaves its textures alone, which the original still uses).
 *   - Re-appliable. The editor replaces materials too (wireframe and semantic view modes). Applying a
 *     style again wraps whatever material the node has now, and unwraps one of these copies a mode switch
 *     put back, so a style never stacks on itself or comes back after it was cleared.
 *
 * THREE only, no DOM, so Node tests load it.
 *
 * The tint multiplies the material's colour, so a cloud's own colours stay visible under it (a vertex
 * colour is multiplied by the material colour); it is a cast, not a paint-over. Ghost half is 0.5 of the
 * opacity the material already had.
 */
import * as THREE from 'three'

/** Distinct from each other and from the editor's own overlay colours. Adopted, not measured (ADR 0005 rule 5). */
export const TINT_PALETTE: readonly number[] = [0x4fc3f7, 0xffb74d, 0xf06292, 0xaed581, 0xba68c8, 0xfff176]

/** How much of its own opacity a ghosted scan keeps. Fifty percent is what the stitching work package asked for. */
export const GHOST_OPACITY_FACTOR = 0.5

export interface CompareStyle {
  /** 0xRRGGBB, or null for the scan's own colours. */
  tint: number | null
  ghost: boolean
}

export const PLAIN_STYLE: CompareStyle = { tint: null, ghost: false }

export function isPlainStyle(style: CompareStyle): boolean {
  return style.tint === null && !style.ghost
}

/** The tint for the n-th scan when every scan is tinted apart: round the palette. */
export function tintForIndex(index: number): number {
  return TINT_PALETTE[((index % TINT_PALETTE.length) + TINT_PALETTE.length) % TINT_PALETTE.length]!
}

/** A styled copy -> the material it was made from. */
const madeFrom = new WeakMap<THREE.Material, THREE.Material>()

function styleKey(style: CompareStyle): string {
  return `${style.tint ?? 'none'}|${style.ghost ? 'ghost' : 'solid'}`
}

function styledCopy(base: THREE.Material, style: CompareStyle): THREE.Material {
  const copy = base.clone()
  madeFrom.set(copy, base)
  copy.userData = { ...copy.userData, compareStyle: styleKey(style) }
  const coloured = copy as THREE.Material & { color?: THREE.Color }
  if (style.tint !== null && coloured.color instanceof THREE.Color) coloured.color.multiply(new THREE.Color(style.tint))
  if (style.ghost) {
    copy.transparent = true
    copy.opacity = base.opacity * GHOST_OPACITY_FACTOR
    copy.depthWrite = false
  }
  copy.needsUpdate = true
  return copy
}

/** The material a node has, or the one a styled copy of it was made from. */
export function baseMaterial(material: THREE.Material): THREE.Material {
  return madeFrom.get(material) ?? material
}

function restyle(material: THREE.Material, style: CompareStyle): THREE.Material {
  const base = baseMaterial(material)
  const isCopy = base !== material
  if (isPlainStyle(style)) {
    if (isCopy) material.dispose()
    return base
  }
  if (isCopy && material.userData['compareStyle'] === styleKey(style)) return material
  if (isCopy) material.dispose()
  return styledCopy(base, style)
}

/**
 * Give every material under `root` the style, or take the style off with {@link PLAIN_STYLE}.
 * Cheap to call again: a node already in the style is left alone.
 */
export function applyCompareStyle(root: THREE.Object3D, style: CompareStyle): void {
  root.traverse((node) => {
    const holder = node as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }
    const current = holder.material
    if (!current) return
    holder.material = Array.isArray(current) ? current.map((material) => restyle(material, style)) : restyle(current, style)
  })
}

/**
 * The style the materials under `root` carry now: {@link PLAIN_STYLE} when none of them is a styled copy, the style
 * they all share when they are, and null when they do not agree (a part of the scan was styled another way). Read
 * from the copies themselves, which remember the style they were made for, so it is true whoever applied it.
 *
 * It exists so that a second owner of the see-through style (the editor's "Previous reference" layer) can tell a
 * scan the compare tools have tinted, which it leaves alone, from a plain one it may dim.
 */
export function appliedStyle(root: THREE.Object3D): CompareStyle | null {
  const keys = new Set<string>()
  root.traverse((node) => {
    const holder = node as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }
    const current = holder.material
    if (!current) return
    for (const material of Array.isArray(current) ? current : [current]) {
      keys.add(madeFrom.has(material) ? String(material.userData['compareStyle']) : styleKey(PLAIN_STYLE))
    }
  })
  if (keys.size === 0) return PLAIN_STYLE
  if (keys.size > 1) return null
  const [tint, shade] = [...keys][0]!.split('|')
  return { tint: tint === 'none' ? null : Number(tint), ghost: shade === 'ghost' }
}
