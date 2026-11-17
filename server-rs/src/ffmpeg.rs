//! Compatibility mode, as server.js does it: /api/probe, /api/keyframe, /api/transcode (and /api/tcsubs through
//! subtitles.rs). Browsers can't decode everything; ffmpeg turns the stream into H.264 + stereo AAC.

use crate::subtitles;
use crate::util::*;
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{BodyExt, StreamBody};
use hyper::body::Frame;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::LazyLock;
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// ffmpegInput(): never let a playlist make ffmpeg read local files; reconnect; the player's user agent
fn input(url: &str, ua: Option<&str>, extra: &[String]) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-protocol_whitelist", "http,https,tcp,tls,crypto", "-user_agent"].iter().map(|s| s.to_string()).collect();
    a.push(ua.filter(|s| !s.is_empty()).unwrap_or(DEFAULT_UA).to_string());
    a.extend(["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-fflags", "+genpts"].iter().map(|s| s.to_string()));
    a.extend(extra.iter().cloned());
    a.push("-i".into());
    a.push(url.into());
    a
}

fn command(bin: &str, args: &[String]) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(bin);
    c.args(args).stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    {
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
    }
    c
}

/// parseAudioStreams(): the sound tracks ffmpeg lists, in the order "-map 0:a:N" counts them; each stream once
pub fn parse_audio_streams(stderr: &str) -> Vec<Value> {
    static ST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*Stream #\d+:(\d+)(?:\[[A-Za-z0-9_]+\])?(?:\(([A-Za-z0-9_]+)\))?: ([A-Za-z0-9_]+): (.*)$").unwrap());
    static LAYOUT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+ Hz, ([^,]+)").unwrap());
    static TRAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(.*\)$").unwrap());
    static CODEC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Za-z0-9_]+)").unwrap());
    static NUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d\.\d$").unwrap());
    static OTHER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(Stream #|Program |Input #|Output #)").unwrap());
    static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s+title\s*:\s*(.+?)\s*$").unwrap());
    static LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n").unwrap());
    let layouts = |l: &str| -> Option<&'static str> {
        Some(match l {
            "mono" | "1 channels" => "Mono",
            "stereo" | "2 channels" => "Stereo",
            "6 channels" => "5.1",
            "8 channels" => "7.1",
            _ => return None,
        })
    };
    let mut by_num: BTreeMap<u64, Value> = BTreeMap::new();
    let mut cur: Option<u64> = None;
    for line in LINES.split(stderr) {
        if let Some(st) = ST.captures(line) {
            let num: u64 = st[1].parse().unwrap_or(0);
            if &st[3] != "Audio" || by_num.contains_key(&num) {
                cur = None;
                continue;
            }
            let rest = &st[4];
            let layout = LAYOUT.captures(rest).map(|c| c[1].to_string()).unwrap_or_default();
            let lay = TRAIL.replace(&layout.trim().to_lowercase(), "").into_owned();
            let channels = layouts(&lay).map(|s| s.to_string()).unwrap_or_else(|| if NUM.is_match(&lay) { lay.clone() } else { String::new() });
            by_num.insert(
                num,
                json!({
                    "lang": st.get(2).map(|x| x.as_str().to_lowercase()).unwrap_or_else(|| "und".into()),
                    "codec": CODEC.captures(rest).map(|c| c[1].to_lowercase()).unwrap_or_default(),
                    "channels": channels,
                    "title": "",
                    "default": rest.contains("(default)"),
                    "comment": rest.contains("(comment)"),
                    "descr": rest.contains("(visual impaired)"),
                }),
            );
            cur = Some(num);
            continue;
        }
        if OTHER.is_match(line) {
            cur = None;
            continue;
        }
        if let Some(n) = cur {
            let a = by_num.get_mut(&n).unwrap();
            if a["title"] == "" {
                if let Some(t) = TITLE.captures(line) {
                    a["title"] = json!(t[1].to_string());
                }
            }
        }
    }
    by_num
        .into_values()
        .enumerate()
        .map(|(index, a)| {
            let mut o = serde_json::Map::new();
            o.insert("index".into(), json!(index));
            for k in ["lang", "codec", "channels", "title", "default", "comment", "descr"] {
                o.insert(k.into(), a[k].clone());
            }
            Value::Object(o)
        })
        .collect()
}

/// Runs ffmpeg for at most 15 s and gives back what it wrote to one of its outputs.
async fn run_capture(bin: &str, args: &[String], stderr: bool, keep: usize) -> std::io::Result<String> {
    let mut cmd = command(bin, args);
    if stderr {
        cmd.stdout(Stdio::null()).stderr(Stdio::piped());
    } else {
        cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    }
    let mut child = cmd.spawn()?;
    let mut pipe: Box<dyn tokio::io::AsyncRead + Unpin + Send> = if stderr { Box::new(child.stderr.take().unwrap()) } else { Box::new(child.stdout.take().unwrap()) };
    let mut out: Vec<u8> = Vec::new();
    let read = async {
        let mut buf = [0u8; 16384];
        loop {
            match pipe.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    out.extend_from_slice(&buf[..n]);
                    if out.len() > keep * 4 {
                        out.drain(..out.len() - keep * 2);
                    }
                }
            }
        }
    };
    if tokio::time::timeout(Duration::from_secs(15), read).await.is_err() {
        let _ = child.start_kill(); // what was read so far is the answer, as server.js does after SIGKILL
    }
    let _ = child.wait().await;
    let text = String::from_utf8_lossy(&out).into_owned();
    let n = text.encode_utf16().count();
    Ok(if n > keep { text.chars().rev().scan(0, |c, ch| { *c += ch.len_utf16(); Some((*c, ch)) }).take_while(|(c, _)| *c <= keep).map(|(_, ch)| ch).collect::<Vec<_>>().into_iter().rev().collect() } else { text })
}

/// GET /api/probe?url=…[&ua=…][&quick=1]: duration, codecs, sound and text subtitle tracks
pub async fn probe(bin: Option<String>, q: &Query) -> ApiResult<Resp> {
    let bin = bin.ok_or_else(|| ApiError::new(501, "ffmpeg is not installed"))?;
    let url = check_url(q.get("url"))?;
    let size = if q.get("quick").map(|s| !s.is_empty()).unwrap_or(false) { "1500000" } else { "4000000" };
    let args = input(url.as_str(), q.get("ua"), &["-analyzeduration".into(), size.into(), "-probesize".into(), size.into()]);
    let err = match run_capture(&bin, &args, true, 60000).await {
        Ok(e) => e,
        Err(e) => return Ok(send_json(502, &json!({ "error": format!("Could not run ffmpeg: {e}") }))),
    };
    static DUR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)").unwrap());
    static V: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Stream #\d+:\d+[^\n]*?Video:\s*([a-z0-9_]+)").unwrap());
    static A: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Stream #\d+:\d+[^\n]*?Audio:\s*([a-z0-9_]+)").unwrap());
    let duration = DUR.captures(&err).map(|d| js_number(Some(&d[1])) * 3600.0 + js_number(Some(&d[2])) * 60.0 + js_number(Some(&d[3]))).unwrap_or(0.0);
    let subs: Vec<Value> = subtitles::parse_sub_streams(&err)
        .into_iter()
        .filter(|t| t.text)
        .map(|t| json!({ "index": t.index, "lang": t.lang, "forced": t.forced, "sdh": t.sdh }))
        .collect();
    Ok(send_json(
        200,
        &json!({
            "duration": js_num(duration),
            "video": V.captures(&err).map(|c| c[1].to_lowercase()).unwrap_or_default(),
            "audio": A.captures(&err).map(|c| c[1].to_lowercase()).unwrap_or_default(),
            "audios": parse_audio_streams(&err),
            "subs": subs,
        }),
    ))
}

/// GET /api/keyframe?url=…&t=…: the time of the keyframe at or before t (copied video can only start on one)
pub async fn keyframe(bin: Option<String>, q: &Query) -> ApiResult<Resp> {
    let bin = bin.ok_or_else(|| ApiError::new(501, "ffmpeg is not installed"))?;
    let url = check_url(q.get("url"))?;
    let t = { let x = js_number(q.get("t")); if x.is_nan() { 0.0 } else { x.max(0.0) } };
    let mut args = input(url.as_str(), q.get("ua"), &["-noaccurate_seek".into(), "-ss".into(), js_num_str(t)]);
    args.extend(["-copyts", "-start_at_zero", "-map", "0:v:0", "-c", "copy", "-frames:v", "1", "-f", "framecrc", "pipe:1"].iter().map(|s| s.to_string()));
    let Ok(out) = run_capture(&bin, &args, false, usize::MAX / 8).await else { return Ok(send_json(200, &json!({ "t": js_num(t) }))) };
    // framecrc: "#tb 0: 1/1000" then "0, dts, pts, duration, size, crc"
    static TB: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^#tb 0: (\d+)/(\d+)").unwrap());
    static PKT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^0,\s*-?\d+,\s*(-?\d+),").unwrap());
    let kf = match (TB.captures(&out), PKT.captures(&out)) {
        (Some(tb), Some(p)) => js_number(Some(&p[1])) * js_number(Some(&tb[1])) / js_number(Some(&tb[2])),
        _ => f64::NAN,
    };
    let answer = if kf.is_finite() && kf >= 0.0 && kf <= t + 0.5 { kf } else { t };
    Ok(send_json(200, &json!({ "t": js_num(answer) })))
}

static ACTIVE: AtomicUsize = AtomicUsize::new(0);
const MAX_CONVERSIONS: usize = 4; // Multi view's 2 × 2 grid

/// one running conversion: counted until ffmpeg exits
struct Slot(Option<String>);
impl Drop for Slot {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::SeqCst);
        subtitles::tc_sub_cleanup(self.0.take());
    }
}

/// GET /api/transcode?url=…[&ua][&start][&video=copy|hevc][&maxh][&apid|&audio][&subs=0,3&sid=…]
pub async fn transcode(bin: Option<String>, q: &Query) -> ApiResult<Resp> {
    let bin = bin.ok_or_else(|| ApiError::new(501, "ffmpeg is not installed"))?;
    if ACTIVE.load(Ordering::SeqCst) >= MAX_CONVERSIONS {
        return Err(ApiError::new(429, "Too many conversions are running – wait a moment and try again"));
    }
    let url = check_url(q.get("url"))?;
    let start = { let x = js_number(q.get("start")); if x.is_nan() { 0.0 } else { x.max(0.0) } };
    let keep_hevc = q.get("video") == Some("hevc"); // the player decodes HEVC itself
    let copy_video = q.get("video") == Some("copy") || keep_hevc;
    let maxh = { let x = js_number(q.get("maxh")); let x = if x == 0.0 || x.is_nan() { 1080.0 } else { x }; x.max(240.0).min(1080.0) };
    static APID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{1,4}$").unwrap());
    static AUDIO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{1,2}$").unwrap());
    static TRACK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{1,3}$").unwrap());
    let apid = q.get("apid").filter(|s| APID.is_match(s)).map(|s| js_number(Some(s)));
    let audio = q.get("audio").filter(|s| AUDIO.is_match(s)).map(|s| js_number(Some(s))).unwrap_or(0.0);

    let mut extra: Vec<String> = ["-analyzeduration", "5000000", "-probesize", "10000000"].iter().map(|s| s.to_string()).collect();
    if start != 0.0 {
        if copy_video {
            extra.push("-noaccurate_seek".into());
        }
        extra.extend(["-ss".into(), js_to_fixed(start, 3)]);
    }
    let mut args = input(url.as_str(), q.get("ua"), &extra);
    args.extend(["-map".into(), "0:v:0".into(), "-map".into(), match apid { Some(p) => format!("0:i:{}", js_num_str(p)), None => format!("0:a:{}?", js_num_str(audio)) }, "-sn".into(), "-dn".into()]);
    if copy_video {
        args.extend(["-c:v".into(), "copy".into()]);
    } else {
        args.extend(["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"].iter().map(|s| s.to_string()));
        args.extend(["-vf".into(), format!("scale=-2:'min({},ih)'", js_num_str(maxh))]);
        args.extend(["-g", "50", "-keyint_min", "50", "-sc_threshold", "0"].iter().map(|s| s.to_string()));
    }
    args.extend(["-c:a", "aac", "-b:a", "192k", "-ac", "2"].iter().map(|s| s.to_string()));
    if keep_hevc {
        args.extend(["-f", "matroska", "-live", "1"].iter().map(|s| s.to_string()));
    } else {
        args.extend(["-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4"].iter().map(|s| s.to_string()));
    }
    args.push("pipe:1".into());
    let tracks: Vec<String> = q.get("subs").unwrap_or("").split(',').filter(|n| TRACK.is_match(n)).take(64).map(|s| s.to_string()).collect();
    let sid = q.get("sid").map(|s| s.to_string());
    args.extend(subtitles::tc_sub_args(sid.as_deref(), &tracks, start));

    let mut cmd = command(&bin, &args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    ACTIVE.fetch_add(1, Ordering::SeqCst);
    let slot = Slot(sid);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            drop(slot);
            return Ok(send_json(502, &json!({ "error": format!("Could not run ffmpeg: {e}") })));
        }
    };
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    // the last 4000 characters of what ffmpeg says, for the error when nothing came out
    let err_tail = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let tail = err_tail.clone();
    let reader = tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
            let mut t = tail.lock().unwrap();
            t.push_str(&String::from_utf8_lossy(&buf[..n]));
            let len = t.chars().count();
            if len > 4000 {
                *t = t.chars().skip(len - 4000).collect();
            }
        }
    });

    // the first bytes decide the answer: a video, or ffmpeg's last words
    let mut first = vec![0u8; 65536];
    let n = stdout.read(&mut first).await.unwrap_or(0);
    if n == 0 {
        let _ = child.wait().await;
        let _ = reader.await; // all of what ffmpeg said (its stderr closes when it exits)
        drop(slot);
        let t = err_tail.lock().unwrap().clone();
        let last = t.trim().split('\n').filter(|l| !l.is_empty()).last().unwrap_or("unknown error").to_string();
        return Ok(send_json(502, &json!({ "error": format!("Conversion failed: {last}") })));
    }
    first.truncate(n);
    // the rest streams to the player; when it hangs up, the body (and with it ffmpeg) is dropped
    let rest = futures_util::stream::unfold((stdout, child, slot), |(mut out, child, slot)| async move {
        let mut buf = vec![0u8; 65536];
        match out.read(&mut buf).await {
            Ok(0) | Err(_) => {
                let mut child = child;
                let _ = child.wait().await;
                drop(slot);
                None
            }
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<_, std::io::Error>(Frame::data(Bytes::from(buf))), (out, child, slot)))
            }
        }
    });
    let body = futures_util::stream::once(async move { Ok::<_, std::io::Error>(Frame::data(Bytes::from(first))) }).chain(rest);
    Ok(hyper::Response::builder()
        .status(200)
        .header("content-type", if keep_hevc { "video/x-matroska" } else { "video/mp4" })
        .header("cache-control", "no-store")
        .header("accept-ranges", "none")
        .body(BodyExt::boxed(StreamBody::new(body)))
        .expect("valid response"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audio_streams_once_each_in_order() {
        let err = "Input #0, mpegts\n  Program 1\n    Stream #0:1[0x101](eng): Audio: ac3 ([129][0][0][0] / 0x0081), 48000 Hz, 5.1(side), fltp, 384 kb/s (default)\n    Metadata:\n      title           : Main\n    Stream #0:2[0x102](nor): Audio: aac (LC), 48000 Hz, stereo, fltp (visual impaired)\n  Program 2\n    Stream #0:1[0x101](eng): Audio: ac3, 48000 Hz, 5.1(side)\n    Stream #0:0[0x100]: Video: h264\n";
        let a = parse_audio_streams(err);
        assert_eq!(a.len(), 2);
        assert_eq!(a[0], json!({ "index": 0, "lang": "eng", "codec": "ac3", "channels": "5.1", "title": "Main", "default": true, "comment": false, "descr": false }));
        assert_eq!(a[1]["channels"], "Stereo");
        assert_eq!(a[1]["descr"], true);
    }
}
