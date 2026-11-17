// Phase 0.1/0.2 spikes: one window on the AG Horizon server origin, with the WebView2 flags the plan proposes.
// Env: SPIKE_URL (default http://127.0.0.1:47831/spike/?exit=1), SPIKE_TIMEOUT seconds (default 600),
//      SPIKE_NO_FLAGS=1 to leave out the WebView2 browser arguments.
// Popup spike (0.2): window.open is answered by `on_new_window` in the mode the page sets with `popup_mode`:
//   "deny" (the default; also what Tauri does with no handler), "allow" (WebView2's own popup window),
//   "create" (a frameless WebviewWindow built here and handed over, as PiP/Mirror would need).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::NewWindowResponse;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct PopupMode(Mutex<String>);
static POPUPS: AtomicU32 = AtomicU32::new(0);

#[derive(serde::Serialize)]
struct WinInfo {
    label: String,
    width: u32,
    height: u32,
    decorated: bool,
    always_on_top: bool,
    fullscreen: bool,
    visible: bool,
}

#[derive(serde::Serialize)]
struct MonitorInfo {
    name: Option<String>,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    scale: f64,
}

#[tauri::command]
fn spike_ping(msg: String) -> String {
    format!("pong:{msg}")
}

#[tauri::command]
fn spike_done(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn popup_mode(state: tauri::State<PopupMode>, mode: String) -> Result<String, String> {
    if !["deny", "allow", "create"].contains(&mode.as_str()) {
        return Err(format!("unknown mode {mode}"));
    }
    *state.0.lock().unwrap() = mode.clone();
    Ok(mode)
}

#[tauri::command]
fn popup_windows(app: tauri::AppHandle) -> Vec<WinInfo> {
    let mut v: Vec<WinInfo> = app
        .webview_windows()
        .into_iter()
        .map(|(label, w)| {
            let size = w.inner_size().unwrap_or_default();
            WinInfo {
                label,
                width: size.width,
                height: size.height,
                decorated: w.is_decorated().unwrap_or(true),
                always_on_top: w.is_always_on_top().unwrap_or(false),
                fullscreen: w.is_fullscreen().unwrap_or(false),
                visible: w.is_visible().unwrap_or(false),
            }
        })
        .collect();
    v.sort_by(|a, b| a.label.cmp(&b.label));
    v
}

// "Mirror to a monitor": main.js:141 makes the mirror window fullscreen on the chosen display.
#[tauri::command]
async fn popup_fullscreen(app: tauri::AppHandle, label: String) -> Result<bool, String> {
    let w = app.get_webview_window(&label).ok_or("no such window")?;
    w.set_fullscreen(true).map_err(|e| e.to_string())?;
    tokio_sleep(600).await;
    let on = w.is_fullscreen().map_err(|e| e.to_string())?;
    let _ = w.set_fullscreen(false);
    Ok(on)
}

#[tauri::command]
fn monitors(app: tauri::AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let w = app.get_webview_window("main").ok_or("no main window")?;
    let list = w.available_monitors().map_err(|e| e.to_string())?;
    Ok(list
        .into_iter()
        .map(|m| MonitorInfo {
            name: m.name().cloned(),
            width: m.size().width,
            height: m.size().height,
            x: m.position().x,
            y: m.position().y,
            scale: m.scale_factor(),
        })
        .collect())
}

async fn tokio_sleep(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms))).await;
}

fn main() {
    let url = std::env::var("SPIKE_URL").unwrap_or_else(|_| "http://127.0.0.1:47831/spike/?exit=1".into());
    let timeout: u64 = std::env::var("SPIKE_TIMEOUT").ok().and_then(|s| s.parse().ok()).unwrap_or(600);

    tauri::Builder::default()
        .manage(PopupMode(Mutex::new("deny".into())))
        .invoke_handler(tauri::generate_handler![
            spike_ping,
            spike_done,
            popup_mode,
            popup_windows,
            popup_fullscreen,
            monitors
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            #[allow(unused_mut)]
            let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("AG Horizon spike")
                .inner_size(1100.0, 900.0)
                .on_new_window(move |target, features| {
                    let mode = handle.state::<PopupMode>().0.lock().unwrap().clone();
                    match mode.as_str() {
                        "allow" => NewWindowResponse::Allow,
                        "create" => {
                            let n = POPUPS.fetch_add(1, Ordering::SeqCst);
                            let pip = target.as_str() == "about:blank";
                            // As electron/main.js:86-111: PiP is a frameless always-on-top 480x270 window,
                            // the mirror a frameless 960x540 one. window_features() also sets the same WebView2
                            // environment as the opener, which SetNewWindow requires.
                            let mut wb = WebviewWindowBuilder::new(
                                &handle,
                                format!("popup-{n}"),
                                WebviewUrl::External("about:blank".parse().unwrap()),
                            )
                            .window_features(features)
                            .title(if pip { "PiP (spike)" } else { "Mirror (spike)" })
                            .decorations(false)
                            .always_on_top(pip);
                            if pip {
                                wb = wb.inner_size(480.0, 270.0).min_inner_size(260.0, 146.0);
                            }
                            match wb.build() {
                                Ok(window) => NewWindowResponse::Create { window },
                                Err(e) => {
                                    eprintln!("spike: popup build failed: {e}");
                                    NewWindowResponse::Deny
                                }
                            }
                        }
                        _ => NewWindowResponse::Deny,
                    }
                });
            #[cfg(windows)]
            if std::env::var("SPIKE_NO_FLAGS").is_err() {
                // Tauri's own defaults first: setting additional_browser_args replaces them.
                b = b.additional_browser_args(concat!(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ",
                    "--enable-features=PlatformHEVCDecoderSupport ",
                    "--enable-blink-features=AudioVideoTracks ",
                    "--autoplay-policy=no-user-gesture-required"
                ));
            }
            let main = b.build()?;
            #[cfg(target_os = "linux")]
            main.with_webview(|wv| {
                use webkit2gtk::{SettingsExt, WebViewExt};
                if let Some(s) = WebViewExt::settings(&wv.inner()) {
                    s.set_javascript_can_open_windows_automatically(true);
                }
            })?;
            #[cfg(not(target_os = "linux"))]
            let _ = main;
            let h = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(timeout));
                eprintln!("spike: timed out after {timeout} s");
                h.exit(3);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the spike");
}
