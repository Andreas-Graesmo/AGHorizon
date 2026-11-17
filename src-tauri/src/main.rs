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

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
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

// Requests to the sidecar over its stdin, answered on its stdout (sidecar/entry.js): id → who waits for the answer.
#[derive(Default)]
struct Rpc {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
}

fn port() -> u16 {
    std::env::var("TUNER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT)
}

fn main() {
    tauri::Builder::default()
        // first, as its docs ask: a second launch focuses this one (two copies would fight over the port)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| focus_main(app)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Server(Mutex::new(None)))
        .manage(Rpc::default())
        .invoke_handler(tauri::generate_handler![downloads, sync])
        .setup(|app| {
            start_server(app.handle().clone())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building AG Horizon")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_server(app);
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

fn stop_server(app: &AppHandle) {
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

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("AG Horizon")
        .inner_size(1280.0, 800.0)
        .min_inner_size(760.0, 520.0)
        .background_color(tauri::window::Color(0x0c, 0x0e, 0x12, 0xff))
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
        // window.open: picture-in-picture and the mirror window come in MIGRATION_PLAN.md 4.3/4.4;
        // other web links (trailers) open in the system browser
        .on_new_window(move |u, _features| {
            let own = u.origin().ascii_serialization() == popup_origin;
            if !own && (u.scheme() == "http" || u.scheme() == "https") {
                let _ = popup_app.opener().open_url(u.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        });

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
    tauri::async_runtime::spawn(async move {
        tokio_sleep(Duration::from_secs(5)).await;
        let _ = window.show();
    });
    Ok(())
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
