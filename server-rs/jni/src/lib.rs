//! The Android TV app's server (MIGRATION_PLAN.md 8.7): the same Rust server as the desktop app's sidecar
//! (server-rs), inside the app's process, started by the Kotlin shell (AppServer.kt) over JNI. It replaced Node.js
//! (nodejs-mobile) running server.js; the HTTP API, and so the pages and the player, are the same.
//!
//! Java: `static native String startServer(int port, String publicDir, String tmpDir, String openSubtitlesKey,
//! String tmdbKey)` on `app.aghorizon.tv.AppServer`. It returns "" once the server listens, or why it couldn't
//! start. The server then runs on its own threads for as long as the process lives. No ffmpeg on the TV (ExoPlayer
//! decodes) and no downloads, as before.

use std::path::PathBuf;
use std::sync::mpsc;

use jni::objects::{JClass, JString};
use jni::sys::{jint, jstring};
use jni::JNIEnv;

fn text(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(|v| v.into()).unwrap_or_default()
}

/// Starts the server; Ok(port) once it listens. Runs it on a thread of its own that never returns.
pub fn start(port: u16, public_dir: PathBuf, tmp_dir: PathBuf, opensubtitles_key: String, tmdb_key: String) -> Result<u16, String> {
    // the temporary subtitle files (subtitles.rs: std::env::temp_dir), as Node's TMPDIR was set
    if !tmp_dir.as_os_str().is_empty() {
        let _ = std::fs::create_dir_all(&tmp_dir);
        std::env::set_var("TMPDIR", &tmp_dir);
    }
    let cfg = aghorizon_server::Config {
        public_dir,
        ffmpeg_path: None,
        opensubtitles_key,
        tmdb_key,
        tmdb_base: "https://api.themoviedb.org/3".into(),
        opensubtitles_base: "https://api.opensubtitles.com/api/v1".into(),
        local_files: None,
    };
    let (tx, rx) = mpsc::channel::<Result<u16, String>>();
    std::thread::Builder::new()
        .name("agh-server".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().thread_name("agh-server").build() {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = tx.send(Err(format!("no runtime: {e}")));
                    return;
                }
            };
            rt.block_on(async move {
                match aghorizon_server::start(cfg, port).await {
                    Ok((p, task)) => {
                        let _ = tx.send(Ok(p));
                        let _ = task.await;
                        eprintln!("AG Horizon server stopped");
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string()));
                    }
                }
            });
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|_| "the server thread ended before it listened".to_string())?
}

#[no_mangle]
pub extern "system" fn Java_app_aghorizon_tv_AppServer_startServer<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    port: jint,
    public_dir: JString<'l>,
    tmp_dir: JString<'l>,
    opensubtitles_key: JString<'l>,
    tmdb_key: JString<'l>,
) -> jstring {
    log_to_logcat();
    let (public_dir, tmp_dir) = (text(&mut env, &public_dir), text(&mut env, &tmp_dir));
    let (os_key, tmdb) = (text(&mut env, &opensubtitles_key), text(&mut env, &tmdb_key));
    // nothing may unwind into the JVM
    let result = std::panic::catch_unwind(|| start(port as u16, PathBuf::from(public_dir), PathBuf::from(tmp_dir), os_key, tmdb))
        .unwrap_or_else(|_| Err("the server panicked while starting".into()));
    let message = match result {
        Ok(p) => {
            eprintln!("AG Horizon server listening on {p}");
            String::new()
        }
        Err(e) => e,
    };
    env.new_string(message).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

/// What the server prints (eprintln) goes to logcat under "AGHorizonServer", as Node's output did. Once per process.
#[cfg(target_os = "android")]
fn log_to_logcat() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    #[link(name = "log")]
    extern "C" {
        fn __android_log_write(prio: libc::c_int, tag: *const libc::c_char, text: *const libc::c_char) -> libc::c_int;
    }
    ONCE.call_once(|| unsafe {
        let mut fds = [0 as libc::c_int; 2];
        if libc::pipe(fds.as_mut_ptr()) != 0 {
            return;
        }
        libc::dup2(fds[1], libc::STDOUT_FILENO);
        libc::dup2(fds[1], libc::STDERR_FILENO);
        let read_fd = fds[0];
        let _ = std::thread::Builder::new().name("agh-log".into()).spawn(move || {
            use std::io::{BufRead, BufReader};
            use std::os::fd::FromRawFd;
            let reader = BufReader::new(std::fs::File::from_raw_fd(read_fd));
            for line in reader.lines().map_while(Result::ok) {
                let tag = b"AGHorizonServer\0";
                let msg = std::ffi::CString::new(line.replace('\0', " ")).unwrap_or_default();
                __android_log_write(4 /* ANDROID_LOG_INFO */, tag.as_ptr() as *const libc::c_char, msg.as_ptr());
            }
        });
    });
}
#[cfg(not(target_os = "android"))]
fn log_to_logcat() {}
