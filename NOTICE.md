# NOTICE

This file records attribution that the licences of our dependencies and
upstream projects legally require us to reproduce. It is not a full dependency
list — see [THIRD_PARTY.md](THIRD_PARTY.md) for that, and [CREDITS.md](CREDITS.md)
for acknowledgements.

## Proprietary, copyleft and reciprocal-licence components

<!-- Maintained by hand. scripts/generate-attribution.mjs (CI-Engineering) reads package
     manifests only, so it sees neither the vendored engine below, nor the desktop app's
     Rust crates, nor the Android app's Gradle libraries (ARCore among them); regenerating
     with it brings back a claim that everything is permissive. -->

Not everything here is under a permissive licence. These are the exceptions:

- **Niantic Spatial XR Engine (8th Wall)**: `public/xr.js`, `public/xr-slam.js`,
  `public/xr-face.js` and `public/resources/`. Proprietary and binary only, under the
  [XR Engine License Agreement](https://github.com/8thwall/engine/blob/main/LICENSE). It is
  not open source. The unmodified files may be distributed with an app; they may not be used
  in a product that is sold and gets its value mainly from the engine (section 1.2). Material
  that uses the engine must name Niantic Spatial as its creator, carry its copyright notice,
  and refer to the Agreement and its disclaimer of warranties (section 1.3.2). The hosted web
  app and the Android and iOS apps include it, and the apps show this notice under Legal
  notices. The hosted web app does not show it yet; whether it must is on the owner's XR
  Engine sign-off list (mobile/README.md, *xr.js licence*). The desktop app leaves it out. The
  files are @8thwall/engine-binary 1.0.0 byte for byte; `scripts/native/check-xr-engine.mjs`
  checks them against its published hashes.

  > This product includes the XR Engine software developed by Niantic Spatial, Inc.
  >
  > Copyright © 2026 Niantic Spatial, Inc. All rights reserved.

- **MPL-2.0 Rust crates in the desktop app**, which Tauri depends on: `cssparser`,
  `cssparser-macros`, `dtoa-short`, `option-ext` and `selectors` at the time of writing. The
  Mozilla Public License 2.0 is a file-level copyleft: those crates' files stay under MPL-2.0,
  and their source must be available to anyone who gets the app. Each desktop release's
  third-party notices name every such crate with its exact version and where its source is.

- **Google ARCore (Android app)**: the `com.google.ar:core` library, version 1.57.0
  (`arcoreVersion` in `mobile/android/variables.gradle`), which the Android app depends on
  (`mobile/android/app/build.gradle`) and its `ArSession` plugin calls. Google provides it
  under the [ARCore Additional Terms of Service](https://developers.google.com/ar/develop/terms),
  which are Google's own terms, not a permissive licence. The library's Maven POM
  names them as its licence. The app runs on Google Play Services for AR (ARCore), a
  separate Google component that Google Play installs or updates when an AR session starts;
  the manifest marks ARCore optional, so the app installs without it.

  Google's [user privacy requirements](https://developers.google.com/ar/develop/privacy-requirements)
  say an app that uses ARCore must disclose the use of Google Play Services for AR, and how it
  collects and processes data, prominently in the app, easily accessible to users. They give this
  text as one way to do that, for a main menu or notice screen:

  > This application runs on [Google Play Services for AR](https://play.google.com/store/apps/details?id=com.google.ar.core) (ARCore), which is provided by Google and governed by the [Google Privacy Policy](https://policies.google.com/privacy).

  That is Google's own wording, and Google can change it, so compare it with that page before a
  store release. The Additional Terms ask for more than that sentence: the terms of service of an
  app that uses ARCore must tell its users that the app includes ARCore functionality provided by
  Google, and that use of that functionality is subject to the then-current
  [Google Terms of Service](https://policies.google.com/terms) and
  [Google Privacy Policy](https://policies.google.com/privacy). This repository has no terms of
  service for the app yet (`mobile/README.md` lists the privacy policy among what is not done),
  so writing that into them is the owner's to do.

  Only the Android app includes ARCore. The iOS app's `ArSession` plugin uses Apple's ARKit,
  and the desktop app has no AR capture.

Everything else in the apps and in this repository's manifests is under a permissive licence
(MIT, Apache-2.0, ISC, BSD, Zlib, Unicode-3.0 or similar), except the public-domain data below.

Each app carries `THIRD-PARTY-NOTICES.txt` and `LICENSE.txt` in its bundle, and shows them
under Legal notices. The notices are generated from the lockfiles for exactly what that bundle
contains (`scripts/native/third-party-notices.mjs`): the npm packages in the web bundle, the
desktop app's linked Rust crates, the Android runtime and every library in the release APK,
transitive ones included (pinned in `mobile/android/app/gradle.lockfile`, which the release
build enforces), the components above, and the World Magnetic Model data below when the bundle
includes it. Each comes with its licence text. For a package that
ships none, its project's text is kept in `scripts/native/licence-texts/`, and the generator
stops while any component is left without one. Each native release attaches the merged notices
of all its builds.

## U.S. Government data (public domain)

- **World Magnetic Model, WMM2025 (NOAA NCEI)**: the 90 coefficient rows in
  `src/world/wmm2025-coefficients.ts`, from which `src/world/declination.ts` computes the magnetic
  declination that turns a compass bearing into a true one. They are material of the World Magnetic
  Model (epoch 2025.0, valid 2025.0 to 2030.0), which the U.S. National Geospatial-Intelligence Agency
  and the U.K. Defence Geographic Centre produce and NOAA's National Centers for Environmental
  Information (NCEI) distributes. NCEI says the WMM source code is in the public domain and not
  licensed or under copyright, and that, as 17 U.S.C. 403 requires, third parties whose copyrighted
  works consist predominantly of the model's U.S. Government material must give notice that
  identifies that material and states that it is not subject to copyright protection. This is that
  notice, given for the coefficients whatever their share of this work: they are U.S. Government
  material and are not subject to copyright protection.
  Source: <https://www.ncei.noaa.gov/products/world-magnetic-model>.
  The table was read from a copy of NOAA's coefficient file on a public mirror, not from NOAA's own
  download; the module's header says so, with the SHA-256 of the file. The model expires on
  December 31, 2029 and must be replaced by WMM2030 before 2030-01-01 (the header of
  `src/world/declination.ts` lists the steps). A native app's `THIRD-PARTY-NOTICES.txt` carries this
  notice whenever its bundle includes the coefficients.

## First-party code

Except as noted above, the contents of this repository are
Copyright © LifeScope INC, DBA Companion Intelligence (<https://ci.computer>),
licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE).

---

_Generated by [`scripts/generate-attribution.mjs`](https://github.com/companionintelligence/CI-Engineering/blob/main/scripts/generate-attribution.mjs) for `CI-Spatial`, with the section above corrected by hand. Regenerate rather than editing generated sections by hand._
