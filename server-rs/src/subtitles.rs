//! subtitles.js: .srt files next to a download (and the built-in ones saved as .srt once), WebVTT for the player,
//! and the subtitles a running conversion writes.

use crate::util::*;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::watch;

// picture-based subtitles (PGS, DVD, DVB) can't become text
const TEXT_CODECS: &[&str] = &["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"];

/// path.extname: from the last "." of the file name, unless the name starts with it
fn extname(p: &Path) -> String {
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    match name.rfind('.') {
        Some(i) if i > 0 => name[i..].to_string(),
        _ => String::new(),
    }
}
/// baseOf(): the video's path without its extension
fn base_of(video: &Path) -> String {
    let s = video.to_string_lossy();
    s[..s.len() - extname(video).len()].to_string()
}
fn basename(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Intl.getCanonicalLocales(lang)[0].toLowerCase(), or lang when it isn't a language tag ("eng" and "en" -> "en")
pub fn canon(lang: &str) -> String {
    static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?i)([a-z]{2,3}|[a-z]{5,8})(-[a-z0-9]{1,8})*$").unwrap());
    if !TAG.is_match(lang) {
        return lang.to_string();
    }
    let lower = lang.to_lowercase();
    let (primary, rest) = match lower.find('-') {
        Some(i) => (&lower[..i], &lower[i..]),
        None => (lower.as_str(), ""),
    };
    match crate::canon_table::ALIASES.iter().find(|(k, _)| *k == primary) {
        Some((_, v)) => format!("{v}{rest}"),
        None => lower.clone(),
    }
}

#[derive(Clone, Debug)]
pub struct Srt {
    pub file: PathBuf,
    pub lang: String,
    pub os: bool,
    pub forced: bool,
    pub sdh: bool,
    k: f64,
}

/// listSrt(): "<name>.<lang>[.forced][.sdh][.2].srt", one language together, the file's own before OpenSubtitles'
pub async fn list_srt(video: &Path) -> Vec<Srt> {
    static OS_LANG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-z]{2}(-[a-z]+)?$").unwrap());
    let dir = video.parent().unwrap_or(Path::new("."));
    let base = basename(&base_of(video));
    let Ok(names) = readdir_node(dir).await else { return Vec::new() };   // in Node's order: ties keep it
    let mut out = Vec::new();
    for (n, _) in names {
        if !(n.starts_with(&format!("{base}.")) && n.to_lowercase().ends_with(".srt")) {
            continue;
        }
        let inner = n.get(base.len() + 1..n.len() - 4).unwrap_or("");
        let tags: Vec<&str> = inner.split('.').collect();
        let lang = tags.first().copied().unwrap_or("").to_string();
        let k = tags.iter().find(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit())).map(|t| js_number(Some(t))).filter(|x| *x != 0.0 && !x.is_nan()).unwrap_or(1.0);
        out.push(Srt { file: dir.join(&n), os: OS_LANG.is_match(&lang), forced: tags.contains(&"forced"), sdh: tags.contains(&"sdh"), lang, k });
    }
    out.sort_by(|a, b| {
        canon(&a.lang)
            .cmp(&canon(&b.lang))
            .then(a.os.cmp(&b.os))
            .then(a.forced.cmp(&b.forced))
            .then(a.sdh.cmp(&b.sdh))
            .then(a.k.partial_cmp(&b.k).unwrap_or(std::cmp::Ordering::Equal))
    });
    out
}

#[derive(Clone, Debug)]
pub struct SubStream {
    pub index: usize,
    pub lang: String,
    pub codec: String,
    pub text: bool,
    pub forced: bool,
    pub sdh: bool,
}

/// parseSubStreams(): the subtitle streams in ffmpeg's listing (its stderr)
pub fn parse_sub_streams(stderr: &str) -> Vec<SubStream> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Stream #\d+:\d+(?:\[[A-Za-z0-9_]+\])?(?:\(([A-Za-z0-9_]+)\))?: Subtitle: ([A-Za-z0-9_]+)(.*)$").unwrap());
    static LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n").unwrap());
    let mut out = Vec::new();
    for line in LINES.split(stderr) {
        if let Some(m) = RE.captures(line) {
            let codec = m[2].to_lowercase();
            out.push(SubStream {
                index: out.len(),
                lang: m.get(1).map(|x| x.as_str().to_lowercase()).unwrap_or_else(|| "und".into()),
                text: TEXT_CODECS.contains(&codec.as_str()),
                codec,
                forced: m[3].contains("(forced)"),
                sdh: m[3].contains("(hearing impaired)"),
            });
        }
    }
    out
}

async fn probe_subs(bin: &str, video: &Path) -> Vec<SubStream> {
    let out = tokio::process::Command::new(bin)
        .args(["-hide_banner", "-nostdin", "-i"])
        .arg(video)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await;
    match out {
        Ok(o) => parse_sub_streams(&String::from_utf8_lossy(&o.stderr)),
        Err(_) => Vec::new(),
    }
}

/// extractEmbedded(): the text subtitles inside a video, saved as .srt (one ffmpeg pass; .part, renamed when done)
async fn extract_embedded(bin: String, video: PathBuf) -> usize {
    let tracks: Vec<SubStream> = probe_subs(&bin, &video).await.into_iter().filter(|t| t.text).collect();
    if tracks.is_empty() {
        return 0;
    }
    let mut used: HashSet<String> = list_srt(&video).await.iter().map(|s| basename(&s.file.to_string_lossy())).collect();
    let base = base_of(&video);
    let base_name = basename(&base);
    let dir = video.parent().unwrap_or(Path::new(".")).to_path_buf();
    let mut args: Vec<std::ffi::OsString> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i"].iter().map(|s| s.into()).collect();
    args.push(video.clone().into_os_string());
    let mut files = Vec::new();
    for t in &tracks {
        let tag = format!("{}{}{}", t.lang, if t.forced { ".forced" } else { "" }, if t.sdh { ".sdh" } else { "" });
        let mut name = format!("{base_name}.{tag}.srt");
        let mut k = 2;
        while used.contains(&name) {
            name = format!("{base_name}.{tag}.{k}.srt");
            k += 1;
        }
        used.insert(name.clone());
        let file = dir.join(&name);
        files.push(file.clone());
        for a in ["-map".to_string(), format!("0:s:{}", t.index), "-c:s".into(), "srt".into(), "-f".into(), "srt".into()] {
            args.push(a.into());
        }
        args.push(format!("{}.part", file.to_string_lossy()).into());
    }
    let ok = tokio::process::Command::new(&bin)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);
    for f in &files {
        let part = format!("{}.part", f.to_string_lossy());
        if ok {
            let _ = tokio::fs::rename(&part, f).await;
        } else {
            let _ = tokio::fs::remove_file(&part).await;
        }
    }
    if ok { tracks.len() } else { 0 }
}

static CHECKED: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
static EXTRACTING: LazyLock<Mutex<HashMap<PathBuf, watch::Receiver<bool>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// localSubs(): the .srt files of a download; the first time, the built-in subtitles are saved as .srt, in the
/// background, or before answering with wait
pub async fn local_subs(bin: Option<String>, video: &Path, wait: bool) -> Vec<Srt> {
    let mut list = list_srt(video).await;
    if list.is_empty() {
        if let Some(bin) = bin {
            let running = EXTRACTING.lock().unwrap().get(video).cloned();
            let first = CHECKED.lock().unwrap().insert(video.to_path_buf());
            if first || running.is_some() {
                let rx = running.unwrap_or_else(|| {
                    let (tx, rx) = watch::channel(false);
                    EXTRACTING.lock().unwrap().insert(video.to_path_buf(), rx.clone());
                    let v = video.to_path_buf();
                    tokio::spawn(async move {
                        extract_embedded(bin, v.clone()).await;
                        EXTRACTING.lock().unwrap().remove(&v);
                        let _ = tx.send(true);
                    });
                    rx
                });
                if wait {
                    let mut rx = rx;
                    while !*rx.borrow() {
                        if rx.changed().await.is_err() {
                            break;
                        }
                    }
                    list = list_srt(video).await;
                }
            }
        }
    }
    list
}

/// what WebVTT can't show: ASS override codes, and <font>, which ffmpeg adds when converting .ass
pub fn vtt_clean(text: &str) -> String {
    static ASS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{\\[^}]*\}").unwrap());
    static FONT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)</?font[^>]*>").unwrap());
    FONT.replace_all(&ASS.replace_all(text, ""), "").into_owned()
}

/// srtToVtt(): older subtitles are often Windows-1252, read as Latin-1 when they aren't UTF-8
pub fn srt_to_vtt(buf: &[u8]) -> String {
    static TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d{1,2}:\d{2}:\d{2}),(\d{3})").unwrap());
    static NL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r\n?").unwrap());
    let mut text = String::from_utf8_lossy(buf).into_owned();
    if text.contains('\u{fffd}') {
        text = buf.iter().map(|&b| b as char).collect();
    }
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text).to_string();
    let text = NL.replace_all(&text, "\n").into_owned();
    if text.starts_with("WEBVTT") {
        return vtt_clean(&text);
    }
    vtt_clean(&format!("WEBVTT\n\n{}", TIME.replace_all(&text, "$1.$2")))
}

/* ───────────── from a running conversion: one growing WebVTT file per track in the temp folder ───────────── */

pub fn tc_dir() -> PathBuf {
    std::env::temp_dir().join("ag-horizon-subs")
}
fn tc_sub_file(sid: &str, n: &str) -> PathBuf {
    tc_dir().join(format!("{sid}.{n}.vtt"))
}
pub fn ok_sid(sid: Option<&str>) -> bool {
    static SID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-z0-9]{8,40}$").unwrap());
    sid.map(|s| SID.is_match(s)).unwrap_or(false)
}

/// tcSubArgs(): ffmpeg writes these text subtitle tracks as it converts
pub fn tc_sub_args(sid: Option<&str>, tracks: &[String], start: f64) -> Vec<String> {
    if !ok_sid(sid) || tracks.is_empty() {
        return Vec::new();
    }
    let sid = sid.unwrap();
    let _ = std::fs::create_dir_all(tc_dir());
    let mut args = Vec::new();
    for n in tracks {
        args.extend(["-map".into(), format!("0:s:{n}"), "-c:s".into(), "webvtt".into(), "-flush_packets".into(), "1".into()]);
        if start != 0.0 {
            args.extend(["-output_ts_offset".into(), js_to_fixed(start, 3)]);
        }
        args.extend(["-f".into(), "webvtt".into(), tc_sub_file(sid, n).to_string_lossy().into_owned()]);
    }
    args
}

pub async fn tc_sub_text(sid: &str, n: &str) -> String {
    if !ok_sid(Some(sid)) || n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return String::new();
    }
    match tokio::fs::read(tc_sub_file(sid, n)).await {
        Ok(b) => vtt_clean(&String::from_utf8_lossy(&b)),
        Err(_) => String::new(),
    }
}

/// files of finished conversions stay a while (the player may still be reading them), then go
pub fn tc_sub_cleanup(sid: Option<String>) {
    let Some(sid) = sid.filter(|s| ok_sid(Some(s))) else { return };
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30 * 60)).await;
        if let Ok(mut rd) = tokio::fs::read_dir(tc_dir()).await {
            while let Ok(Some(e)) = rd.next_entry().await {
                if e.file_name().to_string_lossy().starts_with(&format!("{sid}.")) {
                    let _ = tokio::fs::remove_file(e.path()).await;
                }
            }
        }
    });
}

/// leftovers from a crash or a closed app (older than a day)
pub fn tc_sub_sweep() {
    tokio::spawn(async {
        let Ok(mut rd) = tokio::fs::read_dir(tc_dir()).await else { return };
        let old = std::time::SystemTime::now() - Duration::from_secs(24 * 3600);
        while let Ok(Some(e)) = rd.next_entry().await {
            if let Ok(m) = e.metadata().await {
                if m.modified().map(|t| t < old).unwrap_or(false) {
                    let _ = tokio::fs::remove_file(e.path()).await;
                }
            }
        }
    });
}

/// saveSrt(): an OpenSubtitles download next to the video, "<name>.<lang>.srt" (or ".<lang>.2.srt" …)
pub async fn save_srt(video: &Path, lang: &str, srt: &[u8]) -> std::io::Result<PathBuf> {
    let base = base_of(video);
    let mut file = PathBuf::from(format!("{base}.{lang}.srt"));
    let mut k = 2;
    while file.exists() {
        file = PathBuf::from(format!("{base}.{lang}.{k}.srt"));
        k += 1;
    }
    tokio::fs::write(&file, srt).await?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn languages_and_vtt() {
        assert_eq!(canon("eng"), "en");
        assert_eq!(canon("nob"), "nb");
        assert_eq!(canon("pt-BR"), "pt-br");
        assert_eq!(canon("x"), "x");
        assert_eq!(srt_to_vtt(b"\xef\xbb\xbf1\r\n00:00:01,000 --> 00:00:02,500\r\n{\\an8}<font color=\"red\">Hi</font>\r\n"), "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHi\n");
        assert_eq!(srt_to_vtt(b"1\n00:00:01,000 --> 00:00:02,000\nCaf\xe9\n"), "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nCaf\u{e9}\n");
        let s = parse_sub_streams("  Stream #0:2(eng): Subtitle: mov_text (default)\r\n  Stream #0:3(nor): Subtitle: hdmv_pgs_subtitle (forced)\n  Stream #0:4: Subtitle: subrip (hearing impaired)");
        assert_eq!(s.len(), 3);
        assert!(s[0].text && !s[1].text && s[1].forced && s[2].sdh && s[2].lang == "und");
    }
}
