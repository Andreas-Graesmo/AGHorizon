//! /api/local: finished downloads, played from here so the normal player (and compatibility mode, which hands
//! ffmpeg this address) works offline. Only files the download manager hands out by id. And their subtitles.

use crate::subtitles;
use crate::util::*;
use regex::Regex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

/// (id, "video" | "poster") -> the file, or None (server.js: setLocalFiles)
pub type LocalFiles = Arc<dyn Fn(&str, &str) -> Option<PathBuf> + Send + Sync>;

/// Until the downloads engine is ported (MIGRATION_PLAN.md 8.5): its list, read where it keeps it
/// (<AGH_DATA_DIR>/downloads.json), as desktop/downloads-core.js localFile() answers.
pub fn from_downloads_json(data_dir: PathBuf) -> LocalFiles {
    Arc::new(move |id: &str, what: &str| {
        let text = std::fs::read_to_string(data_dir.join("downloads.json")).ok()?;
        let j: Value = serde_json::from_str(&text).ok()?;
        let it = j.get("items")?.as_array()?.iter().find(|x| x.get("id").and_then(|v| v.as_str()) == Some(id))?;
        let s = |k: &str| it.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        if what == "poster" {
            let p = s("posterFile");
            return (!p.is_empty() && Path::new(&p).exists()).then(|| PathBuf::from(p));
        }
        let f = s("file");
        (s("state") == "done" && !f.is_empty() && Path::new(&f).exists()).then(|| PathBuf::from(f))
    })
}

fn local_mime(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("mkv") => "video/x-matroska",
        Some("webm") => "video/webm",
        Some("ts") => "video/mp2t",
        Some("avi") => "video/x-msvideo",
        Some("jpg") => "image/jpeg",
        _ => "application/octet-stream",
    }
}

/// GET|HEAD /api/local/<id>[/poster], with Range
pub async fn handle_local(files: Option<&LocalFiles>, path: &str, head: bool, range: Option<&str>) -> ApiResult<Resp> {
    static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/local/([a-f0-9]{8,32})(/poster)?$").unwrap());
    static RANGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^bytes=(\d*)-(\d*)$").unwrap());
    let m = ID.captures(path);
    let file = match (m.as_ref(), files) {
        (Some(m), Some(f)) => f(&m[1], if m.get(2).is_some() { "poster" } else { "video" }),
        _ => None,
    };
    let Some(file) = file else { return Err(ApiError::new(404, "Not downloaded")) };
    let meta = match tokio::fs::metadata(&file).await {
        Ok(m) if m.is_file() => m,
        _ => return Ok(send(404, "Not found", &[])),
    };
    let size = meta.len();
    let typ = local_mime(&file);
    let r = range.and_then(|r| RANGE.captures(r)).filter(|c| !c[1].is_empty() || !c[2].is_empty());
    if size == 0 {
        // an empty download: no stream can read bytes 0 to -1
        return Ok(if r.is_some() {
            send(416, "", &[("content-range", "bytes */0")])
        } else {
            send(200, "", &[("content-type", typ), ("content-length", "0"), ("accept-ranges", "bytes")])
        });
    }
    let (mut start, mut end) = (0u64, size - 1);
    let mut b = hyper::Response::builder();
    if let Some(c) = &r {
        let n = |s: &str| s.parse::<u64>().unwrap_or(u64::MAX);
        if !c[1].is_empty() {
            start = n(&c[1]);
            if !c[2].is_empty() {
                end = end.min(n(&c[2]));
            }
        } else {
            start = size.saturating_sub(n(&c[2]));
        }
        if start > end {
            return Ok(send(416, "", &[("content-range", &format!("bytes */{size}"))]));
        }
        b = b
            .status(206)
            .header("content-type", typ)
            .header("content-length", (end - start + 1).to_string())
            .header("content-range", format!("bytes {start}-{end}/{size}"))
            .header("accept-ranges", "bytes")
            .header("cache-control", "no-store");
    } else {
        b = b.status(200).header("content-type", typ).header("content-length", size.to_string()).header("accept-ranges", "bytes").header("cache-control", "no-store");
    }
    if head {
        return Ok(b.body(full(bytes::Bytes::new())).expect("valid response"));
    }
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut f = tokio::fs::File::open(&file).await.map_err(|_| ApiError::new(404, "Not found"))?;
    f.seek(std::io::SeekFrom::Start(start)).await.map_err(|e| ApiError::new(502, e.to_string()))?;
    let left = end - start + 1;
    let stream = futures_util::stream::unfold((f, left), |(mut f, left)| async move {
        if left == 0 {
            return None;
        }
        let mut buf = vec![0u8; (64 * 1024).min(left as usize)];
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<_, std::io::Error>(hyper::body::Frame::data(bytes::Bytes::from(buf))), (f, left - n as u64)))
            }
            Err(e) => Some((Err(e), (f, 0))),
        }
    });
    Ok(b.body(http_body_util::BodyExt::boxed(http_body_util::StreamBody::new(stream))).expect("valid response"))
}

/// GET /api/local/<id>/subs[?wait=1] -> [{ n, lang, forced, sdh, os }];  GET /api/local/<id>/subs/<n> -> WebVTT
pub async fn handle_local_subs(files: Option<&LocalFiles>, ffmpeg: Option<String>, path: &str, q: &Query) -> ApiResult<Resp> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/local/([a-f0-9]{8,32})/subs(?:/(\d+))?$").unwrap());
    let m = RE.captures(path);
    let video = match (m.as_ref(), files) {
        (Some(m), Some(f)) => f(&m[1], "video"),
        _ => None,
    };
    let (Some(video), Some(m)) = (video, m) else { return Err(ApiError::new(404, "Not downloaded")) };
    let list = subtitles::local_subs(ffmpeg, &video, q.get("wait") == Some("1")).await;
    let Some(n) = m.get(2) else {
        let out: Vec<Value> = list.iter().enumerate().map(|(n, s)| json!({ "n": n, "lang": s.lang, "forced": s.forced, "sdh": s.sdh, "os": s.os })).collect();
        return Ok(send_json(200, &Value::Array(out)));
    };
    let idx = js_number(Some(n.as_str()));
    let s = (idx.fract() == 0.0 && idx >= 0.0).then(|| list.get(idx as usize)).flatten();
    let Some(s) = s else { return Err(ApiError::new(404, "No such subtitle")) };
    let buf = tokio::fs::read(&s.file).await.map_err(|e| ApiError::new(502, e.to_string()))?;
    Ok(send(200, subtitles::srt_to_vtt(&buf), &[("content-type", "text/vtt; charset=utf-8")]))
}

/// GET /api/tcsubs/<sid>/<track> -> what a running conversion has written of that track so far
pub async fn handle_tc_subs(path: &str) -> ApiResult<Resp> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^/api/tcsubs/([a-z0-9]{8,40})/(\d{1,3})$").unwrap());
    let m = RE.captures(path).ok_or_else(|| ApiError::new(404, "Not found"))?;
    Ok(send(200, subtitles::tc_sub_text(&m[1], &m[2]).await, &[("content-type", "text/vtt; charset=utf-8")]))
}
