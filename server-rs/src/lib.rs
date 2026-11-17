//! AG Horizon's local server in Rust (MIGRATION_PLAN.md Phase 8): the same HTTP API as server.js, so the same pages
//! work against either. No Tauri dependency: the Windows app runs it as its sidecar, and Android TV can link it.
//!
//! Ported so far: the request guard, static files, /api/capabilities, /api/fetch, /api/epg, /api/stream,
//! /api/tracks. The other /api routes answer 501 until they are ported (test/parity/ lists what is covered).

pub mod epg;
pub mod stream;
pub mod util;

use bytes::Bytes;
use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;
use hyper::{Method, Request};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use util::*;

pub struct Config {
    /// the web app (server.js: PUBLIC_DIR)
    pub public_dir: PathBuf,
    pub ffmpeg_path: Option<String>,
    pub opensubtitles_key: String,
    pub tmdb_key: String,
}

impl Config {
    /// From the environment, as server.js reads it: PUBLIC_DIR, FFMPEG_PATH, OPENSUBTITLES_API_KEY, TMDB_API_KEY
    /// (or secrets.json next to the program: { opensubtitlesApiKey, tmdbApiKey }).
    pub fn from_env() -> Config {
        let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default();
        let secrets: Value = std::fs::read_to_string(exe_dir.join("secrets.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
        let key = |env: &str, field: &str| {
            std::env::var(env).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| secrets.get(field).and_then(|v| v.as_str()).unwrap_or("").to_string())
        };
        Config {
            public_dir: std::env::var_os("PUBLIC_DIR").map(PathBuf::from).unwrap_or_else(|| exe_dir.join("public")),
            ffmpeg_path: std::env::var("FFMPEG_PATH").ok().filter(|s| !s.is_empty()),
            opensubtitles_key: key("OPENSUBTITLES_API_KEY", "opensubtitlesApiKey"),
            tmdb_key: key("TMDB_API_KEY", "tmdbApiKey"),
        }
    }
}

/* ─────────────────────────────── the guard ─────────────────────────────── */

/// requestAllowed(): only the app's own page. Guards against DNS rebinding and other websites using the proxy.
fn request_allowed(req: &Request<Incoming>) -> bool {
    let h = |k: &str| req.headers().get(k).and_then(|v| v.to_str().ok());
    if let Some(site) = h("sec-fetch-site") {
        if site != "same-origin" && site != "none" {
            return false;
        }
    }
    let host = h("host").unwrap_or("");
    let hostname = match host.rfind(':') {
        Some(i) if host[i + 1..].bytes().all(|b| b.is_ascii_digit()) && i + 1 < host.len() => &host[..i],
        _ => host,
    };
    if !["localhost", "127.0.0.1", "[::1]"].contains(&hostname) {
        return false;
    }
    if let Some(origin) = h("origin") {
        match url::Url::parse(origin) {
            Ok(o) => {
                let oh = match (o.host_str(), o.port()) {
                    (Some(hn), Some(p)) => format!("{hn}:{p}"),
                    (Some(hn), None) => hn.to_string(),
                    _ => return false,
                };
                if oh != host {
                    return false;
                }
            }
            Err(_) => return false,
        }
    }
    true
}

/* ─────────────────────────────── static files ─────────────────────────────── */

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// serveStatic(): decodeURIComponent, no NUL, "/" is index.html, nothing outside the folder.
async fn serve_static(public: &Path, pathname: &str) -> Resp {
    let Ok(p) = percent_encoding::percent_decode_str(pathname).decode_utf8() else { return send(400, "Bad request", &[]) };
    if p.contains('\0') {
        return send(400, "Bad request", &[]);
    }
    let p = if p == "/" { "/index.html".to_string() } else { p.into_owned() };
    // path.normalize(path.join(PUBLIC_DIR, p)): lexically, with "..", and on Windows "\" as a separator too
    let rel = if cfg!(windows) { p.replace('\\', "/") } else { p };
    let mut file = public.to_path_buf();
    let mut depth: isize = 0;
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return send(403, "Forbidden", &[]);
                }
                file.pop();
            }
            _ => {
                if Path::new(part).components().any(|c| !matches!(c, Component::Normal(_))) {
                    return send(403, "Forbidden", &[]); // e.g. "C:" on Windows
                }
                depth += 1;
                file.push(part);
            }
        }
    }
    let meta = match tokio::fs::metadata(&file).await {
        Ok(m) if m.is_file() => m,
        _ => return send(404, "Not found", &[]),
    };
    let f = match tokio::fs::File::open(&file).await {
        Ok(f) => f,
        Err(_) => return send(404, "Not found", &[]),
    };
    let body = http_body_util::StreamBody::new(futures_util::StreamExt::map(tokio_util_like::ReaderStream::new(f), |r| r.map(hyper::body::Frame::data)));
    hyper::Response::builder()
        .status(200)
        .header("content-type", mime(&file))
        .header("content-length", meta.len().to_string())
        .header("cache-control", "no-cache")
        .body(body.boxed())
        .expect("valid response")
}

/// A file as a stream of chunks (what tokio-util's ReaderStream does), without the extra crate.
mod tokio_util_like {
    use bytes::Bytes;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, ReadBuf};

    pub struct ReaderStream<R> {
        r: R,
        buf: Vec<u8>,
    }
    impl<R> ReaderStream<R> {
        pub fn new(r: R) -> Self {
            ReaderStream { r, buf: vec![0; 64 * 1024] }
        }
    }
    impl<R: AsyncRead + Unpin> futures_util::Stream for ReaderStream<R> {
        type Item = std::io::Result<Bytes>;
        fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            let this = &mut *self;
            let mut rb = ReadBuf::new(&mut this.buf);
            match Pin::new(&mut this.r).poll_read(cx, &mut rb) {
                Poll::Pending => Poll::Pending,
                Poll::Ready(Err(e)) => Poll::Ready(Some(Err(e))),
                Poll::Ready(Ok(())) if rb.filled().is_empty() => Poll::Ready(None),
                Poll::Ready(Ok(())) => Poll::Ready(Some(Ok(Bytes::copy_from_slice(rb.filled())))),
            }
        }
    }
}

/* ─────────────────────────────── the API ─────────────────────────────── */

/// ffmpeg(): found once; FFMPEG_PATH or "ffmpeg" on the PATH, if it runs.
async fn ffmpeg(cfg: &Config) -> Option<String> {
    static FOUND: tokio::sync::OnceCell<Option<String>> = tokio::sync::OnceCell::const_new();
    FOUND
        .get_or_init(|| async {
            let bin = cfg.ffmpeg_path.clone().unwrap_or_else(|| "ffmpeg".into());
            let mut cmd = tokio::process::Command::new(&bin);
            cmd.arg("-version").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
            match tokio::time::timeout(Duration::from_secs(8), cmd.status()).await {
                Ok(Ok(s)) if s.success() => Some(bin),
                _ => None,
            }
        })
        .await
        .clone()
}

fn parse_json_body(text: &str) -> ApiResult<Value> {
    let text = if text.is_empty() { "{}" } else { text };
    let j: Value = serde_json::from_str(text).map_err(|_| ApiError::new(400, "The request body is not valid JSON"))?;
    if !j.is_object() && !j.is_array() {
        return Err(ApiError::new(400, "The request body is not a JSON object"));
    }
    Ok(j)
}

async fn read_body(body: Incoming, limit: usize) -> ApiResult<String> {
    match Limited::new(body, limit).collect().await {
        Ok(c) => Ok(String::from_utf8_lossy(&c.to_bytes()).into_owned()),
        Err(e) if e.downcast_ref::<http_body_util::LengthLimitError>().is_some() => Err(ApiError::new(413, "Request too large")),
        Err(e) => Err(ApiError::new(400, e.to_string())),
    }
}

async fn handle_fetch(q: &Query) -> ApiResult<Resp> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let u = check_url(q.get("url"))?;
    let r = send_req(upstream(&u, q.get("ua"), None), Duration::from_secs(60)).await?;
    let status = r.status().as_u16();
    if !r.status().is_success() {
        return Err(ApiError::new(if status == 401 || status == 403 { status } else { 502 }, format!("Provider answered HTTP {status}")));
    }
    let buf = maybe_gunzip(read_all(r, deadline).await?)?;
    Ok(send(200, buf, &[("content-type", "text/plain; charset=utf-8")]))
}

pub async fn handle(cfg: Arc<Config>, req: Request<Incoming>) -> Resp {
    if !request_allowed(&req) {
        return send(403, "Forbidden", &[]);
    }
    // new URL(req.url, 'http://local'): the same parser, so the same path (dot segments removed) and query
    static BASE: OnceLock<url::Url> = OnceLock::new();
    let base = BASE.get_or_init(|| url::Url::parse("http://local").unwrap());
    let raw = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let Ok(url) = base.join(raw) else { return send(400, "Bad request", &[]) };
    if url.host_str() != Some("local") {
        return send(400, "Bad request", &[]); // e.g. "//x": another host
    }
    let path = url.path().to_string();
    let q = Query::parse(url.query());
    let method = req.method().clone();

    if !path.starts_with("/api/") {
        return serve_static(&cfg.public_dir, &path).await;
    }
    let range = req.headers().get("range").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let result: ApiResult<Resp> = match (path.as_str(), &method) {
        ("/api/fetch", &Method::GET) => handle_fetch(&q).await,
        ("/api/epg", &Method::POST) => async {
            let body = parse_json_body(&read_body(req.into_body(), 32 * 1024 * 1024).await?)?;
            Ok(send_json(200, &epg::handle(body).await?))
        }
        .await,
        ("/api/stream", &Method::GET) => stream::handle_stream(&q, range).await,
        ("/api/tracks", &Method::GET) => Ok(stream::handle_tracks(&q)),
        ("/api/capabilities", &Method::GET) => Ok(send_json(
            200,
            &json!({ "ffmpeg": ffmpeg(&cfg).await.is_some(), "opensubtitles": !cfg.opensubtitles_key.is_empty(), "tmdb": !cfg.tmdb_key.is_empty() }),
        )),
        // not ported yet (MIGRATION_PLAN.md Phase 8): say so plainly rather than 404
        ("/api/shared" | "/api/shared/stats" | "/api/tmdb" | "/api/trending" | "/api/probe" | "/api/keyframe" | "/api/transcode", &Method::GET) => {
            Err(ApiError::new(501, "Not available in this build yet"))
        }
        (p, &Method::GET | &Method::HEAD) if p.starts_with("/api/local/") || p.starts_with("/api/tcsubs/") => Err(ApiError::new(501, "Not available in this build yet")),
        (p, &Method::POST) if p.starts_with("/api/subs/") => Err(ApiError::new(501, "Not available in this build yet")),
        _ => Ok(send(404, "Not found", &[])),
    };
    result.unwrap_or_else(|e| error_json(&e))
}

/// Serves until the process ends. Returns the port actually used (0: any free port) once listening.
pub async fn start(cfg: Config, port: u16) -> std::io::Result<(u16, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let port = listener.local_addr()?.port();
    let cfg = Arc::new(cfg);
    let task = tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else { continue };
            let cfg = cfg.clone();
            tokio::spawn(async move {
                let svc = hyper::service::service_fn(move |req| {
                    let cfg = cfg.clone();
                    async move { Ok::<_, std::convert::Infallible>(handle(cfg, req).await) }
                });
                let _ = hyper::server::conn::http1::Builder::new().keep_alive(true).serve_connection(hyper_util::rt::TokioIo::new(tcp), svc).await;
            });
        }
    });
    Ok((port, task))
}

/// bytes for callers that build bodies (kept for the next routes)
pub fn bytes(b: impl Into<Bytes>) -> Bytes {
    b.into()
}
