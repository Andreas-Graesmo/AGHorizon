//! The "folder" way to sync (desktop/sync-folder.js): the encrypted files in a folder the person picked (Dropbox,
//! iCloud Drive, OneDrive, Syncthing…). Only that folder: the page never names a path itself. The choice is kept
//! in <data dir>/sync.json.

use crate::util::*;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::{LazyLock, OnceLock};

static DATA_DIR: OnceLock<String> = OnceLock::new();
pub fn configure(data_dir: &str) {
    let _ = DATA_DIR.set(data_dir.to_string());
}
fn cfg_file() -> String {
    pjoin(&[DATA_DIR.get().map(|s| s.as_str()).unwrap_or(""), "sync.json"])
}
const SUBDIR: &str = "AG Horizon Sync";

fn read_cfg() -> Map<String, Value> {
    std::fs::read_to_string(cfg_file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}
fn write_cfg(c: &Map<String, Value>) -> std::io::Result<()> {
    std::fs::write(cfg_file(), json_pretty(&Value::Object(c.clone())))
}

/// JSON.stringify(value, null, 2)
pub fn json_pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn hex(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// "<picked folder>/AG Horizon Sync/<first 16 of the vault id>"
fn vault_dir(vault: &Value) -> Result<String, String> {
    let root = folder();
    if root.is_empty() {
        return Err("No sync folder chosen".into());
    }
    let v = js_string(vault);
    if !hex(&v, 64, 64) {
        return Err("Bad vault".into());
    }
    Ok(pjoin(&[&root, SUBDIR, &v[..16]]))
}
fn check_device(d: &Value) -> Result<String, String> {
    let s = js_string(d);
    if hex(&s, 16, 32) { Ok(s) } else { Err("Bad device".into()) }
}

/// os.hostname() without ".local" / ".lan" / ".home"
pub fn host() -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(local|lan|home)$").unwrap());
    RE.replace(&gethostname::gethostname().to_string_lossy(), "").into_owned()
}

pub fn folder() -> String {
    read_cfg().get("folder").filter(|v| truthy(Some(v))).map(js_string).unwrap_or_default()
}

pub fn set_folder(f: &Value) -> Result<Value, String> {
    if !truthy(Some(f)) {
        return Ok(json!(""));
    }
    let mut c = read_cfg();
    c.insert("folder".into(), json!(js_string(f)));
    write_cfg(&c).map_err(|e| e.to_string())?;
    Ok(json!(js_string(f)))
}

/// [{ device, updated, blob }]: blob as base64 (JSON can't carry bytes; sidecar/entry.js does the same)
pub async fn list(vault: &Value) -> Result<Value, String> {
    use base64::Engine;
    let dir = vault_dir(vault)?;
    let Ok(names) = readdir_node(std::path::Path::new(&dir)).await else { return Ok(json!([])) };
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9a-f]{16,32})\.agh$").unwrap());
    let mut out = Vec::new();
    for (n, _) in names {
        let Some(m) = RE.captures(&n) else { continue };
        let file = PathBuf::from(pjoin(&[&dir, &n]));
        // being written by the sync program right now: next time
        let (Ok(st), Ok(blob)) = (tokio::fs::metadata(&file).await, tokio::fs::read(&file).await) else { continue };
        let updated = st.modified().map(time_ms).unwrap_or(0.0);
        out.push(json!({ "device": &m[1], "updated": iso_ms(updated), "blob": base64::engine::general_purpose::STANDARD.encode(blob) }));
    }
    Ok(Value::Array(out))
}

pub async fn put(vault: &Value, device: &Value, blob64: &Value) -> Result<Value, String> {
    use base64::Engine;
    let dir = vault_dir(vault)?;
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let file = pjoin(&[&dir, &format!("{}.agh", check_device(device)?)]);
    let tmp = format!("{file}.tmp");
    // Buffer.from(String(blob64 || ''), 'base64'): lenient about what isn't base64
    let text: String = if truthy(Some(blob64)) { js_string(blob64) } else { String::new() };
    let clean: String = text.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '-' | '_')).collect();
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(clean.replace('-', "+").replace('_', "/").trim_end_matches('='))
        .unwrap_or_default();
    tokio::fs::write(&tmp, bytes).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, &file).await.map_err(|e| e.to_string())?; // whole files only: a sync program never picks up half of one
    Ok(json!(iso_ms(now_ms())))
}

pub async fn remove(vault: &Value, device: &Value) -> Result<Value, String> {
    let dir = vault_dir(vault)?;
    if truthy(Some(device)) {
        let _ = tokio::fs::remove_file(pjoin(&[&dir, &format!("{}.agh", check_device(device)?)])).await;
    } else {
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
    Ok(Value::Null)
}
