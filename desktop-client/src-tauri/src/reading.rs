use crate::library::{db, err, Result};
use rusqlite::{params, TransactionBehavior};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};

pub fn url(value: &str) -> Result<String> {
    let mut u = tauri::Url::parse(value).map_err(err)?;
    if !["http", "https"].contains(&u.scheme())
        || !u.username().is_empty()
        || u.password().is_some()
        || value.len() > 8000
    {
        return Err("无效的笔记来源".into());
    }
    if !u
        .fragment()
        .is_some_and(|s| s.starts_with('/') || s.starts_with('!'))
    {
        u.set_fragment(None);
    }
    Ok(u.to_string())
}
pub fn empty(address: &str) -> Result<Value> {
    Ok(
        json!({"version":1,"url":url(address)?,"annotations":[],"deleted":[],"note":{"text":"","updatedAt":0,"mutationId":""},"meta":{"title":"","folder":"","tags":"","starred":false,"read":false,"updatedAt":0,"mutationId":""}}),
    )
}
fn text(v: &Value, max: usize) -> Result<()> {
    if v.as_str().is_some_and(|s| s.encode_utf16().count() <= max) {
        Ok(())
    } else {
        Err("笔记字段无效或过长".into())
    }
}
fn stamp(v: &Value) -> Result<()> {
    if !v["updatedAt"]
        .as_u64()
        .is_some_and(|n| n <= (crate::library::now() + 86400) * 1000)
    {
        return Err("无效的笔记版本".into());
    }
    text(&v["mutationId"], 80)
}
fn id(v: &Value) -> Result<()> {
    if v.as_str().is_some_and(|s| {
        !s.is_empty() && s.len() <= 80 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    }) {
        Ok(())
    } else {
        Err("无效的标注ID".into())
    }
}
fn newer(a: &Value, b: &Value) -> bool {
    a["updatedAt"].as_u64().unwrap_or(0) > b["updatedAt"].as_u64().unwrap_or(0)
        || a["updatedAt"] == b["updatedAt"]
            && a["mutationId"].as_str().unwrap_or("") > b["mutationId"].as_str().unwrap_or("")
}
pub fn validate(v: &Value, address: &str) -> Result<Value> {
    if v["version"] != 1
        || url(v["url"].as_str().ok_or("缺少笔记来源")?)? != url(address)?
        || serde_json::to_vec(v).map_err(err)?.len() > 512 * 1024
    {
        return Err("笔记来源不匹配或超过512KiB".into());
    }
    let annotations = v["annotations"]
        .as_array()
        .filter(|a| a.len() <= 500)
        .ok_or("标注数量超限")?;
    let deleted = v["deleted"]
        .as_array()
        .filter(|a| a.len() <= 2000)
        .ok_or("删除记录数量超限")?;
    let mut ids = std::collections::BTreeSet::new();
    for a in annotations {
        id(&a["id"])?;
        if !ids.insert(a["id"].as_str().unwrap()) {
            return Err("重复的标注ID".into());
        }
        stamp(a)?;
        if !["yellow", "green", "blue", "pink", "purple"]
            .contains(&a["color"].as_str().unwrap_or(""))
        {
            return Err("无效的标注颜色".into());
        }
        text(&a["note"], 20000)?;
        let s = &a["selector"];
        text(&s["exact"], 12000)?;
        if let Some(display) = s.get("display") {
            text(display, 12000)?;
        }
        if s["exact"].as_str().unwrap().trim().is_empty() {
            return Err("标注正文不能为空".into());
        }
        text(&s["prefix"], 100)?;
        text(&s["suffix"], 100)?;
        let start = s["start"]
            .as_u64()
            .filter(|n| *n <= 10000000)
            .ok_or("无效的标注位置")?;
        let end = s["end"]
            .as_u64()
            .filter(|n| *n <= 10000000)
            .ok_or("无效的标注位置")?;
        if end.checked_sub(start)
            != Some(s["exact"].as_str().unwrap().encode_utf16().count() as u64)
        {
            return Err("无效的标注范围".into());
        }
    }
    for d in deleted {
        id(&d["id"])?;
        stamp(d)?;
    }
    if let Some(cleared) = v.get("cleared") { stamp(cleared)?; }
    stamp(&v["note"])?;
    text(&v["note"]["text"], 100000)?;
    stamp(&v["meta"])?;
    for (k, n) in [("title", 300), ("folder", 100), ("tags", 500)] {
        text(&v["meta"][k], n)?;
    }
    if !v["meta"]["read"].is_boolean() || !v["meta"]["starred"].is_boolean() {
        return Err("无效的收藏状态".into());
    }
    let mut out = v.clone();
    out["url"] = json!(url(address)?);
    Ok(out)
}
fn combine(a: &Value, b: &Value) -> Result<Value> {
    let address = a["url"].as_str().unwrap();
    let mut out = empty(address)?;
    let mut entries = BTreeMap::new();
    let mut deleted = BTreeMap::new();
    for side in [a, b] {
        for d in side["deleted"].as_array().unwrap() {
            let key = d["id"].as_str().unwrap();
            if deleted.get(key).is_none_or(|old| newer(d, old)) {
                deleted.insert(key.to_owned(), d.clone());
            }
        }
        for mark in side["annotations"].as_array().unwrap() {
            let key = mark["id"].as_str().unwrap();
            if entries.get(key).is_none_or(|old| newer(mark, old)) {
                entries.insert(key.to_owned(), mark.clone());
            }
        }
    }
    let cleared = match (a.get("cleared"), b.get("cleared")) {
        (Some(a), Some(b)) => Some(if newer(b,a) { b } else { a }),
        (Some(a), None) => Some(a), (None, Some(b)) => Some(b), _ => None
    };
    if let Some(clear) = cleared { out["cleared"] = clear.clone(); }
    let mut marks: Vec<Value> = entries
        .into_values()
        .filter(|a| {
            cleared.is_none_or(|clear| newer(a, clear)) && deleted
                .get(a["id"].as_str().unwrap())
                .is_none_or(|d| newer(a, d))
        })
        .collect();
    marks.sort_by_key(|a| a["selector"]["start"].as_u64().unwrap());
    out["annotations"] = json!(marks);
    out["deleted"] = json!(deleted.into_values().filter(|d| cleared.is_none_or(|clear| !newer(clear,d))).collect::<Vec<_>>());
    for field in ["note", "meta"] {
        out[field] = if newer(&b[field], &a[field]) {
            b[field].clone()
        } else {
            a[field].clone()
        };
    }
    if let Some(clear) = cleared { if !newer(&out["note"], clear) { out["note"] = json!({"text":"","updatedAt":clear["updatedAt"],"mutationId":clear["mutationId"]}); } }
    validate(&out, address)
}
pub fn get(root: &Path, address: &str) -> Result<Value> {
    let key = url(address)?;
    let c = db(root)?;
    let raw: Option<String> = c
        .query_row("SELECT data FROM reading_pages WHERE url=?1", [&key], |r| {
            r.get(0)
        })
        .optional()
        .map_err(err)?;
    match raw {
        Some(s) => validate(&serde_json::from_str(&s).map_err(err)?, &key),
        None => empty(&key),
    }
}
use rusqlite::OptionalExtension;
pub fn preview(root: &Path, address: &str, incoming: &Value) -> Result<Value> {
    combine(&get(root, address)?, &validate(incoming, address)?)
}
pub fn merge(root: &Path, address: &str, incoming: &Value) -> Result<Value> {
    let incoming = validate(incoming, address)?;
    let key = url(address)?;
    let mut c = db(root)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let raw: Option<String> = tx
        .query_row("SELECT data FROM reading_pages WHERE url=?1", [&key], |r| {
            r.get(0)
        })
        .optional()
        .map_err(err)?;
    let old = match raw {
        Some(s) => validate(&serde_json::from_str(&s).map_err(err)?, &key)?,
        None => empty(&key)?,
    };
    let out = combine(&old, &incoming)?;
    if out == old { return Ok(out); }
    let searchable = out["annotations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            format!(
                "{} {}",
                a["selector"]["exact"].as_str().unwrap(),
                a["note"].as_str().unwrap()
            )
        })
        .chain([out["note"]["text"].as_str().unwrap().to_owned()])
        .collect::<Vec<_>>()
        .join("\n");
    tx.execute("INSERT INTO reading_pages(url,data,text) VALUES(?1,?2,?3) ON CONFLICT(url) DO UPDATE SET data=excluded.data,text=excluded.text",params![key,serde_json::to_string(&out).map_err(err)?,searchable]).map_err(err)?;
    // Existing snapshots of the same source share reading notes and organisation.
    let items: Vec<(String, String)> = tx
        .prepare("SELECT id,url FROM items")
        .map_err(err)?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(err)?
        .collect::<std::result::Result<_, _>>()
        .map_err(err)?;
    for (id, address) in items {
        if url(&address).ok().as_deref() != Some(&key) {
            continue;
        }
        if newer(&out["meta"], &old["meta"]) {
            let m = &out["meta"];
            tx.execute(
                "UPDATE items SET folder=?1,tags=?2,starred=?3,read=?4 WHERE id=?5",
                params![
                    m["folder"].as_str().unwrap(),
                    m["tags"].as_str().unwrap(),
                    m["starred"].as_bool().unwrap(),
                    m["read"].as_bool().unwrap(),
                    id
                ],
            )
            .map_err(err)?;
        }
        if newer(&out["note"], &old["note"]) {
            tx.execute(
                "UPDATE items SET notes=?1 WHERE id=?2",
                params![out["note"]["text"].as_str().unwrap(), id],
            )
            .map_err(err)?;
        }
    }
    tx.commit().map_err(err)?;
    std::fs::write(root.join("reading-revision"), uuid::Uuid::new_v4().to_string()).map_err(err)?;
    Ok(out)
}
pub fn all(root: &Path) -> Result<Value> {
    let c = db(root)?;
    let rows = c
        .prepare("SELECT data FROM reading_pages")
        .map_err(err)?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(json!(rows
        .into_iter()
        .map(|s| serde_json::from_str::<Value>(&s).map_err(err))
        .collect::<Result<Vec<_>>>()?))
}
// Bounded inventory; each record is transferred separately to fit Native Messaging limits.
pub fn inventory(root: &Path, after: &str) -> Result<Value> {
    let c = db(root)?;
    let rows = c.prepare("SELECT url FROM reading_pages WHERE url > ?1 ORDER BY url LIMIT 51").map_err(err)?
        .query_map([after], |r| r.get::<_, String>(0)).map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>().map_err(err)?;
    let more = rows.len() > 50;
    let urls: Vec<_> = rows.into_iter().take(50).collect();
    Ok(json!({"urls":urls,"next":if more {urls.last().cloned()} else {None},"revision":revision(root)}))
}
pub fn revision(root: &Path) -> String {
    std::fs::read_to_string(root.join("reading-revision")).unwrap_or_else(|_| "initial".into())
}
pub fn markdown(record: &Value) -> Result<String> {
    let r = validate(record, record["url"].as_str().ok_or("缺少笔记来源")?)?;
    let title = r["meta"]["title"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("阅读笔记");
    let mut lines = vec![format!("# {title}\n\n{}\n", r["url"].as_str().unwrap())];
    for (field, label) in [("folder", "收藏夹"), ("tags", "标签")] {
        let s = r["meta"][field].as_str().unwrap();
        if !s.is_empty() {
            lines.push(format!("{label}：{s}\n"));
        }
    }
    let note = r["note"]["text"].as_str().unwrap();
    if !note.is_empty() {
        lines.push(format!("## 阅读笔记\n\n{note}\n"));
    }
    for a in r["annotations"].as_array().unwrap() {
        lines.push(format!(
            "> {}\n",
            a["selector"]["display"]
                .as_str()
                .or(a["selector"]["exact"].as_str())
                .unwrap()
                .replace('\n', "\n> ")
        ));
        let note = a["note"].as_str().unwrap();
        if !note.is_empty() {
            lines.push(format!("{note}\n"));
        }
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn page_deletion_barrier_survives_old_copies_and_allows_new_notes() {
        let root = std::env::temp_dir().join(format!("reading-clear-{}", uuid::Uuid::new_v4()));
        crate::library::init(&root).unwrap();
        let address = "https://example.test/delete";
        let mut old = empty(address).unwrap();
        old["note"] = json!({"text":"old note","updatedAt":10,"mutationId":"old"});
        old["annotations"] = json!([{"id":"old-mark","selector":{"exact":"原","prefix":"","suffix":"","start":0,"end":1},"note":"批注","color":"yellow","updatedAt":10,"mutationId":"old"}]);
        merge(&root,address,&old).unwrap();
        let mut cleared = empty(address).unwrap();
        cleared["cleared"] = json!({"updatedAt":20,"mutationId":"delete"});
        let result = merge(&root,address,&cleared).unwrap();
        assert_eq!(result["note"]["text"], "");
        assert!(result["annotations"].as_array().unwrap().is_empty());
        assert!(merge(&root,address,&old).unwrap()["annotations"].as_array().unwrap().is_empty());
        let rev = revision(&root);
        merge(&root,address,&old).unwrap();
        assert_eq!(rev,revision(&root),"unchanged sync must not generate revision loops");
        old["annotations"][0]["id"] = json!("new-mark");
        old["annotations"][0]["updatedAt"] = json!(30);
        assert_eq!(merge(&root,address,&old).unwrap()["annotations"].as_array().unwrap().len(),1);
        assert_eq!(inventory(&root,"").unwrap()["urls"].as_array().unwrap().len(),1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn merged_capacity_rejects_before_snapshot_import() {
        let root = std::env::temp_dir().join(format!("reading-cap-{}", uuid::Uuid::new_v4()));
        crate::library::init(&root).unwrap();
        let address = "https://example.test/limit";
        let mut existing = empty(address).unwrap();
        let mark = |n: usize| json!({"id":format!("mark-{n}"),"selector":{"exact":"原","prefix":"","suffix":"","start":0,"end":1},"note":"","color":"yellow","updatedAt":10,"mutationId":"test"});
        existing["annotations"] = json!((0..500).map(mark).collect::<Vec<_>>());
        merge(&root, address, &existing).unwrap();
        let mut incoming = empty(address).unwrap();
        incoming["annotations"] = json!([mark(500)]);
        let archive = json!({"version":1,"url":address,"title":"不应部分导入","snapshot":{"html":"<p>原文</p>"},"reading":incoming});
        assert!(crate::library::import(&root, archive).is_err());
        assert!(crate::library::list(&root)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(std::fs::read_dir(root.join("items")).unwrap().count(), 0);
        assert_eq!(
            get(&root, address).unwrap()["annotations"]
                .as_array()
                .unwrap()
                .len(),
            500
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn archive_notes_dedup_search_and_roundtrip() {
        let root = std::env::temp_dir().join(format!("reading-archive-{}", uuid::Uuid::new_v4()));
        crate::library::init(&root).unwrap();
        let address = "https://example.test/post#part";
        let html = "<h1>原始快照</h1><p>原文重点</p>";
        let mut record = empty(address).unwrap();
        record["meta"] = json!({"title":"阅读标题","folder":"学习","tags":"复习","starred":true,"read":false,"updatedAt":5,"mutationId":"m"});
        record["note"] = json!({"text":"整页思考","updatedAt":6,"mutationId":"n"});
        record["annotations"] = json!([{"id":"one","selector":{"exact":"原文重点","prefix":"原始快照","suffix":"","start":4,"end":8},"color":"yellow","note":"重要批注","updatedAt":7,"mutationId":"a"}]);
        let mut archive = json!({"version":1,"source":"webpage","url":address,"title":"测试文章","text":"原文重点","snapshot":{"html":html},"reading":record});
        let saved = crate::library::import(&root, archive.clone()).unwrap();
        let id = saved["id"].as_str().unwrap();
        assert_eq!(
            crate::library::load(&root, id).unwrap()["library"]["folder"],
            "学习"
        );
        assert_eq!(crate::library::search(&root, "重要批注").unwrap()[0], id);
        let mut next = record.clone();
        next["note"] = json!({"text":"更新后的想法","updatedAt":8,"mutationId":"next"});
        archive["reading"] = next;
        let duplicate = crate::library::import(&root, archive.clone()).unwrap();
        assert_eq!(duplicate["id"], id);
        assert_eq!(duplicate["duplicate"], true);
        let loaded = crate::library::load(&root, id).unwrap();
        assert_eq!(loaded["snapshot"]["html"], html);
        assert_eq!(loaded["reading"]["note"]["text"], "更新后的想法");
        assert_eq!(loaded["library"]["notes"], "更新后的想法");
        assert!(
            crate::library::export_contents(&loaded, "md", &Value::Null, &json!("原文"))
                .unwrap()
                .contains("重要批注")
        );
        crate::library::update(
            &root,
            id,
            &json!({"notes":"整理窗口的新笔记","tags":"新标签"}),
        )
        .unwrap();
        let updated = get(&root, address).unwrap();
        assert_eq!(updated["note"]["text"], "整理窗口的新笔记");
        assert_eq!(updated["meta"]["tags"], "新标签");
        assert_eq!(
            crate::library::search(&root, "整理窗口的新笔记").unwrap()[0],
            id
        );
        let restored =
            std::env::temp_dir().join(format!("reading-restored-{}", uuid::Uuid::new_v4()));
        crate::library::init(&restored).unwrap();
        for p in all(&root).unwrap().as_array().unwrap() {
            merge(&restored, p["url"].as_str().unwrap(), p).unwrap();
        }
        let loaded = crate::library::load(&root, id).unwrap();
        let new_id = crate::library::import(&restored, loaded).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            crate::library::load(&restored, &new_id).unwrap()["reading"],
            updated
        );
        archive["reading"]["url"] = json!("https://other.test/");
        assert!(crate::library::import(&root, archive).is_err());
        assert_eq!(
            crate::library::list(&root)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(restored).unwrap();
    }
    #[test]
    fn reading_merge_deletions_and_validation() {
        let root = std::env::temp_dir().join(format!("reading-{}", uuid::Uuid::new_v4()));
        crate::library::init(&root).unwrap();
        let address = "https://example.test/article#heading";
        let mut r = empty(address).unwrap();
        r["annotations"] = json!([{"id":"mark-1","selector":{"exact":"原文😀","prefix":"","suffix":"","start":0,"end":4},"note":"批注正文","color":"green","updatedAt":10,"mutationId":"a"}]);
        merge(&root, address, &r).unwrap();
        assert_eq!(
            get(&root, "https://example.test/article#other").unwrap()["annotations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut delete = empty(address).unwrap();
        delete["deleted"] = json!([{"id":"mark-1","updatedAt":20,"mutationId":"b"}]);
        merge(&root, address, &delete).unwrap();
        assert!(merge(&root, address, &r).unwrap()["annotations"]
            .as_array()
            .unwrap()
            .is_empty());
        let mut edit = r.clone();
        edit["annotations"][0]["updatedAt"] = json!(30);
        assert_eq!(
            merge(&root, address, &edit).unwrap()["annotations"][0]["note"],
            "批注正文"
        );
        edit["url"] = json!("https://other.test/");
        assert!(merge(&root, address, &edit).is_err());
        edit = r.clone();
        edit["annotations"][0]["selector"]["end"] = json!(3);
        assert!(merge(&root, address, &edit).is_err());
        assert!(url("file:///private/key").is_err());
        assert!(url("https://user:pass@example.test/").is_err());
        assert_ne!(
            url("https://example.test/#/a").unwrap(),
            url("https://example.test/#/b").unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
