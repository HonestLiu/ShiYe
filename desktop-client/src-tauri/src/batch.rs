use crate::library::{self, err, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::Path};
use uuid::Uuid;
pub fn init(db: &Connection) -> Result<()> {
    let columns: Vec<String> = db
        .prepare("PRAGMA table_info(exports)")
        .map_err(err)?
        .query_map([], |r| r.get(1))
        .map_err(err)?
        .collect::<std::result::Result<_, _>>()
        .map_err(err)?;
    for (name, default) in [("format", "pdf"), ("batch_id", "")] {
        if !columns.iter().any(|n| n == name) {
            db.execute_batch(&format!(
                "ALTER TABLE exports ADD COLUMN {name} TEXT NOT NULL DEFAULT '{default}'"
            ))
            .map_err(err)?;
        }
    }
    if !columns.iter().any(|n| n == "output_owned") {
        db.execute_batch("ALTER TABLE exports ADD COLUMN output_owned INTEGER NOT NULL DEFAULT 0")
            .map_err(err)?;
    }
    db.execute_batch("CREATE INDEX IF NOT EXISTS exports_batch_status ON exports(batch_id,status); CREATE INDEX IF NOT EXISTS exports_status ON exports(status); CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,directory TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0)").map_err(err)?;
    Ok(())
}
fn ids(req: &Value) -> Result<Vec<String>> {
    let list = req["ids"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 1000)
        .ok_or("请选择1至1000条收藏")?;
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for id in list {
        let id = id.as_str().ok_or("无效收藏ID")?;
        Uuid::parse_str(id).map_err(err)?;
        if seen.insert(id.to_owned()) {
            result.push(id.to_owned());
        }
    }
    Ok(result)
}
pub fn update(root: &Path, req: &Value) -> Result<Value> {
    let ids = ids(req)?;
    let mut db = library::db(root)?;
    let tx = db.transaction().map_err(err)?;
    let patch = &req["patch"];
    if let Some(o) = patch.as_object() {
        if o.keys()
            .any(|k| !["read", "starred", "trashed", "folder"].contains(&k.as_str()))
        {
            return Err("不支持的批量整理字段".into());
        }
    }
    for id in &ids {
        let old: String = tx
            .query_row("SELECT tags FROM items WHERE id=?1", [id], |r| r.get(0))
            .map_err(err)?;
        for key in ["read", "starred", "trashed"] {
            if let Some(v) = patch.get(key) {
                tx.execute(
                    &format!("UPDATE items SET {key}=?1 WHERE id=?2"),
                    params![v.as_bool().ok_or("无效状态")?, id],
                )
                .map_err(err)?;
            }
        }
        if let Some(v) = patch.get("folder") {
            let folder = v
                .as_str()
                .filter(|s| s.chars().count() <= 100)
                .ok_or("收藏夹名称过长")?;
            tx.execute(
                "UPDATE items SET folder=?1 WHERE id=?2",
                params![folder, id],
            )
            .map_err(err)?;
        }
        if let Some(add) = req.get("tagsAdd") {
            let add = add.as_str().filter(|s| s.len() <= 2000).ok_or("标签过长")?;
            let mut tags = Vec::new();
            for t in old.split([',', '，']).chain(add.split([',', '，'])) {
                let t = t.trim();
                if t.is_empty() {
                    continue;
                }
                if t.chars().count() > 100 {
                    return Err("单个标签过长".into());
                }
                if !tags.contains(&t) {
                    tags.push(t)
                }
            }
            tx.execute(
                "UPDATE items SET tags=?1 WHERE id=?2",
                params![tags.join(","), id],
            )
            .map_err(err)?;
        }
    }
    tx.commit().map_err(err)?;
    Ok(json!({"count":ids.len()}))
}
fn filename(title: &str) -> String {
    let mut s = String::new();
    for c in title.chars() {
        let c = if c.is_control() || "/\\:*?\"<>|".contains(c) {
            '_'
        } else {
            c
        };
        if s.len() + c.len_utf8() > 160 {
            break;
        }
        s.push(c)
    }
    let s = s.trim().trim_matches('.').to_owned();
    if s.is_empty() {
        "收藏".into()
    } else {
        s
    }
}
pub fn create(root: &Path, req: &Value) -> Result<Value> {
    let ids = ids(req)?;
    let format = req["format"]
        .as_str()
        .filter(|f| ["pdf", "html", "md", "txt", "json"].contains(f))
        .ok_or("无效的导出格式")?;
    let stamp = req["stamp"]
        .as_str()
        .filter(|s| {
            s.len() == 15
                && s.as_bytes()[8] == b'-'
                && s.bytes()
                    .enumerate()
                    .all(|(i, c)| i == 8 || c.is_ascii_digit())
        })
        .ok_or("无效时间戳")?;
    let parent = Path::new(req["directory"].as_str().ok_or("缺少导出目录")?);
    if !parent.is_dir() {
        return Err("导出目录不存在".into());
    }
    let id = Uuid::new_v4().to_string();
    let directory = parent.join(format!("拾页导出_{stamp}_{}", &id[..8]));
    let mut db = library::db(root)?;
    let tx = db.transaction().map_err(err)?;
    let mut jobs = Vec::new();
    for (index, item) in ids.iter().enumerate() {
        let title: String = tx
            .query_row("SELECT title FROM items WHERE id=?1", [item], |r| r.get(0))
            .map_err(err)?;
        let base = filename(&title);
        let name = format!("{base}_{stamp}_{:03}.{format}", index + 1);
        let job = Uuid::new_v4().to_string();
        let path = directory.join(&name);
        jobs.push((job, item.clone(), name, path));
    }
    fs::create_dir(&directory).map_err(err)?;
    let result = (|| {
        tx.execute(
            "INSERT INTO batches(id,created_at,directory) VALUES(?1,?2,?3)",
            params![id, library::now(), directory.to_string_lossy()],
        )
        .map_err(err)?;
        for (job, item, name, path) in jobs {
            tx.execute("INSERT INTO exports(id,item_id,filename,status,path,options,delivery,format,batch_id) VALUES(?1,?2,?3,'queued',?4,?5,'client',?6,?7)",params![job,item,name,path.to_string_lossy(),serde_json::to_string(req.get("options").unwrap_or(&json!({}))).map_err(err)?,format,id]).map_err(err)?;
        }
        tx.commit().map_err(err)?;
        Ok(json!({"batchId":id,"directory":directory,"count":ids.len()}))
    })();
    if result.is_err() {
        let _ = fs::remove_dir(&directory);
    }
    result
}
pub fn list(root: &Path) -> Result<Value> {
    let db = library::db(root)?;
    let batches:Vec<(String,u64,String,bool)>=db.prepare("SELECT id,created_at,directory,cancel_requested FROM batches WHERE id IN (SELECT id FROM batches ORDER BY created_at DESC,rowid DESC LIMIT 30) OR EXISTS(SELECT 1 FROM exports WHERE batch_id=batches.id AND status IN ('queued','processing')) ORDER BY created_at DESC,rowid DESC").map_err(err)?.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(err)?.collect::<std::result::Result<_,_>>().map_err(err)?;
    let mut result = Vec::new();
    for (id, created, directory, cancel) in batches {
        let jobs: Vec<Value> = db
            .prepare(&format!(
                "SELECT {} FROM exports WHERE batch_id=?1 ORDER BY rowid",
                library::EXPORT_FIELDS
            ))
            .map_err(err)?
            .query_map([&id], library::export_row)
            .map_err(err)?
            .collect::<std::result::Result<_, _>>()
            .map_err(err)?;
        let count = |status: &str| jobs.iter().filter(|j| j["status"] == status).count();
        let active = count("queued") + count("processing");
        result.push(json!({"batchId":id,"createdAt":created,"directory":directory,"cancelRequested":cancel,"total":jobs.len(),"done":count("done"),"failed":count("failed"),"cancelled":count("cancelled"),"active":active,"jobs":jobs}));
    }
    Ok(json!(result))
}
pub fn cancel(root: &Path, id: &str) -> Result<Value> {
    Uuid::parse_str(id).map_err(err)?;
    let mut db = library::db(root)?;
    let tx = db.transaction().map_err(err)?;
    if tx
        .execute("UPDATE batches SET cancel_requested=1 WHERE id=?1", [id])
        .map_err(err)?
        == 0
    {
        return Err("批量任务不存在".into());
    }
    tx.execute(
        "UPDATE exports SET status='cancelled' WHERE batch_id=?1 AND status='queued'",
        [id],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(json!({"ok":true}))
}
pub fn is_cancelled(root: &Path, id: &str) -> Result<bool> {
    let db = library::db(root)?;
    db.query_row("SELECT EXISTS(SELECT 1 FROM batches b JOIN exports e ON e.batch_id=b.id WHERE e.id=?1 AND b.cancel_requested=1)",[id],|r|r.get(0)).map_err(err)
}
pub fn write_export(root: &Path, req: &Value) -> Result<Value> {
    let id = req["jobId"].as_str().ok_or("缺少任务ID")?;
    let job = library::export_status(root, id)?;
    if job["batchId"] == "" || job["status"] != "processing" {
        return Err("不是正在处理的批量任务".into());
    }
    if is_cancelled(root, id)? {
        return Err("任务已取消".into());
    }
    let archive = library::load_export(root, id)?;
    let data = library::export_contents(
        &archive,
        job["format"].as_str().unwrap_or(""),
        &req["html"],
        &req["text"],
    )?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(job["path"].as_str().ok_or("缺少保存位置")?)
        .map_err(err)?;
    use std::io::Write;
    if let Err(e) = file.write_all(data.as_bytes()) {
        drop(file);
        let _ = fs::remove_file(job["path"].as_str().unwrap());
        return Err(err(e));
    }
    mark_output(root, id)?;
    Ok(json!({"ok":true}))
}
pub fn mark_output(root: &Path, id: &str) -> Result<()> {
    library::db(root)?.execute("UPDATE exports SET output_owned=1 WHERE id=?1 AND batch_id!='' AND status='processing'",[id]).map_err(err)?;
    Ok(())
}
pub fn owns_output(root: &Path, id: &str) -> Result<bool> {
    library::db(root)?
        .query_row("SELECT output_owned FROM exports WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .map_err(err)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn archive(text: &str) -> Value {
        json!({"version":1,"title":"同名 / 收藏","url":"https://chatgpt.com/c/test","snapshot":{"html":format!("<section class=\"pdf-message\"><h1>{text}</h1><p>BODY_{text}</p></section>")},"messages":[{"role":"assistant","markdown":format!("# {text}"),"text":format!("BODY_{text}")}]})
    }
    #[test]
    fn bulk_atomic_updates_and_queued_exports() {
        let root = std::env::temp_dir().join(format!("reader-batch-{}", Uuid::new_v4()));
        library::init(&root).unwrap();
        let a = library::import(&root, archive("ONE")).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let b = library::import(&root, archive("TWO")).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        library::update(&root, &a, &json!({"tags":"旧标签"})).unwrap();
        assert!(update(
            &root,
            &json!({"ids":[a,Uuid::new_v4().to_string()],"patch":{"read":true}})
        )
        .is_err());
        assert_eq!(library::load(&root, &a).unwrap()["library"]["read"], false);
        update(&root,&json!({"ids":[a,b,a],"patch":{"read":true,"starred":true,"folder":"408"},"tagsAdd":"计组,旧标签"})).unwrap();
        let item = library::load(&root, &a).unwrap();
        assert_eq!(item["library"]["tags"], "旧标签,计组");
        assert_eq!(item["library"]["folder"], "408");
        for format in ["html", "md", "txt", "json", "pdf"] {
            let result=create(&root,&json!({"ids":[a,b],"directory":root,"stamp":"20261106-123456","format":format,"options":{"toc":true}})).unwrap();
            let batch = list(&root)
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["batchId"] == result["batchId"])
                .unwrap()
                .clone();
            let jobs = batch["jobs"].as_array().unwrap();
            assert_ne!(jobs[0]["path"], jobs[1]["path"]);
            assert!(jobs[0]["filename"]
                .as_str()
                .unwrap()
                .contains("20261106-123456"));
            for job in jobs {
                let id = job["jobId"].as_str().unwrap();
                library::claim_export(&root, id).unwrap();
                if format == "pdf" {
                    fs::write(job["path"].as_str().unwrap(), b"%PDF-test").unwrap();
                } else {
                    write_export(
                        &root,
                        &json!({"jobId":id,"html":"<!doctype html><p>SAFE</p>","text":"PLAIN"}),
                    )
                    .unwrap();
                    assert!(write_export(
                        &root,
                        &json!({"jobId":id,"html":"overwrite","text":"overwrite"})
                    )
                    .is_err());
                }
                library::finish_export(&root, &json!({"jobId":id,"status":"done"})).unwrap();
            }
            let results = list(&root).unwrap();
            assert_eq!(results[0]["active"], 0);
        }
        let result = create(
            &root,
            &json!({"ids":[a,b],"directory":root,"stamp":"20261106-123456","format":"pdf"}),
        )
        .unwrap();
        let batches = list(&root).unwrap();
        let jobs = batches[0]["jobs"].as_array().unwrap();
        let first = jobs[0]["jobId"].as_str().unwrap();
        library::claim_export(&root, first).unwrap();
        fs::write(jobs[0]["path"].as_str().unwrap(), b"%PDF-partial").unwrap();
        mark_output(&root, first).unwrap();
        cancel(&root, result["batchId"].as_str().unwrap()).unwrap();
        assert_eq!(
            library::finish_export(&root, &json!({"jobId":first,"status":"done"})).unwrap()
                ["status"],
            "cancelled"
        );
        assert!(!Path::new(jobs[0]["path"].as_str().unwrap()).exists());
        assert_eq!(
            library::export_status(&root, jobs[1]["jobId"].as_str().unwrap()).unwrap()["status"],
            "cancelled"
        );
        assert!(create(
            &root,
            &json!({"ids":[a],"directory":root,"stamp":"../bad","format":"pdf"})
        )
        .is_err());
        let result = create(
            &root,
            &json!({"ids":[a,b],"directory":root,"stamp":"20261106-123456","format":"txt"}),
        )
        .unwrap();
        let batches = list(&root).unwrap();
        let job = batches[0]["jobs"][0]["jobId"].as_str().unwrap().to_owned();
        library::claim_export(&root, &job).unwrap();
        library::init(&root).unwrap();
        assert_eq!(
            library::export_status(&root, &job).unwrap()["status"],
            "failed"
        );
        assert_eq!(list(&root).unwrap()[0]["batchId"], result["batchId"]);
        let result = create(
            &root,
            &json!({"ids":[a],"directory":root,"stamp":"20261106-123456","format":"pdf"}),
        )
        .unwrap();
        let batches = list(&root).unwrap();
        let job = &batches[0]["jobs"][0];
        let id = job["jobId"].as_str().unwrap();
        library::claim_export(&root, id).unwrap();
        let file = job["path"].as_str().unwrap();
        fs::write(file, b"foreign file").unwrap();
        cancel(&root, result["batchId"].as_str().unwrap()).unwrap();
        library::finish_export(&root, &json!({"jobId":id,"status":"failed"})).unwrap();
        assert_eq!(fs::read(file).unwrap(), b"foreign file");
        let source = root.join("source.pdf");
        let target = root.join("existing.pdf");
        fs::write(&source, b"new").unwrap();
        fs::write(&target, b"old").unwrap();
        assert!(copy_exclusive(&source, &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old");
        fs::remove_dir_all(root).unwrap();
    }
}

pub fn copy_exclusive(source: &Path, destination: &Path) -> Result<()> {
    let mut input = fs::File::open(source).map_err(err)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(err)?;
    if let Err(e) = std::io::copy(&mut input, &mut output) {
        drop(output);
        let _ = fs::remove_file(destination);
        return Err(err(e));
    }
    Ok(())
}
