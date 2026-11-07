use crate::library::{self, err, Result};
use rusqlite::{params, TransactionBehavior};
use serde_json::{json, Value};
use std::{collections::BTreeSet, fs, path::Path};
use uuid::Uuid;

// A crash between filesystem moves and the SQLite commit is recoverable.
pub fn recover(root: &Path) -> Result<()> {
    let base = root.join("deleting");
    fs::create_dir_all(&base).map_err(err)?;
    let db = library::db(root)?;
    for entry in fs::read_dir(&base).map_err(err)? {
        let dir = entry.map_err(err)?.path();
        if !dir.is_dir() { continue; }
        for file in fs::read_dir(&dir).map_err(err)? {
            let file = file.map_err(err)?;
            let id = file.file_name().to_string_lossy().into_owned();
            let target = library::item_dir(root, &id)?;
            let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM items WHERE id=?1)", [&id], |r| r.get(0)).map_err(err)?;
            if exists {
                if target.exists() { return Err("删除恢复时发现重复收藏目录，请保留数据后联系维护者".into()); }
                fs::rename(file.path(), target).map_err(err)?;
            } else { fs::remove_dir_all(file.path()).map_err(err)?; }
        }
        fs::remove_dir(dir).map_err(err)?;
    }
    Ok(())
}

pub fn purge(root: &Path, request: &Value) -> Result<Value> {
    let mut db = library::db(root)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
    let ids: BTreeSet<String> = if request["all"] == true {
        let mut stmt = tx.prepare("SELECT id FROM items WHERE trashed=1").map_err(err)?;
        let values = stmt.query_map([], |r| r.get(0)).map_err(err)?.collect::<std::result::Result<_, _>>().map_err(err)?;
        values
    } else {
        let values = request["ids"].as_array().filter(|v| !v.is_empty() && v.len() <= 1000).ok_or("请选择1至1000条回收站收藏")?;
        values.iter().map(|id| id.as_str().map(str::to_owned).ok_or("无效收藏ID".into())).collect::<Result<_>>()?
    };
    let mut urls = BTreeSet::new();
    let mut jobs = Vec::<String>::new();
    for id in &ids {
        library::item_dir(root, id)?;
        let (trashed, url): (bool, String) = tx.query_row("SELECT trashed,reading_url FROM items WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
        if !trashed { return Err("请先将收藏移到回收站，再永久删除".into()); }
        let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM exports WHERE item_id=?1 AND status IN ('queued','processing'))", [id], |r| r.get(0)).map_err(err)?;
        if busy { return Err("收藏正在导出，请等待导出完成或取消任务后再删除".into()); }
        let mut stmt = tx.prepare("SELECT id FROM exports WHERE item_id=?1").map_err(err)?;
        jobs.extend(stmt.query_map([id], |r| r.get(0)).map_err(err)?.collect::<std::result::Result<Vec<String>, _>>().map_err(err)?);
        if !url.is_empty() { urls.insert(url); }
    }
    if ids.is_empty() { return Ok(json!({"count":0})); }
    let stage = root.join("deleting").join(Uuid::new_v4().to_string());
    fs::create_dir_all(&stage).map_err(err)?;
    let mut moved = Vec::new();
    let outcome = (|| -> Result<()> {
        for id in &ids {
            let source = library::item_dir(root, id)?;
            if source.exists() { fs::rename(source, stage.join(id)).map_err(err)?; moved.push(id.clone()); }
            for table in ["article_documents", "article_history", "article_asset_meta", "exports"] {
                tx.execute(&format!("DELETE FROM {table} WHERE item_id=?1"), [id]).map_err(err)?;
            }
            tx.execute("DELETE FROM items WHERE id=?1", [id]).map_err(err)?;
        }
        for url in urls {
            tx.execute("DELETE FROM reading_pages WHERE url=?1 AND NOT EXISTS(SELECT 1 FROM items WHERE reading_url=?1)", params![url]).map_err(err)?;
        }
        tx.commit().map_err(err)
    })();
    if let Err(error) = outcome {
        for id in moved { fs::rename(stage.join(&id), library::item_dir(root, &id)?).map_err(err)?; }
        let _ = fs::remove_dir(&stage);
        return Err(error);
    }
    let mut pending = fs::remove_dir_all(stage).is_err();
    // Generated download caches belong to the app; user-exported files do not.
    for job in jobs {
        for name in [format!("browser-{job}.pdf"), format!("export-source-{job}.json")] {
            match fs::remove_file(root.join("incoming").join(name)) { Ok(()) => {}, Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}, Err(_) => pending = true }
        }
    }
    Ok(json!({"count":ids.len(),"cleanupPending":pending}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(root: &Path, html: &str) -> String {
        library::import(root,json!({"version":1,"title":"收藏","url":"https://example.org/a","snapshot":{"html":html}})).unwrap()["id"].as_str().unwrap().into()
    }
    #[test]
    fn purge_requires_trash_and_preserves_shared_notes() {
        let root=std::env::temp_dir().join(format!("purge-{}",Uuid::new_v4()));library::init(&root).unwrap();
        let a=item(&root,"<p>one</p>");let b=item(&root,"<p>two</p>");
        assert!(purge(&root,&json!({"ids":[a]})).is_err());
        library::update(&root,&a,&json!({"trashed":true,"notes":"shared note"})).unwrap();
        let db=library::db(&root).unwrap();db.execute("INSERT INTO article_documents(item_id,draft) VALUES(?1,'{}')",[&a]).unwrap();
        db.execute("INSERT INTO article_history(item_id,revision,data,updated_at) VALUES(?1,1,'{}',1)",[&a]).unwrap();
        db.execute("INSERT INTO article_asset_meta(item_id,asset_id,kind,mime,bytes) VALUES(?1,'asset','image','image/png',1)",[&a]).unwrap();
        fs::create_dir_all(library::item_dir(&root,&a).unwrap().join("article-assets")).unwrap();
        fs::write(library::item_dir(&root,&a).unwrap().join("article-assets/asset.json"),"data").unwrap();
        let job=Uuid::new_v4().to_string();db.execute("INSERT INTO exports(id,item_id,filename,status,path) VALUES(?1,?2,'export.pdf','done',?3)",params![job,a,root.join("export.pdf").to_str().unwrap()]).unwrap();
        fs::write(root.join("export.pdf"),"user file").unwrap();fs::write(root.join("incoming").join(format!("browser-{job}.pdf")),"cache").unwrap();
        assert_eq!(purge(&root,&json!({"ids":[a]})).unwrap()["count"],1);
        assert!(!library::item_dir(&root,&a).unwrap().exists());assert!(library::load(&root,&b).is_ok());
        assert_eq!(db.query_row("SELECT count(*) FROM article_documents",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(db.query_row("SELECT count(*) FROM article_history",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(db.query_row("SELECT count(*) FROM article_asset_meta",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert!(root.join("export.pdf").exists());assert!(!root.join("incoming").join(format!("browser-{job}.pdf")).exists());
        assert_eq!(db.query_row("SELECT count(*) FROM reading_pages",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        library::update(&root,&b,&json!({"trashed":true})).unwrap();
        assert_eq!(purge(&root,&json!({"all":true})).unwrap()["count"],1);
        assert_eq!(db.query_row("SELECT count(*) FROM reading_pages",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(purge(&root,&json!({"all":true})).unwrap()["count"],0);fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn refuses_busy_and_mixed_batches_then_recovers_interrupted_moves() {
        let root=std::env::temp_dir().join(format!("purge-{}",Uuid::new_v4()));library::init(&root).unwrap();let a=item(&root,"one");let b=item(&root,"two");
        library::update(&root,&a,&json!({"trashed":true})).unwrap();assert!(purge(&root,&json!({"ids":[a,b]})).is_err());assert!(library::load(&root,&a).is_ok());
        let db=library::db(&root).unwrap();db.execute("INSERT INTO exports(id,item_id,filename,status) VALUES(?1,?2,'x','queued')",params![Uuid::new_v4().to_string(),a]).unwrap();assert!(purge(&root,&json!({"ids":[a]})).is_err());
        let stage=root.join("deleting/interrupted");fs::create_dir_all(&stage).unwrap();fs::rename(library::item_dir(&root,&a).unwrap(),stage.join(&a)).unwrap();recover(&root).unwrap();assert!(library::load(&root,&a).is_ok());
        assert!(purge(&root,&json!({"ids":["../../wrong"]})).is_err());
        let orphan=Uuid::new_v4().to_string();fs::create_dir_all(root.join("deleting/committed").join(&orphan)).unwrap();recover(&root).unwrap();assert!(!root.join("deleting/committed").exists());fs::remove_dir_all(root).unwrap();
    }
}
