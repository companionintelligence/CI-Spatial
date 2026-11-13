# Companion Scan desktop shell

Tauri 2 wraps the bundled Scan web app for macOS and Windows. The app connects to
a Scan server configured by `VITE_API_BASE`; it does not run the Scan server.

```sh
cd desktop
npm install
npm run dev
npm run build
```

Set `VITE_API_BASE` in the parent environment when building for a server. Do not
ship a developer's private LAN address in a public release.

## Store and feature gates

- Reserve and confirm the permanent bundle identifier before the first upload;
  `computer.ci.scan.desktop` is provisional.
- WebXR and the 8th Wall camera path are not available in this shell. A desktop
  build is for reviewing, editing, and managing scans; live AR capture remains
  in the web/headset path until a supported native capture implementation is
  selected and verified.
- Confirm the `public/xr.js` licence permits the intended distribution before
  shipping any bundle that includes it.
- Add product artwork, signing, notarization, privacy declarations, and a
  manual release workflow before store submission.

This shell is a build scaffold, not a submitted or store-ready binary.
