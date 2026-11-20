//! Responses, errors and requests to providers, as in server.js (send, sendJson, httpError, friendlyError, upstream,
//! checkUrl). Every answer the page sees must read the same as from server.js: the parity tests (test/parity/)
//! check both servers against each other.

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::{header, Response, StatusCode};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC};
use std::convert::Infallible;
use std::time::Duration;

pub type Body = BoxBody<Bytes, std::io::Error>;
pub type Resp = Response<Body>;

pub const DEFAULT_UA: &str = "VLC/3.0.20 LibVLC/3.0.20";

/// An error with the status and message the page shows (server.js: httpError / friendlyError).
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        ApiError { status, message: message.into() }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

pub fn full(body: impl Into<Bytes>) -> Body {
    Full::new(body.into()).map_err(|e: Infallible| match e {}).boxed()
}

/// send(): always Cache-Control: no-store; no Content-Type unless given.
pub fn send(status: u16, body: impl Into<Bytes>, headers: &[(&str, &str)]) -> Resp {
    let mut b = Response::builder().status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR));
    b = b.header(header::CACHE_CONTROL, "no-store");
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    b.body(full(body)).expect("valid response")
}

pub fn send_json(status: u16, value: &serde_json::Value) -> Resp {
    send(status, value.to_string(), &[("content-type", "application/json; charset=utf-8")])
}

pub fn error_json(e: &ApiError) -> Resp {
    send_json(e.status, &serde_json::json!({ "error": e.message }))
}

/// encodeURIComponent: everything but A–Z a–z 0–9 - _ . ! ~ * ' ( )
pub const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

pub fn encode_uri_component(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, URI_COMPONENT).to_string()
}

/// checkUrl(): an http(s) URL, normalised as WHATWG's URL parser does (url::Url is that parser).
pub fn check_url(s: Option<&str>) -> ApiResult<url::Url> {
    // new URL(null) / new URL(undefined) parse the strings "null" / "undefined", which fail
    let u = url::Url::parse(s.unwrap_or("null")).map_err(|_| ApiError::new(400, "Invalid URL"))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err(ApiError::new(400, "Only http(s) URLs are supported"));
    }
    Ok(u)
}

pub fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(20)) // as Node's fetch
            .no_proxy() // Node's fetch ignores HTTP(S)_PROXY too
            .build()
            .expect("HTTP client")
    })
}

/// upstream(): GET with the player's user agent (VLC's unless given), any type, and the player's Range.
pub fn upstream(url: &url::Url, ua: Option<&str>, range: Option<&str>) -> reqwest::RequestBuilder {
    let ua = ua.filter(|s| !s.is_empty()).unwrap_or(DEFAULT_UA);
    let mut r = client().get(url.clone()).header("user-agent", ua).header("accept", "*/*");
    if let Some(range) = range {
        r = r.header("range", range);
    }
    r
}

/// friendlyError() for a failed request to a provider: Node's fetch reports the system's error code; these are
/// the same messages for the same causes.
pub fn friendly(e: &reqwest::Error) -> ApiError {
    if e.is_timeout() {
        return ApiError::new(504, "The provider took too long to respond");
    }
    let mut code: Option<String> = None;
    let mut src: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(e);
    let mut text = String::new();
    while let Some(s) = src {
        text.push_str(&s.to_string());
        text.push(' ');
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            code = Some(
                match io.kind() {
                    std::io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
                    std::io::ErrorKind::ConnectionReset => "ECONNRESET",
                    std::io::ErrorKind::ConnectionAborted => "ECONNABORTED",
                    std::io::ErrorKind::TimedOut => return ApiError::new(504, "The provider took too long to respond"),
                    std::io::ErrorKind::UnexpectedEof => "UND_ERR_SOCKET",
                    _ => "",
                }
                .to_string(),
            )
            .filter(|c| !c.is_empty())
            .or(code);
        }
        src = s.source();
    }
    let lower = text.to_lowercase();
    if lower.contains("dns error") || lower.contains("failed to lookup address") || lower.contains("no such host") {
        return ApiError::new(502, "Host not found – check the server address");
    }
    match code.as_deref() {
        Some("ECONNREFUSED") => ApiError::new(502, "Connection refused – check the server address and port"),
        Some(c) => ApiError::new(502, format!("Could not reach the provider ({c})")),
        None => {
            let t = text.trim();
            ApiError::new(502, format!("Could not reach the provider ({})", if t.is_empty() { "unknown" } else { t }))
        }
    }
}

/// Sends a request with an overall time limit, mapping failures as friendlyError does.
pub async fn send_req(req: reqwest::RequestBuilder, limit: Duration) -> ApiResult<reqwest::Response> {
    match tokio::time::timeout(limit, req.send()).await {
        Err(_) => Err(ApiError::new(504, "The provider took too long to respond")),
        Ok(Err(e)) => Err(friendly(&e)),
        Ok(Ok(r)) => Ok(r),
    }
}

/// Reads a whole body within a time limit (server.js reads these with an AbortSignal.timeout over the request).
pub async fn read_all(r: reqwest::Response, deadline: tokio::time::Instant) -> ApiResult<Bytes> {
    match tokio::time::timeout_at(deadline, r.bytes()).await {
        Err(_) => Err(ApiError::new(504, "The provider took too long to respond")),
        Ok(Err(e)) => Err(friendly(&e)),
        Ok(Ok(b)) => Ok(b),
    }
}

pub fn maybe_gunzip(buf: Bytes) -> ApiResult<Bytes> {
    if buf.len() > 2 && buf[0] == 0x1f && buf[1] == 0x8b {
        use std::io::Read;
        let mut out = Vec::new();
        flate2::read::MultiGzDecoder::new(&buf[..])
            .read_to_end(&mut out)
            .map_err(|_| ApiError::new(502, "incorrect header check"))?;
        return Ok(Bytes::from(out));
    }
    Ok(buf)
}

/// The query string as URLSearchParams.get reads it: the first value of a name, '+' as a space.
pub struct Query(Vec<(String, String)>);

impl Query {
    pub fn parse(q: Option<&str>) -> Self {
        Query(url::form_urlencoded::parse(q.unwrap_or("").as_bytes()).into_owned().collect())
    }
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/* ───────────── JavaScript's ways with values, where the answers depend on them ───────────── */

/// A number as JSON.stringify writes it: 10 not 10.0; NaN and Infinity as null.
pub fn js_num(x: f64) -> serde_json::Value {
    if !x.is_finite() {
        return serde_json::Value::Null;
    }
    if x.fract() == 0.0 && x.abs() < 9.007_199_254_740_992e15 {
        return serde_json::json!(x as i64);
    }
    serde_json::json!(x)
}

/// String(number): 12, 12.5, 0.001
pub fn js_num_str(x: f64) -> String {
    match js_num(x) {
        serde_json::Value::Null => if x.is_nan() { "NaN".into() } else if x > 0.0 { "Infinity".into() } else { "-Infinity".into() },
        v => v.to_string(),
    }
}

/// Number(string): trimmed; "" is 0; decimal, exponent, 0x/0o/0b, Infinity; anything else NaN. Number(null) is 0.
pub fn js_number(s: Option<&str>) -> f64 {
    let Some(s) = s else { return 0.0 };
    let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| u64::from_str_radix(p, r).map(|n| n as f64).unwrap_or(f64::NAN);
    if let Some(h) = t.strip_prefix("0x").or(t.strip_prefix("0X")) {
        return radix(h, 16);
    }
    if let Some(o) = t.strip_prefix("0o").or(t.strip_prefix("0O")) {
        return radix(o, 8);
    }
    if let Some(b) = t.strip_prefix("0b").or(t.strip_prefix("0B")) {
        return radix(b, 2);
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Rust accepts "inf", "nan", "1_0"…: only JavaScript's StrDecimalLiteral
    let ok = t.bytes().all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b)) && t.bytes().any(|b| b.is_ascii_digit());
    if !ok {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// Number.prototype.toFixed(digits): on an exact tie, the larger of the two (Rust's {:.N} rounds half to even)
pub fn js_to_fixed(x: f64, digits: usize) -> String {
    let scale = 10f64.powi(digits as i32);
    let scaled = x * scale;
    if (scaled - scaled.trunc()).abs() == 0.5 && (x * scale * 2.0).fract() == 0.0 {
        let up = if x >= 0.0 { scaled.trunc() + 1.0 } else { scaled.trunc() };
        return format!("{:.*}", digits, up / scale);
    }
    format!("{:.*}", digits, x)
}

/// truthiness of a JSON value
pub fn truthy(v: Option<&serde_json::Value>) -> bool {
    use serde_json::Value;
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0 && !x.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// a || b for JSON values
pub fn js_or(a: Option<&serde_json::Value>, b: serde_json::Value) -> serde_json::Value {
    if truthy(a) { a.unwrap().clone() } else { b }
}

/// String(value) for what JSON can hold
pub fn js_string(v: &serde_json::Value) -> String {
    use serde_json::Value;
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map(js_num_str).unwrap_or_else(|| n.to_string()),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// .slice(0, n) counts UTF-16 units
pub fn slice_utf16(s: &str, max: usize) -> String {
    let mut n = 0;
    let mut out = String::new();
    for ch in s.chars() {
        n += ch.len_utf16();
        if n > max {
            break;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod js_tests {
    use super::*;
    #[test]
    fn numbers_as_javascript_has_them() {
        assert_eq!(js_num(10.0).to_string(), "10");
        assert_eq!(js_num(10.5).to_string(), "10.5");
        assert_eq!(js_num(f64::NAN), serde_json::Value::Null);
        assert_eq!(js_num_str(3.0), "3");
        assert_eq!(js_number(Some(" 12 ")), 12.0);
        assert_eq!(js_number(Some("")), 0.0);
        assert_eq!(js_number(None), 0.0);
        assert_eq!(js_number(Some("0x10")), 16.0);
        assert!(js_number(Some("abc")).is_nan());
        assert!(js_number(Some("inf")).is_nan());
        assert_eq!(js_number(Some("1e2")), 100.0);
        assert_eq!(js_to_fixed(1.0625, 3), "1.063"); // (1.0625).toFixed(3) in JavaScript
        assert_eq!(js_to_fixed(2.5, 0), "3");
        assert_eq!(js_to_fixed(12.0, 3), "12.000");
        assert_eq!(js_to_fixed(1.005, 2), "1.00"); // 1.005 is really 1.00499…
    }
}

/* ───────────── Node's paths, dates and directory listings ───────────── */

/// path.join + path.normalize, as Node does on this system ("\" on Windows, "/" elsewhere)
pub fn pjoin(parts: &[&str]) -> String {
    let joined = parts.iter().filter(|p| !p.is_empty()).cloned().collect::<Vec<_>>().join(if cfg!(windows) { "\\" } else { "/" });
    pnormalize(if joined.is_empty() { "." } else { &joined })
}

pub fn pnormalize(p: &str) -> String {
    let win = cfg!(windows);
    let sep = if win { '\\' } else { '/' };
    let is_sep = |c: char| c == '/' || (win && c == '\\');
    // the root: "/" (posix); "C:\", "C:", "\\server\share\" or "\" (Windows)
    let mut root = String::new();
    let mut rest = p;
    if win {
        let b = p.as_bytes();
        if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            root.push_str(&p[..2]);
            rest = &p[2..];
        } else if p.starts_with("\\\\") || p.starts_with("//") {
            let parts: Vec<&str> = p[2..].split(is_sep).collect();
            if parts.len() >= 2 && !parts[0].is_empty() && !parts[1].is_empty() {
                root = format!("\\\\{}\\{}\\", parts[0], parts[1]);
                rest = &p[2 + parts[0].len() + 1 + parts[1].len()..];
            }
        }
    }
    let absolute = rest.starts_with(is_sep) || root.ends_with('\\');
    if absolute && !root.ends_with('\\') {
        root.push(sep);
    }
    let mut out: Vec<&str> = Vec::new();
    for seg in rest.split(is_sep) {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().map(|l| *l != "..").unwrap_or(false) {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let trailing = rest.ends_with(is_sep) && !out.is_empty();
    let mut s = format!("{root}{}", out.join(&sep.to_string()));
    if trailing {
        s.push(sep);
    }
    if s.is_empty() { ".".into() } else { s }
}

/// path.dirname
pub fn pdirname(p: &str) -> String {
    let win = cfg!(windows);
    let is_sep = |c: char| c == '/' || (win && c == '\\');
    let t = p.trim_end_matches(is_sep);
    if t.is_empty() {
        return if p.starts_with(is_sep) { p[..1].to_string() } else { ".".into() };
    }
    match t.rfind(is_sep) {
        Some(0) => p[..1].to_string(),
        Some(i) => {
            let d = t[..i].trim_end_matches(is_sep);
            if d.is_empty() { p[..1].to_string() } else if win && d.len() == 2 && d.as_bytes()[1] == b':' { t[..i + 1].to_string() } else { d.to_string() }
        }
        None => if win && t.len() >= 2 && t.as_bytes()[1] == b':' { t[..2].to_string() } else { ".".into() },
    }
}

/// path.basename
pub fn pbasename(p: &str) -> String {
    let win = cfg!(windows);
    let is_sep = |c: char| c == '/' || (win && c == '\\');
    let t = p.trim_end_matches(is_sep);
    t.rsplit(is_sep).next().unwrap_or("").to_string()
}

/// path.extname: from the last "." of the name, unless the name starts with it
pub fn pextname(p: &str) -> String {
    let b = pbasename(p);
    match b.rfind('.') {
        Some(i) if i > 0 => b[i..].to_string(),
        _ => String::new(),
    }
}

/// path.resolve (one argument)
pub fn presolve(p: &str) -> String {
    let abs = if cfg!(windows) {
        let b = p.as_bytes();
        (b.len() >= 3 && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')) || p.starts_with("\\\\") || p.starts_with("//")
    } else {
        p.starts_with('/')
    };
    let trim = |s: String| -> String {
        // no trailing separator, unless it is the root itself
        let t = s.trim_end_matches(|c| c == '/' || (cfg!(windows) && c == '\\'));
        if t.is_empty() || (cfg!(windows) && t.len() == 2 && t.as_bytes()[1] == b':') { s } else { t.to_string() }
    };
    if abs {
        trim(pnormalize(p))
    } else {
        let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
        trim(pnormalize(&pjoin(&[&cwd, p])))
    }
}

/// A folder's entries in the order Node's fs.readdir gives them: libuv sorts them byte-wise on Linux and macOS;
/// on Windows both take the system's order.
pub async fn readdir_node(dir: &std::path::Path) -> std::io::Result<Vec<(String, std::fs::FileType)>> {
    let mut rd = tokio::fs::read_dir(dir).await?;
    let mut out = Vec::new();
    while let Some(e) = rd.next_entry().await? {
        let ft = e.file_type().await?;
        out.push((e.file_name().to_string_lossy().into_owned(), ft));
    }
    if !cfg!(windows) {
        out.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    }
    Ok(out)
}

/// new Date(ms).toISOString()
pub fn iso_ms(ms: f64) -> String {
    let ms = ms.floor() as i64;
    let (secs, milli) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, sod) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // civil from days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

/// a file time in ms as Node's stat gives it (mtimeMs: seconds * 1000 + nanoseconds / 1e6)
pub fn time_ms(t: std::time::SystemTime) -> f64 {
    match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1e6,
        Err(e) => -(e.duration().as_secs() as f64 * 1000.0 + e.duration().subsec_nanos() as f64 / 1e6),
    }
}

#[cfg(test)]
mod path_tests {
    use super::*;
    #[test]
    #[cfg(not(windows))]
    fn paths_as_node_has_them() {
        assert_eq!(pjoin(&["/a/b", "Movies", "X (2020)"]), "/a/b/Movies/X (2020)");
        assert_eq!(pjoin(&["/a/b/", "../c", "./d"]), "/a/c/d");
        assert_eq!(pnormalize("a//b/../c/"), "a/c/");
        assert_eq!(pdirname("/a/b/c.mp4"), "/a/b");
        assert_eq!(pdirname("/a"), "/");
        assert_eq!(pdirname("a"), ".");
        assert_eq!(pbasename("/a/b/c.mp4"), "c.mp4");
        assert_eq!(pextname("/a/b/c.d.mp4"), ".mp4");
        assert_eq!(pextname("/a/.hidden"), "");
        assert_eq!(presolve("/a/../b/"), "/b");
        assert_eq!(presolve("/"), "/");
        assert_eq!(iso_ms(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_ms(1794941007117.0), "2026-11-17T18:43:27.117Z");
    }
}
