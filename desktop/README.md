# Companion Scan desktop shell

Tauri 2 wraps the bundled Scan web app for macOS and Windows. The app connects to
the Scan server whose https address the person sets in it (the editor asks for one
when none is set); it does not run the Scan server.

```sh
cd desktop
npm install
npm run dev
npm run build
```

A build can name a default server with `VITE_API_BASE` in the parent environment;
an address saved in the app overrides it. Do not ship a developer's private LAN
address in a public release.

## Companion Account sign-in

The app's page is on its own origin (`tauri://localhost`, or `http://tauri.localhost`
on Windows), so the Scan server's session cookie never reaches it. It signs in the way
the phone app does, through the person's default browser:

1. The editor's account control (Navigate menu), or the first-run Sign-in row, opens
   the server's sign-in with `shell=desktop` and a PKCE challenge the app made
   (`src/shared/shell-sign-in.ts`).
2. After CI-Portal, the server sends the browser to
   `computer.ci.scan.desktop://auth?code=…`, a one-time code that lasts 60 seconds
   (`DESKTOP_RETURN_URL` in `server/portal_auth.ts`).
3. The installers register that scheme for the app (`plugins.deep-link` in
   `src-tauri/tauri.conf.json`). On Windows and Linux the link starts a second copy of
   the app, which hands it to the running one (`tauri-plugin-single-instance`) and
   quits. On macOS the system delivers it to the running app.
4. The app trades the code and its verifier at `POST /authenticate/shell/exchange` for
   a session token, keeps it in the WebView's storage, and sends it as
   `Authorization: Bearer`.

CI-Portal redirects only to the Scan server's own `/authenticate/oidc/callback`, so the
scheme needs no Portal registration. A server with sign-in off needs none of this: the
editor drops its account control and everything else works. Not verified: a sign-in
against a real Portal. A copy run straight from the build folder is not registered for
the scheme (a debug build registers itself for the current user), and on macOS the app
must be in Applications, or opened once, before the system knows its scheme.

## Store and feature gates

- Reserve and confirm the permanent bundle identifier before the first upload;
  `computer.ci.scan.desktop` is provisional. The sign-in scheme follows it: change
  both, and `DESKTOP_RETURN_URL` and `DESKTOP_RETURN_PREFIX`, together.
- WebXR and the 8th Wall camera path are not available in this shell. A desktop
  build is for reviewing, editing, and managing scans; live AR capture remains
  in the web/headset path until a supported native capture implementation is
  selected and verified.
- Confirm the `public/xr.js` licence permits the intended distribution before
  shipping any bundle that includes it.
- Add product artwork, signing, notarization, privacy declarations, and a
  manual release workflow before store submission.

This shell is a build scaffold, not a submitted or store-ready binary.
