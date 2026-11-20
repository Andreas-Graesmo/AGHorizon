//! aghorizon-server-rs [port]   (port 0 = any free port; default 47831)
//! Prints "READY <port>" or "ERROR <code> <message>" (then exits with 1), as sidecar/entry.js does, and exits when
//! its stdin closes (unless AGH_NO_STDIN_WATCH), so it can't outlive the app that started it.
//!
//! With AGH_DATA_DIR (and AGH_DOCUMENTS_DIR) it also runs the downloads engine and the folder sync, and talks to the
//! app over stdin/stdout, one JSON object per line (the same lines as sidecar/entry.js):
//!   in:  {"id": 1, "cmd": "downloads.list", "args": []}
//!   out: RPC {"id": 1, "ok": true, "result": …}   or   RPC {"id": 1, "ok": false, "error": "…"}
//!   out: EVENT {"name": "downloads:changed", "payload": …}

use aghorizon_server::{downloads, sync_folder};
use serde_json::{json, Value};
use std::io::Write;
use tokio::io::AsyncBufReadExt;

/// one line to the app at a time
fn line(prefix: &str, v: &Value) {
    let out = std::io::stdout();
    let mut out = out.lock();
    let _ = writeln!(out, "{prefix} {v}");
    let _ = out.flush();
}

async fn op(cmd: &str, a: &[Value]) -> Result<Value, String> {
    let arg = |i: usize| a.get(i).cloned().unwrap_or(Value::Null);
    let truthy = |v: &Value| aghorizon_server::util::truthy(Some(v));
    Ok(match cmd {
        "downloads.list" => downloads::list().await,
        "downloads.orphans" => downloads::orphans().await,
        "downloads.adopt" => downloads::adopt(&arg(0)).await,
        "downloads.add" => downloads::add(&arg(0)),
        "downloads.pause" => downloads::pause(&arg(0)).await,
        "downloads.resume" => downloads::resume(&arg(0)),
        "downloads.reorder" => downloads::reorder(&arg(0)).await,
        "downloads.remove" => downloads::remove(&arg(0), truthy(&arg(1))).await,
        "downloads.setOption" => downloads::set_option(&arg(0), &arg(1)),
        "downloads.setWatching" => downloads::set_watching(truthy(&arg(0))).await,
        "downloads.currentFolder" => downloads::current_folder(),
        "downloads.setFolder" => downloads::set_folder(&arg(0)),
        "downloads.revealTarget" => downloads::reveal_target(&arg(0)),
        "downloads.ensureFolder" => downloads::ensure_folder().await,
        "sync.info" => json!({ "host": sync_folder::host(), "folder": sync_folder::folder() }),
        "sync.setFolder" => sync_folder::set_folder(&arg(0))?,
        "sync.folderList" => sync_folder::list(&arg(0)).await?,
        "sync.folderPut" => sync_folder::put(&arg(0), &arg(1), &arg(2)).await?,
        "sync.folderRemove" => sync_folder::remove(&arg(0), &arg(1)).await?,
        _ => return Err(format!("unknown command {cmd}")),
    })
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(47831);
    let cfg = aghorizon_server::Config::from_env();
    let data_dir = std::env::var("AGH_DATA_DIR").ok().filter(|s| !s.is_empty());
    if let Some(d) = &data_dir {
        let docs = std::env::var("AGH_DOCUMENTS_DIR").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| d.clone());
        downloads::configure(d, &docs, Box::new(|snapshot| line("EVENT", &json!({ "name": "downloads:changed", "payload": snapshot }))));
        sync_folder::configure(d);
    }
    let (port, task) = match aghorizon_server::start(cfg, port).await {
        Ok(x) => x,
        Err(e) => {
            let code = match e.kind() {
                std::io::ErrorKind::AddrInUse => "EADDRINUSE",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                _ => "START",
            };
            println!("ERROR {code} {e}");
            std::process::exit(1);
        }
    };
    println!("READY {port}");
    if data_dir.is_some() {
        downloads::start();
    }
    if std::env::var_os("AGH_NO_STDIN_WATCH").is_none() {
        let rpc = data_dir.is_some();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
            loop {
                let text = match lines.next_line().await {
                    Ok(Some(t)) => t,
                    _ => {
                        // the app went away
                        if rpc {
                            downloads::quitting();
                        }
                        std::process::exit(0);
                    }
                };
                if !rpc || text.trim().is_empty() {
                    continue;
                }
                let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
                tokio::spawn(async move {
                    let id = msg.get("id").cloned().unwrap_or(Value::Null);
                    let cmd = msg.get("cmd").map(|c| aghorizon_server::util::js_string(c)).unwrap_or_else(|| "undefined".into());
                    let args: Vec<Value> = msg.get("args").and_then(|a| a.as_array()).cloned().unwrap_or_default();
                    if cmd == "quit" {
                        // the app is closing: what was downloading carries on next time, then exit
                        downloads::quitting();
                        line("RPC", &json!({ "id": id, "ok": true, "result": true }));
                        std::process::exit(0);
                    }
                    match op(&cmd, &args).await {
                        Ok(result) => line("RPC", &json!({ "id": id, "ok": true, "result": result })),
                        Err(error) => line("RPC", &json!({ "id": id, "ok": false, "error": error })),
                    }
                });
            }
        });
    }
    let _ = task.await;
}
