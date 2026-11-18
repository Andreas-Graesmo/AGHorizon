// AG Horizon desktop app, Tauri shell (MIGRATION_PLAN.md Phase 2, Windows first).
// Starts the app's own server (server.js as the `aghorizon-server` sidecar, with the bundled ffmpeg) and shows its
// page, http://127.0.0.1:47831, in the main window: the same origin as the Electron app, so the page works unchanged.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_window_state::StateFlags;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// The page keeps playlists in localStorage, which belongs to the origin, port included: never change it.
const DEFAULT_PORT: u16 = 47831;
const START_TIMEOUT: Duration = Duration::from_secs(20);

// WebView2 flags, as tested in the media spike (MIGRATION_PLAN.md 0.1). Tauri's own defaults come first, because
// setting additional_browser_args replaces them.
#[cfg(windows)]
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
    --enable-features=PlatformHEVCDecoderSupport --enable-blink-features=AudioVideoTracks \
    --autoplay-policy=no-user-gesture-required";

struct Server(Mutex<Option<CommandChild>>);

// What the first start brings over from the Electron app (MIGRATION_PLAN.md Phase 6), decided before the window opens.
#[derive(Default)]
struct Migration {
    script: Mutex<Option<String>>, // initialization script that imports migration.json into the page
    notice: Mutex<bool>,           // an Electron profile without migration.json: tell the person once
}

// Requests to the sidecar over its stdin, answered on its stdout (sidecar/entry.js): id → who waits for the answer.
#[derive(Default)]
struct Rpc {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
}

fn port() -> u16 {
    std::env::var("TUNER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT)
}

mod updater;

// MIGRATION_PLAN.md 9.6: the screen stays on while a video plays. tauri-shell.js asks for the Wake Lock API first
// (WebView2 grants it); WebKit (macOS, Linux) denies it, so the page falls back to this. Held until released or quit.
#[derive(Default)]
struct KeepAwake(#[cfg(not(windows))] Mutex<Option<keepawake::KeepAwake>>);

#[tauri::command]
fn keep_awake(#[allow(unused_variables)] state: tauri::State<'_, KeepAwake>, on: bool) -> Result<bool, String> {
    #[cfg(not(windows))]
    {
        let mut held = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if on && held.is_none() {
            *held = Some(hold_awake()?);
        } else if !on {
            if let Some(k) = held.take() {
                // dropping it lets the screen sleep again; keepawake's Linux release unwraps the D-Bus answer, and a
                // screensaver that went away in between must not take the app down
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || drop(k)));
            }
        }
        Ok(held.is_some())
    }
    #[cfg(windows)]
    {
        let _ = on;
        Err("not used on Windows: WebView2 grants the Wake Lock API".into())
    }
}

// The screen on and no idle sleep. On Linux these are two services (the session's screensaver, logind on the system
// bus) and keepawake fails as a whole if either is missing, so take what the system has.
#[cfg(not(windows))]
fn hold_awake() -> Result<keepawake::KeepAwake, String> {
    let mut last = String::new();
    for (display, idle) in [(true, true), (true, false), (false, true)] {
        let made = std::panic::catch_unwind(|| {
            keepawake::Builder::default()
                .display(display)
                .idle(idle)
                .reason("Playing video")
                .app_name("AG Horizon")
                .app_reverse_domain("app.aghorizon.desktop")
                .create()
        });
        match made {
            Ok(Ok(k)) => return Ok(k),
            Ok(Err(e)) => last = e.to_string(),
            Err(_) => last = "keepawake panicked".into(),
        }
    }
    Err(last)
}

fn main() {
    tauri::Builder::default()
        // first, as its docs ask: a second launch focuses this one (two copies would fight over the port)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| focus_main(app)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // size, position and maximised (MIGRATION_PLAN.md 4.1); not VISIBLE: the page shows the window when drawn
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .with_denylist(&["pip", "mirror"])
                .build(),
        )
        .manage(Server(Mutex::new(None)))
        .manage(Rpc::default())
        .manage(Migration::default())
        .manage(updater::Updater::default())
        .manage(KeepAwake::default())
        .invoke_handler(tauri::generate_handler![downloads, sync, popups, migration, keep_awake, updater::updater])
        .setup(|app| {
            updater::init(app.handle());
            start_server(app.handle().clone())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building AG Horizon")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_server(app);
                updater::install_on_quit(app);   // exits if an update was waiting
            }
        });
}

fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/* ───────────────────────── the server sidecar ───────────────────────── */

fn start_server(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let port = port();
    let public = app.path().resource_dir()?.join("public");
    // externalBin programs sit next to the app's executable, without the target triple
    let exe_dir = std::env::current_exe()?.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let ffmpeg = exe_dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });

    // the downloads list and the sync folder setting live in the app's data folder (MIGRATION_PLAN.md 3.4/3.5)
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    // before the server reads downloads.json and sync.json
    from_electron(&app, &data_dir);
    let documents = app.path().document_dir().unwrap_or_else(|_| data_dir.clone());
    let mut envs: Vec<(String, String)> = vec![
        ("PUBLIC_DIR".into(), public.to_string_lossy().into_owned()),
        ("FFMPEG_PATH".into(), ffmpeg.to_string_lossy().into_owned()),
        ("AGH_DATA_DIR".into(), data_dir.to_string_lossy().into_owned()),
        ("AGH_DOCUMENTS_DIR".into(), documents.to_string_lossy().into_owned()),
    ];
    // API keys: set at build time by CI from its secrets (as release.yml writes secrets.json for Electron)
    if let Some(k) = option_env!("TMDB_API_KEY") {
        envs.push(("TMDB_API_KEY".into(), k.into()));
    }
    if let Some(k) = option_env!("OPENSUBTITLES_API_KEY") {
        envs.push(("OPENSUBTITLES_API_KEY".into(), k.into()));
    }

    // stdin stays open while the app runs: the server exits when it closes (sidecar/entry.js)
    let (mut rx, child) = app
        .shell()
        .sidecar("aghorizon-server")?
        .args([port.to_string()])
        .envs(envs)
        .spawn()?;
    #[cfg(windows)]
    job::contain(child.pid());
    *app.state::<Server>().0.lock().unwrap() = Some(child);

    let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = started.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line).trim().to_string();
                    if let Some(rest) = line.strip_prefix("RPC ") {
                        answer(&app2, rest);
                        continue;
                    }
                    if let Some(rest) = line.strip_prefix("EVENT ") {
                        if let Ok(ev) = serde_json::from_str::<Value>(rest) {
                            if let Some(name) = ev["name"].as_str() {
                                let _ = tauri::Emitter::emit_to(&app2, "main", name, ev["payload"].clone());
                            }
                        }
                        continue;
                    }
                    if flag.load(std::sync::atomic::Ordering::SeqCst) {
                        continue;
                    }
                    if let Some(p) = line.strip_prefix("READY ") {
                        flag.store(true, std::sync::atomic::Ordering::SeqCst);
                        if let Err(e) = open_main(&app2, p.parse().unwrap_or(port)) {
                            fail(&app2, &format!("The window could not be opened: {e}"));
                        }
                    } else if line.starts_with("ERROR") {
                        let msg = if line.contains("EADDRINUSE") {
                            format!("Port {port} is used by another program. Close it, or start AG Horizon with the environment variable TUNER_PORT set to a free port number (your saved playlists are tied to the port, so keep using the same one).")
                        } else {
                            line.clone()
                        };
                        fail(&app2, &msg);
                    }
                }
                CommandEvent::Stderr(line) => eprintln!("[server] {}", String::from_utf8_lossy(&line).trim_end()),
                CommandEvent::Terminated(status) => {
                    if !flag.load(std::sync::atomic::Ordering::SeqCst) {
                        fail(&app2, &format!("The app's server stopped while starting ({status:?})."));
                    } else {
                        eprintln!("[server] stopped: {status:?}");
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    let app3 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio_sleep(START_TIMEOUT).await;
        if !started.load(std::sync::atomic::Ordering::SeqCst) {
            fail(&app3, "The app's server did not start in time.");
        }
    });
    Ok(())
}

pub(crate) fn stop_server(app: &AppHandle) {
    // already stopped (the updater stops it before its installer runs, then the app exits)
    if app.state::<Server>().0.lock().unwrap().is_none() {
        return;
    }
    // first ask: the downloads engine marks what was downloading to carry on next time, saves, and exits
    let asked = tauri::async_runtime::block_on(async {
        tokio::time::timeout(Duration::from_millis(1500), rpc(app, "quit", json!([]))).await
    });
    if asked.is_err() {
        eprintln!("[server] did not answer quit in time");
    }
    if let Some(child) = app.state::<Server>().0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

/* ───────────────────────── talking to the sidecar ───────────────────────── */

async fn rpc(app: &AppHandle, cmd: &str, args: Value) -> Result<Value, String> {
    let state = app.state::<Rpc>();
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id, tx);
    let msg = format!("{}\n", json!({ "id": id, "cmd": cmd, "args": args }));
    {
        let mut server = app.state::<Server>().inner().0.lock().unwrap();
        let child = server.as_mut().ok_or("the app's server is not running")?;
        child.write(msg.as_bytes()).map_err(|e| e.to_string())?;
    }
    match tokio::time::timeout(Duration::from_secs(60), rx).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(_)) => Err("no answer from the app's server".into()),
        Err(_) => {
            state.pending.lock().unwrap().remove(&id);
            Err("the app's server did not answer in time".into())
        }
    }
}

fn answer(app: &AppHandle, text: &str) {
    let Ok(m) = serde_json::from_str::<Value>(text) else { return };
    let Some(id) = m["id"].as_u64() else { return };
    let waiting = app.state::<Rpc>().pending.lock().unwrap().remove(&id);
    if let Some(tx) = waiting {
        let result = if m["ok"].as_bool() == Some(true) {
            Ok(m["result"].clone())
        } else {
            Err(m["error"].as_str().unwrap_or("error").to_string())
        };
        let _ = tx.send(result);
    }
}

async fn pick_folder(app: &AppHandle, title: &str, start: Option<String>) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    let mut dialog = app.dialog().file().set_title(title).set_can_create_directories(true);
    if let Some(dir) = start.filter(|d| std::path::Path::new(d).is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    if let Some(w) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&w);
    }
    dialog.pick_folder(move |p| {
        let _ = tx.send(p.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()));
    });
    rx.await.ok().flatten()
}

/* ───────────────────────── commands for the page (public/js/tauri-shell.js) ───────────────────────── */

// Downloads (electron/preload.js `downloads.*`). The engine runs in the sidecar (desktop/downloads-core.js); the
// folder dialog and Explorer are here. Only these operations exist: the page can't reach anything else.
#[tauri::command]
async fn downloads(app: AppHandle, op: String, args: Vec<Value>) -> Result<Value, String> {
    match op.as_str() {
        "list" | "orphans" | "adopt" | "add" | "pause" | "resume" | "reorder" | "remove" | "setOption" | "setWatching" => {
            rpc(&app, &format!("downloads.{op}"), Value::Array(args)).await
        }
        "chooseFolder" => {
            let current = rpc(&app, "downloads.currentFolder", json!([])).await?;
            match pick_folder(&app, "Choose the download folder", current.as_str().map(String::from)).await {
                Some(folder) => rpc(&app, "downloads.setFolder", json!([folder])).await,
                None => Ok(Value::Null),
            }
        }
        "reveal" => {
            let target = rpc(&app, "downloads.revealTarget", Value::Array(args)).await?;
            let result = match target["file"].as_str() {
                Some(file) => app.opener().reveal_item_in_dir(file),
                None => app.opener().open_path(target["folder"].as_str().unwrap_or_default(), None::<&str>),
            };
            result.map(|_| Value::Null).map_err(|e| e.to_string())
        }
        "openFolder" => {
            let folder = rpc(&app, "downloads.ensureFolder", json!([])).await?;
            // as Electron's shell.openPath: '' when it worked, else the error text
            Ok(json!(app.opener().open_path(folder.as_str().unwrap_or_default(), None::<&str>).err().map(|e| e.to_string()).unwrap_or_default()))
        }
        _ => Err(format!("unknown downloads operation {op}")),
    }
}

// Sync (electron/preload.js `sync.*`): the code in the system's keychain, the folder through the sidecar
// (desktop/sync-folder.js). The encrypted files travel as base64.
#[tauri::command]
async fn sync(app: AppHandle, op: String, args: Vec<Value>) -> Result<Value, String> {
    match op.as_str() {
        "info" => {
            let mut info = rpc(&app, "sync.info", json!([])).await?;
            info["keychain"] = json!(code_store::secure());
            Ok(info)
        }
        "getCode" => code_store::get(&app).map(Value::String),
        "setCode" => code_store::set(&app, args.first().and_then(|v| v.as_str()).unwrap_or_default()).map(|_| Value::Null),
        "chooseFolder" => {
            let current = rpc(&app, "sync.info", json!([])).await?;
            match pick_folder(&app, "Choose a folder to sync through", current["folder"].as_str().map(String::from)).await {
                Some(folder) => rpc(&app, "sync.setFolder", json!([folder])).await,
                None => Ok(json!("")),
            }
        }
        "folderList" | "folderPut" | "folderRemove" => rpc(&app, &format!("sync.{op}"), Value::Array(args)).await,
        _ => Err(format!("unknown sync operation {op}")),
    }
}

// The sync code: Windows Credential Manager. Elsewhere (development builds until MIGRATION_PLAN.md Phase 9) a file in
// the app's data folder, as the Electron app does when it has no keychain.
mod code_store {
    use tauri::AppHandle;
    #[cfg(not(windows))]
    use tauri::Manager;

    #[cfg(windows)]
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new("AG Horizon", "sync-code").map_err(|e| e.to_string())
    }

    pub fn secure() -> bool {
        cfg!(windows)
    }

    #[cfg(windows)]
    pub fn get(_app: &AppHandle) -> Result<String, String> {
        match entry()?.get_password() {
            Ok(code) => Ok(code),
            Err(keyring::Error::NoEntry) => Ok(String::new()),
            Err(e) => Err(e.to_string()),
        }
    }

    #[cfg(windows)]
    pub fn set(_app: &AppHandle, code: &str) -> Result<(), String> {
        let e = entry()?;
        if code.is_empty() {
            match e.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(err) => Err(err.to_string()),
            }
        } else {
            e.set_password(code).map_err(|e| e.to_string())
        }
    }

    #[cfg(not(windows))]
    fn file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
        Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("sync-code"))
    }

    #[cfg(not(windows))]
    pub fn get(app: &AppHandle) -> Result<String, String> {
        Ok(std::fs::read_to_string(file(app)?).unwrap_or_default())
    }

    #[cfg(not(windows))]
    pub fn set(app: &AppHandle, code: &str) -> Result<(), String> {
        let f = file(app)?;
        if code.is_empty() {
            let _ = std::fs::remove_file(f);
            Ok(())
        } else {
            std::fs::write(f, code).map_err(|e| e.to_string())
        }
    }

}

// As electron/main.js: tell the person, then quit. AGH_NO_DIALOG=1 (tests): just print it.
// Only once: stopping the server below makes it report its end too.
static FAILED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn fail(app: &AppHandle, message: &str) {
    if FAILED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    eprintln!("AG Horizon could not start: {message}");
    if std::env::var("AGH_NO_DIALOG").is_err() {
        app.dialog()
            .message(message)
            .title("AG Horizon could not start")
            .kind(MessageDialogKind::Error)
            .blocking_show();
    }
    stop_server(app);
    app.exit(1);
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

/* ───────────────────────── the main window ───────────────────────── */

fn open_main(app: &AppHandle, port: u16) -> tauri::Result<()> {
    let origin = format!("http://127.0.0.1:{port}");
    let url: Url = format!("{origin}/").parse().expect("valid url");
    let (nav_app, popup_app, nav_origin, popup_origin) = (app.clone(), app.clone(), origin.clone(), origin);
    let legacy = legacy_bounds(app);

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("AG Horizon")
        .inner_size(1280.0, 800.0)
        .min_inner_size(760.0, 520.0)
        .background_color(tauri::window::Color(0x0c, 0x0e, 0x12, 0xff))
        // the app's own top bar is the title bar, with HTML window buttons (MIGRATION_PLAN.md 0.5 / 4.2)
        .decorations(false)
        .shadow(true)
        .visible(false) // shown by the page once it has drawn (tauri-shell.js ready()), or after 5 s
        .disable_drag_drop_handler() // the page reads dropped .m3u files itself (boot.js)
        // stay on the app's own page; real links go to the system browser (electron/main.js will-navigate)
        .on_navigation(move |u| {
            let own = u.origin().ascii_serialization() == nav_origin;
            if !own && (u.scheme() == "http" || u.scheme() == "https") {
                let _ = nav_app.opener().open_url(u.as_str(), None::<&str>);
            }
            own
        })
        // window.open: picture-in-picture and the mirror window (MIGRATION_PLAN.md 4.3 / 4.4);
        // other web links (trailers) open in the system browser
        .on_new_window(move |u, features| {
            if u.as_str() == "about:blank" || (u.origin().ascii_serialization() == popup_origin && u.path() == "/mirror.html") {
                return popup(&popup_app, &u, features);
            }
            if u.scheme() == "http" || u.scheme() == "https" {
                let _ = popup_app.opener().open_url(u.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        });
    if let Some(script) = app.state::<Migration>().script.lock().unwrap().clone() {
        builder = builder.initialization_script(&script);
    }
    if let Some(b) = &legacy {
        builder = builder.inner_size(b.width, b.height);
        if let (Some(x), Some(y)) = (b.x, b.y) {
            builder = builder.position(x, y);
        }
    }

    // 9.7 macOS: the system's traffic lights over the top bar's left end, as in the Electron app (titleBarStyle
    // 'hidden'); the top bar stays the title bar (tauri-shell.js leaves room for them and adds no buttons)
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .decorations(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            // centred in the 42 px top bar (--topbar in style.css)
            .traffic_light_position(tauri::LogicalPosition::new(14.0, 21.0));
    }

    #[cfg(windows)]
    {
        let mut args = BROWSER_ARGS.to_string();
        // tests drive the page through the Chrome DevTools Protocol (e2e/tauri-windows.js)
        if let Ok(p) = std::env::var("AGH_DEVTOOLS_PORT") {
            args.push_str(&format!(" --remote-debugging-port={p}"));
        }
        builder = builder.additional_browser_args(&args);
    }

    let window = builder.build()?;
    if legacy.map(|b| b.maximized).unwrap_or(false) {
        let _ = window.maximize();
    }
    // closing the app window takes picture-in-picture and the mirror with it (electron/main.js 'closed')
    let a = app.clone();
    window.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            for label in ["pip", "mirror"] {
                if let Some(w) = a.get_webview_window(label) {
                    let _ = w.destroy();
                }
            }
        }
    });
    if *app.state::<Migration>().notice.lock().unwrap() {
        notice_no_export(app);
    }
    tauri::async_runtime::spawn(async move {
        tokio_sleep(Duration::from_secs(5)).await;
        let _ = window.show();
    });
    Ok(())
}

/* ───────────────────────── the first start after the Electron app (MIGRATION_PLAN.md Phase 6) ───────────────────────── */

const IMPORT_MARKER: &str = "electron-import.json";
const NOTICE_MARKER: &str = "electron-import-notice";

// The Electron app's data folder: <appData>/Tuner IPTV (Windows %APPDATA%\Tuner IPTV), next to this app's config dir.
fn electron_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?.parent()?.join("Tuner IPTV");
    dir.is_dir().then_some(dir)
}

fn from_electron(app: &AppHandle, data_dir: &std::path::Path) {
    let Some(old) = electron_dir(app) else { return };
    // 6.1 plain files, only where this app has none yet; the downloaded films stay where they are
    for f in ["downloads.json", "sync.json"] {
        let (from, to) = (old.join(f), data_dir.join(f));
        if from.is_file() && !to.exists() {
            if let Err(e) = std::fs::copy(&from, &to) {
                eprintln!("migration: could not copy {f}: {e}");
            }
        }
    }
    let export = old.join("migration.json");
    let Ok(text) = std::fs::read_to_string(&export) else {
        // 6.4 an Electron profile but no export (the bridge version was never run): say so once
        let never_imported = !data_dir.join(IMPORT_MARKER).exists() && !data_dir.join(NOTICE_MARKER).exists();
        if never_imported && old.join("Local Storage").is_dir() {
            *app.state::<Migration>().notice.lock().unwrap() = true;
        }
        return;
    };
    let Ok(mut data) = serde_json::from_str::<Value>(&text) else {
        eprintln!("migration: migration.json is not readable JSON");
        return;
    };
    // 6.3 the sync code, put there by the hand-over: into Credential Manager (unless this app has one), then out of the file
    if let Some(code) = data.get("syncCode").and_then(|c| c.as_str()).map(String::from) {
        if !code.is_empty() && code_store::get(app).map(|c| c.is_empty()).unwrap_or(false) {
            if let Err(e) = code_store::set(app, &code) {
                eprintln!("migration: could not store the sync code: {e}");
                return; // keep it in the file: next start tries again
            }
        }
        if let Some(obj) = data.as_object_mut() {
            obj.remove("syncCode");
        }
        let tmp = export.with_extension("json.tmp");
        if std::fs::write(&tmp, data.to_string()).and_then(|_| std::fs::rename(&tmp, &export)).is_err() {
            eprintln!("migration: could not remove the sync code from migration.json");
        }
    }
    // 6.2 the page's storage: once, by an initialization script that runs before the page's own scripts
    if data_dir.join(IMPORT_MARKER).exists() || data.get("format").and_then(|f| f.as_u64()) != Some(1) {
        return;
    }
    let payload = json!({ "localStorage": data["localStorage"], "indexedDB": data["indexedDB"] });
    let script = format!(
        "if (location.origin === 'http://127.0.0.1:{}' && !window.__aghMigrating) window.__aghMigrating = {}({});",
        port(),
        include_str!("../../desktop/migration-import.js").lines().filter(|l| !l.starts_with("//")).collect::<Vec<_>>().join("\n"),
        payload
    );
    *app.state::<Migration>().script.lock().unwrap() = Some(script);
}

fn notice_no_export(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::write(dir.join(NOTICE_MARKER), "shown\n");
    }
    if std::env::var("AGH_NO_DIALOG").is_ok() {
        eprintln!("migration: no export from the previous version");
        return;
    }
    app.dialog()
        .message("Your playlists, favourites and history from the previous version of AG Horizon could not be brought over yet. Start the previous version once (it is still installed), close it, and then start this one again. Or restore them from sync.")
        .title("AG Horizon")
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

// The page reports the import (tauri-shell.js): from now on it isn't offered again.
#[tauri::command]
fn migration(app: AppHandle, op: String, result: Option<Value>) -> Result<Value, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match op.as_str() {
        "done" => {
            let record = json!({ "importedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0), "result": result });
            std::fs::write(dir.join(IMPORT_MARKER), record.to_string()).map_err(|e| e.to_string())?;
            *app.state::<Migration>().script.lock().unwrap() = None;
            Ok(Value::Null)
        }
        "status" => Ok(json!({
            "imported": dir.join(IMPORT_MARKER).exists(),
            "noticeShown": dir.join(NOTICE_MARKER).exists(),
        })),
        _ => Err(format!("unknown migration operation {op}")),
    }
}

// The Electron app's last window bounds (<appData>/Tuner IPTV/window-state.json, logical pixels), used once: until
// the window-state plugin has its own file (MIGRATION_PLAN.md 4.1).
struct LegacyBounds {
    x: Option<f64>,
    y: Option<f64>,
    width: f64,
    height: f64,
    maximized: bool,
}
fn legacy_bounds(app: &AppHandle) -> Option<LegacyBounds> {
    let config = app.path().app_config_dir().ok()?;
    if config.join(tauri_plugin_window_state::DEFAULT_FILENAME).exists() {
        return None;
    }
    let text = std::fs::read_to_string(config.parent()?.join("Tuner IPTV").join("window-state.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let (width, height) = (v["width"].as_f64()?, v["height"].as_f64()?);
    if width < 400.0 || height < 300.0 {
        return None;
    }
    Some(LegacyBounds { x: v["x"].as_f64(), y: v["y"].as_f64(), width, height, maximized: v["maximized"].as_bool() == Some(true) })
}

/* ───────────────────────── picture-in-picture and the mirror window ───────────────────────── */

// window.open("about:blank", "ag-horizon-pip") and window.open("/mirror.html[?d=<monitor>]", "tuner-mirror"):
// Tauri windows handed to WebView2, so the page keeps scripting them as before (spike 0.2). As electron/main.js:
// frameless; PiP 480x270, on top, bottom right; the mirror floating on top, or fullscreen on the monitor picked.
fn popup(app: &AppHandle, url: &Url, features: NewWindowFeatures) -> NewWindowResponse<Wry> {
    let pip = url.as_str() == "about:blank";
    let label = if pip { "pip" } else { "mirror" };
    // window.close() from the page leaves the Tauri window up (spike 0.2): a leftover would block the label
    if let Some(old) = app.get_webview_window(label) {
        let _ = old.destroy();
    }
    let display = if pip { None } else { url.query_pairs().find(|(k, _)| k == "d").map(|(_, v)| v.into_owned()) };
    let (w, h) = if pip { (480.0, 270.0) } else { (960.0, 540.0) };
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External("about:blank".parse().expect("url")))
        .window_features(features)
        .title(if pip { "AG Horizon – picture in picture" } else { "AG Horizon – mirror picture" })
        .decorations(false)
        .shadow(true)
        .background_color(tauri::window::Color(0, 0, 0, 0xff))
        .always_on_top(display.is_none())
        .inner_size(w, h)
        .min_inner_size(260.0, 146.0);
    if display.is_none() {
        if let Some((x, y)) = bottom_right(app, w, h) {
            builder = builder.position(x, y);
        }
    }
    match builder.build() {
        Ok(window) => {
            if let Some(key) = display {
                fullscreen_on(&window, &key);
            }
            if pip {
                keep_16_9(&window);
            }
            NewWindowResponse::Create { window }
        }
        Err(e) => {
            eprintln!("popup {label}: {e}");
            NewWindowResponse::Deny
        }
    }
}

// bottom right of the work area of the screen the app window is on, 24 px in (electron/main.js float())
fn bottom_right(app: &AppHandle, w: f64, h: f64) -> Option<(f64, f64)> {
    let m = app.get_webview_window("main")?.current_monitor().ok()??;
    let (area, scale) = (m.work_area(), m.scale_factor());
    let right = (area.position.x as f64 + area.size.width as f64) / scale;
    let bottom = (area.position.y as f64 + area.size.height as f64) / scale;
    Some((right - w - 24.0, bottom - h - 24.0))
}

// the monitor picked in the page ("name@x,y", tauri-shell.js displays()): cover it, fullscreen
fn fullscreen_on(window: &WebviewWindow, key: &str) {
    let Ok(monitors) = window.available_monitors() else { return };
    let found = monitors.into_iter().find(|m| {
        format!("{}@{},{}", m.name().map(String::as_str).unwrap_or(""), m.position().x, m.position().y) == key
    });
    if let Some(m) = found {
        let _ = window.set_position(*m.position());
        let _ = window.set_size(*m.size());
        let _ = window.set_fullscreen(true);
    }
}

// Tauri has no setAspectRatio: put the height back to 16:9 of the width after each resize
fn keep_16_9(window: &WebviewWindow) {
    let w = window.clone();
    window.on_window_event(move |e| {
        if let WindowEvent::Resized(size) = e {
            let want = size.width * 9 / 16;
            if size.height.abs_diff(want) > 2 && size.width > 0 {
                let _ = w.set_size(tauri::PhysicalSize::new(size.width, want));
            }
        }
    });
}

// The page asks for these through tauri-shell.js: remove a closed popup's window, or drag a frameless one.
#[tauri::command]
fn popups(app: AppHandle, op: String, label: String) -> Result<(), String> {
    if label != "pip" && label != "mirror" {
        return Err(format!("no such popup {label}"));
    }
    let Some(w) = app.get_webview_window(&label) else { return Ok(()) };
    match op.as_str() {
        "destroy" => w.destroy().map_err(|e| e.to_string()),
        "drag" => w.start_dragging().map_err(|e| e.to_string()),
        _ => Err(format!("unknown popups operation {op}")),
    }
}

/* ───────────────────────── Windows: the server dies with the app ───────────────────────── */

// The server and every ffmpeg it starts go into a job that Windows ends when the app ends, whichever way: quit,
// crash or Task Manager. The job's handle is deliberately never closed by us.
#[cfg(windows)]
mod job {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    pub fn contain(pid: u32) {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                eprintln!("job object: could not create one");
                return;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() || AssignProcessToJobObject(job, process) == 0 {
                eprintln!("job object: could not add the server (pid {pid})");
            }
            if !process.is_null() {
                CloseHandle(process);
            }
        }
    }
}
