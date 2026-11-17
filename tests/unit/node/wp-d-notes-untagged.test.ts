/**
 * SceneEditor.setNotes(): a note on an untagged object must not write a category.
 *
 * Before this change the Edit panel's Save Notes wrote the tag 'unknown' onto any object
 * that had no tag, with manualOverride set, so a note alone claimed a category the user
 * never chose (see the F88 audit finding).
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-d-notes-untagged.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { SceneEditor } from '../../../src/viewer/editor.ts'

function sceneWithBox() {
  const scene = new THREE.Scene()
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  box.name = 'plain-box'
  scene.add(box)
  scene.updateMatrixWorld(true)
  const editor = new SceneEditor()
  editor.setScene(scene)
  return { editor, box }
}

test('a note on an untagged object writes no tag and no manual override', () => {
  const { editor, box } = sceneWithBox()

  editor.setNotes(box, 'check the outlet')

  const ud = box.userData as Record<string, unknown>
  assert.equal(ud['tag'], undefined)
  assert.equal(ud['manualOverride'], undefined)
  assert.equal(editor.getTagInfo(box), undefined)
  const data = editor.getInspectorData(box)
  assert.equal(data.tag, undefined, 'the inspector reports no category')
  assert.equal(data.notes, 'check the outlet')
})

test('flushing tags leaves an untagged note untagged', () => {
  const { editor, box } = sceneWithBox()

  editor.setNotes(box, 'check the outlet')
  editor.flushTags()

  assert.equal((box.userData as Record<string, unknown>)['tag'], undefined)
  assert.equal(editor.getInspectorData(box).notes, 'check the outlet')
})

test('a tag chosen after a note keeps that note', () => {
  const { editor, box } = sceneWithBox()

  editor.setNotes(box, 'check the outlet')
  editor.tagObject(box, 'outlet')

  const data = editor.getInspectorData(box)
  assert.equal(data.tag, 'outlet')
  assert.equal(data.notes, 'check the outlet')
})

test('a note on a tagged object keeps its tag and replaces the note', () => {
  const { editor, box } = sceneWithBox()

  editor.tagObject(box, 'sofa', { notes: 'old' })
  editor.setNotes(box, 'new')

  assert.equal(editor.getTagInfo(box)?.tag, 'sofa')
  assert.equal(editor.getTagInfo(box)?.notes, 'new')
  assert.equal(editor.getInspectorData(box).tag, 'sofa')
})
