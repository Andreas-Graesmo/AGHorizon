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
