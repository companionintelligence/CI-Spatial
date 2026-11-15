Companion Scan {{VERSION}} for desktop and Android. **This is a pre-release, not a store build.** Nothing here is in an app store, and the apps are early.

## Before you install

- **The apps need your own Scan server.** They have no server of their own. Run Companion Scan on your Companion Hub, or on a machine you run, and enter its https address in the app the first time you open it. See [Companion Hub: how Scan finds its services](https://github.com/companionintelligence/CI-Spatial/blob/main/docs/operations/COMPANION_HUB.md). The apps accept https addresses only.
- **The desktop app is the editor and viewer only.** It opens the Place Scan Editor and cannot capture. Scan with a phone, then review, edit and export on the desktop.
- **AR capture in the Android app has not been tried on a phone yet.** The app installs and opens, but the camera capture path (the 8th Wall engine in the app's WebView) is unverified. Expect problems there.

## Downloads

| File | For |
| --- | --- |
| `{{WINDOWS_SETUP}}` | Windows 10 and 11 (installer) |
| `{{WINDOWS_MSI}}` | Windows (MSI package) |
| `{{MACOS_DMG}}` | macOS 12 or later, Apple silicon and Intel |
| `{{LINUX_DEB}}` | Debian, Ubuntu and their derivatives |
| `{{LINUX_RPM}}` | Fedora, RHEL and their derivatives |
| `{{ANDROID_APK}}` | Android 7.0 or later |
| `SHA256SUMS.txt` | The SHA-256 of every file here |
| `LICENSE`, `THIRD-PARTY-NOTICES.txt` | Companion Scan's licence, and the licences of everything the apps include |

## Installing

**Windows.** The installers are not code-signed, so SmartScreen may say "Windows protected your PC". Choose **More info**, then **Run anyway**.

**macOS.** The app is ad-hoc signed and not notarized, so macOS will not open it with a double-click the first time. Drag it to Applications, then right-click (or Control-click) it, choose **Open**, and choose **Open** again. If macOS still refuses, open **System Settings > Privacy & Security** and choose **Open Anyway** next to the message about Companion Scan.

**Linux.** Install the package with your package manager, which also installs WebKitGTK 4.1: `sudo apt install ./{{LINUX_DEB}}` or `sudo dnf install ./{{LINUX_RPM}}`.

**Android.** Download the APK on the phone and open it. Android asks you to allow installs from the browser or file manager you used; allow it for that app. {{ANDROID_SIGNING}} Android installs an update only when it is signed with the same key as the app already installed. When a later build is signed with a different key, uninstall this one first, which also removes the scans it keeps on the phone.

To check a download against `SHA256SUMS.txt`: `sha256sum -c SHA256SUMS.txt --ignore-missing` on Linux, `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` on macOS, or `Get-FileHash <file>` in PowerShell on Windows.

## Licences

Companion Scan is licensed under the PolyForm Noncommercial License 1.0.0 (`LICENSE`). The Android app includes the Niantic Spatial XR Engine (8th Wall), which is proprietary and licensed under the [XR Engine License Agreement](https://github.com/8thwall/engine/blob/main/LICENSE); the desktop app does not include it. `THIRD-PARTY-NOTICES.txt` lists every other component with its licence, and each app shows these under Legal notices.

Built from {{COMMIT}}.
