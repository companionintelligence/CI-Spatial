/**
 * onnxruntime-web@1.21.x ships real types (node_modules/onnxruntime-web/types.d.ts,
 * itself just `export * from 'onnxruntime-common'`) but its package.json
 * `exports` map has no `"types"` condition on any subpath — confirmed
 * against the installed 1.21.1: every entry under `exports` lists only
 * `node`/`import`/`require`. onnxruntime-common's `exports` has the same
 * gap. Under this repo's `moduleResolution: "bundler"`, tsc refuses to fall
 * back to the legacy top-level `types` field once `exports` is present,
 * so both `import ... from 'onnxruntime-web'` and the `/webgpu` subpath
 * this repo actually imports (src/inference/lfm-driver-web.ts) resolve to
 * `implicitly has an 'any' type` without this file — tsc's own error names
 * the fix ("add a new declaration (.d.ts) file"). Re-declares the same two
 * modules onnxruntime-web's own types.d.ts declares, so real types still
 * flow through; this only routes around the broken `exports` lookup.
 */
declare module 'onnxruntime-web' {
  export * from 'onnxruntime-common'
}
declare module 'onnxruntime-web/webgpu' {
  export * from 'onnxruntime-web'
}
