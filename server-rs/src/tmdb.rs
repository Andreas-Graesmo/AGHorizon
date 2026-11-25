//! TMDB, with the app's key: /api/tmdb (runtime and cast of one title) and /api/trending (this week's most
//! popular), as server.js does. AGH_TMDB_BASE points both servers at the test suite's fake TMDB.

use crate::util::*;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::watch;

async fn get_json(url: &str) -> ApiResult<(u16, Option<Value>)> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let r = send_req(client().get(url), Duration::from_secs(15)).await?;
    let status = r.status().as_u16();
    if !r.status().is_success() {
        return Ok((status, None));
    }
    let body = read_all(r, deadline).await?;
    let j = serde_json::from_slice(&body).map_err(|e| ApiError::new(502, e.to_string()))?;
    Ok((status, Some(j)))
}

static TITLES: LazyLock<Mutex<VecDeque<(String, Value)>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));

/// GET /api/tmdb?type=movie|tv&id=… -> { runtime, poster, cast: [{ name, role, photo }] }; one request per title
pub async fn handle_tmdb(base: &str, key: &str, q: &Query) -> ApiResult<Resp> {
    if key.is_empty() {
        return Err(ApiError::new(501, "TMDB isn’t available in this build"));
    }
    let typ = if q.get("type") == Some("tv") { "tv" } else { "movie" };
    let id = q.get("id").unwrap_or("");
    if id.is_empty() || id.len() > 10 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ApiError::new(400, "Invalid id"));
    }
    let ck = format!("{typ}:{id}");
    if let Some((_, v)) = TITLES.lock().unwrap().iter().find(|(k, _)| *k == ck) {
        return Ok(send_json(200, v));
    }
    // series: aggregate_credits lists everyone across all seasons, with their character names under roles
    let credits = if typ == "tv" { "aggregate_credits" } else { "credits" };
    let (status, j) = get_json(&format!("{base}/{typ}/{id}?append_to_response={credits}&api_key={}", encode_uri_component(key))).await?;
    let Some(j) = j else { return Err(ApiError::new(if status == 404 { 404 } else { 502 }, format!("TMDB answered HTTP {status}"))) };
    let runtime_v = if typ == "tv" {
        let first = j.get("episode_run_time").and_then(|e| e.get(0)).cloned();
        js_or(first.as_ref(), j.get("last_episode_to_air").filter(|v| truthy(Some(v))).and_then(|e| e.get("runtime")).cloned().unwrap_or(Value::Null))
    } else {
        j.get("runtime").cloned().unwrap_or(Value::Null)
    };
    let runtime = { let x = js_value_number(&runtime_v); if x.is_nan() || x == 0.0 { 0.0 } else { x } };
    let cast: Vec<Value> = j
        .get(credits)
        .filter(|c| truthy(Some(c)))
        .and_then(|c| c.get("cast"))
        .filter(|c| truthy(Some(c)))
        .and_then(|c| c.as_array())
        .map(|a| a.iter().take(12).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .map(|c| {
            let role = js_or(c.get("character"), c.get("roles").and_then(|r| r.get(0)).filter(|r| truthy(Some(r))).and_then(|r| r.get("character")).filter(|v| truthy(Some(v))).cloned().unwrap_or(json!("")));
            let photo = match c.get("profile_path") {
                Some(p) if truthy(Some(p)) => json!(format!("https://image.tmdb.org/t/p/w185{}", js_string(p))),
                _ => json!(""),
            };
            json!({ "name": js_or(c.get("name"), json!("")), "role": role, "photo": photo })
        })
        .collect();
    let poster = match j.get("poster_path") {
        Some(p) if truthy(Some(p)) => json!(format!("https://image.tmdb.org/t/p/w500{}", js_string(p))),
        _ => json!(""),
    };
    let v = json!({ "runtime": js_num(runtime), "poster": poster, "cast": cast });
    let mut t = TITLES.lock().unwrap();
    t.retain(|(k, _)| *k != ck);
    t.push_back((ck, v.clone()));
    while t.len() > 200 {
        t.pop_front();
    }
    Ok(send_json(200, &v))
}

/// Number(value) for a JSON value
fn js_value_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => if *b { 1.0 } else { 0.0 },
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_number(Some(s)),
        Value::Array(a) if a.is_empty() => 0.0,
        Value::Array(a) if a.len() == 1 => js_value_number(&a[0]),
        _ => f64::NAN,
    }
}

type Trending = Result<Value, ApiError>;
struct TrendingJob {
    t: f64,
    rx: watch::Receiver<Option<Trending>>,
}
static TRENDING: LazyLock<Mutex<Option<TrendingJob>>> = LazyLock::new(|| Mutex::new(None));
const TRENDING_TTL_MS: f64 = 6.0 * 3600e3;

async fn trending_page(base: &str, key: &str, typ: &str, page: u32) -> ApiResult<Vec<Value>> {
    let (status, j) = get_json(&format!("{base}/trending/{typ}/week?page={page}&api_key={}", encode_uri_component(key))).await?;
    let Some(j) = j else { return Err(ApiError::new(502, format!("TMDB answered HTTP {status}"))) };
    let results = j.get("results").filter(|r| truthy(Some(r))).and_then(|r| r.as_array()).cloned().unwrap_or_default();
    Ok(results
        .iter()
        .map(|x| {
            let mut o = serde_json::Map::new();
            if let Some(id) = x.get("id") {
                o.insert("id".into(), id.clone());
            }
            o.insert("title".into(), js_or(x.get("title"), js_or(x.get("name"), json!(""))));
            o.insert("original".into(), js_or(x.get("original_title"), js_or(x.get("original_name"), json!(""))));
            let date = js_or(x.get("release_date"), js_or(x.get("first_air_date"), json!("")));
            o.insert("year".into(), json!(slice_utf16(&js_string(&date), 4)));
            o.insert("overview".into(), js_or(x.get("overview"), json!("")));
            o.insert(
                "backdrop".into(),
                match x.get("backdrop_path") {
                    Some(p) if truthy(Some(p)) => json!(format!("https://image.tmdb.org/t/p/w1280{}", js_string(p))),
                    _ => json!(""),
                },
            );
            Value::Object(o)
        })
        .collect())
}

/// GET /api/trending -> { movie: [...], tv: [...] }: 40 of each, kept 6 hours; a failed ask is tried again next time
pub async fn handle_trending(base: &str, key: &str) -> ApiResult<Resp> {
    if key.is_empty() {
        return Err(ApiError::new(501, "Trending isn’t available in this build"));
    }
    let mut rx = {
        let mut g = TRENDING.lock().unwrap();
        let fresh = g.as_ref().map(|j| now_ms() - j.t <= TRENDING_TTL_MS).unwrap_or(false);
        if !fresh {
            let (tx, rx) = watch::channel(None);
            *g = Some(TrendingJob { t: now_ms(), rx: rx.clone() });
            let (base, key) = (base.to_string(), key.to_string());
            tokio::spawn(async move {
                let (m1, m2, t1, t2) = tokio::join!(
                    trending_page(&base, &key, "movie", 1),
                    trending_page(&base, &key, "movie", 2),
                    trending_page(&base, &key, "tv", 1),
                    trending_page(&base, &key, "tv", 2)
                );
                let result = (|| -> Trending {
                    let (m1, m2, t1, t2) = (m1?, m2?, t1?, t2?);
                    let (movie, tv) = ([m1, m2].concat(), [t1, t2].concat());
                    Ok(json!({ "movie": movie, "tv": tv }))
                })();
                if result.is_err() {
                    *TRENDING.lock().unwrap() = None;
                }
                let _ = tx.send(Some(result));
            });
        }
        g.as_ref().unwrap().rx.clone()
    };
    loop {
        if let Some(r) = rx.borrow().clone() {
            return r.map(|v| send_json(200, &v));
        }
        if rx.changed().await.is_err() {
            return Err(ApiError::new(502, "TMDB did not answer"));
        }
    }
}
