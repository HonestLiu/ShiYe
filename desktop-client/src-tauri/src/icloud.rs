//! Immutable iCloud Drive events. Local SQLite remains outside iCloud.
use crate::library::{self, err, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Emitter;
use uuid::Uuid;
pub static LOCK: Mutex<()> = Mutex::new(());
fn hash(v: &[u8]) -> String {
    format!("{:x}", Sha256::digest(v))
}
fn download(p: &Path) {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSFileManager, NSString, NSURL};
        let u = NSURL::fileURLWithPath(&NSString::from_str(&p.to_string_lossy()));
        let _ = NSFileManager::defaultManager().startDownloadingUbiquitousItemAtURL_error(&u);
    }
}
fn read(p: &Path) -> Result<Value> {
    if !p.exists() {
        download(p);
    }
    if fs::metadata(p).map_err(err)?.len() > 300 * 1024 * 1024 {
        return Err("同步文件超过300MiB".into());
    }
    serde_json::from_slice(&fs::read(p).map_err(err)?).map_err(err)
}
fn atomic(p: &Path, v: &Value) -> Result<()> {
    if serde_json::to_vec(v).map_err(err)?.len() > 300 * 1024 * 1024 {
        return Err("同步数据超过300MiB".into());
    }
    let t = p.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(&t, serde_json::to_vec(v).map_err(err)?).map_err(err)?;
    fs::rename(t, p).map_err(err)
}
fn state(root: &Path) -> Result<Value> {
    let p = root.join("icloud-state.json");
    if p.exists() {
        let v = read(&p)?;
        if !v["known"].is_object() || !v["seen"].is_object() || !v["reading"].is_object() {
            return Err("本机同步状态损坏，请保留数据并联系维护者".into());
        }
        Uuid::parse_str(v["device"].as_str().ok_or("同步设备标识缺失")?).map_err(err)?;
        Ok(v)
    } else {
        Ok(
            json!({"device":Uuid::new_v4().to_string(),"enabled":false,"clock":0,"known":{},"seen":{},"reading":{}}),
        )
    }
}
fn folder() -> Result<PathBuf> {
    let p = PathBuf::from(std::env::var_os("HOME").ok_or("无法定位用户目录")?)
        .join("Library/Mobile Documents/com~apple~CloudDocs");
    if !p.is_dir() {
        return Err("请在系统设置中登录 iCloud 并开启 iCloud Drive".into());
    }
    Ok(p.join("拾页"))
}
pub fn status(root: &Path) -> Result<Value> {
    let s = state(root)?;
    Ok(
        json!({"enabled":s["enabled"],"lastSync":s["lastSync"],"error":s["error"],"path":folder().ok().map(|p|p.to_string_lossy().into_owned()),"available":folder().is_ok()}),
    )
}
pub fn configure(root: &Path, enabled: bool) -> Result<Value> {
    if enabled {
        let p = folder()?;
        for d in ["events", "blobs"] {
            fs::create_dir_all(p.join(d)).map_err(err)?;
        }
    }
    let mut s = state(root)?;
    s["enabled"] = json!(enabled);
    s["error"] = Value::Null;
    atomic(&root.join("icloud-state.json"), &s)?;
    status(root)
}
fn fingerprint(v: &Value) -> Result<String> {
    Ok(hash(&serde_json::to_vec(v).map_err(err)?))
}
fn load_blob(cloud: &Path, key: &str) -> Result<Value> {
    if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("同步资源标识无效".into());
    }
    let p = cloud.join("blobs").join(format!("{key}.json"));
    let v = read(&p).map_err(|e| format!("iCloud资源未就绪，稍后自动重试：{e}"))?;
    if fingerprint(&v)? != key {
        return Err("同步资源校验失败".into());
    }
    Ok(v)
}
fn stamp(v: &Value) -> (u64, String) {
    (
        v["clock"].as_u64().unwrap_or(0),
        v["id"].as_str().unwrap_or("").into(),
    )
}
fn inventory(root: &Path) -> Result<BTreeMap<String, (String, Value)>> {
    let c = library::db(root)?;
    let mut stmt = c.prepare("SELECT id,digest FROM items").map_err(err)?;
    let ids = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(err)?
        .collect::<std::result::Result<BTreeMap<_, _>, _>>()
        .map_err(err)?;
    let mut out = BTreeMap::new();
    for meta in library::list(root)?.as_array().ok_or("内容库无效")? {
        let id = meta["id"].as_str().unwrap();
        let mut archive = library::load(root, id)?;
        for k in ["library", "reading", "articleEdit", "exportRequest"] {
            archive.as_object_mut().unwrap().remove(k);
        }
        let mut editing = crate::article_edit::bundle(root, id)?;
        if let Some(a) = editing["assets"].as_array_mut() {
            a.sort_by_key(|v| v["id"].to_string());
        }
        archive["articleEditing"] = editing;
        let mut meta = meta.clone();
        meta.as_object_mut().unwrap().remove("id");
        out.insert(
            ids.get(id).ok_or("收藏已变化")?.clone(),
            (id.into(), json!({"archive":archive,"meta":meta})),
        );
    }
    Ok(out)
}
fn put_blob(cloud: &Path, v: &Value) -> Result<String> {
    let digest = fingerprint(v)?;
    let p = cloud.join("blobs").join(format!("{digest}.json"));
    if !p.exists() {
        atomic(&p, v)?;
    }
    Ok(digest)
}
fn publish(cloud: &Path, s: &mut Value, key: &str, data: Value, deleted: bool) -> Result<Value> {
    let mut record_time = 0;
    if key.starts_with("reading-") {
        for field in ["meta", "note", "cleared"] {
            record_time = record_time.max(data[field]["updatedAt"].as_u64().unwrap_or(0));
        }
        for field in ["annotations", "deleted"] {
            if let Some(values) = data[field].as_array() {
                for v in values {
                    record_time = record_time.max(v["updatedAt"].as_u64().unwrap_or(0));
                }
            }
        }
    }
    let clock = s["clock"].as_u64().unwrap_or(0).max(record_time).max(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(err)?
            .as_millis() as u64,
    ) + 1;
    s["clock"] = json!(clock);
    let data_url = if deleted {
        s["known"][key]["url"].clone()
    } else {
        data["archive"]["url"].clone()
    };
    let digest = if deleted {
        Value::Null
    } else {
        let packed = if key.starts_with("reading-") {
            data
        } else {
            let mut archive = data["archive"].clone();
            let editing = archive
                .as_object_mut()
                .ok_or("同步收藏无效")?
                .remove("articleEditing")
                .unwrap_or(Value::Null);
            json!({"archiveBlob":put_blob(cloud,&archive)?,"editingBlob":put_blob(cloud,&editing)?,"meta":data["meta"]})
        };
        json!(put_blob(cloud, &packed)?)
    };
    let e = json!({"version":1,"id":Uuid::new_v4().to_string(),"device":s["device"],"clock":clock,"key":key,"deleted":deleted,"blob":digest,"url":data_url});
    atomic(
        &cloud
            .join("events")
            .join(format!("{}.json", e["id"].as_str().unwrap())),
        &e,
    )?;
    Ok(e)
}
// Avoid re-reading and hashing large offline snapshots when only polling for changes.
fn local_token(root: &Path) -> Result<String> {
    let c = library::db(root)?;
    let mut rows = Vec::new();
    for sql in ["SELECT item_id||':'||revision||':'||coalesce(document,'')||':'||coalesce(draft,'') FROM article_documents ORDER BY item_id", "SELECT data FROM reading_pages ORDER BY url"] {
   let mut stmt=c.prepare(sql).map_err(err)?;
   rows.extend(stmt.query_map([],|r|r.get::<_,String>(0)).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?);
 }
    fingerprint(&json!([library::list(root)?, rows]))
}
fn remote_token(cloud: &Path) -> Result<String> {
    let mut names = fs::read_dir(cloud.join("events"))
        .map_err(err)?
        .map(|e| {
            e.map(|e| e.file_name().to_string_lossy().into_owned())
                .map_err(err)
        })
        .collect::<Result<Vec<_>>>()?;
    names.sort();
    fingerprint(&json!(names))
}
fn run_at(root: &Path, cloud: &Path, s: &mut Value) -> Result<bool> {
    for d in ["events", "blobs"] {
        fs::create_dir_all(cloud.join(d)).map_err(err)?;
    }
    let marker = cloud.join("shiye-sync.json");
    if cloud.join(".shiye-sync.json.icloud").exists() {
        download(&marker);
        return Err("正在等待iCloud下载目录标识".into());
    }
    if !marker.exists() {
        atomic(
            &marker,
            &json!({"format":"shiye-drive","version":1,"id":Uuid::new_v4().to_string()}),
        )?;
    }
    let namespace = read(&marker)?;
    if namespace["format"] != "shiye-drive" || namespace["version"] != 1 {
        return Err("iCloud同步目录格式不兼容".into());
    }
    if s["cloudId"] != namespace["id"] {
        s["known"] = json!({});
        s["seen"] = json!({});
        s["reading"] = json!({});
        s["cloudId"] = namespace["id"].clone();
        s["localToken"] = Value::Null;
        s["remoteToken"] = Value::Null;
    }
    if s["localToken"].as_str() == Some(&local_token(root)?)
        && s["remoteToken"].as_str() == Some(&remote_token(cloud)?)
        && s["error"].is_null()
    {
        return Ok(false);
    }
    let local = inventory(root)?;
    let mut events = vec![];
    let mut winners = BTreeMap::<String, Value>::new();
    for file in fs::read_dir(cloud.join("events")).map_err(err)? {
        let p = file.map_err(err)?.path();
        if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
            if name.starts_with('.') && name.ends_with(".icloud") {
                let target = cloud.join("events").join(&name[1..name.len() - 7]);
                download(&target);
                return Err("正在等待 iCloud 下载同步记录，稍后自动重试".into());
            }
        }
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let e = read(&p)?;
        if e["version"] != 1 {
            return Err("不支持的同步版本".into());
        }
        Uuid::parse_str(e["id"].as_str().ok_or("同步事件无效")?).map_err(err)?;
        let key = e["key"].as_str().ok_or("同步标识缺失")?.to_owned();
        let digest = key.strip_prefix("reading-").unwrap_or(&key);
        if digest.len() != 64
            || !digest.bytes().all(|c| c.is_ascii_hexdigit())
            || !e["deleted"].is_boolean()
            || e["clock"]
                .as_u64()
                .is_none_or(|c| c > (library::now() + 86400) * 1000)
        {
            return Err("同步记录内容无效".into());
        }

        s["clock"] = json!(s["clock"].as_u64().unwrap_or(0).max(stamp(&e).0));
        if winners.get(&key).is_none_or(|v| stamp(&e) > stamp(v)) {
            winners.insert(key, e.clone());
        }
        events.push(e);
    }
    // Publish offline local edits before applying remote changes.
    for (key, (_, v)) in &local {
        let fp = fingerprint(v)?;
        if s["known"][key]["fingerprint"].as_str() != Some(&fp) {
            let e = publish(cloud, s, key, v.clone(), false)?;
            winners.insert(key.clone(), e.clone());
            events.push(e);
            s["known"][key] = json!({"fingerprint":fp,"deleted":false,"url":v["archive"]["url"]});
        }
    }
    for (key, v) in s["known"].as_object().cloned().unwrap_or_default() {
        if !local.contains_key(&key) && v["deleted"] != true {
            let e = publish(cloud, s, &key, Value::Null, true)?;
            winners.insert(key.clone(), e.clone());
            events.push(e);
            s["known"][&key] = json!({"deleted":true,"url":v["url"]});
        }
    }
    for page in crate::reading::all(root)?
        .as_array()
        .ok_or("阅读数据无效")?
    {
        let key = format!(
            "reading-{}",
            hash(page["url"].as_str().unwrap_or("").as_bytes())
        );
        let fp = fingerprint(page)?;
        if s["reading"][&key].as_str() != Some(&fp) {
            events.push(publish(cloud, s, &key, page.clone(), false)?);
            s["reading"][&key] = json!(fp);
        }
    }
    let mut changed = false;
    for e in events
        .iter()
        .filter(|e| e["key"].as_str().unwrap_or("").starts_with("reading-"))
    {
        let id = e["id"].as_str().unwrap();
        if s["seen"][id] == true {
            continue;
        }
        let page = load_blob(cloud, e["blob"].as_str().ok_or("笔记资源缺失")?)?;
        crate::reading::merge(root, page["url"].as_str().ok_or("笔记来源缺失")?, &page)?;
        s["seen"][id] = json!(true);
        changed = true;
    }
    for (key, e) in winners.iter().filter(|(k, _)| !k.starts_with("reading-")) {
        let eid = e["id"].as_str().unwrap();
        if s["seen"][eid] == true {
            continue;
        }
        if e["deleted"] == true {
            if let Some((id, _)) = local.get(key) {
                library::db(root)?
                    .execute("UPDATE items SET trashed=1 WHERE id=?1", [id])
                    .map_err(err)?;
                if let Err(error) = crate::deletion::purge(root, &json!({"ids":[id]})) {
                    // A busy PDF job must postpone deletion without creating a local
                    // trash edit that could be republished over the cloud tombstone.
                    library::db(root)?
                        .execute(
                            "UPDATE items SET trashed=?1 WHERE id=?2",
                            rusqlite::params![
                                local.get(key).unwrap().1["meta"]["trashed"]
                                    .as_bool()
                                    .unwrap_or(false),
                                id
                            ],
                        )
                        .map_err(err)?;
                    return Err(error);
                }
                changed = true;
            }
            s["known"][key] = json!({"deleted":true,"url":e["url"]});
        } else {
            let mut data = load_blob(cloud, e["blob"].as_str().ok_or("收藏资源缺失")?)?;
            data["archive"] =
                load_blob(cloud, data["archiveBlob"].as_str().ok_or("快照资源缺失")?)?;
            data["archive"]["articleEditing"] =
                load_blob(cloud, data["editingBlob"].as_str().ok_or("编辑资源缺失")?)?;
            let result = library::import(root, data["archive"].clone())?;
            let id = result["id"].as_str().ok_or("收藏导入失败")?;
            crate::article_edit::sync_restore(root, id, &data["archive"]["articleEditing"])?;
            library::update_only(root, id, &data["meta"])?;
            changed = true;
        }
        s["seen"][eid] = json!(true);
    }
    // Keep a page-level deletion barrier so delayed note files cannot resurrect removed notes.
    for (_, e) in winners.iter().filter(|(_, e)| e["deleted"] == true) {
        if let Some(address) = e["url"].as_str().filter(|u| crate::reading::url(u).is_ok()) {
            let key = crate::reading::url(address)?;
            let count: i64 = library::db(root)?
                .query_row(
                    "SELECT count(*) FROM items WHERE reading_url=?1",
                    [&key],
                    |r| r.get(0),
                )
                .map_err(err)?;
            if count == 0 {
                let mut clear = crate::reading::empty(address)?;
                clear["cleared"] = json!({"updatedAt":e["clock"],"mutationId":e["id"]});
                crate::reading::merge(root, address, &clear)?;
            }
        }
    }
    // Reconcile per-source CRDT fields after new snapshots have been imported.
    for meta in library::list(root)?.as_array().ok_or("内容库无效")? {
        let address = meta["url"].as_str().unwrap_or("");
        if crate::reading::url(address).is_ok() {
            let r = crate::reading::get(root, address)?;
            let mut patch = json!({});
            if r["meta"]["updatedAt"].as_u64().unwrap_or(0) > 0 {
                for k in ["folder", "tags", "starred", "read"] {
                    patch[k] = r["meta"][k].clone();
                }
            }
            if r["note"]["updatedAt"].as_u64().unwrap_or(0) > 0 {
                patch["notes"] = r["note"]["text"].clone();
            }
            library::update_only(root, meta["id"].as_str().unwrap(), &patch)?;
        }
    }
    for (key, (_, v)) in inventory(root)? {
        s["known"][&key] =
            json!({"fingerprint":fingerprint(&v)?,"deleted":false,"url":v["archive"]["url"]});
    }
    for page in crate::reading::all(root)?
        .as_array()
        .ok_or("阅读数据无效")?
    {
        let key = format!(
            "reading-{}",
            hash(page["url"].as_str().unwrap_or("").as_bytes())
        );
        s["reading"][&key] = json!(fingerprint(page)?);
    }
    s["localToken"] = json!(local_token(root)?);
    s["remoteToken"] = json!(remote_token(cloud)?);
    Ok(changed)
}
pub fn sync(root: &Path) -> Result<bool> {
    let mut s = state(root)?;
    if s["enabled"] != true {
        return Ok(false);
    }
    let result = folder().and_then(|p| run_at(root, &p, &mut s));
    match &result {
        Ok(_) => {
            s["lastSync"] = json!(library::now() * 1000);
            s["error"] = Value::Null;
        }
        Err(e) => s["error"] = json!(e),
    }
    atomic(&root.join("icloud-state.json"), &s)?;
    result
}
pub fn sync_report(root: &Path, app: &tauri::AppHandle) -> Result<bool> {
    if state(root)?["enabled"] != true {
        let _ = app.emit("sync-state", status(root)?);
        return Ok(false);
    }
    let _ = app.emit("sync-state", json!({"enabled":true,"running":true}));
    let result = sync(root);
    let mut current = status(root).unwrap_or_else(|_| json!({"enabled":true}));
    current["running"] = json!(false);
    if let Err(e) = &result {
        current["error"] = json!(e);
    }
    let _ = app.emit("sync-state", current);
    result
}
pub fn start(root: PathBuf, app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        if let Ok(_g) = LOCK.lock() {
            if sync_report(&root, &app).unwrap_or(false) {
                let _ = app.emit("library-changed", json!({}));
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(30));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn init() -> PathBuf {
        let p = std::env::temp_dir().join(format!("icloud-test-{}", Uuid::new_v4()));
        library::init(&p).unwrap();
        p
    }
    fn cycle(p: &Path, c: &Path, s: &mut Value) {
        run_at(p, c, s).unwrap();
    }
    fn one(p: &Path) -> Value {
        library::list(p).unwrap().as_array().unwrap()[0].clone()
    }
    #[test]
    fn two_devices_merge_offline_notes_and_delete_without_resurrection() {
        let a = init();
        let b = init();
        let cloud = init();
        let mut sa = state(&a).unwrap();
        let mut sb = state(&b).unwrap();
        let id=library::import(&a,json!({"version":1,"title":"原文","url":"https://example.test/sync","source":"webpage","snapshot":{"html":"<h1>原文</h1>"}})).unwrap()["id"].as_str().unwrap().to_owned();
        library::update(
            &a,
            &id,
            &json!({"folder":"收藏夹","tags":"tag","notes":"first","progress":0.4}),
        )
        .unwrap();
        cycle(&a, &cloud, &mut sa);
        cycle(&b, &cloud, &mut sb);
        let mb = one(&b);
        assert_eq!(mb["folder"], "收藏夹");
        assert_eq!(mb["notes"], "first");
        assert_eq!(mb["progress"], 0.4);
        let bid = mb["id"].as_str().unwrap();
        library::update(&a, &id, &json!({"notes":"offline note"})).unwrap();
        library::update(&b, bid, &json!({"starred":true})).unwrap();
        cycle(&a, &cloud, &mut sa);
        cycle(&b, &cloud, &mut sb);
        cycle(&a, &cloud, &mut sa);
        cycle(&b, &cloud, &mut sb);
        assert_eq!(one(&a)["notes"], "offline note");
        assert_eq!(one(&b)["notes"], "offline note");
        assert_eq!(one(&a)["starred"], true);
        let before = fs::read_dir(cloud.join("events")).unwrap().count();
        cycle(&a, &cloud, &mut sa);
        cycle(&b, &cloud, &mut sb);
        assert_eq!(
            fs::read_dir(cloud.join("events")).unwrap().count(),
            before,
            "unchanged sync must not echo events"
        );
        library::update(&a, &id, &json!({"trashed":true})).unwrap();
        crate::deletion::purge(&a, &json!({"ids":[id]})).unwrap();
        cycle(&a, &cloud, &mut sa);
        let job = Uuid::new_v4().to_string();
        library::queue_export(&b, bid, &json!({"id":job,"filename":"busy.pdf"})).unwrap();
        assert!(run_at(&b, &cloud, &mut sb).is_err());
        assert_eq!(one(&b)["trashed"], false);
        let count = fs::read_dir(cloud.join("events")).unwrap().count();
        assert!(run_at(&b, &cloud, &mut sb).is_err());
        assert_eq!(fs::read_dir(cloud.join("events")).unwrap().count(), count);
        library::db(&b)
            .unwrap()
            .execute("UPDATE exports SET status='cancelled' WHERE id=?1", [&job])
            .unwrap();
        cycle(&b, &cloud, &mut sb);
        cycle(&a, &cloud, &mut sa);
        cycle(&b, &cloud, &mut sb);
        assert!(library::list(&a).unwrap().as_array().unwrap().is_empty());
        assert!(library::list(&b).unwrap().as_array().unwrap().is_empty());
        let fresh = init();
        let mut sf = state(&fresh).unwrap();
        cycle(&fresh, &cloud, &mut sf);
        assert!(library::list(&fresh)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            crate::reading::get(&fresh, "https://example.test/sync").unwrap()["note"]["text"],
            ""
        );
        fs::remove_dir_all(fresh).unwrap();
        for p in [a, b, cloud] {
            fs::remove_dir_all(p).unwrap();
        }
    }
    #[test]
    fn editor_versions_sync_and_metadata_does_not_duplicate_snapshots() {
        let a = init();
        let b = init();
        let c = init();
        let mut sa = state(&a).unwrap();
        let mut sb = state(&b).unwrap();
        let id = library::import(
            &a,
            json!({"version":1,"title":"editor","snapshot":{"html":"<h1>immutable original</h1>"}}),
        )
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let doc = |t: &str| json!({"schemaVersion":1,"content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":t}]}]},"htmlTemplate":format!("<p>{t}</p>"),"text":t});
        crate::article_edit::save(
            &a,
            &json!({"id":id,"baseRevision":0,"document":doc("version one")}),
            false,
        )
        .unwrap();
        cycle(&a, &c, &mut sa);
        cycle(&b, &c, &mut sb);
        let bid = one(&b)["id"].as_str().unwrap().to_owned();
        assert_eq!(
            crate::article_edit::get(&b, &bid).unwrap()["document"]["text"],
            "version one"
        );
        crate::article_edit::save(
            &b,
            &json!({"id":bid,"baseRevision":1,"document":doc("version two")}),
            false,
        )
        .unwrap();
        cycle(&b, &c, &mut sb);
        cycle(&a, &c, &mut sa);
        assert_eq!(
            crate::article_edit::get(&a, &id).unwrap()["document"]["text"],
            "version two"
        );
        assert_eq!(
            library::load(&a, &id).unwrap()["snapshot"]["html"],
            "<h1>immutable original</h1>"
        );
        let archives = || {
            fs::read_dir(c.join("blobs"))
                .unwrap()
                .flatten()
                .filter(|e| read(&e.path()).unwrap()["snapshot"]["html"].is_string())
                .count()
        };
        assert_eq!(archives(), 1);
        library::update(&a, &id, &json!({"progress":0.8})).unwrap();
        cycle(&a, &c, &mut sa);
        cycle(&b, &c, &mut sb);
        assert_eq!(archives(), 1);
        assert_eq!(one(&b)["progress"], 0.8);
        crate::article_edit::save(
            &a,
            &json!({"id":id,"baseRevision":2,"document":doc("offline A")}),
            false,
        )
        .unwrap();
        crate::article_edit::save(
            &b,
            &json!({"id":bid,"baseRevision":2,"document":doc("offline B")}),
            false,
        )
        .unwrap();
        cycle(&a, &c, &mut sa);
        cycle(&b, &c, &mut sb);
        cycle(&a, &c, &mut sa);
        assert_eq!(
            crate::article_edit::get(&a, &id).unwrap()["document"]["text"],
            "offline B"
        );
        assert!(crate::article_edit::save(
            &a,
            &json!({"id":id,"baseRevision":3,"document":doc("stale editor")}),
            false
        )
        .is_err());
        let mut invalid = crate::article_edit::bundle(&a, &id).unwrap();
        invalid["document"] = json!({"invalid":true});
        assert!(crate::article_edit::sync_restore(&a, &id, &invalid).is_err());
        assert_eq!(
            crate::article_edit::get(&a, &id).unwrap()["document"]["text"],
            "offline B"
        );
        for p in [a, b, c] {
            fs::remove_dir_all(p).unwrap();
        }
    }
    #[test]
    fn disabled_sync_does_not_write_state_or_cloud() {
        let root = init();
        assert!(!sync(&root).unwrap());
        assert!(!root.join("icloud-state.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn incomplete_cloud_resource_retries_without_deleting_local_data() {
        let a = init();
        let b = init();
        let c = init();
        let mut sa = state(&a).unwrap();
        let mut sb = state(&b).unwrap();
        library::import(
            &a,
            json!({"version":1,"snapshot":{"html":"<p>payload</p>"}}),
        )
        .unwrap();
        cycle(&a, &c, &mut sa);
        let file = fs::read_dir(c.join("blobs"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let bytes = fs::read(&file).unwrap();
        fs::remove_file(&file).unwrap();
        assert!(run_at(&b, &c, &mut sb).is_err());
        assert_eq!(library::list(&a).unwrap().as_array().unwrap().len(), 1);
        fs::write(file, bytes).unwrap();
        cycle(&b, &c, &mut sb);
        assert_eq!(library::list(&b).unwrap().as_array().unwrap().len(), 1);
        for p in [a, b, c] {
            fs::remove_dir_all(p).unwrap();
        }
    }
}
