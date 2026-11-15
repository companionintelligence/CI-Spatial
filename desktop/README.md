# Companion Scan desktop shell

Tauri 2 wraps the bundled Scan web app for Windows, macOS and Linux. The app is the
Place Scan Editor and viewer. It connects to the Scan server whose https address the
person sets in it (the editor asks for one when none is set); it does not run the Scan
server, and it cannot capture.

```sh
npm ci                      # in the repo root, once
cd desktop
npm ci
npm run dev                 # the app against the local Vite and Deno servers
npm run build               # this OS's installers, in src-tauri/target/release/bundle
```

Tauri needs Rust 1.90 or later and the platform's WebView: WebView2 on Windows (the
installer fetches it if it is missing), WKWebView on macOS 12 or later, and WebKitGTK 4.1
on Linux (`libwebkit2gtk-4.1-dev` and the rest of Tauri's prerequisites to build).

## What the app is

The window opens `viewer.html`, the editor. There is no AR capture on a desktop, so the
app never loads the 8th Wall engine, and its bundle leaves it out.

- `npm run build` runs `scripts/native/build-web.mjs desktop` first. That is the root
  Vite build with `VITE_DISABLE_PWA=1` (no service worker, no web manifest) into
  `desktop/dist`, without `xr.js`, `xr-slam.js`, `xr-face.js` and `resources/`, and
  without the model weights and test files no app ships. It refuses a `.env` file that
  sets a `VITE_` variable, so no local setting is baked in, and it writes
  `THIRD-PARTY-NOTICES.txt` and `LICENSE.txt` into the bundle.
- Links stay inside the app only when they are its own pages. The start screen's editor
  card goes to `/viewer.html`, because `/editor` is a rewrite that only a Scan server
  and the public site make; in the app an unknown path falls back to the scanner. A
  link to anywhere else (a server's own pages, a licence) opens in the default browser
  (`external_links` in `src-tauri/src/main.rs`). The editor's "Scan a Place" opens the
  start screen, which offers uploads but no live capture. The WebXR scanner entry is
  removed in the app, which has no WebXR.
- The app has no first-run screen: the window opens the editor, and the scanner page
  never reaches its onboarding without an AR runtime. Its setup is in the editor's
  Navigate menu instead: the Scan server (set, test and change it; the editor also asks
  for one on launch while none is set), Legal notices (Companion Scan's licence and the
  open-source licences in the app), and the account control that signs in.
- `npm run dev` serves the app from `vite.http.config.ts` on port 5199, because the
  main Vite config serves HTTPS with a certificate the webview does not trust.

A build can name a default server with `VITE_API_BASE` in the parent environment;
an address saved in the app overrides it. Release builds set none. Do not ship a
developer's private LAN address in a public release.

## Companion Account sign-in

The app's page is on its own origin (`tauri://localhost`, or `http://tauri.localhost`
on Windows), so the Scan server's session cookie never reaches it. The server accepts
those origins (`server/origin.ts`). The app signs in the way the phone app does,
through the person's default browser:

1. The account control at the foot of the editor's Navigate menu ("Connect account")
   opens the server's sign-in in the default browser, with `shell=desktop` and a PKCE
   challenge the app made (`src/shared/shell-sign-in.ts`). With no Scan server set, it
   asks for one first.
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

The deep-link plugin hands every page the process's last link again, so the app keeps the
latest codes it was handed and ignores any it has seen: a return that ended one sign-in
never ends the next. A link to the scheme without a code of the server's shape is ignored
too, so a web page that opens one cannot cancel a sign-in in progress.

CI-Portal redirects only to the Scan server's own `/authenticate/oidc/callback`, so the
scheme needs no Portal registration. A server with sign-in off needs none of this: the
editor drops its account control and everything else works. Not verified: a sign-in
against a real Portal. A copy run straight from the build folder is not registered for
the scheme (a debug build registers itself for the current user), and on macOS the app
must be in Applications, or opened once, before the system knows its scheme.

## Builds and releases

- **Desktop Build** (`.github/workflows/desktop-build.yml`, run by hand) builds Windows
  NSIS and MSI installers on `windows-latest`, a universal (`universal-apple-darwin`)
  app and dmg on `macos-latest`, and deb and rpm packages on `ubuntu-22.04`, and keeps
  them as artifacts for 14 days. No AppImage.
- **Native Release** (`.github/workflows/native-release.yml`, run by hand with a tag)
  builds the same installers with the Android APK and publishes them as a GitHub
  pre-release; see the README's *Desktop and Android apps*.
- The installers are unsigned. The macOS app is ad-hoc signed (`signingIdentity "-"`),
  so on Apple silicon macOS offers **Open** from the right-click menu, or **Open Anyway**
  in Privacy & Security, instead of calling the download damaged. Windows SmartScreen
  warns on first run.
- The app's version is 0.2.0, written in `tauri.conf.json`, `src-tauri/Cargo.toml`
  (and `Cargo.lock`) and `package.json`, in step with the Android app.
  `node scripts/native/check-versions.mjs` checks all of them.

## Gates

- The bundle identifier `computer.ci.scan.desktop` is provisional. It also names the
  folder where the app keeps its local data, so changing it after people use a build
  orphans that data. The sign-in scheme follows it: change both, and
  `DESKTOP_RETURN_URL` and `DESKTOP_RETURN_PREFIX`, together.
- WebXR and the 8th Wall camera path are not in this app. Live AR capture stays in the
  web, headset and phone paths.
- The bundle does not include `public/xr.js` or the rest of the engine, so the engine's
  licence conditions do not apply to it.
- Code signing on Windows, notarization on macOS, product artwork and privacy
  declarations come before any store submission, which is the owner's to do.
