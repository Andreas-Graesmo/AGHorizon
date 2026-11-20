//! Downloads for offline viewing, one at a time (desktop/downloads-core.js): ordinary video files laid out as
//! Plex / Kodi / Jellyfin expect, the list in <data dir>/downloads.json, the page told of changes as events.
//!   <folder>/Movies/Title (Year)/Title (Year).mkv          + poster.jpg
//!   <folder>/Series/Show/Season 01/Show - S01E02.mkv       + poster.jpg in the show folder
//! The list holds the provider URLs (with the login), so it stays in the app's data folder, never in file names.
//! Each list entry is a JSON object, as in the JS engine, so what was never set stays out of the file and of the page.

use crate::util::*;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::{watch, Notify};

const MAX_TRIES: i64 = 3; // automatic retries after a dropped connection (each one resumes where it stopped)

type Item = Map<String, Value>;

struct Active {
    id: String,
    stop: Arc<Notify>,
    stopped: Arc<AtomicBool>,
    done: watch::Receiver<bool>,
}

struct Engine {
    data_dir: String,
    documents_dir: String,
    folder: String,
    pause_while_watching: bool,
    watching: bool,
    items: Vec<Item>,
    active: Option<Active>,
}

static ENGINE: LazyLock<Mutex<Engine>> = LazyLock::new(|| {
    Mutex::new(Engine { data_dir: String::new(), documents_dir: String::new(), folder: String::new(), pause_while_watching: true, watching: false, items: Vec::new(), active: None })
});
type Broadcast = Box<dyn Fn(Value) + Send + Sync>;
static BROADCAST: OnceLock<Broadcast> = OnceLock::new();

pub fn configure(data_dir: &str, documents_dir: &str, broadcast: Broadcast) {
    let mut e = ENGINE.lock().unwrap();
    e.data_dir = data_dir.to_string();
    e.documents_dir = documents_dir.to_string();
    let _ = BROADCAST.set(broadcast);
}

fn s(it: &Item, k: &str) -> String {
    it.get(k).filter(|v| !v.is_null()).map(js_string).unwrap_or_default()
}
fn exists(p: &str) -> bool {
    !p.is_empty() && Path::new(p).exists()
}

impl Engine {
    fn list_file(&self) -> String {
        pjoin(&[&self.data_dir, "downloads.json"])
    }
    fn held(&self) -> bool {
        self.watching && self.pause_while_watching
    }
    fn find(&self, id: &Value) -> Option<usize> {
        self.items.iter().position(|x| x.get("id") == Some(id))
    }
    fn is_active(&self, idx: usize) -> bool {
        self.active.as_ref().map(|a| Some(&json!(a.id)) == self.items[idx].get("id")).unwrap_or(false)
    }

    /* ───────────── storage ───────────── */
    fn load(&mut self) {
        let j: Value = std::fs::read_to_string(self.list_file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({})); // first run
        self.folder = j.get("folder").filter(|v| truthy(Some(v))).map(js_string).unwrap_or_else(|| pjoin(&[&self.documents_dir, "AGHorizon"]));
        self.pause_while_watching = j.get("pauseWhileWatching") != Some(&json!(false));
        self.items = j
            .get("items")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|it| it.as_object().cloned())
                    .map(|mut it| {
                        if it.get("state") == Some(&json!("downloading")) {
                            it.insert("state".into(), json!("queued")); // the app was closed mid-download: carry on
                        }
                        it
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.relocate();
    }

    fn save(&mut self) {
        SAVE_GEN.fetch_add(1, Ordering::SeqCst); // a pending saveSoon is no longer needed
        // via a temp file, so a crash mid-write never leaves a broken list (load() would then start empty)
        let body = json!({ "folder": self.folder, "pauseWhileWatching": self.pause_while_watching, "items": self.items }).to_string();
        let f = self.list_file();
        let _ = std::fs::write(format!("{f}.tmp"), body).and_then(|_| std::fs::rename(format!("{f}.tmp"), &f));
    }

    /* ───────────── moved or missing files ───────────── */
    fn present(it: &Item) -> bool {
        it.get("state") != Some(&json!("done")) || exists(&s(it, "file"))
    }
    fn under_folder(&self, file: &str) -> Option<String> {
        static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\\/](Movies[\\/][^\\/]+[\\/][^\\/]+|Series[\\/][^\\/]+[\\/][^\\/]+[\\/][^\\/]+)$").unwrap());
        RE.captures(file).map(|m| pjoin(&[&self.folder, &m[1]]))
    }
    /// A finished download whose file isn't where it was is kept, never dropped: it's looked for at the same place
    /// under the current folder, and hidden from the page until it turns up.
    fn relocate(&mut self) {
        let mut changed = false;
        for i in 0..self.items.len() {
            if Self::present(&self.items[i]) {
                continue;
            }
            let Some(moved) = self.under_folder(&s(&self.items[i], "file")) else { continue };
            if !exists(&moved) {
                continue;
            }
            self.items[i].insert("file".into(), json!(moved));
            let p = poster_path(&self.items[i]);
            self.items[i].insert("posterFile".into(), json!(if exists(&p) { p } else { String::new() }));
            changed = true;
        }
        if changed {
            self.save();
        }
    }

    /* ───────────── telling the page ───────────── */
    fn snapshot(&self) -> Map<String, Value> {
        let items: Vec<Value> = self.items.iter().filter(|it| Self::present(it)).map(|it| Value::Object(publish(it))).collect();
        let mut o = Map::new();
        o.insert("items".into(), Value::Array(items));
        o.insert("folder".into(), json!(self.folder));
        o.insert("pauseWhileWatching".into(), json!(self.pause_while_watching));
        o.insert("held".into(), json!(self.held()));
        o
    }

    /// targetFile(): never overwrite a file that was already there, or one another download is about to write
    fn target_file(&self, m: &Item) -> String {
        static EXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-z0-9]{2,5}$").unwrap());
        static SE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)S\d+\s*E\d+").unwrap());
        let ext = { let e = s(m, "ext"); if EXT.is_match(&e) { e.to_lowercase() } else { "mp4".into() } };
        let (dir, base) = if s(m, "kind") == "movie" {
            let mut name = clean(m.get("title"));
            let year = m.get("year").filter(|v| truthy(Some(v))).map(js_string);
            if let Some(y) = year.filter(|y| !name.contains(y.as_str())) {
                name.push_str(&format!(" ({y})"));
            }
            (pjoin(&[&self.folder, "Movies", &name]), name)
        } else {
            let show = clean(Some(&js_or(m.get("seriesName"), json!("Series"))));
            let se = format!("S{}E{}", pad(m.get("season")), pad(m.get("episode")));
            let t = m.get("epTitle").filter(|v| truthy(Some(v))).map(js_string).unwrap_or_default();
            let extra = if !t.is_empty() && !SE.is_match(&t) && !t.to_lowercase().starts_with(&show.to_lowercase()) { format!(" - {}", clean(Some(&json!(t)))) } else { String::new() };
            (pjoin(&[&self.folder, "Series", &show, &format!("Season {}", pad(m.get("season")))]), format!("{show} - {se}{extra}"))
        };
        let mut file = pjoin(&[&dir, &format!("{base}.{ext}")]);
        let mut i = 2;
        while exists(&file) || self.items.iter().any(|x| s(x, "file") == file) {
            file = pjoin(&[&dir, &format!("{base} ({i}).{ext}")]);
            i += 1;
        }
        file
    }
}

/// Movies/Title/poster.jpg, Series/Show/poster.jpg
fn poster_path(it: &Item) -> String {
    let f = s(it, "file");
    let dir = if s(it, "kind") == "movie" { pdirname(&f) } else { pdirname(&pdirname(&f)) };
    pjoin(&[&dir, "poster.jpg"])
}

/// what the page sees of a list entry
fn publish(it: &Item) -> Map<String, Value> {
    let mut o = Map::new();
    let copy = |o: &mut Map<String, Value>, k: &str| {
        if let Some(v) = it.get(k) {
            o.insert(k.into(), v.clone());
        }
    };
    for k in ["id", "uid", "pid", "kind", "title", "year", "plot", "ext", "seriesUid", "seriesName", "season", "episode", "epTitle", "poster"] {
        copy(&mut o, k);
    }
    o.insert("hasPoster".into(), json!(truthy(it.get("posterFile"))));
    copy(&mut o, "state");
    copy(&mut o, "error");
    for k in ["size", "received", "speed"] {
        o.insert(k.into(), js_or(it.get(k), json!(0)));
    }
    copy(&mut o, "addedAt");
    o.insert("doneAt".into(), js_or(it.get("doneAt"), json!(0)));
    o
}

/// a name Windows, macOS and Linux all accept
fn clean(v: Option<&Value>) -> String {
    static BAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[<>:"/\\|?*\x00-\x1f]+"#).unwrap());
    static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s\u{feff}]+").unwrap());
    static TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[. ]+$").unwrap());
    static RESERVED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(con|prn|aux|nul|com\d|lpt\d)$").unwrap());
    let raw = v.filter(|x| truthy(Some(x))).map(js_string).unwrap_or_default();
    let n = BAD.replace_all(&raw, " ");
    let n = SPACE.replace_all(&n, " ");
    let mut n = TAIL.replace(n.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'), "").into_owned();
    if n.encode_utf16().count() > 100 {
        n = slice_utf16(&n, 100).trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}').to_string();
    }
    if n.is_empty() || RESERVED.is_match(&n) {
        n = format!("_{n}");
    }
    n
}
fn pad(v: Option<&Value>) -> String {
    let s = js_string(&js_or(v, json!(0)));
    if s.encode_utf16().count() < 2 { format!("{s:0>2}") } else { s }
}

/* ───────────── telling the page: now, or once within half a second while downloading ───────────── */

fn send() {
    let snap = ENGINE.lock().unwrap().snapshot();
    if let Some(b) = BROADCAST.get() {
        b(Value::Object(snap));
    }
}
static TICK: AtomicBool = AtomicBool::new(false);
fn send_soon() {
    if !TICK.swap(true, Ordering::SeqCst) {
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            TICK.store(false, Ordering::SeqCst);
            send();
        });
    }
}
static SAVE_GEN: AtomicU64 = AtomicU64::new(0);
static SAVE_PENDING: AtomicBool = AtomicBool::new(false);
fn save_soon() {
    if !SAVE_PENDING.swap(true, Ordering::SeqCst) {
        let gen = SAVE_GEN.load(Ordering::SeqCst);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            SAVE_PENDING.store(false, Ordering::SeqCst);
            if SAVE_GEN.load(Ordering::SeqCst) == gen {
                ENGINE.lock().unwrap().save();
            }
        });
    }
}
/// set(): change an entry, save, tell the page
fn set(id: &str, patch: Value) {
    {
        let mut e = ENGINE.lock().unwrap();
        if let Some(i) = e.find(&json!(id)) {
            if let Value::Object(p) = patch {
                for (k, v) in p {
                    e.items[i].insert(k, v);
                }
            }
        }
        e.save();
    }
    send();
}
fn get(id: &str, k: &str) -> Option<Value> {
    let e = ENGINE.lock().unwrap();
    e.find(&json!(id)).and_then(|i| e.items[i].get(k).cloned())
}

/* ───────────── downloading ───────────── */

fn friendly_status(status: u16) -> String {
    match status {
        401 | 403 => "The provider refused the download. Check that the subscription is active.".into(),
        404 => "This title is no longer available from the provider.".into(),
        429 | 458 | 509 => "The provider’s connection limit is used up. Stop other playback and try again.".into(),
        s => format!("The provider answered HTTP {s}."),
    }
}
const LOST: &str = "Lost the connection to the provider.";
fn friendly_io(e: &std::io::Error) -> String {
    use std::io::ErrorKind::*;
    match e.kind() {
        StorageFull => "Not enough disk space.".into(),
        PermissionDenied | ReadOnlyFilesystem => "Can’t write to the download folder. Choose another folder.".into(),
        ConnectionRefused | ConnectionReset | TimedOut | UnexpectedEof | ConnectionAborted => LOST.into(),
        _ => e.to_string().lines().next().unwrap_or("Unknown error").chars().take(200).collect(),
    }
}

async fn save_poster(id: String, poster: String, ua: String, file: String) {
    if !exists(&file) {
        let r = upstream(&match url::Url::parse(&poster) { Ok(u) => u, Err(_) => return }, Some(&ua), None);
        let Ok(Ok(r)) = tokio::time::timeout(Duration::from_secs(20), r.send()).await else { return };
        let image = r.headers().get("content-type").and_then(|v| v.to_str().ok()).map(|c| c.to_lowercase().starts_with("image/")).unwrap_or(false);
        if !r.status().is_success() || !image {
            return;
        }
        let Ok(Ok(b)) = tokio::time::timeout(Duration::from_secs(20), r.bytes()).await else { return };
        if tokio::fs::write(&file, &b).await.is_err() {
            return; // the download itself matters more than its picture
        }
    }
    let mut e = ENGINE.lock().unwrap();
    if let Some(i) = e.find(&json!(id)) {
        e.items[i].insert("posterFile".into(), json!(file));
    }
}

enum Fail {
    Status(u16),
    Msg(String, bool), // message, transient
}

async fn run(id: String, stop: Arc<Notify>, stopped: Arc<AtomicBool>) {
    set(&id, json!({ "state": "downloading", "error": "", "speed": 0 }));
    let result: Result<(), Fail> = async {
        let (file, url, ua, poster, has_poster, kind) = {
            let e = ENGINE.lock().unwrap();
            let it = &e.items[e.find(&json!(id)).ok_or(Fail::Msg("removed".into(), false))?];
            (s(it, "file"), s(it, "url"), s(it, "ua"), s(it, "poster"), truthy(it.get("posterFile")), s(it, "kind"))
        };
        let part = format!("{file}.part");
        tokio::fs::create_dir_all(pdirname(&file)).await.map_err(|e| Fail::Msg(friendly_io(&e), false))?;
        if !poster.is_empty() && !has_poster {
            let mut it = Item::new();
            it.insert("file".into(), json!(file));
            it.insert("kind".into(), json!(kind));
            tokio::spawn(save_poster(id.clone(), poster, ua.clone(), poster_path(&it)));
        }
        let mut have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
        let u = url::Url::parse(&url).map_err(|_| Fail::Msg("Invalid URL".into(), false))?;
        let range = (have > 0).then(|| format!("bytes={have}-"));
        let r = tokio::select! {
            r = upstream(&u, Some(&ua), range.as_deref()).send() => r.map_err(|_| Fail::Msg(LOST.into(), true))?,
            _ = stop.notified() => return Ok(()),
        };
        let status = r.status().as_u16();
        if !(status == 416 && have > 0) {
            // 416 with a .part: asked for bytes past the end, the .part is already complete
            if !r.status().is_success() {
                return Err(Fail::Status(status));
            }
            let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
            if ct.contains("mpegurl") {
                return Err(Fail::Msg("This title is streamed in small pieces (HLS) and can’t be downloaded.".into(), false));
            }
            if ct.starts_with("text/") || ct.contains("json") {
                return Err(Fail::Msg("The provider sent a web page instead of the video. The connection limit may be used up.".into(), false));
            }
            let resumed = status == 206;
            if !resumed {
                have = 0;
            }
            static TOTAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/(\d+)\s*$").unwrap());
            let total = r.headers().get("content-range").and_then(|v| v.to_str().ok()).and_then(|c| TOTAL.captures(c).map(|m| js_number(Some(&m[1]))));
            let len = r.headers().get("content-length").and_then(|v| v.to_str().ok()).map(|c| js_number(Some(c))).filter(|x| !x.is_nan()).unwrap_or(0.0);
            let size = total.unwrap_or(if len > 0.0 { have as f64 + len } else { 0.0 });
            {
                let mut e = ENGINE.lock().unwrap();
                if let Some(i) = e.find(&json!(id)) {
                    e.items[i].insert("size".into(), js_num(size));
                    e.items[i].insert("received".into(), js_num(have as f64));
                }
            }
            let mut out = std::fs::OpenOptions::new().create(true).write(true).append(resumed).truncate(!resumed).open(&part).map_err(|e| Fail::Msg(friendly_io(&e), false))?;
            let mut received = have as f64;
            let mut mark = (now_ms(), received);
            let mut speed = 0.0;
            let mut body = r.bytes_stream();
            use futures_util::StreamExt;
            loop {
                let chunk = tokio::select! {
                    c = body.next() => c,
                    _ = stop.notified() => { let _ = out.flush(); return Ok(()); }
                };
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|_| Fail::Msg(LOST.into(), true))?;
                out.write_all(&chunk).map_err(|e| Fail::Msg(friendly_io(&e), false))?;
                received += chunk.len() as f64;
                let now = now_ms();
                let mut patch = json!({ "received": js_num(received) });
                if now - mark.0 >= 1000.0 {
                    let v = (received - mark.1) * 1000.0 / (now - mark.0);
                    speed = if speed != 0.0 { speed * 0.6 + v * 0.4 } else { v };
                    mark = (now, received);
                    patch["speed"] = json!(speed);
                    save_soon();
                }
                {
                    let mut e = ENGINE.lock().unwrap();
                    if let Some(i) = e.find(&json!(id)) {
                        for (k, v) in patch.as_object().unwrap() {
                            e.items[i].insert(k.clone(), v.clone());
                        }
                    }
                }
                send_soon();
            }
            out.flush().map_err(|e| Fail::Msg(friendly_io(&e), false))?;
            drop(out);
            if size > 0.0 && received < size {
                return Err(Fail::Msg(LOST.into(), true)); // the download stopped early
            }
        }
        tokio::fs::rename(&part, &file).await.map_err(|e| Fail::Msg(friendly_io(&e), false))?;
        let len = tokio::fs::metadata(&file).await.map(|m| m.len()).unwrap_or(0);
        set(&id, json!({ "state": "done", "size": len, "received": 0, "speed": 0, "tries": 0, "doneAt": now_ms() as i64 }));
        Ok(())
    }
    .await;

    if let Err(f) = result {
        if !stopped.load(Ordering::SeqCst) {
            // paused, held for playback or removed: whoever stopped it has set the state
            let (msg, transient) = match f {
                Fail::Status(st) => (friendly_status(st), false),
                Fail::Msg(m, t) => (m.clone(), t || m == LOST),
            };
            let tries = get(&id, "tries").and_then(|v| v.as_f64()).unwrap_or(0.0) as i64 + 1;
            {
                let mut e = ENGINE.lock().unwrap();
                if let Some(i) = e.find(&json!(id)) {
                    e.items[i].insert("tries".into(), json!(tries));
                }
            }
            if transient && tries < MAX_TRIES {
                set(&id, json!({ "state": "queued", "speed": 0, "error": "" }));
                tokio::time::sleep(Duration::from_secs(5)).await;
            } else {
                set(&id, json!({ "state": "failed", "speed": 0, "error": msg }));
            }
        }
    }
    // finally
    {
        let mut e = ENGINE.lock().unwrap();
        if e.active.as_ref().map(|a| a.id == id).unwrap_or(false) {
            e.active = None;
        }
    }
    pump();
}

/// the first one waiting starts, unless one is running or playback holds them
fn pump() {
    let mut e = ENGINE.lock().unwrap();
    if e.active.is_some() || e.held() {
        return;
    }
    let Some(i) = e.items.iter().position(|x| x.get("state") == Some(&json!("queued"))) else { return };
    let id = s(&e.items[i], "id");
    let (stop, stopped) = (Arc::new(Notify::new()), Arc::new(AtomicBool::new(false)));
    let (tx, rx) = watch::channel(false);
    e.active = Some(Active { id: id.clone(), stop: stop.clone(), stopped: stopped.clone(), done: rx });
    drop(e);
    tokio::spawn(async move {
        run(id, stop, stopped).await;
        let _ = tx.send(true);
    });
}

/// stopActive(): stop the running download, mark it, and wait until its file is closed
async fn stop_active(id: &Value, state: &str) {
    let mut done = {
        let mut e = ENGINE.lock().unwrap();
        let Some(a) = e.active.as_ref().filter(|a| Some(&json!(a.id)) == Some(id)) else { return };
        let (stop, stopped, done) = (a.stop.clone(), a.stopped.clone(), a.done.clone());
        if let Some(i) = e.find(id) {
            e.items[i].insert("state".into(), json!(state));
            e.items[i].insert("speed".into(), json!(0));
        }
        stopped.store(true, Ordering::SeqCst);
        stop.notify_waiters();
        stop.notify_one();
        done
    };
    while !*done.borrow() {
        if done.changed().await.is_err() {
            break;
        }
    }
}

/* ───────────── what the shells call ───────────── */

pub fn start() {
    ENGINE.lock().unwrap().load();
    pump();
}

/// the file of a finished download (or its poster), for /api/local
pub fn local_file(id: &str, what: &str) -> Option<std::path::PathBuf> {
    let e = ENGINE.lock().unwrap();
    let it = &e.items[e.find(&json!(id))?];
    if what == "poster" {
        let p = s(it, "posterFile");
        return exists(&p).then(|| p.into());
    }
    let f = s(it, "file");
    (it.get("state") == Some(&json!("done")) && exists(&f)).then(|| f.into())
}

async fn free_space(folder: &str) -> f64 {
    if tokio::fs::create_dir_all(folder).await.is_err() {
        return 0.0;
    }
    #[cfg(unix)]
    {
        let Ok(c) = std::ffi::CString::new(folder) else { return 0.0 };
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return 0.0;
        }
        st.f_bavail as f64 * st.f_bsize as f64
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let w: Vec<u16> = std::ffi::OsStr::new(folder).encode_wide().chain(Some(0)).collect();
        let mut avail: u64 = 0;
        let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, std::ptr::null_mut(), std::ptr::null_mut()) };
        if ok == 0 { 0.0 } else { avail as f64 }
    }
}

pub async fn list() -> Value {
    let (mut snap, folder) = {
        let mut e = ENGINE.lock().unwrap();
        e.relocate(); // files moved back, or the drive is plugged in again
        (e.snapshot(), e.folder.clone())
    };
    snap.insert("free".into(), js_num(free_space(&folder).await));
    Value::Object(snap)
}

/// Video files in the folder that the list doesn't know (e.g. the list was lost), read from their Plex-style names.
pub async fn orphans() -> Value {
    static VIDEO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(mkv|mp4|m4v|avi|ts|mov|webm)$").unwrap());
    static SEASON: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^Season \d+$").unwrap());
    static SE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)S(\d+)\s*E(\d+)").unwrap());
    let (folder, known) = {
        let e = ENGINE.lock().unwrap();
        (e.folder.clone(), e.items.iter().map(|it| presolve(&s(it, "file")).to_lowercase()).collect::<std::collections::HashSet<_>>())
    };
    let ls = |d: String| async move { readdir_node(Path::new(&d)).await.unwrap_or_default() };
    let mut out = Vec::new();
    let found = |file: String, info: Value, out: &mut Vec<Value>| {
        if known.contains(&presolve(&file).to_lowercase()) {
            return;
        }
        let Ok(st) = std::fs::metadata(&file) else { return };
        let mut o = Map::new();
        o.insert("file".into(), json!(file));
        o.insert("ext".into(), json!(pextname(&file).trim_start_matches('.').to_lowercase()));
        o.insert("size".into(), json!(st.len()));
        if let Value::Object(i) = info {
            o.extend(i);
        }
        out.push(Value::Object(o));
    };
    for (m, t) in ls(pjoin(&[&folder, "Movies"])).await {
        if !t.is_dir() {
            continue;
        }
        for (f, ft) in ls(pjoin(&[&folder, "Movies", &m])).await {
            if ft.is_file() && VIDEO.is_match(&f) {
                found(pjoin(&[&folder, "Movies", &m, &f]), json!({ "kind": "movie", "folderName": m }), &mut out);
            }
        }
    }
    for (show, t) in ls(pjoin(&[&folder, "Series"])).await {
        if !t.is_dir() {
            continue;
        }
        for (season, st) in ls(pjoin(&[&folder, "Series", &show])).await {
            if !st.is_dir() || !SEASON.is_match(&season) {
                continue;
            }
            for (f, ft) in ls(pjoin(&[&folder, "Series", &show, &season])).await {
                if !(ft.is_file() && VIDEO.is_match(&f)) {
                    continue;
                }
                if let Some(se) = SE.captures(&f) {
                    let info = json!({ "kind": "episode", "seriesName": show, "season": js_num(js_number(Some(&se[1]))), "episode": js_num(js_number(Some(&se[2]))) });
                    found(pjoin(&[&folder, "Series", &show, &season, &f]), info, &mut out);
                }
            }
        }
    }
    Value::Array(out)
}

/// a list entry from what the page sends about a movie / episode
fn new_item(m: &Value) -> Option<Item> {
    static HTTP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https?://").unwrap());
    let kind = m.get("kind")?.as_str()?;
    if kind != "movie" && kind != "episode" {
        return None;
    }
    let url = m.get("url").filter(|v| truthy(Some(v))).map(js_string).unwrap_or_default();
    if !HTTP.is_match(&url) {
        return None;
    }
    let mut it = Item::new();
    let mut id = [0u8; 8];
    getrandom_fill(&mut id);
    it.insert("id".into(), json!(id.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    it.insert("uid".into(), json!(m.get("uid").map(js_string).unwrap_or_else(|| "undefined".into())));
    let copy = |it: &mut Item, k: &str| {
        if let Some(v) = m.get(k) {
            it.insert(k.into(), v.clone());
        }
    };
    copy(&mut it, "pid");
    it.insert("kind".into(), json!(kind));
    it.insert("url".into(), m["url"].clone());
    it.insert("ua".into(), js_or(m.get("ua"), json!("")));
    copy(&mut it, "ext");
    copy(&mut it, "title");
    it.insert("year".into(), js_or(m.get("year"), json!("")));
    it.insert("plot".into(), json!(slice_utf16(&m.get("plot").filter(|v| truthy(Some(v))).map(js_string).unwrap_or_default(), 1200)));
    let poster = m.get("poster").filter(|v| truthy(Some(v))).map(js_string).unwrap_or_default();
    it.insert("poster".into(), if HTTP.is_match(&poster) { m["poster"].clone() } else { json!("") });
    it.insert("seriesUid".into(), js_or(m.get("seriesUid"), json!("")));
    it.insert("seriesName".into(), js_or(m.get("seriesName"), json!("")));
    let num = |k: &str| { let x = m.get(k).map(value_number).unwrap_or(f64::NAN); if x.is_nan() || x == 0.0 { json!(0) } else { js_num(x) } };
    it.insert("season".into(), num("season"));
    it.insert("episode".into(), num("episode"));
    it.insert("epTitle".into(), js_or(m.get("epTitle"), json!("")));
    it.insert("state".into(), json!("queued"));
    it.insert("size".into(), json!(0));
    it.insert("received".into(), json!(0));
    it.insert("addedAt".into(), json!(now_ms() as i64));
    Some(it)
}

/// Number(value)
fn value_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => if *b { 1.0 } else { 0.0 },
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_number(Some(s)),
        _ => f64::NAN,
    }
}

fn getrandom_fill(buf: &mut [u8]) {
    // 8 random bytes for an id: the clock and the process mixed through a hash, twice
    use std::hash::{BuildHasher, Hasher};
    for chunk in buf.chunks_mut(8) {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.write_u32(std::process::id());
        let v = h.finish().to_le_bytes();
        chunk.copy_from_slice(&v[..chunk.len()]);
    }
}

pub fn add(list: &Value) -> Value {
    let list: Vec<Value> = match list {
        Value::Array(a) => a.clone(),
        other => vec![other.clone()],
    };
    let mut added = 0;
    {
        let mut e = ENGINE.lock().unwrap();
        for m in &list {
            let Some(mut it) = new_item(m) else { continue };
            if let Some(oi) = e.items.iter().position(|x| x.get("uid") == it.get("uid")) {
                if !Engine::present(&e.items[oi]) {
                    e.items.remove(oi); // its file is gone: download it again
                } else {
                    let st = s(&e.items[oi], "state");
                    if st == "failed" || st == "paused" {
                        let old = &mut e.items[oi];
                        old.insert("state".into(), json!("queued"));
                        old.insert("error".into(), json!(""));
                        old.insert("tries".into(), json!(0));
                        added += 1;
                    }
                    continue;
                }
            }
            let f = e.target_file(&it);
            it.insert("file".into(), json!(f));
            e.items.push(it);
            added += 1;
        }
        e.save();
    }
    send();
    pump();
    json!(added)
}

/// Take orphaned files back as finished downloads, with what the page found out about them.
pub async fn adopt(list: &Value) -> Value {
    let root = {
        let e = ENGINE.lock().unwrap();
        format!("{}{}", presolve(&e.folder).to_lowercase(), if cfg!(windows) { "\\" } else { "/" })
    };
    let mut n = 0;
    for entry in list.as_array().cloned().unwrap_or_default() {
        let file = entry.get("file").filter(|v| truthy(Some(v))).map(js_string).unwrap_or_default();
        if file.is_empty() || !presolve(&file).to_lowercase().starts_with(&root) || !exists(&file) {
            continue;
        }
        let Ok(st) = tokio::fs::metadata(&file).await else { continue };
        let mut e = ENGINE.lock().unwrap();
        if e.items.iter().any(|x| s(x, "file") == file) {
            continue;
        }
        let Some(mut it) = new_item(entry.get("meta").unwrap_or(&Value::Null)) else { continue };
        e.items.retain(|x| !(x.get("uid") == it.get("uid") && !Engine::present(x))); // it replaces its own lost entry
        if e.items.iter().any(|x| x.get("uid") == it.get("uid")) {
            continue;
        }
        let mtime = st.modified().map(time_ms).unwrap_or(0.0);
        for (k, v) in [
            ("file", json!(file)),
            ("ext", json!(pextname(&file).trim_start_matches('.').to_lowercase())),
            ("state", json!("done")),
            ("size", json!(st.len())),
            ("received", json!(st.len())),
            ("addedAt", js_num(mtime)),
            ("doneAt", js_num(mtime)),
        ] {
            it.insert(k.into(), v);
        }
        let p = poster_path(&it);
        if exists(&p) {
            it.insert("posterFile".into(), json!(p));
        }
        e.items.push(it);
        n += 1;
    }
    if n > 0 {
        ENGINE.lock().unwrap().save();
        send();
    }
    json!(n)
}

/// folders left empty (a poster alone doesn't keep one), up to the download folder, never above it
pub async fn remove_empty_dirs(dir: &str) {
    let root = presolve(&ENGINE.lock().unwrap().folder);
    let sep = if cfg!(windows) { "\\" } else { "/" };
    let mut d = presolve(dir);
    while d.starts_with(&format!("{root}{sep}")) {
        let Ok(left) = readdir_node(Path::new(&d)).await else { return };
        if left.iter().any(|(f, _)| f != "poster.jpg") {
            return;
        }
        if tokio::fs::remove_dir_all(&d).await.is_err() {
            return;
        }
        d = pdirname(&d);
    }
}

pub async fn remove(id: &Value, delete_file: bool) -> Value {
    let Some(it) = ({ let e = ENGINE.lock().unwrap(); e.find(id).map(|i| e.items[i].clone()) }) else { return Value::Null };
    stop_active(id, "removed").await;
    let state = get(&s(&it, "id"), "state").map(|v| js_string(&v)).unwrap_or_else(|| s(&it, "state"));
    ENGINE.lock().unwrap().items.retain(|x| x.get("id") != Some(id));
    let file = s(&it, "file");
    let _ = tokio::fs::remove_file(format!("{file}.part")).await;
    if delete_file && state == "done" {
        let _ = tokio::fs::remove_file(&file).await;
        // and its subtitles: "<name>.<lang>….srt" next to it (subtitles.js)
        let base = format!("{}.", pbasename(&file).strip_suffix(&pextname(&file)).unwrap_or(&pbasename(&file)));
        for (f, _) in readdir_node(Path::new(&pdirname(&file))).await.unwrap_or_default() {
            if f.starts_with(&base) && f.to_lowercase().ends_with(".srt") {
                let _ = tokio::fs::remove_file(pjoin(&[&pdirname(&file), &f])).await;
            }
        }
    }
    if delete_file || state != "done" {
        remove_empty_dirs(&pdirname(&file)).await;
    }
    ENGINE.lock().unwrap().save();
    send();
    pump();
    Value::Null
}

pub async fn pause(id: &Value) -> Value {
    let active = { let e = ENGINE.lock().unwrap(); e.find(id).map(|i| e.is_active(i)) };
    let Some(active) = active else { return Value::Null };
    if active {
        stop_active(id, "paused").await;
    } else {
        let mut e = ENGINE.lock().unwrap();
        if let Some(i) = e.find(id) {
            if e.items[i].get("state") == Some(&json!("queued")) {
                e.items[i].insert("state".into(), json!("paused"));
            }
        }
    }
    ENGINE.lock().unwrap().save();
    send();
    pump();
    Value::Null
}

/// A new order for the unfinished downloads; if the first waiting one is no longer the one downloading, it takes over.
pub async fn reorder(ids: &Value) -> Value {
    let pos: std::collections::HashMap<String, usize> = ids.as_array().map(|a| a.iter().enumerate().map(|(i, id)| (js_string(id), i)).collect()).unwrap_or_default();
    let stop = {
        let mut e = ENGINE.lock().unwrap();
        let mut moved: Vec<Item> = e.items.iter().filter(|x| pos.contains_key(&s(x, "id")) && s(x, "state") != "done").cloned().collect();
        if moved.is_empty() {
            return Value::Null;
        }
        moved.sort_by_key(|x| pos[&s(x, "id")]);
        let ids: Vec<Value> = moved.iter().map(|x| x["id"].clone()).collect();
        let rest: Vec<Item> = e.items.iter().filter(|x| !ids.contains(&x["id"])).cloned().collect();
        e.items = moved.into_iter().chain(rest).collect();
        let next = e.items.iter().find(|x| matches!(s(x, "state").as_str(), "queued" | "downloading")).map(|x| s(x, "id"));
        match (&e.active, next) {
            (Some(a), Some(n)) if a.id != n => Some(a.id.clone()),
            _ => None,
        }
    };
    if let Some(a) = stop {
        stop_active(&json!(a), "queued").await;
    }
    ENGINE.lock().unwrap().save();
    send();
    pump();
    Value::Null
}

pub fn resume(id: &Value) -> Value {
    let changed = {
        let mut e = ENGINE.lock().unwrap();
        match e.find(id) {
            Some(i) if matches!(s(&e.items[i], "state").as_str(), "paused" | "failed") => {
                for (k, v) in [("state", json!("queued")), ("error", json!("")), ("tries", json!(0))] {
                    e.items[i].insert(k.into(), v);
                }
                e.save();
                true
            }
            _ => false,
        }
    };
    if changed {
        send();
        pump();
    }
    Value::Null
}

pub async fn set_watching(on: bool) -> Value {
    let stop = {
        let mut e = ENGINE.lock().unwrap();
        e.watching = on;
        if e.held() { e.active.as_ref().map(|a| a.id.clone()) } else { None }
    };
    if let Some(a) = stop {
        stop_active(&json!(a), "queued").await; // it continues from the same byte when playback stops
    }
    send();
    pump();
    Value::Null
}

pub fn set_option(key: &Value, value: &Value) -> Value {
    if key == "pauseWhileWatching" {
        let watching = {
            let mut e = ENGINE.lock().unwrap();
            e.pause_while_watching = truthy(Some(value));
            e.watching
        };
        tokio::spawn(set_watching(watching));
        ENGINE.lock().unwrap().save();
    }
    Value::Null
}

pub fn current_folder() -> Value {
    json!(ENGINE.lock().unwrap().folder)
}

/// the file to show in Explorer / Finder for "show in folder", or null: then the download folder
pub fn reveal_target(id: &Value) -> Value {
    let e = ENGINE.lock().unwrap();
    let Some(i) = e.find(id) else { return json!({ "file": null, "folder": e.folder }) };
    let file = s(&e.items[i], "file");
    let f = if exists(&file) { file } else { format!("{file}.part") };
    json!({ "file": if exists(&f) { json!(f) } else { Value::Null }, "folder": e.folder })
}

pub async fn ensure_folder() -> Value {
    let f = ENGINE.lock().unwrap().folder.clone();
    let _ = tokio::fs::create_dir_all(&f).await;
    json!(f)
}

/// the person picked a new folder: new downloads go there; finished ones stay where they are, unless moved there
pub fn set_folder(next: &Value) -> Value {
    if !truthy(Some(next)) {
        return current_folder();
    }
    let f = {
        let mut e = ENGINE.lock().unwrap();
        e.folder = js_string(next);
        e.relocate();
        e.save();
        e.folder.clone()
    };
    send();
    json!(f)
}

/// the app is closing: what was downloading carries on next time
pub fn quitting() {
    let mut e = ENGINE.lock().unwrap();
    for it in e.items.iter_mut() {
        if it.get("state") == Some(&json!("downloading")) {
            it.insert("state".into(), json!("queued"));
        }
    }
    e.save();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_are_safe() {
        assert_eq!(clean(Some(&json!("  A: B / C?  "))), "A B C");
        assert_eq!(clean(Some(&json!("con"))), "_con");
        assert_eq!(clean(Some(&json!("Dots..."))), "Dots");
        assert_eq!(clean(None), "_");
        assert_eq!(pad(Some(&json!(3))), "03");
        assert_eq!(pad(Some(&json!(12))), "12");
        assert_eq!(pad(None), "00");
    }
}
