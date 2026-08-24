# Real-Camera Fixture Bank

The real-camera fixture bank contains locally retained Android captures used to
regress the actual camera, capture, tag-rendering, Place, and Area flows. It
is deliberately ignored by Git because a capture can reveal a private interior
or precise location.

## Location

`test-data/real-camera/manifest.json` is the index. Each fixture has two local
artifacts relative to that folder:

1. `cameraPhoto` is a photo from the physical device camera before capture.
2. `tagScreenshot` is an app screenshot after generated tags are visibly
   rendered over that same live camera view.

The manifest also records the device, Place, optional Area, coarse location
label, capture time, and explicit checks that reject synthetic/mock imagery and
solid-colour camera failures. The schema is enforced by
`real_camera_fixture_bank.test.ts`.

## Adding A Fixture

1. Close stale Chrome tabs and open the secure Tailscale scanner URL.
2. Choose/create the intended Place and optional Area, then complete or
   explicitly skip calibration.
3. Confirm a recognisable real scene changes as the device moves. Do not capture
   if the camera area is solid colour, blank, mocked, or blocked by a permission
   prompt.
4. Save one raw physical-camera photo and one post-tag app screenshot.
5. Put both under `test-data/real-camera/` and add an `android-real-camera`
   record to the manifest. Run:

   ```powershell
   deno test --allow-read real_camera_fixture_bank.test.ts
   ```

Only deliberately approved, privacy-reviewed captures should be copied outside
this ignored local bank.
