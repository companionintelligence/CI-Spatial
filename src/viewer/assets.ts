import * as THREE from 'three'

// Simple promise-based asset cache
const assetCache = new Map<string, Promise<THREE.Group>>()

/**
 * Asynchronously loads (or generates) a 3D model for a given semantic label.
 * Employs a shared promise cache so each unique label is only loaded/compiled once.
 */
export function loadSemanticAsset(label: string): Promise<THREE.Group> {
  const normLabel = label.toLowerCase()
  if (assetCache.has(normLabel)) {
    return assetCache.get(normLabel)!.then(group => group.clone())
  }

  const loadPromise = new Promise<THREE.Group>((resolve) => {
    // Simulate async network/file load delay (e.g. 100ms)
    setTimeout(() => {
      const group = new THREE.Group()
      group.name = `detailed-${normLabel}`

      if (normLabel.includes('chair')) {
        // Detailed chair representation
        // Seat
        const seat = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.05, 0.5),
          new THREE.MeshStandardMaterial({ color: 0x8a7d73, roughness: 0.8 })
        )
        seat.position.y = 0.4
        seat.castShadow = true
        seat.receiveShadow = true
        group.add(seat)

        // Backrest
        const back = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.5, 0.05),
          new THREE.MeshStandardMaterial({ color: 0x8a7d73, roughness: 0.8 })
        )
        back.position.set(0, 0.65, -0.225)
        back.castShadow = true
        group.add(back)

        // 4 Legs
        const legGeom = new THREE.CylinderGeometry(0.02, 0.02, 0.4, 8)
        const legMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.5 })
        const offsets = [[-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]]
        for (const [x, z] of offsets) {
          const leg = new THREE.Mesh(legGeom, legMat)
          leg.position.set(x, 0.2, z)
          leg.castShadow = true
          group.add(leg)
        }
      } else if (normLabel.includes('table') || normLabel.includes('desk')) {
        // Detailed table representation
        const top = new THREE.Mesh(
          new THREE.BoxGeometry(1.2, 0.05, 0.8),
          new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.6 })
        )
        top.position.y = 0.75
        top.castShadow = true
        top.receiveShadow = true
        group.add(top)

        const legGeom = new THREE.CylinderGeometry(0.04, 0.04, 0.75, 8)
        const legMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.2 })
        const offsets = [[-0.55, -0.35], [0.55, -0.35], [-0.55, 0.35], [0.55, 0.35]]
        for (const [x, z] of offsets) {
          const leg = new THREE.Mesh(legGeom, legMat)
          leg.position.set(x, 0.375, z)
          leg.castShadow = true
          group.add(leg)
        }
      } else if (normLabel.includes('lamp') || normLabel.includes('light')) {
        // Detailed floor lamp representation
        const base = new THREE.Mesh(
          new THREE.CylinderGeometry(0.15, 0.15, 0.02, 16),
          new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.8 })
        )
        base.position.y = 0.01
        group.add(base)

        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.015, 0.015, 1.4, 8),
          new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.8 })
        )
        pole.position.y = 0.7
        group.add(pole)

        const shade = new THREE.Mesh(
          new THREE.CylinderGeometry(0.15, 0.2, 0.3, 16),
          new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, emissive: 0xfff9c4, emissiveIntensity: 0.2 })
        )
        shade.position.y = 1.4 + 0.15
        group.add(shade)
      } else if (normLabel.includes('plant')) {
        // Detailed plant representation
        const pot = new THREE.Mesh(
          new THREE.CylinderGeometry(0.15, 0.1, 0.3, 12),
          new THREE.MeshStandardMaterial({ color: 0xd84315, roughness: 0.9 })
        )
        pot.position.y = 0.15
        group.add(pot)

        const stem = new THREE.Mesh(
          new THREE.CylinderGeometry(0.01, 0.01, 0.5, 8),
          new THREE.MeshStandardMaterial({ color: 0x3e2723 })
        )
        stem.position.y = 0.5
        group.add(stem)

        // Add some green spheres as leaves
        const leafMat = new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.9 })
        for (let i = 0; i < 5; i++) {
          const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), leafMat)
          const angle = (i / 5) * Math.PI * 2
          leaf.position.set(Math.cos(angle) * 0.1, 0.7 + i * 0.05, Math.sin(angle) * 0.1)
          group.add(leaf)
        }
      } else {
        // Generic detailed placeholder (capsule shape)
        const mesh = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.2, 0.4, 4, 8),
          new THREE.MeshStandardMaterial({ color: 0x00bcd4, roughness: 0.5 })
        )
        mesh.position.y = 0.4
        group.add(mesh)
      }

      // Normalise height to roughly 1.0 units for standard scaling
      const box = new THREE.Box3().setFromObject(group)
      const size = box.getSize(new THREE.Vector3())
      if (size.y > 0) {
        group.scale.setScalar(1 / size.y)
      }

      resolve(group)
    }, 100)
  })

  assetCache.set(normLabel, loadPromise)
  return loadPromise.then(group => group.clone())
}

/**
 * Creates a medium-poly version of the model to serve as LOD level 1
 */
export function createMediumPolyAsset(label: string): THREE.Group {
  const normLabel = label.toLowerCase()
  const group = new THREE.Group()
  group.name = `medium-${normLabel}`

  if (normLabel.includes('chair')) {
    // Medium chair: simplified seat box + single column pedestal
    const seat = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.08, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x8a7d73, roughness: 0.8 })
    )
    seat.position.y = 0.4
    group.add(seat)

    const back = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.4, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x8a7d73, roughness: 0.8 })
    )
    back.position.set(0, 0.6, -0.22)
    group.add(back)

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.36, 6),
      new THREE.MeshStandardMaterial({ color: 0x222222 })
    )
    base.position.y = 0.18
    group.add(base)
  } else if (normLabel.includes('table') || normLabel.includes('desk')) {
    // Medium table: top + pedestal
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.06, 0.8),
      new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.6 })
    )
    top.position.y = 0.74
    group.add(top)

    const col = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.71, 6),
      new THREE.MeshStandardMaterial({ color: 0x111111 })
    )
    col.position.y = 0.355
    group.add(col)
  } else {
    // Generic medium placeholder (cylinder shape)
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.2, 0.8, 6),
      new THREE.MeshStandardMaterial({ color: 0x00bcd4 })
    )
    mesh.position.y = 0.4
    group.add(mesh)
  }

  // Normalise height to roughly 1.0 units for standard scaling
  const box = new THREE.Box3().setFromObject(group)
  const size = box.getSize(new THREE.Vector3())
  if (size.y > 0) {
    group.scale.setScalar(1 / size.y)
  }

  return group
}
