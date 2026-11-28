//! Football fixtures from TheSportsDB: /api/fixtures?q=<team name> -> { id, name, next: [match], last: [match] },
//! match: { home, away, league, at (kick-off, ms), score ("2-1" once played, else "") }, as server.js does. The team is
//! looked up by name once (kept a week), its matches kept 6 hours. AGH_TSDB_BASE points both servers at the tests' fake.

use crate::util::*;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

static TEAMS: LazyLock<Mutex<HashMap<String, (String, String, Instant)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static MATCHES: LazyLock<Mutex<HashMap<String, (Value, Instant)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

async fn get(base: &str, key: &str, path: &str) -> ApiResult<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let r = send_req(client().get(format!("{base}/{}/{path}", encode_uri_component(key))), Duration::from_secs(15)).await?;
    if !r.status().is_success() {
        return Err(ApiError::new(502, format!("TheSportsDB answered HTTP {}", r.status().as_u16())));
    }
    let body = read_all(r, deadline).await?;
    serde_json::from_slice(&body).map_err(|e| ApiError::new(502, e.to_string()))
}

fn s(e: &Value, k: &str) -> String {
    match e.get(k) {
        Some(v) if !v.is_null() => js_string(v),
        _ => String::new(),
    }
}

/// kick-off, ms: "2026-11-28T15:00:00+00:00", "2026-11-28T15:00:00" (UTC), else the date and time apart; 0: unknown
fn time(e: &Value) -> f64 {
    static T: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?(?:\.[0-9]+)?\s*(Z|[+-][0-9]{2}:?[0-9]{2})?$").unwrap()
    });
    let st = s(e, "strTime");
    let alt = format!("{}T{}", s(e, "dateEvent"), if st.is_empty() { "00:00:00".to_string() } else { st });
    let ts = s(e, "strTimestamp");
    let Some(m) = T.captures(&ts).or_else(|| T.captures(&alt)) else { return 0.0 };
    let n = |i: usize| m.get(i).map(|x| x.as_str().parse::<i64>().unwrap_or(0)).unwrap_or(0);
    let mut t = crate::epg::date_utc(n(1), n(2) - 1, n(3), n(4), n(5), n(6));
    if let Some(z) = m.get(7).map(|z| z.as_str().replace(':', "")).filter(|z| z != "Z") {
        let sign = if z.starts_with('-') { -1.0 } else { 1.0 };
        t -= sign * (z[1..3].parse::<f64>().unwrap_or(0.0) * 60.0 + z[3..5].parse::<f64>().unwrap_or(0.0)) * 60000.0;
    }
    t
}

fn one(e: &Value) -> Value {
    let (h, a) = (s(e, "intHomeScore"), s(e, "intAwayScore"));
    json!({
        "home": s(e, "strHomeTeam"), "away": s(e, "strAwayTeam"), "league": s(e, "strLeague"), "at": js_num(time(e)),
        "score": if !h.is_empty() && !a.is_empty() { format!("{h}-{a}") } else { String::new() },
    })
}

fn list(j: &Value, k: &str) -> Vec<Value> {
    j.get(k).and_then(|v| v.as_array()).map(|a| a.iter().map(one).collect()).unwrap_or_default()
}

pub async fn handle_fixtures(base: &str, key: &str, q: &Query) -> ApiResult<Resp> {
    let name = q.get("q").unwrap_or("").trim().to_string();
    if name.is_empty() || name.encode_utf16().count() > 80 {
        return Err(ApiError::new(400, "Invalid team"));
    }
    let lk = name.to_lowercase();
    let cached = TEAMS.lock().unwrap().get(&lk).filter(|t| t.2.elapsed() < Duration::from_secs(7 * 86400)).cloned();
    let (id, tname) = match cached {
        Some((id, n, _)) => (id, n),
        None => {
            let j = get(base, key, &format!("searchteams.php?t={}", encode_uri_component(&name))).await?;
            // the men's football team of that name (or of that alternate name), else the first men's football team found
            let all: Vec<&Value> = j
                .get("teams")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter(|t| s(t, "strSport") == "Soccer" && s(t, "strGender") != "Female").collect())
                .unwrap_or_default();
            let same = |t: &Value| std::iter::once(s(t, "strTeam")).chain(s(t, "strTeamAlternate").split(',').map(String::from)).any(|n| n.trim().to_lowercase() == lk);
            let Some(t) = all.iter().copied().find(|t| same(t)).or(all.first().copied()) else { return Err(ApiError::new(404, "Team not found")) };
            let tn = s(t, "strTeam");
            let v = (s(t, "idTeam"), if tn.is_empty() { name.clone() } else { tn });
            TEAMS.lock().unwrap().insert(lk, (v.0.clone(), v.1.clone(), Instant::now()));
            v
        }
    };
    let cached = MATCHES.lock().unwrap().get(&id).filter(|m| m.1.elapsed() < Duration::from_secs(6 * 3600)).map(|m| m.0.clone());
    let m = match cached {
        Some(m) => m,
        None => {
            let (np, lp) = (format!("eventsnext.php?id={id}"), format!("eventslast.php?id={id}"));
            let (next, last) = tokio::try_join!(get(base, key, &np), get(base, key, &lp))?;
            let m = json!({ "next": list(&next, "events"), "last": list(&last, "results") });
            MATCHES.lock().unwrap().insert(id.clone(), (m.clone(), Instant::now()));
            m
        }
    };
    Ok(send_json(200, &json!({ "id": id, "name": tname, "next": m["next"], "last": m["last"] })))
}
