//! OpenSubtitles.com REST API v1, as subtitles.js does: the app's key, the person's own account (sent in the body,
//! never in a URL), one login per account, logged in again once when the token has expired.
//! POST /api/subs/login | /api/subs/search | /api/subs/download

use crate::local::LocalFiles;
use crate::subtitles;
use crate::util::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

pub struct Os<'a> {
    pub base: &'a str,
    pub key: &'a str,
}

static TOKENS: LazyLock<Mutex<HashMap<Option<String>, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn ua() -> String {
    format!("AGHorizon v{}", env!("AGH_APP_VERSION")) // the consumer's name on opensubtitles.com
}

/// cfg.username as a Map key: undefined (None) is a key of its own
fn user(cfg: &Value) -> Option<String> {
    cfg.get("username").filter(|v| !v.is_null()).map(js_string)
}

impl Os<'_> {
    async fn request(&self, cfg: &Value, path: &str, method: &str, body: Option<Value>, auth: bool, retried: bool) -> ApiResult<Value> {
        if self.key.is_empty() {
            return Err(ApiError::new(501, "OpenSubtitles isn’t available in this build of AG Horizon"));
        }
        let mut req = if method == "POST" { client().post(format!("{}{path}", self.base)) } else { client().get(format!("{}{path}", self.base)) };
        req = req.header("api-key", self.key).header("user-agent", ua()).header("accept", "application/json");
        if let Some(b) = &body {
            req = req.header("content-type", "application/json").body(b.to_string());
        }
        if auth {
            let token = Box::pin(self.token(cfg)).await?;
            req = req.header("authorization", format!("Bearer {token}"));
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        let r = send_req(req, Duration::from_secs(20)).await?;
        let status = r.status().as_u16();
        let ok = r.status().is_success();
        let j: Value = read_all(r, deadline).await.ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({}));
        if status == 401 && auth && !retried {
            // token expired: log in again once
            TOKENS.lock().unwrap().remove(&user(cfg));
            return Box::pin(self.request(cfg, path, method, body, auth, true)).await;
        }
        if !ok {
            let errors = j.get("errors").and_then(|e| e.as_array()).map(|a| a.iter().map(js_string).collect::<Vec<_>>().join(", ")).unwrap_or_default();
            let msg = if truthy(j.get("message")) { js_string(&j["message"]) } else if !errors.is_empty() { errors } else { format!("HTTP {status}") };
            return Err(ApiError::new(if status == 401 || status == 403 { 401 } else { 502 }, format!("OpenSubtitles: {msg}")));
        }
        Ok(j)
    }

    async fn token(&self, cfg: &Value) -> ApiResult<String> {
        let key = user(cfg);
        if let Some(t) = TOKENS.lock().unwrap().get(&key) {
            return Ok(t.clone());
        }
        if !truthy(cfg.get("username")) || !truthy(cfg.get("password")) {
            return Err(ApiError::new(400, "Add your OpenSubtitles username and password in Settings › Subtitles"));
        }
        let body = json!({ "username": cfg["username"], "password": cfg["password"] });
        let j = self.request(cfg, "/login", "POST", Some(body), false, false).await?;
        let Some(token) = j.get("token").filter(|t| truthy(Some(t))).map(js_string) else { return Err(ApiError::new(401, "OpenSubtitles: login failed")) };
        TOKENS.lock().unwrap().insert(key, token.clone());
        Ok(token)
    }

    /// q: { tmdb_id | parent_tmdb_id + season_number + episode_number | query (+ year), languages }
    async fn search(&self, cfg: &Value, q: &Value) -> ApiResult<Value> {
        let mut params: Vec<(String, String)> = match q {
            Value::Object(o) => o.iter().filter(|(_, v)| !v.is_null() && *v != "").map(|(k, v)| (k.clone(), js_string(v).to_lowercase())).collect(),
            Value::Array(a) => a.iter().enumerate().filter(|(_, v)| !v.is_null() && **v != "").map(|(k, v)| (k.to_string(), js_string(v).to_lowercase())).collect(),
            _ => Vec::new(),
        };
        // the API wants parameters sorted and lower case (it redirects otherwise)
        params.sort_by(|a, b| if a.0 < b.0 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater });
        let qs = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(params.iter()).finish();
        let j = self.request(cfg, &format!("/subtitles?{qs}"), "GET", None, false, false).await?;
        let data = j.get("data").filter(|d| truthy(Some(d))).and_then(|d| d.as_array()).cloned().unwrap_or_default();
        let out: Vec<Value> = data
            .iter()
            .map(|s| {
                let a = s.get("attributes").filter(|a| truthy(Some(a))).cloned().unwrap_or(json!({}));
                let f = a.get("files").and_then(|f| f.get(0)).filter(|f| truthy(Some(f))).cloned().unwrap_or(json!({}));
                let mut o = serde_json::Map::new();
                if let Some(id) = f.get("file_id") {
                    o.insert("fileId".into(), id.clone());
                }
                o.insert("lang".into(), js_or(a.get("language"), json!("")));
                o.insert("release".into(), js_or(a.get("release"), js_or(f.get("file_name"), json!(""))));
                o.insert("downloads".into(), js_or(a.get("download_count"), json!(0)));
                o.insert("sdh".into(), json!(truthy(a.get("hearing_impaired"))));
                o.insert("trusted".into(), json!(truthy(a.get("from_trusted"))));
                o.insert("ai".into(), json!(truthy(a.get("ai_translated")) || truthy(a.get("machine_translated"))));
                Value::Object(o)
            })
            .filter(|s| truthy(s.get("fileId")))
            .collect();
        Ok(Value::Array(out))
    }

    async fn download(&self, cfg: &Value, file_id: Option<&Value>) -> ApiResult<(bytes::Bytes, Option<Value>)> {
        let n = match file_id {
            None | Some(Value::Null) => if file_id.is_none() { f64::NAN } else { 0.0 },
            Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
            Some(Value::String(s)) => js_number(Some(s)),
            Some(Value::Bool(b)) => if *b { 1.0 } else { 0.0 },
            Some(_) => f64::NAN,
        };
        let j = self.request(cfg, "/download", "POST", Some(json!({ "file_id": js_num(n) })), true, false).await?;
        let Some(link) = j.get("link").filter(|l| truthy(Some(l))).map(js_string) else {
            let m = if truthy(j.get("message")) { js_string(&j["message"]) } else { "no download link".into() };
            return Err(ApiError::new(502, format!("OpenSubtitles: {m}")));
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        let r = send_req(client().get(link).header("user-agent", ua()), Duration::from_secs(20)).await?;
        if !r.status().is_success() {
            return Err(ApiError::new(502, format!("OpenSubtitles: download failed (HTTP {})", r.status().as_u16())));
        }
        let srt = read_all(r, deadline).await?;
        Ok((srt, j.get("remaining").cloned())) // undefined is left out of the JSON, null kept
    }

    async fn login(&self, cfg: &Value) -> ApiResult<Value> {
        TOKENS.lock().unwrap().remove(&user(cfg));
        self.token(cfg).await?;
        let j = self.request(cfg, "/infos/user", "GET", None, true, false).await.unwrap_or(json!({})); // the quota is a bonus
        let u = j.get("data").filter(|d| truthy(Some(d))).cloned().unwrap_or(json!({}));
        let mut o = serde_json::Map::new();
        if let Some(v) = u.get("allowed_downloads") {
            o.insert("allowed".into(), v.clone());
        }
        if let Some(v) = u.get("remaining_downloads") {
            o.insert("remaining".into(), v.clone());
        }
        o.insert("level".into(), js_or(u.get("level"), json!("")));
        Ok(Value::Object(o))
    }
}

/// handleSubsApi()
pub async fn handle(os: Os<'_>, files: Option<&LocalFiles>, path: &str, body: Value) -> ApiResult<Resp> {
    let cfg_or_empty = js_or(body.get("os"), json!({}));
    match path {
        "/api/subs/login" => Ok(send_json(200, &os.login(&cfg_or_empty).await?)),
        "/api/subs/search" => {
            let cfg = body.get("os").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({}));
            Ok(send_json(200, &os.search(&cfg, &js_or(body.get("q"), json!({}))).await?))
        }
        "/api/subs/download" => {
            let cfg = body.get("os").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({}));
            let (srt, remaining) = os.download(&cfg, body.get("fileId")).await?;
            let video = match (truthy(body.get("saveFor")), files) {
                (true, Some(f)) => f(&js_string(&body["saveFor"]), "video"),
                _ => None,
            };
            if let Some(v) = &video {
                let lang: String = body.get("lang").filter(|l| truthy(Some(l))).map(js_string).unwrap_or_default().to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || *c == '-').collect();
                let lang = if lang.is_empty() { "und".to_string() } else { lang };
                subtitles::save_srt(v, &lang, &srt).await.map_err(|e| ApiError::new(502, e.to_string()))?;
            }
            let mut o = serde_json::Map::new();
            o.insert("vtt".into(), json!(subtitles::srt_to_vtt(&srt)));
            if let Some(r) = remaining {
                o.insert("remaining".into(), r);
            }
            o.insert("saved".into(), json!(video.is_some()));
            Ok(send_json(200, &Value::Object(o)))
        }
        _ => Ok(send(404, "Not found", &[])),
    }
}
