//! /api/stream and /api/tracks, as server.js does (rewriteM3u8, tsSniffer, parsePmt, handleStream, handleTracks).

use crate::util::*;
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{BodyExt, StreamBody};
use hyper::body::Frame;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// rewriteM3u8(): segments, sub-playlists and keys go through the proxy too. src: the channel's own address.
pub fn rewrite_m3u8(text: &str, base: &url::Url, ua: &str, src: Option<&str>) -> ApiResult<String> {
    static URI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"URI="([^"]+)""#).unwrap());
    static LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n").unwrap());
    let prox = |u: &str| -> ApiResult<String> {
        if u.len() >= 5 && u[..5].eq_ignore_ascii_case("data:") {
            return Ok(u.to_string());
        }
        let abs = base.join(u).map_err(|_| ApiError::new(502, "Invalid URL"))?;
        let mut out = format!("/api/stream?url={}", encode_uri_component(abs.as_str()));
        if !ua.is_empty() {
            out.push_str(&format!("&ua={}", encode_uri_component(ua)));
        }
        if let Some(s) = src.filter(|s| !s.is_empty()) {
            out.push_str(&format!("&src={}", encode_uri_component(s)));
        }
        Ok(out)
    };
    let mut lines = Vec::new();
    for line in LINES.split(text) {
        if js_trim(line).is_empty() {
            lines.push(line.to_string());
        } else if line.starts_with('#') {
            let mut err = None;
            let rewritten = URI.replace_all(line, |c: &regex::Captures| match prox(&c[1]) {
                Ok(p) => format!("URI=\"{p}\""),
                Err(e) => {
                    err = Some(e);
                    String::new()
                }
            });
            if let Some(e) = err {
                return Err(e);
            }
            lines.push(rewritten.into_owned());
        } else {
            lines.push(prox(js_trim(line))?);
        }
    }
    Ok(lines.join("\n"))
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/* ───────────── what's in an MPEG-TS stream: its sound tracks, from the programme map ───────────── */

fn ts_video(t: u8) -> &'static str {
    match t {
        0x01 => "mpeg1video",
        0x02 => "mpeg2video",
        0x10 => "mpeg4",
        0x1b => "h264",
        0x24 => "hevc",
        _ => "",
    }
}
fn ts_audio(t: u8) -> &'static str {
    match t {
        0x03 | 0x04 => "mp2",
        0x0f => "aac",
        0x11 => "aac_latm",
        0x81 => "ac3",
        0x87 => "eac3",
        0x82 | 0x85 | 0x8a => "dts",
        _ => "",
    }
}
fn ts_private_audio(tag: u8) -> &'static str {
    match tag {
        0x6a => "ac3",
        0x7a => "eac3",
        0x7b => "dts",
        0x7c => "aac",
        _ => "",
    }
}
fn ts_reg_audio(id: &[u8]) -> &'static str {
    match id {
        b"AC-3" => "ac3",
        b"EAC3" => "eac3",
        b"DTS1" | b"DTS2" | b"DTS3" => "dts",
        b"Opus" => "opus",
        _ => "",
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Tracks {
    pub video: String,
    pub audios: Vec<Value>,
}

pub fn parse_pmt(sec: &[u8]) -> Tracks {
    let at = |i: usize| -> u8 { sec.get(i).copied().unwrap_or(0) };
    let end = (3 + ((((at(1) & 0x0f) as usize) << 8) | at(2) as usize)) as isize - 4;
    let mut i = 12 + ((((at(10) & 0x0f) as usize) << 8) | at(11) as usize);
    let mut video = String::new();
    let mut audios: Vec<Value> = Vec::new();
    while (i + 5) as isize <= end {
        let typ = at(i);
        let pid = (((at(i + 1) & 0x1f) as u32) << 8) | at(i + 2) as u32;
        let len = (((at(i + 3) & 0x0f) as usize) << 8) | at(i + 4) as usize;
        let mut codec = ts_audio(typ).to_string();
        let mut lang = "und".to_string();
        let mut descr = false;
        let mut d = i + 5;
        while d + 2 <= i + 5 + len && d + 2 + at(d + 1) as usize <= sec.len() {
            let (tag, dl) = (at(d), at(d + 1) as usize);
            let body = &sec[d + 2..d + 2 + dl];
            if tag == 0x0a && dl >= 4 {
                let l: String = body[..3].iter().map(|&b| (b as char).to_ascii_lowercase()).filter(|c| c.is_ascii_lowercase()).collect();
                lang = if l.is_empty() { "und".into() } else { l };
                descr = body[3] == 3;
            } else if typ == 0x06 && !ts_private_audio(tag).is_empty() {
                codec = ts_private_audio(tag).into();
            } else if typ == 0x06 && tag == 0x05 && dl >= 4 && !ts_reg_audio(&body[..4]).is_empty() {
                codec = ts_reg_audio(&body[..4]).into();
            }
            d += 2 + dl;
        }
        if !ts_video(typ).is_empty() && video.is_empty() {
            video = ts_video(typ).into();
        }
        if !codec.is_empty() {
            let index = audios.len();
            audios.push(json!({ "index": index, "pid": pid, "lang": lang, "codec": codec, "channels": "", "title": "", "default": false, "comment": false, "descr": descr }));
        }
        i += 5 + len;
    }
    Tracks { video, audios }
}

pub enum Sniff {
    More,
    No,
    Found(Tracks),
}

/// tsSniffer(): fed the stream's bytes, finds the PMT (through the PAT); No when this isn't MPEG-TS or nothing came
/// in the first 2 MB.
#[derive(Default)]
pub struct TsSniffer {
    buf: Vec<u8>,
    seen: usize,
    synced: bool,
    pmt_pid: Option<u32>,
    parts: std::collections::HashMap<u32, Vec<u8>>,
}

impl TsSniffer {
    fn section(&mut self, pid: u32, payload: &[u8], start: bool) -> Option<Vec<u8>> {
        let part = if start {
            let pointer = payload[0] as usize;
            payload.get(1 + pointer..).map(|p| p.to_vec()).unwrap_or_default()
        } else if let Some(mut p) = self.parts.remove(&pid) {
            p.extend_from_slice(payload);
            p
        } else {
            return None;
        };
        if part.len() >= 3 && part.len() >= 3 + ((((part[1] & 0x0f) as usize) << 8) | part[2] as usize) {
            self.parts.remove(&pid);
            return Some(part);
        }
        self.parts.insert(pid, part);
        None
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Sniff {
        self.seen += chunk.len();
        self.buf.extend_from_slice(chunk);
        if !self.synced {
            let b = &self.buf;
            let mut i = 0;
            while i + 188 < b.len() && !(b[i] == 0x47 && b[i + 188] == 0x47) {
                i += 1;
            }
            if i + 188 >= b.len() {
                if self.seen > 65536 {
                    return Sniff::No;
                }
                self.buf.drain(..i);
                return Sniff::More;
            }
            self.buf.drain(..i);
            self.synced = true;
        }
        let mut o = 0;
        while o + 188 <= self.buf.len() {
            let b = &self.buf;
            if b[o] != 0x47 {
                return Sniff::No;
            }
            let pid = (((b[o + 1] & 0x1f) as u32) << 8) | b[o + 2] as u32;
            if pid != 0 && Some(pid) != self.pmt_pid {
                o += 188;
                continue;
            }
            let afc = (b[o + 3] >> 4) & 3;
            if afc & 1 == 0 {
                o += 188;
                continue;
            }
            let start = o + 4 + if afc & 2 != 0 { 1 + b[o + 4] as usize } else { 0 };
            if start >= o + 188 {
                o += 188;
                continue;
            }
            let payload = b[start..o + 188].to_vec();
            let unit_start = b[o + 1] & 0x40 != 0;
            o += 188;
            let Some(sec) = self.section(pid, &payload, unit_start) else { continue };
            if pid == 0 && sec.first() == Some(&0x00) {
                let end = (3 + ((((sec[1] & 0x0f) as usize) << 8) | sec[2] as usize)) as isize - 4;
                let mut i = 8usize;
                while (i + 4) as isize <= end {
                    if (((sec[i] as u32) << 8) | sec[i + 1] as u32) != 0 {
                        self.pmt_pid = Some((((sec[i + 2] & 0x1f) as u32) << 8) | sec[i + 3] as u32);
                        break;
                    }
                    i += 4;
                }
            } else if Some(pid) == self.pmt_pid && sec.first() == Some(&0x02) {
                return Sniff::Found(parse_pmt(&sec));
            }
        }
        self.buf.drain(..o);
        if self.seen > 2 * 1024 * 1024 {
            Sniff::No
        } else {
            Sniff::More
        }
    }
}

struct Known {
    tracks: Tracks,
    hls: bool,
    t: f64,
}

/// channel address -> what was read from it; the 300 most recent
static TRACKS: LazyLock<Mutex<VecDeque<(String, Known)>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));

fn remember(key: String, k: Known) {
    let mut m = TRACKS.lock().unwrap();
    m.retain(|(x, _)| *x != key);
    m.push_back((key, k));
    while m.len() > 300 {
        m.pop_front();
    }
}

pub fn handle_tracks(q: &Query) -> Resp {
    let m = TRACKS.lock().unwrap();
    let key = q.get("url").unwrap_or("");
    let v = m.iter().find(|(k, _)| k == key).map(|(_, i)| json!({ "video": i.tracks.video, "audios": i.tracks.audios, "hls": i.hls }));
    send_json(200, &v.unwrap_or_else(|| json!({})))
}

/// GET /api/stream?url=…[&ua=…][&src=…], with the player's Range passed on.
pub async fn handle_stream(q: &Query, range: Option<String>) -> ApiResult<Resp> {
    let ua = q.get("ua").unwrap_or("").to_string();
    let u = check_url(q.get("url"))?;
    // the provider has 20 s to answer; after that the stream runs as long as the player reads it
    let r = send_req(upstream(&u, Some(&ua), range.as_deref()), Duration::from_secs(20)).await?;
    let status = r.status().as_u16();
    if !r.status().is_success() && status != 206 {
        return Err(ApiError::new(if status == 404 { 404 } else { 502 }, format!("Stream answered HTTP {status}")));
    }
    let header = |k: &str| r.headers().get(k).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let ct = header("content-type").unwrap_or_default();
    static M3U8_CT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)mpegurl").unwrap());
    static M3U8_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.m3u8?(\?|$)").unwrap());
    let final_url = r.url().clone();
    let looks_m3u8 = M3U8_CT.is_match(&ct) || M3U8_URL.is_match(final_url.as_str());
    let is_text = ct.len() >= 5 && ct[..5].eq_ignore_ascii_case("text/");
    if looks_m3u8 || is_text {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3600);
        let raw = read_all(r, deadline).await?;
        let text = String::from_utf8_lossy(&raw).into_owned();
        let text = text.strip_prefix('\u{feff}').map(|s| s.to_string()).unwrap_or(text); // Response.text() drops a BOM
        if looks_m3u8 || text.starts_with("#EXTM3U") {
            let src = q.get("src").filter(|s| !s.is_empty()).or(q.get("url"));
            let out = rewrite_m3u8(&text, &final_url, &ua, src)?;
            return Ok(send(200, out, &[("content-type", "application/vnd.apple.mpegurl")]));
        }
        return Ok(send(200, text, &[("content-type", ct.as_str())]));
    }

    let mut b = hyper::Response::builder().status(status).header("cache-control", "no-store");
    for k in ["content-type", "content-range", "accept-ranges"] {
        if let Some(v) = header(k) {
            b = b.header(k, v);
        }
    }
    // reqwest drops Content-Length (and Content-Encoding) when it decompresses, as Node passes it on only then
    if header("content-encoding").is_none() {
        if let Some(v) = header("content-length") {
            b = b.header("content-length", v);
        }
    }

    // a live stream (or an HLS segment of one, src = its channel): note its sound tracks as they pass
    let src = q.get("src").filter(|s| !s.is_empty()).map(|s| s.to_string());
    let key = src.clone().or(q.get("url").map(|s| s.to_string())).unwrap_or_default();
    let stale = {
        let m = TRACKS.lock().unwrap();
        m.iter().find(|(k, _)| *k == key).map(|(_, i)| now_ms() - i.t > 10.0 * 60e3).unwrap_or(true)
    };
    let mut sniff = if range.is_none() && (src.is_none() || stale) { Some(TsSniffer::default()) } else { None };
    let hls = src.is_some();
    let body = r.bytes_stream().map(move |chunk| {
        let chunk = chunk.map_err(|e| std::io::Error::other(e.to_string()))?;
        if let Some(s) = sniff.as_mut() {
            match s.feed(&chunk) {
                Sniff::More => {}
                Sniff::No => sniff = None,
                Sniff::Found(tracks) => {
                    remember(key.clone(), Known { tracks, hls, t: now_ms() });
                    sniff = None;
                }
            }
        }
        Ok::<_, std::io::Error>(Frame::data(Bytes::from(chunk)))
    });
    Ok(b.body(BodyExt::boxed(StreamBody::new(body))).expect("valid response"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hls_routes_segments_and_keys_back() {
        let base = url::Url::parse("http://host.example/live/a/index.m3u8").unwrap();
        let out = rewrite_m3u8("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\nseg1.ts\n\nhttps://cdn.example/seg2.ts", &base, "VLC", None).unwrap();
        let prox = |u: &str| format!("/api/stream?url={}&ua=VLC", encode_uri_component(u));
        assert_eq!(
            out.split('\n').collect::<Vec<_>>(),
            vec![
                "#EXTM3U".to_string(),
                format!("#EXT-X-KEY:METHOD=AES-128,URI=\"{}\"", prox("http://host.example/live/a/key.bin")),
                prox("http://host.example/live/a/seg1.ts"),
                String::new(),
                prox("https://cdn.example/seg2.ts"),
            ]
        );
    }
}
