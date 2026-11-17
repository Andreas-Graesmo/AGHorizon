/*
 * In-app updates for the Tauri build (MIGRATION_PLAN.md Phase 5). The page sees the same `updater` as in the
 * Electron app (electron/updater.js): check, download, install, with the same status shapes, pushed as
 * `updater:status` events: {state: idle|checking|available|current|downloading|ready|error, version, percent, notes,
 * manual, checkedAt, message}.
 *
 * Where an update is looked for (decision 0.6):
 *   Stable  releases/latest/download/latest.json (GitHub's latest release, never a pre-release)
 *   Test    the newest published release, beta or not: the page finds it through the GitHub API (tauri-shell.js, as
 *           the Android TV app does) and passes its latest.json here. Only a latest.json from this repository's
 *           releases is accepted; anything else falls back to Stable.
 * Whatever is found, the installer is installed only if it carries a valid signature from the release key
 * (plugins.updater.pubkey in tauri.conf.json, MIGRATION_PLAN.md 1.0), and only if it is newer than this version.
 * AGH_UPDATER_ENDPOINT replaces the endpoint, for e2e/tauri-update.js only (its test builds have their own key).
 */
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

pub const REPO: &str = "Andreas-Graesmo/AGHorizon";

fn stable_endpoint() -> String {
    format!("https://github.com/{REPO}/releases/latest/download/latest.json")
}

// the Test channel's latest.json, as the page found it: only from this repository's releases
fn accepted(url: &str) -> bool {
    let prefix = format!("https://github.com/{REPO}/releases/download/");
    url.starts_with(&prefix) && url.ends_with("/latest.json") && !url[prefix.len()..].contains("..")
}

#[derive(Default)]
pub struct Updater {
    channel: Mutex<String>,
    status: Mutex<Value>,
    found: Mutex<Option<Update>>,
    ready: Mutex<Option<(Update, Vec<u8>)>>,
}

pub fn init(app: &AppHandle) {
    let st = app.state::<Updater>();
    let version = app.package_info().version.to_string();
    *st.channel.lock().unwrap() = if version.contains('-') { "test" } else { "stable" }.into();   // as in Electron
    *st.status.lock().unwrap() = json!({ "state": "idle" });
}

// why updates can't be installed here ("" = they can)
fn reason() -> &'static str {
    if cfg!(windows) {
        ""
    } else {
        "On this system, download new versions from GitHub."   // macOS and Linux: MIGRATION_PLAN.md Phase 9
    }
}

fn send(app: &AppHandle, next: Value) -> Value {
    *app.state::<Updater>().status.lock().unwrap() = next.clone();
    let _ = app.emit("updater:status", next.clone());
    next
}

fn version_of(app: &AppHandle) -> Option<String> {
    app.state::<Updater>().status.lock().unwrap().get("version").and_then(|v| v.as_str()).map(String::from)
}

fn busy(app: &AppHandle) -> bool {
    let st = app.state::<Updater>();
    let s = st.status.lock().unwrap();
    matches!(s.get("state").and_then(|v| v.as_str()), Some("downloading") | Some("ready"))
}

#[tauri::command]
pub async fn updater(app: AppHandle, op: String, args: Vec<Value>) -> Result<Value, String> {
    let st = app.state::<Updater>();
    match op.as_str() {
        "info" => Ok(json!({
            "updater": reason().is_empty(),
            "updaterReason": reason(),
            "channel": *st.channel.lock().unwrap(),
            "releasesUrl": format!("https://github.com/{REPO}/releases/latest"),
        })),
        "status" => Ok(st.status.lock().unwrap().clone()),
        "setChannel" => {
            let next = args.first().and_then(|v| v.as_str()).unwrap_or("");
            if (next == "stable" || next == "test") && *st.channel.lock().unwrap() != next {
                *st.channel.lock().unwrap() = next.into();
                if !busy(&app) {
                    *st.found.lock().unwrap() = None;
                    send(&app, json!({ "state": "idle" }));
                }
            }
            Ok(json!(*st.channel.lock().unwrap()))
        }
        "check" => Ok(check(&app, args.first().and_then(|v| v.as_str()).map(String::from)).await),
        "download" => Ok(download(&app).await),
        // on its own thread: the installer's hook stops the server, which waits (block_on), and that may not happen
        // on one of the async runtime's threads (found by e2e/tauri-update.js: "Cannot start a runtime from within a
        // runtime"). On Windows install() exits the process, so join() returns only if it failed.
        "install" => {
            let app2 = app.clone();
            std::thread::spawn(move || install(&app2)).join().map_err(|_| "the installer could not be started".to_string())
        }
        // the release on offer, else the newest release (or, on the Test channel, the list with the pre-releases)
        "open" => {
            let base = format!("https://github.com/{REPO}/releases");
            let state = st.status.lock().unwrap().get("state").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let url = match version_of(&app) {
                Some(v) if ["available", "downloading", "ready", "error"].contains(&state.as_str()) => format!("{base}/tag/v{v}"),
                _ if *st.channel.lock().unwrap() == "test" => base,
                _ => format!("{base}/latest"),
            };
            app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        _ => Err(format!("unknown updater operation {op}")),
    }
}

async fn check(app: &AppHandle, test_manifest: Option<String>) -> Value {
    if busy(app) {
        return app.state::<Updater>().status.lock().unwrap().clone();
    }
    send(app, json!({ "state": "checking" }));
    let endpoint = std::env::var("AGH_UPDATER_ENDPOINT").ok().unwrap_or_else(|| {
        let on_test = *app.state::<Updater>().channel.lock().unwrap() == "test";
        match test_manifest {
            Some(url) if on_test && accepted(&url) => url,
            _ => stable_endpoint(),
        }
    });
    let found = async {
        let url = tauri::Url::parse(&endpoint).map_err(|e| e.to_string())?;
        let quit = app.clone();
        app.updater_builder()
            .endpoints(vec![url])
            .map_err(|e| e.to_string())?
            // the installer replaces the program files: the server sidecar and its ffmpeg must be gone first
            .on_before_exit(move || crate::stop_server(&quit))
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    match found {
        Ok(Some(update)) => {
            let next = json!({ "state": "available", "version": update.version, "notes": update.body });
            *app.state::<Updater>().found.lock().unwrap() = Some(update);
            send(app, next)
        }
        Ok(None) => send(app, json!({ "state": "current", "checkedAt": now_ms() })),
        // no latest.json there: the newest release on this channel isn't a Tauri build (e.g. while it's Electron's)
        Err(e) if e.contains("404") || e.contains("release JSON") || e.contains("ReleaseNotFound") => {
            send(app, json!({ "state": "current", "checkedAt": now_ms() }))
        }
        Err(e) => send(app, json!({ "state": "error", "message": short(&e) })),
    }
}

async fn download(app: &AppHandle) -> Value {
    let Some(update) = app.state::<Updater>().found.lock().unwrap().clone() else {
        return app.state::<Updater>().status.lock().unwrap().clone();
    };
    let version = update.version.clone();
    send(app, json!({ "state": "downloading", "version": version, "percent": 0 }));
    let (mut got, mut shown) = (0u64, 0u64);
    let progress = app.clone();
    let v = version.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                got += chunk as u64;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let percent = (got * 100 / total).min(100);
                    if percent != shown {
                        shown = percent;
                        send(&progress, json!({ "state": "downloading", "version": v, "percent": percent }));
                    }
                }
            },
            || {},
        )
        .await;
    match bytes {
        // the signature was checked by download(): a wrong or missing one is an error
        Ok(bytes) => {
            *app.state::<Updater>().ready.lock().unwrap() = Some((update, bytes));
            send(app, json!({ "state": "ready", "version": version }))
        }
        Err(e) => send(app, json!({ "state": "error", "version": version, "message": short(&e.to_string()) })),
    }
}

// runs the installer (passive: a progress window, no questions) and exits; the installer starts the app again
fn install(app: &AppHandle) -> Value {
    let Some((update, bytes)) = app.state::<Updater>().ready.lock().unwrap().take() else {
        return app.state::<Updater>().status.lock().unwrap().clone();
    };
    let version = update.version.clone();
    match update.install(&bytes) {
        Ok(()) => send(app, json!({ "state": "idle" })),   // not on Windows, which exits in install()
        Err(e) => send(app, json!({ "state": "error", "version": version, "message": short(&e.to_string()) })),
    }
}

// The app is closing with an update downloaded: install it now, without starting the app again (as Electron's
// autoInstallOnAppQuit did). Returns only if there was nothing to install, or it failed.
pub fn install_on_quit(app: &AppHandle) {
    let Some((update, bytes)) = app.state::<Updater>().ready.lock().unwrap().take() else { return };
    if let Err(e) = update.restart_after_install(false).install(&bytes) {
        eprintln!("[updater] could not install on quit: {e}");
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn short(s: &str) -> String {
    s.chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_repositorys_release_manifests() {
        assert!(accepted("https://github.com/Andreas-Graesmo/AGHorizon/releases/download/v3.0.0-beta.1/latest.json"));
        assert!(!accepted("https://github.com/Andreas-Graesmo/AGHorizon/releases/download/v3/other.json"));
        assert!(!accepted("https://github.com/someone/AGHorizon/releases/download/v3/latest.json"));
        assert!(!accepted("http://github.com/Andreas-Graesmo/AGHorizon/releases/download/v3/latest.json"));
        assert!(!accepted("https://github.com/Andreas-Graesmo/AGHorizon/releases/download/../../x/latest.json"));
        assert!(!accepted("https://evil.example/https://github.com/Andreas-Graesmo/AGHorizon/releases/download/v3/latest.json"));
    }
}
