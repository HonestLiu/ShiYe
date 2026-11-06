use crate::library::{err, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
const ONLINE_MS: u64 = 20_000;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn short(v: &Value, key: &str) -> String {
    v[key]
        .as_str()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(100)
        .collect()
}
#[derive(Default)]
pub struct Monitor(Mutex<State>);
#[derive(Default)]
struct State {
    sessions: HashMap<String, Session>,
    recent: HashMap<String, u64>,
    loaded: bool,
    persisted_at: u64,
}
struct Session {
    origin: String,
    browser: String,
    version: String,
    last: u64,
    active: bool,
    check: Value,
    nonce: Option<String>,
    sent: u64,
}
fn online(s: &Session, time: u64) -> bool {
    s.active && time.saturating_sub(s.last) < ONLINE_MS
}
pub fn origins(root: &Path) -> Vec<String> {
    fs::read(root.join("origins.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
pub fn save_label(root: &Path, id: &str, label: &str) -> Result<()> {
    let p = root.join("pairing-labels.json");
    let mut v: HashMap<String, String> = fs::read(&p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    v.insert(
        id.into(),
        label.chars().filter(|c| !c.is_control()).take(80).collect(),
    );
    fs::write(p, serde_json::to_vec(&v).map_err(err)?).map_err(err)
}
fn load_history(state: &mut State, root: &Path) {
    if !state.loaded {
        state.recent = fs::read(root.join("connection-history.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        state.loaded = true;
    }
}
fn persist_history(state: &mut State, root: &Path, time: u64, force: bool) {
    if force || time.saturating_sub(state.persisted_at) > 60_000 {
        state.persisted_at = time;
        if let Ok(bytes) = serde_json::to_vec(&state.recent) {
            let temp = root.join("connection-history.tmp");
            if fs::write(&temp, bytes).is_ok() {
                let _ = fs::rename(temp, root.join("connection-history.json"));
            }
        }
    }
}
fn compatible(version: &str) -> bool {
    let mut parts = version.split('.').filter_map(|s| s.parse::<u32>().ok());
    matches!((parts.next(),parts.next()),(Some(major),Some(minor)) if major>1 || major==1&&minor>=5)
}
impl Monitor {
    pub fn receive(&self, root: &Path, r: &Value) -> Result<Value> {
        let origin = r["origin"].as_str().ok_or("缺少来源")?;
        if !origins(root).iter().any(|o| o == origin) {
            return Err("扩展未配对或已移除".into());
        }
        let mut state = self.0.lock().map_err(err)?;
        let time = now();
        let action = r["action"].as_str().unwrap_or("");
        load_history(&mut state, root);
        state.recent.insert(origin.into(), time);
        persist_history(
            &mut state,
            root,
            time,
            action == "connection_open" || action == "connection_closed",
        );
        if action == "connection_recent" {
            return Ok(json!({"ok":true}));
        }
        let id = r["sessionId"]
            .as_str()
            .filter(|s| uuid::Uuid::parse_str(s).is_ok())
            .ok_or("无效连接ID")?;
        if action == "connection_open" {
            // Bound stale session growth across repeated extension reloads.
            if state.sessions.len() >= 128 {
                let old = state
                    .sessions
                    .iter()
                    .filter(|(_, s)| !online(s, time))
                    .min_by_key(|(_, s)| s.last)
                    .map(|(id, _)| id.clone());
                if let Some(id) = old {
                    state.sessions.remove(&id);
                } else {
                    return Err("浏览器连接数量过多".into());
                }
            }
            state.sessions.insert(
                id.into(),
                Session {
                    origin: origin.into(),
                    browser: short(r, "browser"),
                    version: short(r, "version"),
                    last: time,
                    active: true,
                    check: json!({"status":"none"}),
                    nonce: None,
                    sent: 0,
                },
            );
            return Ok(json!({"ok":true,"protocol":1}));
        }
        let s = state
            .sessions
            .get_mut(id)
            .filter(|s| s.origin == origin)
            .ok_or("连接已失效，请重新连接")?;
        match action {
            "connection_heartbeat" => {
                s.last = time;
                s.active = true;
                if let Some(nonce) = &s.nonce {
                    if time.saturating_sub(s.check["requestedAt"].as_u64().unwrap_or(time)) > 15_000
                    {
                        s.check = json!({"status":"timeout","at":time});
                        s.nonce = None;
                    } else if s.sent == 0 {
                        s.sent = time;
                        return Ok(json!({"ok":true,"challenge":nonce}));
                    }
                }
            }
            "connection_pong" => {
                if s.nonce.is_none() || s.nonce.as_deref() != r["nonce"].as_str() || s.sent == 0 {
                    return Err("无效的检测响应".into());
                }
                s.last = time;
                s.check = json!({"status":"ok","at":time,"latencyMs":time.saturating_sub(s.sent)});
                s.nonce = None;
            }
            "connection_closed" => {
                s.active = false;
                s.nonce = None;
                s.check = if s.check["status"] == "pending" {
                    json!({"status":"disconnected","at":time})
                } else {
                    s.check.clone()
                };
            }
            _ => return Err("无效连接操作".into()),
        }
        Ok(json!({"ok":true}))
    }
    pub fn check(&self, id: &str) -> Result<Value> {
        let mut state = self.0.lock().map_err(err)?;
        let s = state.sessions.get_mut(id).ok_or("连接不存在")?;
        if !online(s, now()) {
            return Err("浏览器未连接，请先在插件中检查连接或导出一次".into());
        }
        let nonce = uuid::Uuid::new_v4().to_string();
        s.nonce = Some(nonce);
        s.sent = 0;
        s.check = json!({"status":"pending","requestedAt":now()});
        Ok(s.check.clone())
    }
    pub fn snapshot(&self, root: &Path) -> Result<Value> {
        let paired = origins(root);
        let labels: HashMap<String, String> = fs::read(root.join("pairing-labels.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let mut state = self.0.lock().map_err(err)?;
        load_history(&mut state, root);
        let time = now();
        for s in state.sessions.values_mut() {
            if s.check["status"] == "pending"
                && time.saturating_sub(s.check["requestedAt"].as_u64().unwrap_or(time)) > 15_000
            {
                s.check = json!({"status":"timeout","at":time});
                s.nonce = None;
            }
        }
        let rows:Vec<Value>=paired.iter().map(|origin|{let id=origin.trim_start_matches("chrome-extension://").trim_end_matches('/');let mut sessions:Vec<Value>=state.sessions.iter().filter(|(_,s)|&s.origin==origin).map(|(id,s)|json!({"id":id,"browser":s.browser,"version":s.version,"lastSeen":s.last,"online":online(s,time),"compatible":compatible(&s.version),"check":s.check})).collect();sessions.sort_by_key(|s|std::cmp::Reverse(s["lastSeen"].as_u64().unwrap_or(0)));json!({"extensionId":id,"label":labels.get(id).cloned().unwrap_or_default(),"lastSeen":state.recent.get(origin),"sessions":sessions,"registrations":crate::bridge::audit(root,id)})}).collect();
        Ok(json!({"pairings":rows,"now":time}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_ids_and_sessions() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let a = format!("chrome-extension://{}/", "a".repeat(32));
        let b = format!("chrome-extension://{}/", "b".repeat(32));
        fs::write(
            root.join("origins.json"),
            serde_json::to_vec(&vec![&a, &b]).unwrap(),
        )
        .unwrap();
        let monitor = Monitor::default();
        let x = uuid::Uuid::new_v4().to_string();
        let y = uuid::Uuid::new_v4().to_string();
        for (id, origin, browser) in [(&x, &a, "Chrome"), (&y, &b, "Edge")] {
            monitor.receive(&root,&json!({"action":"connection_open","origin":origin,"sessionId":id,"browser":browser,"version":"1.5.0"})).unwrap();
        }
        monitor.check(&x).unwrap();
        let reply = monitor
            .receive(
                &root,
                &json!({"action":"connection_heartbeat","origin":a,"sessionId":x}),
            )
            .unwrap();
        assert!(reply["challenge"].is_string());
        let duplicate = monitor
            .receive(
                &root,
                &json!({"action":"connection_heartbeat","origin":a,"sessionId":x}),
            )
            .unwrap();
        assert!(
            duplicate["challenge"].is_null(),
            "queued heartbeats must not resend the same challenge"
        );
        assert!(monitor.receive(&root,&json!({"action":"connection_pong","origin":b,"sessionId":x,"nonce":reply["challenge"]})).is_err());
        monitor.receive(&root,&json!({"action":"connection_pong","origin":a,"sessionId":x,"nonce":reply["challenge"]})).unwrap();
        assert!(monitor
            .receive(
                &root,
                &json!({"action":"connection_pong","origin":a,"sessionId":x})
            )
            .is_err());
        monitor
            .receive(
                &root,
                &json!({"action":"connection_closed","origin":a,"sessionId":x}),
            )
            .unwrap();
        let snapshot = monitor.snapshot(&root).unwrap();
        assert_eq!(snapshot["pairings"][0]["sessions"][0]["online"], false);
        assert_eq!(snapshot["pairings"][1]["sessions"][0]["online"], true);
        assert_eq!(
            snapshot["pairings"][0]["sessions"][0]["check"]["status"],
            "ok"
        );
        {
            let mut s = monitor.0.lock().unwrap();
            let a = s.sessions.get_mut(&y).unwrap();
            a.last = 0;
        }
        assert!(monitor.check(&y).is_err());
        fs::write(root.join("origins.json"), b"[]").unwrap();
        assert!(monitor
            .receive(
                &root,
                &json!({"action":"connection_heartbeat","origin":b,"sessionId":y})
            )
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
