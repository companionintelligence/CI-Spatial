/**
 * A scan GLB for the place-register tests: a `point-cloud` node holding one POINTS
 * primitive, the way src/export/gltf.ts writes a capture. The points are in the
 * scan's own (session) frame; `localToWorld` is what places them in the Place.
 *
 * `scale` puts a uniform scale on the node and divides it out of the vertices, so
 * the points a reader gets back through the node's matrix are the ones passed in
 * while the raw POSITION values are not. That is how a quantized, optimized scan
 * stores its cloud (server/panoptic/panoptic_lift.ts, "Why the cloud is read
 * through the node hierarchy"), and a reader that skips the node would be out by
 * exactly this factor.
 */
import { Document, NodeIO, Primitive } from '@gltf-transform/core'

export async function pointCloudGlb(positions: ArrayLike<number>, options: { scale?: number } = {}): Promise<Uint8Array> {
  const scale = options.scale ?? 1
  const document = new Document()
  const buffer = document.createBuffer()
  const stored = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i++) stored[i] = positions[i]! / scale

  const accessor = document.createAccessor('positions').setType('VEC3').setArray(stored).setBuffer(buffer)
  const primitive = document.createPrimitive().setMode(Primitive.Mode.POINTS).setAttribute('POSITION', accessor)
  const mesh = document.createMesh('point-cloud').addPrimitive(primitive)
  const cloud = document.createNode('point-cloud').setMesh(mesh).setScale([scale, scale, scale])
  const room = document.createNode('Room_Unknown').addChild(cloud)
  const scene = document.createScene('room-scan').addChild(room)
  document.getRoot().setDefaultScene(scene)
  return await new NodeIO().writeBinary(document)
}
