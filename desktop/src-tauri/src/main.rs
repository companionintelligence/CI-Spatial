// Companion Scan desktop shell: the bundled Scan web app (../../src) in a Tauri window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        // Registered first, so a second launch hands over and quits before anything else starts.
        // A Companion Account sign-in ends in the browser at computer.ci.scan.desktop://auth?code=…
        // On Windows and Linux that link starts a second copy of the app; the deep-link feature
        // passes the link to this copy, which then comes to the front.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // The sign-in return. src/shared/shell-sign-in.ts reads it through window.__TAURI__.deepLink.
        .plugin(tauri_plugin_deep_link::init())
        // Opens the Scan server's sign-in page in the system browser (window.__TAURI__.opener).
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            // The installers register the URL scheme (NSIS, MSI, deb and rpm; Info.plist on macOS).
            // A debug run from the source tree was never installed, so it registers itself for the
            // current user instead.
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                _app.deep_link().register_all()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Companion Scan");
}
