// Companion Scan desktop shell: the bundled Scan web app (../../src) in a Tauri window. The window
// opens the editor and viewer (viewer.html); there is no AR capture on the desktop.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{Manager, Runtime, Url};

/// True for a page of the app itself: the bundle (tauri://localhost on macOS and Linux,
/// http(s)://tauri.localhost on Windows), the dev server in a debug build, and the blank and
/// blob pages a webview uses on its own.
fn is_app_page(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            Some("localhost") | Some("127.0.0.1") => cfg!(debug_assertions),
            _ => false,
        },
        "about" | "blob" | "data" => true,
        _ => false,
    }
}

/// Keeps the window on the app. A link anywhere else (a Scan server's own pages, a licence, a
/// map) opens in the person's browser instead of replacing the app in its window, where there
/// would be no way back. Links with target="_blank" are the opener plugin's: it sends them to
/// the browser before they navigate.
fn external_links<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("external-links")
        .on_navigation(|_webview, url| {
            if is_app_page(url) {
                return true;
            }
            if matches!(url.scheme(), "https" | "http" | "mailto") {
                let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .build()
}

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
        .plugin(external_links())
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

#[cfg(test)]
mod tests {
    use super::is_app_page;
    use tauri::Url;

    fn page(url: &str) -> bool {
        is_app_page(&Url::parse(url).unwrap())
    }

    #[test]
    fn the_bundle_is_the_app_on_every_platform() {
        assert!(page("tauri://localhost/viewer.html"));
        assert!(page("http://tauri.localhost/viewer.html?project=p1"));
        assert!(page("https://tauri.localhost/index.html"));
        assert!(page("about:blank"));
    }

    #[test]
    fn anything_else_is_not() {
        assert!(!page("https://scan.example.ts.net/authenticate/oidc?shell=desktop"));
        assert!(!page("https://github.com/8thwall/engine/blob/main/LICENSE"));
        assert!(!page("tauri://evil.example/"));
        assert!(!page("http://tauri.localhost.evil.example/"));
        assert!(!page("file:///C:/Windows/"));
        assert!(!page("computer.ci.scan.desktop://auth?code=x"));
    }
}
