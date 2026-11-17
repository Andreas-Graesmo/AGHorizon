// Phase 0.1 media spike: one window on the AG Horizon server origin, with the WebView2 flags the plan proposes.
// Env: SPIKE_URL (default http://127.0.0.1:47831/spike/?exit=1), SPIKE_TIMEOUT seconds (default 600),
//      SPIKE_NO_FLAGS=1 to leave out the WebView2 browser arguments.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn spike_ping(msg: String) -> String {
    format!("pong:{msg}")
}

#[tauri::command]
fn spike_done(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    let url = std::env::var("SPIKE_URL").unwrap_or_else(|_| "http://127.0.0.1:47831/spike/?exit=1".into());
    let timeout: u64 = std::env::var("SPIKE_TIMEOUT").ok().and_then(|s| s.parse().ok()).unwrap_or(600);

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![spike_ping, spike_done])
        .setup(move |app| {
            #[allow(unused_mut)]
            let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("AG Horizon media spike")
                .inner_size(1100.0, 900.0);
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
            b.build()?;
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
