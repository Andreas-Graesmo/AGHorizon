//! /api/shared and /api/shared/stats: several Multi view pictures from one playlist take turns on ONE provider
//! connection (experimental, Settings › Playback), as server.js does it.
//!
//! A fresh connection to a live MPEG-TS channel opens with a burst: what the provider has buffered, often 10–25 s,
//! sent as fast as the line allows. A picture takes its burst, hands the connection to the next picture and plays
//! what it got meanwhile. Every new connection sends part of what the picture already has once more; that overlap
//! is dropped (TsStitcher), so the player gets one unbroken stream per picture.

use crate::util::*;
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{BodyExt, StreamBody};
use hyper::body::Frame;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, Notify};

/// seconds before a picture is worth another visit (AGH_SHARE_REVISIT: shorter, for the test suite only)
fn revisit() -> f64 {
    static R: LazyLock<f64> = LazyLock::new(|| {
        let x = js_number(std::env::var("AGH_SHARE_REVISIT").ok().as_deref());
        if x == 0.0 || x.is_nan() { 3.0 } else { x }
    });
    *R
}
const VISIT_MAX: f64 = 4.0; // seconds a visit may last while another picture waits

fn now() -> f64 {
    static T0: LazyLock<Instant> = LazyLock::new(Instant::now);
    T0.elapsed().as_secs_f64()
}

/* ───────────── joining one connection's packets to the next ───────────── */

const HZ: i64 = 27_000_000;

/// The clock (PCR) of the 188-byte packet at o, in 27 MHz ticks; None when it carries none.
pub fn ts_pcr(b: &[u8], o: usize) -> Option<i64> {
    if b[o + 3] & 0x20 == 0 || b[o + 4] < 7 || b[o + 5] & 0x10 == 0 {
        return None;
    }
    let base = u32::from_be_bytes([b[o + 6], b[o + 7], b[o + 8], b[o + 9]]) as i64 * 2 + (b[o + 10] >> 7) as i64;
    Some(base * 300 + ((((b[o + 10] & 1) as i64) << 8) | b[o + 11] as i64))
}

#[derive(Default, Clone, Debug, PartialEq)]
pub struct StitchStats {
    pub first: Option<f64>,
    pub end: Option<f64>,
    pub from: Option<f64>,
    pub to: Option<f64>,
    pub joins: u64,
    pub rough: u64,
    pub missing: f64,
}

/// tsStitcher(): forwarding always stops just before a packet that carries a PCR, and picks up at the packet with
/// that very PCR in the next connection: the provider sends the same bytes again, so the join is exact. A provider
/// that builds the stream anew per connection is joined at the first PCR past the old end ("rough").
pub struct TsStitcher {
    carry: Vec<u8>,
    pid: Option<u32>,
    held: Vec<Vec<u8>>,
    held_pcr: Option<i64>,
    resume: Option<i64>,
    fresh: bool,
    pub st: StitchStats,
}

impl Default for TsStitcher {
    fn default() -> Self {
        TsStitcher { carry: Vec::new(), pid: None, held: Vec::new(), held_pcr: None, resume: None, fresh: true, st: StitchStats::default() }
    }
}

impl TsStitcher {
    /// Returns what may be forwarded now.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        let mut b = std::mem::take(&mut self.carry);
        b.extend_from_slice(chunk);
        let mut out: Vec<u8> = Vec::new();
        let mut o = 0;
        while o + 188 <= b.len() {
            if b[o] != 0x47 || (o + 188 < b.len() && b[o + 188] != 0x47) {
                o += 1; // not on a packet edge
                continue;
            }
            let at = o;
            o += 188;
            let id = (((b[at + 1] & 0x1f) as u32) << 8) | b[at + 2] as u32;
            let pcr = if self.pid.is_none() || self.pid == Some(id) { ts_pcr(&b, at) } else { None };
            let Some(pcr) = pcr else {
                if self.resume.is_none() || self.fresh {
                    self.held.push(b[at..o].to_vec());
                }
                continue;
            };
            self.pid = Some(id);
            let opening = self.fresh;
            self.fresh = false;
            if opening {
                self.st.from = Some(pcr as f64 / HZ as f64);
            }
            self.st.to = Some(pcr as f64 / HZ as f64);
            if let Some(resume) = self.resume {
                let ahead = pcr - resume;
                if ahead < 0 && ahead > -120 * HZ {
                    self.held.clear(); // still what the picture already has
                    continue;
                }
                if ahead == 0 {
                    self.st.joins += 1; // the very packet forwarding stopped before
                    self.held.clear();
                } else if opening && ahead > 0 && ahead < 120 * HZ {
                    self.st.missing += ahead as f64 / HZ as f64; // the provider no longer reaches back that far: keep its opening packets
                } else {
                    self.st.rough += 1;
                    if !opening {
                        self.held.clear();
                    }
                }
                self.resume = None;
            }
            for p in self.held.drain(..) {
                out.extend_from_slice(&p);
            }
            self.held.push(b[at..o].to_vec());
            self.held_pcr = Some(pcr);
            self.st.end = Some(pcr as f64 / HZ as f64);
            if self.st.first.is_none() {
                self.st.first = self.st.end;
            }
        }
        self.carry = b[o..].to_vec();
        out
    }

    /// The connection is closing. What is held was not forwarded; the next connection brings it again.
    pub fn cut(&mut self) {
        if self.held_pcr.is_some() {
            self.resume = self.held_pcr;
        }
        self.held.clear();
        self.held_pcr = None;
        self.carry.clear();
        self.fresh = true;
        self.st.from = None;
        self.st.to = None;
    }
}

/* ───────────── the pictures on one connection, and whose turn it is ───────────── */

struct Picture {
    url: url::Url,
    ua: String,
    last: f64, // when its latest visit ended
    t: Option<f64>, // the playback clock: None until its first data
    played: f64,
    depth: f64, // seconds its last burst held
    errors: u32,
    visits: u64,
    stitch: TsStitcher,
    /// to the player; None once it has gone
    tx: Option<mpsc::UnboundedSender<Bytes>>,
    queued: Arc<AtomicUsize>,
    /// until its answer has started: the error, if it gets one before any data
    first: Option<oneshot::Sender<Result<(), ApiError>>>,
}

type Member = Arc<Mutex<Picture>>;

struct Group {
    members: Vec<Member>,
    cur: Option<Member>,
    abort: Option<Arc<Notify>>,
    connects: u64,
}

static GROUPS: LazyLock<Mutex<Vec<(String, Arc<Mutex<Group>>)>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn avail(p: &Picture) -> f64 {
    match (p.stitch.st.first, p.stitch.st.end) {
        (Some(f), Some(e)) => e - f - p.stitch.st.missing,
        _ => 0.0,
    }
}
/// the picture plays in real time from its first data on, as far as what it has reaches
fn reserve(p: &mut Picture) -> f64 {
    let Some(t) = p.t else { return 0.0 };
    let n = now();
    p.played = avail(p).min(p.played + n - t);
    p.t = Some(n);
    avail(p) - p.played
}
/// seconds until the picture is in trouble: it runs dry, or the provider's buffer no longer reaches back to what it
/// holds. A picture that has not started goes first, unless it keeps failing.
fn need(p: &mut Picture) -> f64 {
    if p.t.is_none() {
        return p.errors as f64 - 1.0;
    }
    reserve(p).min(0.6 * p.depth - (now() - p.last))
}

/// writes to the player; the first data starts its answer and its playback clock
fn write(p: &mut Picture, buf: Vec<u8>) {
    if buf.is_empty() {
        return;
    }
    let Some(tx) = &p.tx else { return };
    if let Some(first) = p.first.take() {
        let _ = first.send(Ok(()));
    }
    if p.t.is_none() {
        p.t = Some(now());
    }
    let n = buf.len();
    if tx.send(Bytes::from(buf)).is_err() {
        p.tx = None;
        return;
    }
    // the reader takes a burst in its own time; one that has stopped reading altogether must not fill the memory
    if p.queued.fetch_add(n, Ordering::SeqCst) + n > 256 * 1024 * 1024 {
        p.tx = None;
    }
}

enum VisitEnd {
    Ok,
    Err(ApiError, bool), // bool: final (no point trying again)
}

/// One turn on the connection for picture m.
async fn visit(g: &Arc<Mutex<Group>>, m: &Member) -> VisitEnd {
    let abort = Arc::new(Notify::new());
    let aborted = Arc::new(AtomicBool::new(false));
    let (url, ua) = {
        let mut gg = g.lock().unwrap();
        gg.abort = Some(abort.clone());
        gg.cur = Some(m.clone());
        gg.connects += 1;
        let mut p = m.lock().unwrap();
        p.visits += 1;
        (p.url.clone(), p.ua.clone())
    };
    let t0 = now();
    // what the watch below and the reading share
    struct Run {
        first_data: Option<f64>,
        last_data: Option<f64>,
        begun: bool,
        slow: bool,
        depth_known: bool,
        dead: Option<ApiError>,
        mark: (f64, f64),
    }
    let run = Arc::new(Mutex::new(Run { first_data: None, last_data: None, begun: false, slow: false, depth_known: false, dead: None, mark: (0.0, 0.0) }));
    let sent = |p: &Picture| match (p.stitch.st.from, p.stitch.st.to) {
        (Some(f), Some(t)) => t - f,
        _ => 0.0,
    };
    let stop = {
        let (abort, aborted) = (abort.clone(), aborted.clone());
        move || {
            aborted.store(true, Ordering::SeqCst);
            abort.notify_waiters();
            abort.notify_one();
        }
    };

    let watch = {
        let (g, m, run, stop) = (g.clone(), m.clone(), run.clone(), stop.clone());
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_millis(100));
            iv.tick().await;
            loop {
                iv.tick().await;
                let n = now();
                let mut r = run.lock().unwrap();
                let quiet = match r.last_data { None => n - t0 > 8.0, Some(l) => n - l > 10.0 };
                if quiet {
                    r.dead = Some(ApiError::new(504, "The provider took too long to respond"));
                    drop(r);
                    stop();
                    return;
                }
                let Some(last) = r.last_data else { continue };
                let over = r.begun && (r.slow || n - last > 0.3); // the burst is spent: from here on it is real time
                if over && !r.depth_known {
                    r.depth_known = true;
                    let mut p = m.lock().unwrap();
                    p.depth = sent(&p);
                }
                drop(r);
                let waiting = {
                    let gg = g.lock().unwrap();
                    gg.members.iter().any(|x| !Arc::ptr_eq(x, &m) && n - x.lock().unwrap().last >= revisit())
                };
                if waiting && (over || n - t0 > VISIT_MAX) {
                    stop(); // nobody waiting: staying costs nothing
                    return;
                }
            }
        })
    };

    let result: Result<(), (ApiError, bool)> = async {
        let req = upstream(&url, Some(&ua), None);
        let r = tokio::select! {
            r = req.send() => r.map_err(|e| (friendly(&e), false))?,
            _ = abort.notified() => return Ok(()),
        };
        let status = r.status().as_u16();
        if !r.status().is_success() {
            return Err((ApiError::new(if status == 404 { 404 } else { 502 }, format!("Stream answered HTTP {status}")), false));
        }
        let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
        if ct.contains("mpegurl") || ct.starts_with("text/") {
            return Err((ApiError::new(415, "This channel has no MPEG-TS stream to share"), true));
        }
        let mut body = r.bytes_stream();
        loop {
            let chunk = tokio::select! {
                c = body.next() => c,
                _ = abort.notified() => return Ok(()),
            };
            let Some(chunk) = chunk else { break };
            let chunk = chunk.map_err(|e| (friendly(&e), false))?;
            let n = now();
            let out;
            let s_sent;
            {
                let mut p = m.lock().unwrap();
                out = p.stitch.push(&chunk);
                write(&mut p, out);
                s_sent = sent(&p);
            }
            let mut r = run.lock().unwrap();
            r.last_data = Some(n);
            if r.first_data.is_none() {
                r.first_data = Some(n);
                r.mark = (0.0, s_sent);
            }
            let wall = n - r.first_data.unwrap();
            r.begun = s_sent >= 2.0 || wall >= 1.5; // a high-bitrate burst starts slowly: don't mistake that for its end
            if wall - r.mark.0 >= 0.3 {
                r.slow = s_sent - r.mark.1 < 2.0 * (wall - r.mark.0);
                r.mark = (wall, s_sent);
            }
        }
        if run.lock().unwrap().last_data.is_none() {
            return Err((ApiError::new(502, "The stream ended without sending anything"), false));
        }
        Ok(())
    }
    .await;

    let was_aborted = aborted.load(Ordering::SeqCst); // before the clean-up below stops it anyway
    watch.abort();
    stop();
    let dead = run.lock().unwrap().dead.clone();
    let depth_known = run.lock().unwrap().depth_known;
    {
        let mut p = m.lock().unwrap();
        if !depth_known && p.stitch.st.to.is_some() {
            p.depth = sent(&p);
        }
        p.stitch.cut();
        p.last = now();
    }
    {
        let mut gg = g.lock().unwrap();
        gg.cur = None;
        gg.abort = None;
    }
    match (dead, result) {
        (Some(d), _) => VisitEnd::Err(d, false),
        (None, Err((e, fin))) if !was_aborted || fin => VisitEnd::Err(e, fin),
        _ => VisitEnd::Ok,
    }
}

async fn run_group(key: String, g: Arc<Mutex<Group>>) {
    loop {
        let members: Vec<Member> = g.lock().unwrap().members.clone();
        if members.is_empty() {
            break;
        }
        let n = now();
        let ready: Vec<Member> = members.into_iter().filter(|m| n - m.lock().unwrap().last >= revisit()).collect();
        if ready.is_empty() {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        let mut m = ready[0].clone();
        for b in &ready[1..] {
            let nb = need(&mut b.lock().unwrap());
            let na = need(&mut m.lock().unwrap());
            if nb < na {
                m = b.clone();
            }
        }
        let end = visit(&g, &m).await;
        // let the provider notice the connection is gone before the next one opens: it allows only one
        tokio::time::sleep(Duration::from_millis(100)).await;
        let VisitEnd::Err(err, fin) = end else {
            m.lock().unwrap().errors = 0;
            continue;
        };
        if !g.lock().unwrap().members.iter().any(|x| Arc::ptr_eq(x, &m)) {
            continue; // the picture was closed meanwhile
        }
        let errors = {
            let mut p = m.lock().unwrap();
            p.errors += 1;
            p.errors
        };
        if !fin && errors < 3 {
            tokio::time::sleep(Duration::from_millis(1000)).await; // don't hammer a provider that says no
            continue;
        }
        // give up: the picture falls back to a connection of its own
        g.lock().unwrap().members.retain(|x| !Arc::ptr_eq(x, &m));
        let mut p = m.lock().unwrap();
        match p.first.take() {
            Some(first) => {
                let _ = first.send(Err(err));
            }
            None => p.tx = None, // its answer had started: end it
        }
    }
    let mut groups = GROUPS.lock().unwrap();
    if let Some(i) = groups.iter().position(|(k, x)| *k == key && Arc::ptr_eq(x, &g)) {
        groups.remove(i);
    }
    for m in g.lock().unwrap().members.drain(..) {
        m.lock().unwrap().tx = None;
    }
}

struct Gone(Arc<Notify>);
impl Drop for Gone {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

/// GET /api/shared?url=…[&ua=…][&group=…]
pub async fn handle_shared(q: &Query) -> ApiResult<Resp> {
    let url = check_url(q.get("url"))?;
    let key = q.get("group").filter(|s| !s.is_empty()).map(|s| s.to_string()).unwrap_or_else(|| match url.port() {
        Some(p) => format!("{}:{p}", url.host_str().unwrap_or("")),
        None => url.host_str().unwrap_or("").to_string(),
    });
    let (tx, mut rx) = mpsc::unbounded_channel::<Bytes>();
    let (first_tx, first_rx) = oneshot::channel();
    let queued = Arc::new(AtomicUsize::new(0));
    let m: Member = Arc::new(Mutex::new(Picture {
        url,
        ua: q.get("ua").unwrap_or("").to_string(),
        last: f64::NEG_INFINITY,
        t: None,
        played: 0.0,
        depth: 0.0,
        errors: 0,
        visits: 0,
        stitch: TsStitcher::default(),
        tx: Some(tx.clone()),
        queued: queued.clone(),
        first: Some(first_tx),
    }));
    let (g, is_new) = {
        let mut groups = GROUPS.lock().unwrap();
        match groups.iter().find(|(k, _)| *k == key) {
            Some((_, g)) => (g.clone(), false),
            None => {
                let g = Arc::new(Mutex::new(Group { members: Vec::new(), cur: None, abort: None, connects: 0 }));
                groups.push((key.clone(), g.clone()));
                (g, true)
            }
        }
    };
    g.lock().unwrap().members.push(m.clone());
    // the player has gone (its request, or once started its answer, was dropped): off the connection, and its
    // visit ends now
    let gone = Arc::new(Notify::new());
    let guard = Gone(gone.clone());
    drop(tx); // the picture holds the only sender: when it lets go, the answer ends
    {
        let (g, m) = (g.clone(), m.clone());
        tokio::spawn(async move {
            gone.notified().await;
            let mut gg = g.lock().unwrap();
            gg.members.retain(|x| !Arc::ptr_eq(x, &m));
            if gg.cur.as_ref().map(|c| Arc::ptr_eq(c, &m)).unwrap_or(false) {
                if let Some(a) = &gg.abort {
                    a.notify_waiters();
                    a.notify_one();
                }
            }
        });
    }
    if is_new {
        tokio::spawn(run_group(key, g));
    }
    // the answer starts with the first data, or is the error the picture got before any
    match first_rx.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err(ApiError::new(502, "The shared connection ended")),
    }
    let body = futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx)).map(move |b| {
        let _keep = &guard; // dropped with the answer
        queued.fetch_sub(b.len(), Ordering::SeqCst);
        Ok::<_, std::io::Error>(Frame::data(b))
    });
    Ok(hyper::Response::builder()
        .status(200)
        .header("content-type", "video/mp2t")
        .header("cache-control", "no-store")
        .body(BodyExt::boxed(StreamBody::new(body)))
        .expect("valid response"))
}

/// GET /api/shared/stats: how the sharing is going (no addresses)
pub fn handle_stats() -> Resp {
    let groups = GROUPS.lock().unwrap();
    let out: Vec<Value> = groups
        .iter()
        .map(|(key, g)| {
            let g = g.lock().unwrap();
            let pictures: Vec<Value> = g
                .members
                .iter()
                .map(|m| {
                    let mut p = m.lock().unwrap();
                    let r = reserve(&mut p);
                    let s = &p.stitch.st;
                    json!({ "reserve": js_num(r), "burst": js_num(p.depth), "visits": p.visits, "errors": p.errors, "joins": s.joins, "rough": s.rough, "missing": js_num(s.missing) })
                })
                .collect();
            json!({ "group": key, "connects": g.connects, "pictures": pictures })
        })
        .collect();
    send_json(200, &Value::Array(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    // the fixtures of test/shared.test.js: every 40 ms of stream is one PCR packet and two "video" packets, each
    // saying which channel and which 40 ms it belongs to
    const STEP: f64 = 0.04;
    fn packet(pid: u16, ch: u32, n: u32, k: u8, pcr: Option<i64>) -> Vec<u8> {
        let mut p = vec![0xffu8; 188];
        p[0] = 0x47;
        p[1] = (pid >> 8) as u8;
        p[2] = (pid & 0xff) as u8;
        match pcr {
            None => p[3] = 0x10,
            Some(t) => {
                p[3] = 0x20;
                p[4] = 183;
                p[5] = 0x10;
                let (base, ext) = (t / 300, t % 300);
                p[6..10].copy_from_slice(&((base / 2) as u32).to_be_bytes());
                p[10] = (((base & 1) << 7) as u8) | 0x7e | ((ext >> 8) as u8);
                p[11] = (ext & 0xff) as u8;
            }
        }
        p[20..24].copy_from_slice(&ch.to_be_bytes());
        p[24..28].copy_from_slice(&n.to_be_bytes());
        p[28] = k;
        p
    }
    fn opening(ch: u32) -> Vec<u8> {
        packet(0, ch, 0, 9, None)
    }
    fn group(ch: u32, n: u32, shift: i64) -> Vec<u8> {
        let t = (n as f64 * STEP * 27e6).round() as i64 + shift;
        [packet(0x100, ch, n, 0, Some(t)), packet(0x101, ch, n, 1, None), packet(0x101, ch, n, 2, None)].concat()
    }
    fn groups(ch: u32, from: u32, to: u32, shift: i64) -> Vec<u8> {
        (from..=to).flat_map(|n| group(ch, n, shift)).collect()
    }
    fn stitch(pieces: &[(Vec<u8>, usize)]) -> (Vec<u8>, StitchStats) {
        let mut s = TsStitcher::default();
        let mut out = Vec::new();
        for (data, size) in pieces {
            for c in data.chunks(*size) {
                out.extend(s.push(c));
            }
            s.cut();
        }
        (out, s.st)
    }

    #[test]
    fn overlapping_connections_become_one_stream() {
        let (out, st) = stitch(&[([opening(1), groups(1, 0, 59, 0)].concat(), 1000), ([opening(1), groups(1, 40, 99, 0)].concat(), 777)]);
        assert_eq!(out, [opening(1), groups(1, 0, 98, 0)].concat());
        assert_eq!((st.joins, st.rough, st.missing), (1, 0, 0.0));
    }

    #[test]
    fn a_late_connection_is_joined_with_the_hole_counted() {
        let (out, st) = stitch(&[([opening(1), groups(1, 0, 59, 0)].concat(), 4096), ([opening(1), groups(1, 70, 99, 0)].concat(), 4096)]);
        assert_eq!(out, [opening(1), groups(1, 0, 58, 0), opening(1), groups(1, 70, 98, 0)].concat());
        assert_eq!(st.joins, 0);
        assert!((st.missing - 11.0 * STEP).abs() < 1e-6);
    }

    #[test]
    fn a_stream_built_anew_is_joined_past_the_old_end() {
        let (out, st) = stitch(&[([opening(1), groups(1, 0, 59, 0)].concat(), 4096), ([opening(1), groups(1, 40, 99, 1)].concat(), 4096)]);
        assert_eq!(out, [opening(1), groups(1, 0, 58, 0), groups(1, 59, 98, 1)].concat());
        assert_eq!((st.joins, st.rough, st.missing), (0, 1, 0.0));
    }
}
