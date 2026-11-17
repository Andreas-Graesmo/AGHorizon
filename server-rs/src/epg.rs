//! /api/epg: an XMLTV guide (plain or gzipped) as compact JSON, as server.js does (xmltvParser, loadEpg, filterEpg).

use crate::util::*;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::watch;

/// normName in server.js / public/js/core.js: lower case, only letters and digits (Unicode).
pub fn norm_name(s: &str) -> String {
    static OTHER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap());
    OTHER.replace_all(&s.to_lowercase(), "").into_owned()
}

/// decode(): CDATA, character references and the five named entities, then trimmed.
pub fn decode(s: &str) -> String {
    static CDATA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<!\[CDATA\[(.*?)\]\]>").unwrap());
    static ENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)&(#x[0-9a-f]+|#\d+|[a-z]+);").unwrap());
    if s.is_empty() {
        return String::new();
    }
    let s = CDATA.replace_all(s, "$1");
    let out = ENT.replace_all(&s, |c: &regex::Captures| {
        let e = &c[1];
        let whole = c[0].to_string();
        if let Some(num) = e.strip_prefix('#') {
            let n = if num.starts_with('x') || num.starts_with('X') { u32::from_str_radix(&num[1..], 16).ok() } else { num.parse::<u32>().ok() };
            return n.and_then(char::from_u32).map(|ch| ch.to_string()).unwrap_or(whole);
        }
        match e.to_lowercase().as_str() {
            "amp" => "&".into(),
            "lt" => "<".into(),
            "gt" => ">".into(),
            "quot" => "\"".into(),
            "apos" => "'".into(),
            _ => whole,
        }
    });
    js_trim(&out).to_string()
}

/// String.prototype.trim: also the byte order mark, which Rust's trim keeps.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// "20261023203000 +0200" -> epoch ms
pub fn parse_xmltv_time(s: &str) -> Option<f64> {
    static T: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?").unwrap());
    let m = T.captures(s)?;
    let n = |i: usize| m.get(i).map(|x| x.as_str().parse::<i64>().unwrap_or(0)).unwrap_or(0);
    let mut t = date_utc(n(1), n(2) - 1, n(3), n(4), n(5), n(6));
    if let Some(z) = m.get(7) {
        let z = z.as_str();
        let sign = if z.starts_with('-') { -1.0 } else { 1.0 };
        let h: f64 = z[1..3].parse().unwrap_or(0.0);
        let mi: f64 = z[3..5].parse().unwrap_or(0.0);
        t -= sign * (h * 60.0 + mi) * 60000.0;
    }
    Some(t)
}

/// Date.UTC, which also accepts out-of-range months, days, hours… by carrying them over.
fn date_utc(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64) -> f64 {
    let y = y + mo.div_euclid(12);
    let mo = mo.rem_euclid(12) + 1;
    // days from civil (Howard Hinnant)
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468 + (d - 1);
    ((days * 86400 + h * 3600 + mi * 60 + s) * 1000) as f64
}

fn attr(attrs: &str, name: &str) -> String {
    // JS: \bname\s*=\s*(["'])(.*?)\1 — the regex crate has no back-references: one branch per quote
    let re = Regex::new(&format!(r#"\b{name}\s*=\s*(?:"([^"\n\r\u{{2028}}\u{{2029}}]*)"|'([^'\n\r\u{{2028}}\u{{2029}}]*)')"#)).unwrap();
    re.captures(attrs).map(|c| c.get(1).or(c.get(2)).map(|m| m.as_str().to_string()).unwrap_or_default()).unwrap_or_default()
}

fn tag(body: &str, name: &str) -> String {
    let re = match name {
        "title" => &*TITLE,
        _ => &*DESC,
    };
    re.captures(body).map(|c| decode(&c[1])).unwrap_or_default()
}
static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<title\b[^>]*>(.*?)</title>").unwrap());
static DESC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<desc\b[^>]*>(.*?)</desc>").unwrap());

/// .slice(0, 400) counts UTF-16 units
fn slice_utf16(s: &str, max: usize) -> String {
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

/// A JavaScript object's own string keys in its iteration order: integer-like keys first, ascending, then the rest
/// in the order they were added. filterEpg's "first channel wins" depends on it.
#[derive(Default)]
pub struct JsMap<V> {
    order: Vec<String>,
    map: HashMap<String, V>,
}

impl<V> JsMap<V> {
    fn entry(&mut self, k: &str) -> &mut V
    where
        V: Default,
    {
        if !self.map.contains_key(k) {
            self.order.push(k.to_string());
        }
        self.map.entry(k.to_string()).or_default()
    }
    fn set(&mut self, k: &str, v: V) {
        if !self.map.contains_key(k) {
            self.order.push(k.to_string());
        }
        self.map.insert(k.to_string(), v);
    }
    pub fn get(&self, k: &str) -> Option<&V> {
        self.map.get(k)
    }
    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn keys(&self) -> Vec<&str> {
        let index = |k: &str| -> Option<u32> {
            if k == "0" {
                return Some(0);
            }
            if k.is_empty() || k.starts_with('0') || !k.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            k.parse::<u64>().ok().filter(|n| *n < u32::MAX as u64).map(|n| n as u32)
        };
        let mut ints: Vec<(&str, u32)> = self.order.iter().filter_map(|k| index(k).map(|n| (k.as_str(), n))).collect();
        ints.sort_by_key(|(_, n)| *n);
        let mut out: Vec<&str> = ints.into_iter().map(|(k, _)| k).collect();
        out.extend(self.order.iter().filter(|k| index(k).is_none()).map(|k| k.as_str()));
        out
    }
}

pub struct Guide {
    pub ch_names: JsMap<Vec<String>>,
    pub programmes: JsMap<Vec<(f64, f64, String, String)>>,
    pub parsed_at: f64,
}

/// xmltvParser(): fed text piece by piece; only whole <channel> / <programme> elements are parsed.
pub struct XmltvParser {
    from: f64,
    to: f64,
    rest: String,
    is_tv: bool,
    ch_names: JsMap<Vec<String>>,
    programmes: JsMap<Vec<(f64, f64, String, String)>>,
}

static CH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s)<channel\b[^>]*?\bid\s*=\s*(?:"([^"\n\r\u{2028}\u{2029}]*)"|'([^'\n\r\u{2028}\u{2029}]*)')[^>]*>(.*?)</channel>"#).unwrap()
});
static NAME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<display-name\b[^>]*>(.*?)</display-name>").unwrap());
static P_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<programme\b([^>]*)>(.*?)</programme>").unwrap());
static TV_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<tv\b").unwrap());

impl XmltvParser {
    pub fn new(from: f64, to: f64) -> Self {
        XmltvParser { from, to, rest: String::new(), is_tv: false, ch_names: JsMap::default(), programmes: JsMap::default() }
    }

    fn parse(&mut self, xml: &str) {
        for m in CH_RE.captures_iter(xml) {
            let id = m.get(1).or(m.get(2)).map(|x| x.as_str()).unwrap_or("");
            let names: Vec<String> = NAME_RE.captures_iter(&m[3]).map(|n| norm_name(&decode(&n[1]))).filter(|k| !k.is_empty()).collect();
            self.ch_names.set(&decode(id), names);
        }
        for m in P_RE.captures_iter(xml) {
            let (Some(start), Some(stop)) = (parse_xmltv_time(&attr(&m[1], "start")), parse_xmltv_time(&attr(&m[1], "stop"))) else { continue };
            if stop < self.from || start > self.to {
                continue;
            }
            let ch = decode(&attr(&m[1], "channel"));
            if ch.is_empty() {
                continue;
            }
            let title = tag(&m[2], "title");
            let desc = slice_utf16(&tag(&m[2], "desc"), 400);
            self.programmes.entry(&ch).push((start, stop, title, desc));
        }
    }

    pub fn push(&mut self, text: &str) -> ApiResult<()> {
        self.rest.push_str(text);
        if !self.is_tv {
            self.is_tv = TV_RE.is_match(&self.rest);
            if !self.is_tv && self.rest.encode_utf16().count() > 1_000_000 {
                return Err(ApiError::new(502, "That URL did not return an XMLTV guide"));
            }
        }
        let p = self.rest.rfind("</programme>").map(|i| i + 12);
        let c = self.rest.rfind("</channel>").map(|i| i + 10);
        let Some(cut) = p.max(c) else { return Ok(()) };
        let head = self.rest[..cut].to_string();
        self.parse(&head);
        self.rest.drain(..cut);
        Ok(())
    }

    pub fn end(mut self) -> ApiResult<Guide> {
        if !self.is_tv && !TV_RE.is_match(&self.rest) {
            return Err(ApiError::new(502, "That URL did not return an XMLTV guide"));
        }
        let rest = std::mem::take(&mut self.rest);
        self.parse(&rest);
        for v in self.programmes.map.values_mut() {
            v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal)); // stable, as Array.prototype.sort
        }
        Ok(Guide { ch_names: self.ch_names, programmes: self.programmes, parsed_at: now_ms() })
    }
}

/// guideText(): the file (plain or gzipped) as ~1 MB pieces of text, UTF-8 decoded across piece edges with
/// U+FFFD for invalid bytes (TextDecoder).
pub fn parse_xmltv(buf: &[u8], from: f64, to: f64) -> ApiResult<Guide> {
    use std::io::Read;
    const PIECE: usize = 1 << 20;
    let mut parser = XmltvParser::new(from, to);
    let mut pending: Vec<u8> = Vec::new();
    let mut feed = |piece: &[u8], last: bool, parser: &mut XmltvParser| -> ApiResult<()> {
        pending.extend_from_slice(piece);
        let mut text = String::new();
        loop {
            match std::str::from_utf8(&pending) {
                Ok(s) => {
                    text.push_str(s);
                    pending.clear();
                    break;
                }
                Err(e) => {
                    let ok = e.valid_up_to();
                    text.push_str(std::str::from_utf8(&pending[..ok]).unwrap());
                    match e.error_len() {
                        Some(n) => {
                            text.push('\u{fffd}');
                            pending.drain(..ok + n);
                        }
                        None if last => {
                            text.push('\u{fffd}');
                            pending.clear();
                            break;
                        }
                        None => {
                            pending.drain(..ok);
                            break;
                        }
                    }
                }
            }
        }
        parser.push(&text)
    };
    if buf.len() > 2 && buf[0] == 0x1f && buf[1] == 0x8b {
        let mut gz = flate2::read::MultiGzDecoder::new(buf);
        let mut piece = vec![0u8; PIECE];
        loop {
            let mut filled = 0;
            while filled < PIECE {
                let n = gz.read(&mut piece[filled..]).map_err(|e| ApiError::new(502, e.to_string()))?;
                if n == 0 {
                    break;
                }
                filled += n;
            }
            if filled == 0 {
                break;
            }
            feed(&piece[..filled], false, &mut parser)?;
        }
    } else {
        for chunk in buf.chunks(PIECE) {
            feed(chunk, false, &mut parser)?;
        }
    }
    feed(&[], true, &mut parser)?;
    parser.end()
}

/* ───────────── the cache: a guide is downloaded once per 30 minutes, and once for several askers at a time ───────────── */

const EPG_TTL_MS: f64 = 30.0 * 60.0 * 1000.0;
type Shared = Result<Arc<Guide>, ApiError>;

#[derive(Default)]
struct Cache {
    done: Vec<(String, f64, Arc<Guide>)>, // oldest first, at most 6
    loading: HashMap<String, watch::Receiver<Option<Shared>>>,
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(Cache::default()));

async fn load_epg(url: String, ua: Option<String>, force: bool) -> Shared {
    let rx = {
        let mut c = CACHE.lock().unwrap();
        if !force {
            if let Some((_, t, g)) = c.done.iter().find(|(u, _, _)| *u == url) {
                if now_ms() - t < EPG_TTL_MS {
                    return Ok(g.clone());
                }
            }
        }
        if let Some(rx) = c.loading.get(&url) {
            rx.clone()
        } else {
            let (tx, rx) = watch::channel(None);
            c.loading.insert(url.clone(), rx.clone());
            let (u2, ua2) = (url.clone(), ua.clone());
            tokio::spawn(async move {
                let result = download_epg(&u2, ua2.as_deref()).await;
                let mut c = CACHE.lock().unwrap();
                c.loading.remove(&u2);
                if let Ok(g) = &result {
                    c.done.retain(|(u, _, _)| *u != u2); // a refreshed guide counts as the newest
                    c.done.push((u2.clone(), now_ms(), g.clone()));
                    while c.done.len() > 6 {
                        c.done.remove(0);
                    }
                }
                let _ = tx.send(Some(result));
            });
            rx
        }
    };
    let mut rx = rx;
    loop {
        if let Some(r) = rx.borrow().clone() {
            return r;
        }
        if rx.changed().await.is_err() {
            return rx.borrow().clone().unwrap_or_else(|| Err(ApiError::new(502, "Guide download failed")));
        }
    }
}

async fn download_epg(url: &str, ua: Option<&str>) -> Shared {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    let u = check_url(Some(url))?;
    let r = send_req(upstream(&u, ua, None), Duration::from_secs(180)).await?;
    if !r.status().is_success() {
        return Err(ApiError::new(502, format!("Guide download failed (HTTP {})", r.status().as_u16())));
    }
    let buf = read_all(r, deadline).await?;
    let now = now_ms();
    let guide = tokio::task::spawn_blocking(move || parse_xmltv(&buf, now - 3.0 * 3600e3, now + 36.0 * 3600e3))
        .await
        .map_err(|e| ApiError::new(502, e.to_string()))??;
    Ok(Arc::new(guide))
}

/// filterEpg(): only the channels the page has, by guide id or by normalised name.
fn filter_epg(full: &Guide, ids: &[String], names: &[String]) -> Value {
    let id_set: HashSet<String> = ids.iter().map(|s| s.to_lowercase()).collect();
    let name_set: HashSet<&str> = names.iter().map(|s| s.as_str()).collect();
    let mut programmes = Map::new();
    let mut by_name = Map::new();
    for id in full.programmes.keys() {
        let mut keep = id_set.contains(&id.to_lowercase());
        if !keep {
            for n in full.ch_names.get(id).map(|v| v.as_slice()).unwrap_or(&[]) {
                if name_set.contains(n.as_str()) {
                    keep = true;
                    if !by_name.contains_key(n) {
                        by_name.insert(n.clone(), json!(id));
                    }
                }
            }
        }
        if keep {
            let list: Vec<Value> = full.programmes.get(id).unwrap().iter().map(|(a, b, t, d)| json!([a, b, t, d])).collect();
            programmes.insert(id.to_string(), Value::Array(list));
        }
    }
    json!({ "programmes": programmes, "byName": by_name, "totalChannels": full.programmes.len(), "parsedAt": full.parsed_at })
}

/// POST /api/epg { url, ua?, force?, ids?, names? }
pub async fn handle(body: Value) -> ApiResult<Value> {
    let url = match body.get("url") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        None | Some(Value::Null) | Some(Value::Bool(false)) => return Err(ApiError::new(400, "Missing guide URL")),
        Some(Value::String(_)) => return Err(ApiError::new(400, "Missing guide URL")),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => return Err(ApiError::new(400, "Missing guide URL")),
        Some(other) => js_string(other),
    };
    let ua = match body.get("ua") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Null) | None => None,
        Some(other) => Some(js_string(other)),
    };
    let force = truthy(body.get("force"));
    let list = |k: &str| -> Vec<String> {
        match body.get(k) {
            Some(Value::Array(a)) => a.iter().map(js_string).collect(),
            _ => Vec::new(),
        }
    };
    let ids = list("ids");
    let names = list("names");
    let full = load_epg(url, ua, force).await?;
    Ok(filter_epg(&full, &ids, &names))
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0 && !x.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// String(value) for what a JSON body can hold
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_honour_their_zone() {
        assert_eq!(parse_xmltv_time("20261023203000 +0200"), Some(date_utc(2026, 9, 23, 18, 30, 0)));
        assert_eq!(parse_xmltv_time("20261023203000 -0130"), Some(date_utc(2026, 9, 23, 22, 0, 0)));
        assert_eq!(parse_xmltv_time("202610232030"), Some(date_utc(2026, 9, 23, 20, 30, 0)));
        assert_eq!(parse_xmltv_time("garbage"), None);
        assert_eq!(date_utc(1970, 0, 1, 0, 0, 0), 0.0);
        assert_eq!(date_utc(2000, 0, 1, 0, 0, 0), 946684800000.0);
    }

    #[test]
    fn names_and_entities() {
        assert_eq!(norm_name("NRK1 HD+"), "nrk1hd");
        assert_eq!(norm_name("Ærø TV"), "ærøtv");
        assert_eq!(decode(" <![CDATA[a &amp; b]]> &#65;&#x42;&bogus; "), "a & b AB&bogus;");
    }

    #[test]
    fn js_key_order() {
        let mut m: JsMap<i32> = JsMap::default();
        for k in ["b", "10", "a", "2", "02"] {
            m.set(k, 0);
        }
        assert_eq!(m.keys(), vec!["2", "10", "b", "a", "02"]);
    }
}
