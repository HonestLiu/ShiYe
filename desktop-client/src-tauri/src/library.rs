use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
pub type Result<T> = std::result::Result<T, String>;
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn root() -> PathBuf {
    if let Some(path) = std::env::var_os("ARCHIVE_READER_DATA_DIR") {
        return PathBuf::from(path);
    }
    let home = PathBuf::from(
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .unwrap_or_default(),
    );
    #[cfg(target_os = "macos")]
    let base = home.join("Library/Application Support");
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or(home);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = home.join(".local/share");
    base.join("io.local.archive-reader")
}
pub fn init(root: &Path) -> Result<()> {
    for dir in [root.to_owned(), root.join("items"), root.join("incoming")] {
        fs::create_dir_all(&dir).map_err(err)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(err)?;
    }
    // Abandoned transfers and render files are disposable; committed items live elsewhere.
    if let Ok(entries) = fs::read_dir(root.join("incoming")) {
        for entry in entries.flatten() {
            if entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() > 86400)
            {
                let path = entry.path();
                if path.is_dir() {
                    let _ = fs::remove_dir_all(path);
                } else {
                    let _ = fs::remove_file(path);
                }
            }
        }
    }
    let db = db(root)?;
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE,title TEXT NOT NULL,url TEXT NOT NULL,saved_at INTEGER NOT NULL,summary TEXT NOT NULL,text TEXT NOT NULL,starred INTEGER NOT NULL DEFAULT 0,read INTEGER NOT NULL DEFAULT 0,trashed INTEGER NOT NULL DEFAULT 0,folder TEXT NOT NULL DEFAULT '',tags TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',progress REAL NOT NULL DEFAULT 0);").map_err(err)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,item_id TEXT NOT NULL,filename TEXT NOT NULL,status TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',path TEXT NOT NULL DEFAULT ''); UPDATE exports SET status='failed',error='客户端在导出完成前退出，请重新提交' WHERE status='processing';").map_err(err)?;
    Ok(())
}
fn db(root: &Path) -> Result<Connection> {
    let c = Connection::open(root.join("library.sqlite3")).map_err(err)?;
    c.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(err)?;
    Ok(c)
}
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn item_dir(root: &Path, id: &str) -> Result<PathBuf> {
    Uuid::parse_str(id).map_err(err)?;
    Ok(root.join("items").join(id))
}
pub fn import(root: &Path, mut archive: Value) -> Result<Value> {
    if archive["version"].as_u64() != Some(1) {
        return Err("不支持的归档版本".into());
    }
    let html = archive["snapshot"]["html"]
        .as_str()
        .ok_or("归档缺少网页快照")?
        .to_owned();
    if html.is_empty() || html.len() > 256 * 1024 * 1024 {
        return Err("网页快照大小无效".into());
    }
    let title = archive["title"]
        .as_str()
        .unwrap_or("未命名收藏")
        .chars()
        .take(300)
        .collect::<String>();
    let url = archive["url"].as_str().unwrap_or("").to_owned();
    if !url.is_empty() && !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("无效的来源链接".into());
    }
    let text = archive["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .map(|m| m["text"].as_str().or(m["markdown"].as_str()).unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_else(|| archive["text"].as_str().unwrap_or("").to_owned());
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!([url, html, archive["messages"]])).map_err(err)?)
    );
    let c = db(root)?;
    if let Ok(id) = c.query_row("SELECT id FROM items WHERE digest=?1", [&digest], |r| {
        r.get::<_, String>(0)
    }) {
        return Ok(json!({"id":id,"duplicate":true}));
    }
    let id = Uuid::new_v4().to_string();
    let staging = root.join("incoming").join(format!("item-{id}"));
    fs::create_dir(&staging).map_err(err)?;
    archive["snapshot"]["html"] = Value::Null;
    archive["title"] = json!(title);
    fs::write(
        staging.join("archive.json"),
        serde_json::to_vec(&archive).map_err(err)?,
    )
    .map_err(err)?;
    fs::write(staging.join("snapshot.html"), html).map_err(err)?;
    let dir = item_dir(root, &id)?;
    fs::rename(&staging, &dir).map_err(err)?;
    let summary = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(160)
        .collect::<String>();
    if let Err(e) = c.execute(
        "INSERT INTO items(id,digest,title,url,saved_at,summary,text) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![id, digest, title, url, now() as i64, summary, text],
    ) {
        let _ = fs::remove_dir_all(&dir);
        return Err(err(e));
    }
    if archive["library"].is_object() {
        update(root, &id, &archive["library"])?;
    }
    Ok(json!({"id":id,"duplicate":false}))
}
pub fn list(root: &Path) -> Result<Value> {
    let c = db(root)?;
    let mut stmt=c.prepare("SELECT id,title,url,saved_at,summary,starred,read,trashed,folder,tags,notes,progress FROM items ORDER BY saved_at DESC,rowid DESC").map_err(err)?;
    let rows=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"url":r.get::<_,String>(2)?,"savedAt":r.get::<_,i64>(3)?,"summary":r.get::<_,String>(4)?,"starred":r.get::<_,bool>(5)?,"read":r.get::<_,bool>(6)?,"trashed":r.get::<_,bool>(7)?,"folder":r.get::<_,String>(8)?,"tags":r.get::<_,String>(9)?,"notes":r.get::<_,String>(10)?,"progress":r.get::<_,f64>(11)?}))).map_err(err)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map(Value::from)
        .map_err(err)
}
pub fn search(root: &Path, query: &str) -> Result<Value> {
    // Literal substring search supports Chinese without pretending unicode61 tokenizes it.
    let c = db(root)?;
    let mut stmt=c.prepare("SELECT id FROM items WHERE instr(lower(title||' '||text||' '||tags||' '||notes),lower(?1))>0").map_err(err)?;
    let rows = stmt
        .query_map([query], |r| r.get::<_, String>(0))
        .map_err(err)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map(Value::from)
        .map_err(err)
}
pub fn load(root: &Path, id: &str) -> Result<Value> {
    let dir = item_dir(root, id)?;
    let mut archive: Value =
        serde_json::from_slice(&fs::read(dir.join("archive.json")).map_err(err)?).map_err(err)?;
    archive["snapshot"]["html"] =
        json!(fs::read_to_string(dir.join("snapshot.html")).map_err(err)?);
    if let Some(meta) = list(root)?
        .as_array()
        .and_then(|a| a.iter().find(|m| m["id"] == id))
    {
        archive["library"] = meta.clone();
    }
    Ok(archive)
}
pub fn update(root: &Path, id: &str, patch: &Value) -> Result<Value> {
    item_dir(root, id)?;
    let c = db(root)?;
    for field in [
        "title", "folder", "tags", "notes", "starred", "read", "trashed", "progress", "savedAt",
    ] {
        if let Some(v) = patch.get(field) {
            let column = if field == "savedAt" {
                "saved_at"
            } else {
                field
            };
            let sql = format!("UPDATE items SET {column}=?1 WHERE id=?2");
            if ["starred", "read", "trashed"].contains(&field) {
                c.execute(&sql, params![v.as_bool().ok_or("无效的状态")?, id])
                    .map_err(err)?;
            } else if field == "savedAt" {
                let timestamp = v.as_i64().filter(|n| *n > 0).ok_or("无效的保存时间")?;
                c.execute(&sql, params![timestamp, id]).map_err(err)?;
            } else if field == "progress" {
                c.execute(
                    &sql,
                    params![v.as_f64().ok_or("无效的阅读进度")?.clamp(0., 1.), id],
                )
                .map_err(err)?;
            } else {
                let s = v.as_str().ok_or("无效的文本")?;
                if s.len() > 100_000 {
                    return Err("文本过长".into());
                }
                c.execute(&sql, params![s, id]).map_err(err)?;
            }
        }
    }
    Ok(json!({"ok":true}))
}
pub fn queue_export(root: &Path, item_id: &str, request: &Value) -> Result<Value> {
    let id = request["id"].as_str().ok_or("缺少导出请求ID")?;
    Uuid::parse_str(id).map_err(err)?;
    let filename = request["filename"].as_str().ok_or("缺少文件名")?;
    if filename.len() > 500 || filename.contains(['/', '\\', '\0']) {
        return Err("无效的PDF文件名".into());
    }
    let c = db(root)?;
    c.execute(
        "INSERT OR IGNORE INTO exports(id,item_id,filename,status) VALUES(?1,?2,?3,'queued')",
        params![id, item_id, filename],
    )
    .map_err(err)?;
    export_status(root, id)
}
pub fn export_status(root: &Path, id: &str) -> Result<Value> {
    db(root)?.query_row("SELECT id,item_id,filename,status,error,path FROM exports WHERE id=?1",[id],|r|Ok(json!({"jobId":r.get::<_,String>(0)?,"itemId":r.get::<_,String>(1)?,"filename":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"error":r.get::<_,String>(4)?,"path":r.get::<_,String>(5)?}))).map_err(err)
}
pub fn pending_exports(root: &Path) -> Result<Value> {
    let c = db(root)?;
    let mut s = c
        .prepare("SELECT id FROM exports WHERE status='queued' ORDER BY rowid")
        .map_err(err)?;
    let ids = s
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err)?;
    ids.into_iter()
        .map(|id| export_status(root, &id))
        .collect::<Result<Vec<_>>>()
        .map(Value::from)
}
pub fn claim_export(root: &Path, id: &str) -> Result<Value> {
    let changed = db(root)?
        .execute(
            "UPDATE exports SET status='processing' WHERE id=?1 AND status='queued'",
            [id],
        )
        .map_err(err)?;
    Ok(json!({"claimed":changed==1}))
}
pub fn finish_export(root: &Path, req: &Value) -> Result<Value> {
    let id = req["jobId"].as_str().ok_or("缺少任务ID")?;
    let status = req["status"].as_str().ok_or("缺少任务状态")?;
    if !["done", "failed", "cancelled"].contains(&status) {
        return Err("无效任务状态".into());
    }
    db(root)?
        .execute(
            "UPDATE exports SET status=?1,error=?2,path=?3 WHERE id=?4 AND status='processing'",
            params![
                status,
                req["error"].as_str().unwrap_or(""),
                req["path"].as_str().unwrap_or(""),
                id
            ],
        )
        .map_err(err)?;
    export_status(root, id)
}
pub fn dispatch(root: &Path, req: Value) -> Result<Value> {
    use base64::Engine;
    match req["action"].as_str().unwrap_or("") {
        "hello" => Ok(
            json!({"version":1,"name":"拾页","formats":["html","md","txt","json","pdf"],"nativePdfJobs":true,"appVersion":"0.1.1","platform":std::env::consts::OS}),
        ),
        "export_status" => export_status(root, req["jobId"].as_str().ok_or("缺少任务ID")?),
        "begin" => {
            let size = req["size"].as_u64().ok_or("缺少大小")?;
            if size == 0 || size > 256 * 1024 * 1024 {
                return Err("单次收藏不得超过256MiB".into());
            }
            let hash = req["sha256"].as_str().ok_or("缺少校验")?;
            if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("无效的校验值".into());
            }
            let upload = Uuid::new_v4().to_string();
            let path = root.join("incoming").join(&upload);
            fs::write(path.with_extension("part"), []).map_err(err)?;
            fs::write(
                path.with_extension("json"),
                serde_json::to_vec(&json!({"size":size,"sha256":hash})).map_err(err)?,
            )
            .map_err(err)?;
            Ok(json!({"upload":upload}))
        }
        "chunk" | "commit" => {
            let id = req["upload"].as_str().ok_or("缺少传输ID")?;
            Uuid::parse_str(id).map_err(err)?;
            let path = root.join("incoming").join(id);
            if req["action"] == "commit" && path.with_extension("result").exists() {
                return serde_json::from_slice(
                    &fs::read(path.with_extension("result")).map_err(err)?,
                )
                .map_err(err);
            }
            let meta: Value =
                serde_json::from_slice(&fs::read(path.with_extension("json")).map_err(err)?)
                    .map_err(err)?;
            if req["action"] == "chunk" {
                use std::io::Write;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(req["data"].as_str().ok_or("缺少数据")?)
                    .map_err(err)?;
                if bytes.len() > 512 * 1024 {
                    return Err("分块过大".into());
                }
                let length = fs::metadata(path.with_extension("part"))
                    .map_err(err)?
                    .len();
                let offset = req["offset"].as_u64().ok_or("缺少偏移")?;
                if offset != length
                    || length + bytes.len() as u64 > meta["size"].as_u64().unwrap_or(0)
                {
                    return Err("分块偏移或长度不匹配".into());
                }
                let mut f = fs::OpenOptions::new()
                    .append(true)
                    .open(path.with_extension("part"))
                    .map_err(err)?;
                f.write_all(&bytes).map_err(err)?;
                Ok(json!({"offset":length+bytes.len() as u64}))
            } else {
                let bytes = fs::read(path.with_extension("part")).map_err(err)?;
                if bytes.len() as u64 != meta["size"].as_u64().unwrap_or(0)
                    || format!("{:x}", Sha256::digest(&bytes))
                        != meta["sha256"].as_str().unwrap_or("")
                {
                    return Err("归档校验失败".into());
                }
                let archive: Value = serde_json::from_slice(&bytes).map_err(err)?;
                let export_request = archive["exportRequest"].clone();
                let mut value = import(root, archive)?;
                if export_request.is_object() {
                    let job = queue_export(root, value["id"].as_str().unwrap(), &export_request)?;
                    value["jobId"] = job["jobId"].clone();
                }
                fs::write(
                    path.with_extension("result"),
                    serde_json::to_vec(&value).map_err(err)?,
                )
                .map_err(err)?;
                let _ = fs::remove_file(path.with_extension("part"));
                let _ = fs::remove_file(path.with_extension("json"));
                Ok(value)
            }
        }
        _ => Err("未知客户端请求".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!({"version":1,"title":"计组地址划分","url":"https://chatgpt.com/c/test","source":"chatgpt","snapshot":{"html":"<!doctype html><h1>计组地址划分</h1><pre>code end</pre>","width":760},"messages":[{"id":"answer-1","role":"assistant","markdown":"# 计组地址划分\n中文正文与代码","text":"中文正文与代码"}]})
    }
    #[test]
    fn durable_library_and_transfer() {
        use base64::Engine;
        let root = std::env::temp_dir().join(format!("reader-test-{}", Uuid::new_v4()));
        init(&root).unwrap();
        let a = import(&root, fixture()).unwrap();
        let id = a["id"].as_str().unwrap();
        assert_eq!(import(&root, fixture()).unwrap()["duplicate"], true);
        assert_eq!(list(&root).unwrap().as_array().unwrap().len(), 1);
        assert_eq!(search(&root, "中文正文").unwrap()[0], id);
        assert_eq!(
            load(&root, id).unwrap()["snapshot"]["html"],
            fixture()["snapshot"]["html"]
        );
        update(&root,id,&json!({"starred":true,"read":true,"folder":"408","tags":"计组,地址","notes":"复习","progress":0.4,"savedAt":1234567890})).unwrap();
        init(&root).unwrap();
        let item = &list(&root).unwrap()[0];
        assert_eq!(item["starred"], true);
        assert_eq!(item["folder"], "408");
        assert_eq!(item["progress"], 0.4);
        assert_eq!(item["savedAt"], 1234567890);
        assert!(item_dir(&root, "../../x").is_err());
        let bytes = serde_json::to_vec(&fixture()).unwrap();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let upload = dispatch(
            &root,
            json!({"action":"begin","size":bytes.len(),"sha256":digest}),
        )
        .unwrap()["upload"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(dispatch(
            &root,
            json!({"action":"chunk","upload":upload,"offset":1,"data":"YQ=="})
        )
        .is_err());
        assert!(dispatch(&root, json!({"action":"commit","upload":upload})).is_err());
        dispatch(&root,json!({"action":"chunk","upload":upload,"offset":0,"data":base64::engine::general_purpose::STANDARD.encode(&bytes)})).unwrap();
        assert_eq!(
            dispatch(&root, json!({"action":"commit","upload":upload})).unwrap()["id"],
            id
        );
        assert_eq!(
            dispatch(&root, json!({"action":"commit","upload":upload})).unwrap()["id"],
            id
        );
        assert_eq!(list(&root).unwrap().as_array().unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn browser_pdf_queue_is_durable_and_idempotent() {
        let root = std::env::temp_dir().join(format!("reader-pdf-job-{}", Uuid::new_v4()));
        init(&root).unwrap();
        let item = import(&root, fixture()).unwrap();
        let item_id = item["id"].as_str().unwrap();
        let id = Uuid::new_v4().to_string();
        let request = json!({"id":id,"filename":"网页_20261105.pdf"});
        assert_eq!(
            queue_export(&root, item_id, &request).unwrap()["status"],
            "queued"
        );
        queue_export(&root, item_id, &request).unwrap();
        assert_eq!(pending_exports(&root).unwrap().as_array().unwrap().len(), 1);
        assert_eq!(claim_export(&root, &id).unwrap()["claimed"], true);
        assert_eq!(claim_export(&root, &id).unwrap()["claimed"], false);
        finish_export(
            &root,
            &json!({"jobId":id,"status":"done","path":"/tmp/export.pdf"}),
        )
        .unwrap();
        assert_eq!(
            export_status(&root, &id).unwrap()["path"],
            "/tmp/export.pdf"
        );
        assert_eq!(
            queue_export(&root, item_id, &request).unwrap()["status"],
            "done"
        );
        let second = Uuid::new_v4().to_string();
        queue_export(
            &root,
            item_id,
            &json!({"id":second,"filename":"cancel.pdf"}),
        )
        .unwrap();
        claim_export(&root, &second).unwrap();
        finish_export(&root, &json!({"jobId":second,"status":"cancelled"})).unwrap();
        assert_eq!(
            export_status(&root, &second).unwrap()["status"],
            "cancelled"
        );
        let interrupted = Uuid::new_v4().to_string();
        queue_export(
            &root,
            item_id,
            &json!({"id":interrupted,"filename":"interrupted.pdf"}),
        )
        .unwrap();
        claim_export(&root, &interrupted).unwrap();
        init(&root).unwrap();
        assert_eq!(
            export_status(&root, &interrupted).unwrap()["status"],
            "failed"
        );
        assert!(queue_export(
            &root,
            item_id,
            &json!({"id":Uuid::new_v4().to_string(),"filename":"../bad.pdf"})
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
