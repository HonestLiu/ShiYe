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
    let has_options = {
        let mut statement = db.prepare("PRAGMA table_info(exports)").map_err(err)?;
        let columns = statement
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        columns.iter().any(|name| name == "options")
    };
    if !has_options {
        db.execute_batch("ALTER TABLE exports ADD COLUMN options TEXT NOT NULL DEFAULT '{}'")
            .map_err(err)?;
    }
    let columns: Vec<String> = db
        .prepare("PRAGMA table_info(exports)")
        .map_err(err)?
        .query_map([], |r| r.get(1))
        .map_err(err)?
        .collect::<std::result::Result<_, _>>()
        .map_err(err)?;
    if !columns.iter().any(|n| n == "delivery") {
        db.execute_batch("ALTER TABLE exports ADD COLUMN delivery TEXT NOT NULL DEFAULT 'client'")
            .map_err(err)?;
    }
    db.execute_batch("CREATE TABLE IF NOT EXISTS reading_pages(url TEXT PRIMARY KEY,data TEXT NOT NULL,text TEXT NOT NULL)").map_err(err)?;
    let item_columns: Vec<String> = db.prepare("PRAGMA table_info(items)").map_err(err)?.query_map([],|r|r.get(1)).map_err(err)?.collect::<std::result::Result<_,_>>().map_err(err)?;
    if !item_columns.iter().any(|n| n=="reading_url") {db.execute_batch("ALTER TABLE items ADD COLUMN reading_url TEXT NOT NULL DEFAULT ''").map_err(err)?;}
    let addresses:Vec<(String,String)>=db.prepare("SELECT id,url FROM items WHERE reading_url=''").map_err(err)?.query_map([],|r|Ok((r.get(0)?,r.get(1)?))).map_err(err)?.collect::<std::result::Result<_,_>>().map_err(err)?;
    for(id,address)in addresses {if let Ok(key)=crate::reading::url(&address){db.execute("UPDATE items SET reading_url=?1 WHERE id=?2",params![key,id]).map_err(err)?;}}
    crate::batch::init(&db)?;crate::article_edit::init(&db)?;
    let terminal: Vec<String> = db
        .prepare(
            "SELECT id FROM exports WHERE item_id='' AND status IN ('done','failed','cancelled')",
        )
        .map_err(err)?
        .query_map([], |r| r.get(0))
        .map_err(err)?
        .collect::<std::result::Result<_, _>>()
        .map_err(err)?;
    for id in terminal {
        let _ = fs::remove_file(export_source_path(root, &id)?);
    }
    crate::deletion::recover(root)?;
    Ok(())
}
pub(crate) fn db(root: &Path) -> Result<Connection> {
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
    let editing=archive.as_object_mut().and_then(|a|a.remove("articleEditing")).unwrap_or(Value::Null);
    let html = archive["snapshot"]["html"]
        .as_str()
        .ok_or("归档缺少网页快照")?
        .to_owned();
    if html.is_empty() || html.len() > 256 * 1024 * 1024 {
        return Err("网页快照大小无效".into());
    }
    let article_html=archive["articleSnapshot"]["html"].as_str().unwrap_or("");
    if !archive["articleSnapshot"].is_null() && (article_html.is_empty() || html.len()+article_html.len()>256*1024*1024){return Err("正文版本或归档大小无效".into());}
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
    if archive["reading"].is_object(){crate::reading::preview(root,&url,&archive["reading"])?;}
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
        Sha256::digest(serde_json::to_vec(&if article_html.is_empty(){json!([url,html,archive["messages"]])}else{json!([url,html,archive["messages"],article_html])}).map_err(err)?)
    );
    let c = db(root)?;
    if let Ok(id) = c.query_row("SELECT id FROM items WHERE digest=?1", [&digest], |r| {
        r.get::<_, String>(0)
    }) {
        if archive["reading"].is_object(){crate::reading::merge(root,&url,&archive["reading"])?;}
        crate::article_edit::restore(root,&id,&editing)?;return Ok(json!({"id":id,"duplicate":true}));
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
    c.execute("UPDATE items SET reading_url=?1 WHERE id=?2",params![crate::reading::url(&url).unwrap_or_default(),id]).map_err(err)?;
    if archive["library"].is_object() {
        update_only(root, &id, &archive["library"])?;
    }
    if archive["reading"].is_object(){let record=match crate::reading::merge(root,&url,&archive["reading"]){Ok(v)=>v,Err(e)=>{let _=c.execute("DELETE FROM items WHERE id=?1",[&id]);let _=fs::remove_dir_all(&dir);return Err(e);}};let mut patch=json!({});if record["meta"]["updatedAt"].as_u64().unwrap_or(0)>0 {for field in ["folder","tags","starred","read"]{patch[field]=record["meta"][field].clone();}}if record["note"]["updatedAt"].as_u64().unwrap_or(0)>0{patch["notes"]=record["note"]["text"].clone();}update_only(root,&id,&patch)?;}
    if let Err(e)=crate::article_edit::restore(root,&id,&editing){let _=c.execute("DELETE FROM items WHERE id=?1",[&id]);let _=fs::remove_dir_all(&dir);return Err(e);}
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
    let mut stmt=c.prepare("SELECT items.id FROM items LEFT JOIN reading_pages ON items.reading_url=reading_pages.url WHERE instr(lower(title||' '||items.text||' '||tags||' '||notes||' '||coalesce(reading_pages.text,'')||' '||coalesce((SELECT json_extract(document,'$.text') FROM article_documents WHERE item_id=items.id),'')),lower(?1))>0").map_err(err)?;
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
    if crate::reading::url(archive["url"].as_str().unwrap_or("")).is_ok(){let mut record=crate::reading::get(root,archive["url"].as_str().unwrap())?;if record["note"]["updatedAt"]==0&&archive["library"]["notes"].as_str().is_some_and(|s|!s.is_empty()&&s.encode_utf16().count()<=100000){record["note"]=json!({"text":archive["library"]["notes"],"updatedAt":1,"mutationId":"legacy"});}archive["reading"]=record;}
    archive["articleEdit"]=crate::article_edit::metadata(root,id)?;
    Ok(archive)
}
pub fn update(root: &Path, id: &str, patch: &Value) -> Result<Value> {
    for(field,max)in [("title",300),("folder",100),("tags",500),("notes",100000)]{if let Some(v)=patch.get(field){if !v.as_str().is_some_and(|s|s.encode_utf16().count()<=max){return Err("整理字段无效或过长".into());}}}
    let result=update_only(root,id,patch)?;
    if ["title","folder","tags","starred","read","notes"].iter().any(|k|patch.get(k).is_some()) {
        let address: String=db(root)?.query_row("SELECT url FROM items WHERE id=?1",[id],|r|r.get(0)).map_err(err)?;
        if crate::reading::url(&address).is_ok(){let mut record=crate::reading::get(root,&address)?;let current=record["meta"]["updatedAt"].as_u64().unwrap_or(0).max(record["note"]["updatedAt"].as_u64().unwrap_or(0));let now=SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;let stamp=now.max(current+1);let mutation=Uuid::new_v4().to_string();
        if let Some(note)=patch.get("notes"){record["note"]=json!({"text":note,"updatedAt":stamp,"mutationId":mutation});}
        if ["title","folder","tags","starred","read"].iter().any(|k|patch.get(k).is_some()){for field in ["title","folder","tags","starred","read"]{if let Some(v)=patch.get(field){record["meta"][field]=v.clone();}}record["meta"]["updatedAt"]=json!(stamp);record["meta"]["mutationId"]=json!(mutation);}
        crate::reading::merge(root,&address,&record)?;}
    }Ok(result)
}
fn update_only(root: &Path, id: &str, patch: &Value) -> Result<Value> {
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
        "INSERT OR IGNORE INTO exports(id,item_id,filename,status,options,delivery) VALUES(?1,?2,?3,'queued',?4,?5)",
        params![id, item_id, filename,serde_json::to_string(request.get("options").unwrap_or(&json!({}))).map_err(err)?,if request["browserDownload"]==true&&crate::service::settings(root)["browserDownload"]==true {"browser"}else{"client"}],
    )
    .map_err(err)?;
    export_status(root, id)
}
pub(crate) fn export_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(
        json!({"jobId":r.get::<_,String>(0)?,"itemId":r.get::<_,String>(1)?,"filename":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"error":r.get::<_,String>(4)?,"path":r.get::<_,String>(5)?,"options":serde_json::from_str::<Value>(&r.get::<_,String>(6)?).unwrap_or(json!({})),"delivery":r.get::<_,String>(7)?,"format":r.get::<_,String>(8)?,"batchId":r.get::<_,String>(9)?}),
    )
}
pub(crate) const EXPORT_FIELDS: &str =
    "id,item_id,filename,status,error,path,options,delivery,format,batch_id";
pub fn export_status(root: &Path, id: &str) -> Result<Value> {
    db(root)?
        .query_row(
            &format!("SELECT {EXPORT_FIELDS} FROM exports WHERE id=?1"),
            [id],
            export_row,
        )
        .map_err(err)
}

pub fn pending_exports(root: &Path) -> Result<Value> {
    let c = db(root)?;
    let mut s = c
        .prepare("SELECT id FROM exports WHERE status='queued' ORDER BY rowid LIMIT 1")
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
    let cancelled = crate::batch::is_cancelled(root, id)?;
    let status = if cancelled { "cancelled" } else { status };
    if cancelled
        && export_status(root, id)?["status"] == "processing"
        && crate::batch::owns_output(root, id)?
    {
        let job = export_status(root, id)?;
        if let Some(path) = job["path"].as_str().filter(|s| !s.is_empty()) {
            let _ = fs::remove_file(path);
        }
    }
    db(root)?
        .execute(
            "UPDATE exports SET status=?1,error=?2,output_owned=CASE WHEN ?1='cancelled' THEN 0 ELSE output_owned END,path=CASE WHEN ?3='' THEN path ELSE ?3 END WHERE id=?4 AND status='processing'",
            params![
                status,
                req["error"].as_str().unwrap_or(""),
                req["path"].as_str().unwrap_or(""),
                id
            ],
        )
        .map_err(err)?;
    let result = export_status(root, id)?;
    if result["itemId"] == ""
        && ["done", "failed", "cancelled"].contains(&result["status"].as_str().unwrap_or(""))
    {
        let _ = fs::remove_file(export_source_path(root, id)?);
    }
    Ok(result)
}
pub fn browser_export_path(root: &Path, id: &str) -> Result<PathBuf> {
    Uuid::parse_str(id).map_err(err)?;
    Ok(root.join("incoming").join(format!("browser-{id}.pdf")))
}
pub fn export_chunk(root: &Path, req: &Value) -> Result<Value> {
    use base64::Engine;
    use std::io::{Read, Seek, SeekFrom};
    let id = req["jobId"].as_str().ok_or("缺少任务ID")?;
    let job = export_status(root, id)?;
    if job["delivery"] != "browser" || job["status"] != "done" {
        return Err("此任务没有可下载的PDF".into());
    }
    let mut file = fs::File::open(browser_export_path(root, id)?).map_err(err)?;
    let size = file.metadata().map_err(err)?.len();
    if size == 0 || size > 256 * 1024 * 1024 {
        return Err("PDF文件大小超出范围".into());
    }
    let offset = req["offset"].as_u64().ok_or("缺少下载偏移")?;
    if offset > size {
        return Err("无效下载偏移".into());
    }
    file.seek(SeekFrom::Start(offset)).map_err(err)?;
    let mut bytes = vec![0; (384 * 1024).min((size - offset) as usize)];
    file.read_exact(&mut bytes).map_err(err)?;
    Ok(
        json!({"offset":offset,"size":size,"length":bytes.len(),"data":base64::engine::general_purpose::STANDARD.encode(bytes)}),
    )
}
fn export_source_path(root: &Path, id: &str) -> Result<PathBuf> {
    Uuid::parse_str(id).map_err(err)?;
    Ok(root
        .join("incoming")
        .join(format!("export-source-{id}.json")))
}
pub fn load_export(root: &Path, id: &str) -> Result<Value> {
    let job = export_status(root, id)?;
    if job["itemId"] == "" {
        serde_json::from_slice(&fs::read(export_source_path(root, id)?).map_err(err)?).map_err(err)
    } else {
        load(root, job["itemId"].as_str().ok_or("任务缺少收藏ID")?)
    }
}
fn queue_pdf_only(root: &Path, archive: &Value, request: &Value) -> Result<Value> {
    let id = request["id"].as_str().ok_or("缺少任务ID")?;
    let path = export_source_path(root, id)?;
    if let Ok(job) = export_status(root, id) {
        if job["itemId"] != "" {
            return Err("任务保存方式冲突".into());
        }
        return Ok(job);
    }
    if archive["version"] != 1
        || archive["snapshot"]["html"]
            .as_str()
            .is_none_or(|h| h.is_empty() || h.len() > 256 * 1024 * 1024)
    {
        return Err("无效的PDF网页快照".into());
    }
    fs::write(&path, serde_json::to_vec(archive).map_err(err)?).map_err(err)?;
    match queue_export(root, "", request) {
        Ok(v) => Ok(v),
        Err(e) => {
            let _ = fs::remove_file(path);
            Err(e)
        }
    }
}
pub fn dispatch(root: &Path, req: Value) -> Result<Value> {
    use base64::Engine;
    match req["action"].as_str().unwrap_or("") {
        "hello" => Ok(
            json!({"version":1,"name":"拾页","formats":["html","md","txt","json","pdf"],"nativePdfJobs":true,"browserPdfDownload":true,"pdfOnly":true,"appVersion":"0.16.8","offlineWebPagesVersion":1,"readingAnnotationsVersion":1,"webSnapshotLayoutVersion":2,"articleCaptureVersion":1,"dualWebCaptureVersion":1,"connectionMonitorVersion":1,"pdfOptionsVersion":1,"platform":std::env::consts::OS}),
        ),
        "reading_get"=>crate::reading::get(root,req["url"].as_str().ok_or("缺少笔记来源")?),
        "reading_merge"=>crate::reading::merge(root,req["url"].as_str().ok_or("缺少笔记来源")?,&req["record"]),
        "export_status" => export_status(root, req["jobId"].as_str().ok_or("缺少任务ID")?),
        "export_chunk" => export_chunk(root, &req),
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
        "abort" => {
            let id=req["upload"].as_str().ok_or("缺少传输ID")?;Uuid::parse_str(id).map_err(err)?;let path=root.join("incoming").join(id);
            if path.with_extension("result").exists(){return Ok(json!({"committed":true}));}
            for ext in ["part","json"]{match fs::remove_file(path.with_extension(ext)){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::NotFound=>{},Err(e)=>return Err(err(e))}}
            Ok(json!({"aborted":true}))
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
                let value = if export_request.is_object()
                    && export_request["saveToLibrary"] == false
                {
                    let job = queue_pdf_only(root, &archive, &export_request)?;
                    json!({"jobId":job["jobId"],"delivery":job["delivery"],"savedToLibrary":false})
                } else {
                    let mut value = import(root, archive)?;
                    if export_request.is_object() {
                        let job =
                            queue_export(root, value["id"].as_str().unwrap(), &export_request)?;
                        value["jobId"] = job["jobId"].clone();
                        value["delivery"] = job["delivery"].clone();
                        value["savedToLibrary"] = json!(true);
                    }
                    value
                };
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
    fn dual_versions_roundtrip_and_dedup() {
        let root=std::env::temp_dir().join(format!("reader-dual-{}",Uuid::new_v4()));init(&root).unwrap();
        let mut archive=fixture();archive["source"]=json!("webpage");archive["articleSnapshot"]=json!({"html":"<h1>ARTICLE_VERSION</h1>","mode":"article"});
        let result=import(&root,archive.clone()).unwrap();let id=result["id"].as_str().unwrap();init(&root).unwrap();
        let stored=load(&root,id).unwrap();assert_eq!(stored["snapshot"]["html"],archive["snapshot"]["html"]);assert_eq!(stored["articleSnapshot"],archive["articleSnapshot"]);
        let json=export_contents(&stored,"json",&Value::Null,&Value::Null).unwrap();assert_eq!(serde_json::from_str::<Value>(&json).unwrap()["articleSnapshot"],archive["articleSnapshot"]);
        assert_eq!(import(&root,archive.clone()).unwrap()["duplicate"],true);
        archive["articleSnapshot"]["html"]=json!("<h1>UPDATED_ARTICLE</h1>");assert_ne!(import(&root,archive.clone()).unwrap()["id"],result["id"]);
        archive["articleSnapshot"]["html"]=json!("");assert!(import(&root,archive).is_err());
        let mut failed=fixture();failed["articleError"]=json!("not an article");assert!(import(&root,failed).is_ok());fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancelled_upload_removes_only_uncommitted_parts() {
        use base64::Engine;
        let root=std::env::temp_dir().join(format!("reader-abort-{}",Uuid::new_v4()));init(&root).unwrap();
        let bytes=serde_json::to_vec(&fixture()).unwrap();
        let begin=||dispatch(&root,json!({"action":"begin","size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes))})).unwrap()["upload"].as_str().unwrap().to_owned();
        let id=begin();dispatch(&root,json!({"action":"chunk","upload":id,"offset":0,"data":base64::engine::general_purpose::STANDARD.encode(&bytes[..10])})).unwrap();
        dispatch(&root,json!({"action":"abort","upload":id})).unwrap();
        assert!(!root.join("incoming").join(format!("{id}.part")).exists());assert!(!root.join("incoming").join(format!("{id}.json")).exists());assert!(list(&root).unwrap().as_array().unwrap().is_empty());assert!(dispatch(&root,json!({"action":"commit","upload":id})).is_err());
        let id=begin();dispatch(&root,json!({"action":"chunk","upload":id,"offset":0,"data":base64::engine::general_purpose::STANDARD.encode(&bytes)})).unwrap();dispatch(&root,json!({"action":"commit","upload":id})).unwrap();assert_eq!(dispatch(&root,json!({"action":"abort","upload":id})).unwrap()["committed"],true);assert_eq!(list(&root).unwrap().as_array().unwrap().len(),1);assert!(dispatch(&root,json!({"action":"abort","upload":"../../invalid"})).is_err());fs::remove_dir_all(root).unwrap();
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
        let request = json!({"id":id,"filename":"网页_20261105.pdf","options":{"pageSize":"a5","outline":false,"toc":true}});
        assert_eq!(
            queue_export(&root, item_id, &request).unwrap()["status"],
            "queued"
        );
        assert_eq!(export_status(&root, &id).unwrap()["options"]["toc"], true);
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
    #[test]
    fn browser_download_settings_chunks_and_legacy_delivery() {
        use base64::Engine;
        let root = std::env::temp_dir().join(format!("reader-download-{}", Uuid::new_v4()));
        init(&root).unwrap();
        assert_eq!(crate::service::settings(&root)["lightweight"], true);
        let item = import(&root, fixture()).unwrap();
        let item = item["id"].as_str().unwrap();
        let id = Uuid::new_v4().to_string();
        let job = queue_export(
            &root,
            item,
            &json!({"id":id,"filename":"test.pdf","browserDownload":true}),
        )
        .unwrap();
        assert_eq!(job["delivery"], "browser");
        assert!(export_chunk(&root, &json!({"jobId":id,"offset":0})).is_err());
        let mut bytes = b"%PDF-1.7\n".to_vec();
        bytes.extend((0..950000).map(|i| (i % 251) as u8));
        fs::write(browser_export_path(&root, &id).unwrap(), &bytes).unwrap();
        claim_export(&root, &id).unwrap();
        finish_export(&root, &json!({"jobId":id,"status":"done"})).unwrap();
        let mut copied = Vec::new();
        while copied.len() < bytes.len() {
            let p = export_chunk(&root, &json!({"jobId":id,"offset":copied.len()})).unwrap();
            assert!(serde_json::to_vec(&p).unwrap().len() < 1024 * 1024);
            copied.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(p["data"].as_str().unwrap())
                    .unwrap(),
            );
        }
        assert_eq!(copied, bytes);
        assert!(export_chunk(&root, &json!({"jobId":id,"offset":bytes.len()+1})).is_err());
        assert!(browser_export_path(&root, "../secret").is_err());
        crate::service::save_settings(&root, &json!({"lightweight":false,"browserDownload":false}))
            .unwrap();
        assert_eq!(crate::service::settings(&root)["browserDownload"], false);
        let next = queue_export(
            &root,
            item,
            &json!({"id":Uuid::new_v4().to_string(),"filename":"next.pdf","browserDownload":true}),
        )
        .unwrap();
        assert_eq!(next["delivery"], "client");
        assert_eq!(export_status(&root, &id).unwrap()["delivery"], "browser");
        crate::service::save_settings(&root, &json!({"lightweight":true,"browserDownload":true}))
            .unwrap();
        let legacy = queue_export(
            &root,
            item,
            &json!({"id":Uuid::new_v4().to_string(),"filename":"old.pdf"}),
        )
        .unwrap();
        assert_eq!(legacy["delivery"], "client");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn pdf_only_never_imports_and_cleans_temporary_source() {
        use base64::Engine;
        let root = std::env::temp_dir().join(format!("reader-pdf-only-{}", Uuid::new_v4()));
        init(&root).unwrap();
        for status in ["done", "cancelled", "failed", "interrupted"] {
            let id = Uuid::new_v4().to_string();
            let mut archive = fixture();
            archive["exportRequest"] =
                json!({"id":id,"filename":"only.pdf","saveToLibrary":false,"browserDownload":true});
            let bytes = serde_json::to_vec(&archive).unwrap();
            let upload=dispatch(&root,json!({"action":"begin","size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes))})).unwrap()["upload"].as_str().unwrap().to_owned();
            dispatch(&root,json!({"action":"chunk","upload":upload,"offset":0,"data":base64::engine::general_purpose::STANDARD.encode(bytes)})).unwrap();
            let result = dispatch(&root, json!({"action":"commit","upload":upload})).unwrap();
            assert_eq!(result["savedToLibrary"], false);
            assert!(result.get("id").is_none());
            assert_eq!(export_status(&root, &id).unwrap()["itemId"], "");
            assert_eq!(
                load_export(&root, &id).unwrap()["snapshot"],
                archive["snapshot"]
            );
            assert!(list(&root).unwrap().as_array().unwrap().is_empty());
            assert_eq!(fs::read_dir(root.join("items")).unwrap().count(), 0);
            claim_export(&root, &id).unwrap();
            if status == "interrupted" {
                init(&root).unwrap();
            } else {
                finish_export(&root, &json!({"jobId":id,"status":status})).unwrap();
            }
            assert!(!export_source_path(&root, &id).unwrap().exists());
            assert_eq!(
                dispatch(&root, json!({"action":"commit","upload":upload})).unwrap(),
                result
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}

pub fn export_contents(
    archive: &Value,
    format: &str,
    html: &Value,
    plain_text: &Value,
) -> Result<String> {
    let data = match format {
        "json" => serde_json::to_string_pretty(&archive).map_err(err)?,
        "html" => html.as_str().ok_or("缺少清理后的网页")?.to_owned(),
        "md" | "txt" => {
            let mut text = format!(
                "# {}\n\n{}\n\n",
                archive["library"]["title"]
                    .as_str()
                    .or(archive["title"].as_str())
                    .unwrap_or("收藏"),
                archive["url"].as_str().unwrap_or("")
            );
            if let Some(messages) = archive["messages"].as_array() {
                for m in messages {
                    let content = if format == "md" {
                        m["markdown"].as_str()
                    } else {
                        m["text"].as_str().or(m["markdown"].as_str())
                    };
                    text.push_str(&format!(
                        "## {}\n\n{}\n\n",
                        if m["role"] == "user" {
                            "用户"
                        } else {
                            "助手"
                        },
                        content.unwrap_or("")
                    ));
                }
            } else {
                text.push_str(plain_text.as_str().unwrap_or(""));
            }
            if archive["reading"].is_object() && (archive["reading"]["note"]["text"].as_str().is_some_and(|s|!s.is_empty()) || archive["reading"]["annotations"].as_array().is_some_and(|a|!a.is_empty())){text.push_str("\n\n---\n\n");text.push_str(&crate::reading::markdown(&archive["reading"])?);}
            text
        }
        _ => return Err("不支持的格式".into()),
    };
    Ok(data)
}
