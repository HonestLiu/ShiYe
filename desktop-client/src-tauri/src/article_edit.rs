use crate::library::{self, err, Result};
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn init(c: &Connection) -> Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS article_documents(item_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,document TEXT,draft TEXT,updated_at INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS article_history(item_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(item_id,revision));CREATE TABLE IF NOT EXISTS article_asset_meta(item_id TEXT NOT NULL,asset_id TEXT NOT NULL,kind TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(item_id,asset_id));").map_err(err)
}
fn check_item(root: &Path, id: &str) -> Result<PathBuf> {
    let dir = library::item_dir(root, id)?;
    if !dir.join("archive.json").exists() {
        return Err("收藏不存在".into());
    }
    Ok(dir)
}
fn asset_path(root: &Path, id: &str, key: &str) -> Result<PathBuf> {
    if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("无效资源ID".into());
    }
    Ok(check_item(root, id)?
        .join("article-assets")
        .join(format!("{key}.json")))
}
pub fn asset_put(root: &Path, req: &Value) -> Result<Value> {
    let id = req["id"].as_str().ok_or("缺少收藏ID")?;
    let kind = req["kind"].as_str().ok_or("缺少资源类型")?;
    let mime = req["mime"].as_str().ok_or("缺少MIME")?;
    if !(kind == "image"
        && [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/avif",
            "image/svg+xml",
        ]
        .contains(&mime)
        || kind == "protected" && mime == "text/html")
    {
        return Err("不支持的资源类型".into());
    }
    let data = req["data"]
        .as_str()
        .filter(|s| s.len() <= 24 * 1024 * 1024)
        .ok_or("资源过大")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(err)?;
    if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
        return Err("资源需小于16MiB".into());
    }
    let key = format!(
        "{:x}",
        Sha256::digest([kind.as_bytes(), mime.as_bytes(), &bytes].concat())
    );
    let path = asset_path(root, id, &key)?;
    let asset = json!({"id":key,"kind":kind,"mime":mime,"data":data,"bytes":bytes.len()});
    if !path.exists() {
        let dir = path.parent().unwrap();
        fs::create_dir_all(dir).map_err(err)?;
        let total: u64 = fs::read_dir(dir)
            .map_err(err)?
            .flatten()
            .filter_map(|e| e.metadata().ok().map(|m| m.len()))
            .sum();
        if total + data.len() as u64 > 350 * 1024 * 1024 {
            return Err("此收藏的编辑资源超过256MiB预算".into());
        }
        let tmp = dir.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&tmp, serde_json::to_vec(&asset).map_err(err)?).map_err(err)?;
        fs::rename(tmp, path).map_err(err)?;
    }
    library::db(root)?.execute("INSERT OR IGNORE INTO article_asset_meta(item_id,asset_id,kind,mime,bytes) VALUES(?1,?2,?3,?4,?5)",params![id,key,kind,mime,bytes.len()]).map_err(err)?;
    Ok(json!({"id":key,"kind":kind,"mime":mime,"bytes":bytes.len()}))
}
pub fn asset_get(root: &Path, id: &str, key: &str) -> Result<Value> {
    serde_json::from_slice(&fs::read(asset_path(root, id, key)?).map_err(err)?).map_err(err)
}
fn valid_source_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}
fn validate(root: &Path, id: &str, v: &Value) -> Result<()> {
    if v["content"]["type"] != "doc"
        || v["schemaVersion"] != 1
        || v["htmlTemplate"].as_str().is_none()
        || v["text"].as_str().is_none()
        || serde_json::to_vec(v).map_err(err)?.len() > 4 * 1024 * 1024
    {
        return Err("编辑文档无效或超过4MiB".into());
    }
    if let Some(ledger) = v.get("sourceHighlights") {
        let entries = ledger.as_object().ok_or("原文高亮对应记录无效")?;
        if entries.len() > 2500
            || entries.iter().any(|(id, stamp)| {
                !valid_source_id(id) || stamp.as_str().is_none_or(|value| value.len() > 50000)
            })
        {
            return Err("原文高亮对应记录超限或无效".into());
        }
    }
    let c = library::db(root)?;
    let mut verified = std::collections::HashMap::<String, String>::new();
    let mut stack = vec![(&v["content"], 0)];
    let mut count = 0;
    while let Some((n, depth)) = stack.pop() {
        count += 1;
        if count > 50000 || depth > 80 {
            return Err("编辑文档结构过大".into());
        }
        let ty = n["type"].as_str().ok_or("缺少节点类型")?;
        if let Some(attrs) = n["attrs"].as_object() {
            if attrs.keys().any(|k| {
                ![
                    "level", "start", "language", "src", "alt", "title", "width", "height",
                    "asset", "label", "colspan", "rowspan", "colwidth", "align",
                ]
                .contains(&k.as_str())
            }) {
                return Err("编辑节点属性不支持".into());
            }
        }
        if ![
            "doc",
            "paragraph",
            "heading",
            "text",
            "blockquote",
            "bulletList",
            "orderedList",
            "listItem",
            "codeBlock",
            "hardBreak",
            "horizontalRule",
            "image",
            "table",
            "tableRow",
            "tableCell",
            "tableHeader",
            "protectedBlock",
            "protectedInline",
        ]
        .contains(&ty)
        {
            return Err("不支持的编辑节点".into());
        }
        if let Some(marks) = n["marks"].as_array() {
            for mark in marks {
                if ![
                    "bold",
                    "italic",
                    "strike",
                    "code",
                    "underline",
                    "link",
                    "highlight",
                ]
                .contains(&mark["type"].as_str().unwrap_or(""))
                {
                    return Err("不支持的文本格式".into());
                }
                if mark["type"] == "highlight" {
                    let attrs = mark["attrs"].as_object().ok_or("高亮属性无效")?;
                    let ids = mark["attrs"]["sourceIds"].as_str().ok_or("高亮来源无效")?;
                    if attrs
                        .keys()
                        .any(|key| !["color", "sourceIds"].contains(&key.as_str()))
                        || !["yellow", "green", "blue", "pink", "purple"]
                            .contains(&mark["attrs"]["color"].as_str().unwrap_or(""))
                        || ids.len() > 40500
                        || ids.split_whitespace().count() > 500
                        || ids.split_whitespace().any(|id| !valid_source_id(id))
                    {
                        return Err("高亮颜色或来源无效".into());
                    }
                }
                if mark["type"] == "link" {
                    let href = mark["attrs"]["href"].as_str().unwrap_or("");
                    if !["https://", "http://", "mailto:", "#"]
                        .iter()
                        .any(|p| href.starts_with(p))
                    {
                        return Err("链接协议不支持".into());
                    }
                }
            }
        }
        if ["image", "protectedBlock", "protectedInline"].contains(&ty) {
            let key = if ty == "image" {
                n["attrs"]["src"]
                    .as_str()
                    .unwrap_or("")
                    .strip_prefix("shiye-image:")
                    .ok_or("图片必须存为本地资源")?
            } else {
                n["attrs"]["asset"].as_str().ok_or("缺少内容块资源")?
            };
            if !asset_path(root, id, key)?.exists() {
                return Err("正文资源缺失".into());
            }
            let kind = if let Some(value) = verified.get(key) {
                value.clone()
            } else {
                let value: String = c
                    .query_row(
                        "SELECT kind FROM article_asset_meta WHERE item_id=?1 AND asset_id=?2",
                        params![id, key],
                        |r| r.get(0),
                    )
                    .map_err(err)?;
                verified.insert(key.to_owned(), value.clone());
                value
            };
            if (ty == "image") != (kind == "image") {
                return Err("资源类型不匹配".into());
            }
        }
        if let Some(children) = n["content"].as_array() {
            for child in children {
                stack.push((child, depth + 1));
            }
        }
    }
    Ok(())
}
pub fn metadata(root: &Path, id: &str) -> Result<Value> {
    let c = library::db(root)?;
    c.query_row("SELECT revision,updated_at,document IS NOT NULL,draft IS NOT NULL FROM article_documents WHERE item_id=?1",[id],|r|Ok(json!({"revision":r.get::<_,u64>(0)?,"updatedAt":r.get::<_,u64>(1)?,"hasDocument":r.get::<_,bool>(2)?,"hasDraft":r.get::<_,bool>(3)?}))).optional().map(|v|v.unwrap_or(json!({"revision":0,"hasDocument":false,"hasDraft":false}))).map_err(err)
}
pub fn get(root: &Path, id: &str) -> Result<Value> {
    check_item(root, id)?;
    let c = library::db(root)?;
    let row: Option<(u64, Option<String>, Option<String>, u64)> = c
        .query_row(
            "SELECT revision,document,draft,updated_at FROM article_documents WHERE item_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(err)?;
    let (rev, doc, draft, stamp) = row.unwrap_or((0, None, None, 0));
    let history:Vec<Value>=c.prepare("SELECT revision,updated_at FROM article_history WHERE item_id=?1 ORDER BY revision DESC LIMIT 20").map_err(err)?.query_map([id],|r|Ok(json!({"revision":r.get::<_,u64>(0)?,"updatedAt":r.get::<_,u64>(1)?}))).map_err(err)?.collect::<std::result::Result<_,_>>().map_err(err)?;
    Ok(
        json!({"revision":rev,"updatedAt":stamp,"document":doc.map(|s|serde_json::from_str::<Value>(&s)).transpose().map_err(err)?,"draft":draft.map(|s|serde_json::from_str::<Value>(&s)).transpose().map_err(err)?,"history":history}),
    )
}
pub fn save(root: &Path, req: &Value, draft: bool) -> Result<Value> {
    let id = req["id"].as_str().ok_or("缺少收藏ID")?;
    check_item(root, id)?;
    validate(root, id, &req["document"])?;
    let base = req["baseRevision"].as_u64().ok_or("缺少文档版本")?;
    let data = serde_json::to_string(&req["document"]).map_err(err)?;
    let mut c = library::db(root)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    tx.execute(
        "INSERT OR IGNORE INTO article_documents(item_id) VALUES(?1)",
        [id],
    )
    .map_err(err)?;
    let (rev, old, stamp): (u64, Option<String>, u64) = tx
        .query_row(
            "SELECT revision,document,updated_at FROM article_documents WHERE item_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(err)?;
    if base != rev {
        return Err(
            "编辑稿已在另一处更新；本次修改仍在当前编辑器中，请先保留内容再重新打开".into(),
        );
    }
    let time = now();
    if draft {
        tx.execute(
            "UPDATE article_documents SET draft=?1 WHERE item_id=?2",
            params![data, id],
        )
        .map_err(err)?;
    } else {
        if let Some(old) = old {
            tx.execute("INSERT OR REPLACE INTO article_history(item_id,revision,data,updated_at) VALUES(?1,?2,?3,?4)",params![id,rev,old,stamp]).map_err(err)?;
        }
        tx.execute("UPDATE article_documents SET revision=?1,document=?2,draft=NULL,updated_at=?3 WHERE item_id=?4",params![rev+1,data,time,id]).map_err(err)?;
        tx.execute("DELETE FROM article_history WHERE item_id=?1 AND revision NOT IN(SELECT revision FROM article_history WHERE item_id=?1 ORDER BY revision DESC LIMIT 20)",[id]).map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(
        json!({"revision":if draft{rev}else{rev+1},"updatedAt":time,"hasDocument":!draft||rev>0,"hasDraft":draft}),
    )
}
pub fn history(root: &Path, id: &str, rev: u64) -> Result<Value> {
    check_item(root, id)?;
    let s: String = library::db(root)?
        .query_row(
            "SELECT data FROM article_history WHERE item_id=?1 AND revision=?2",
            params![id, rev],
            |r| r.get(0),
        )
        .map_err(err)?;
    serde_json::from_str(&s).map_err(err)
}
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
pub fn render(root: &Path, id: &str) -> Result<Value> {
    let state = get(root, id)?;
    let doc = &state["document"];
    if doc.is_null() {
        return Err("此收藏尚无编辑稿".into());
    }
    let mut html = doc["htmlTemplate"].as_str().unwrap_or("").to_owned();
    let dir = check_item(root, id)?.join("article-assets");
    if dir.exists() {
        for entry in fs::read_dir(dir).map_err(err)?.flatten() {
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let filename = entry.file_name().to_string_lossy().into_owned();
            if !html.contains(filename.trim_end_matches(".json")) {
                continue;
            }
            let asset: Value =
                serde_json::from_slice(&fs::read(entry.path()).map_err(err)?).map_err(err)?;
            let key = asset["id"].as_str().unwrap_or("");
            if asset["kind"] == "image" {
                html = html.replace(
                    &format!("shiye-image:{key}"),
                    &format!(
                        "data:{};base64,{}",
                        asset["mime"].as_str().unwrap_or(""),
                        asset["data"].as_str().unwrap_or("")
                    ),
                );
            } else if html.contains(&format!("shiye-block:{key}")) {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(asset["data"].as_str().unwrap_or(""))
                    .map_err(err)?;
                html = html.replace(
                    &format!("shiye-block:{key}"),
                    &escape(&String::from_utf8(bytes).map_err(err)?),
                );
            }
        }
    }
    if html.len() > 256 * 1024 * 1024 {
        return Err("正文输出过大".into());
    }
    Ok(
        json!({"html":html,"text":doc["text"],"width":840,"mode":"article","revision":state["revision"],"warnings":[],"edited":true,"sourceHighlights":doc["sourceHighlights"]}),
    )
}
pub fn bundle(root: &Path, id: &str) -> Result<Value> {
    let mut state = get(root, id)?;
    let dir = check_item(root, id)?.join("article-assets");
    let mut assets = vec![];
    if dir.exists() {
        for entry in fs::read_dir(dir).map_err(err)?.flatten() {
            if entry.path().extension().and_then(|s| s.to_str()) == Some("json") {
                assets.push(
                    serde_json::from_slice::<Value>(&fs::read(entry.path()).map_err(err)?)
                        .map_err(err)?,
                );
            }
        }
    }
    let history=state["history"].as_array().unwrap().iter().map(|h|Ok(json!({"revision":h["revision"],"updatedAt":h["updatedAt"],"document":history(root,id,h["revision"].as_u64().unwrap())?}))).collect::<Result<Vec<_>>>()?;
    state["history"] = json!(history);
    state["assets"] = json!(assets);
    state["version"] = json!(1);
    Ok(state)
}
pub fn restore(root: &Path, id: &str, b: &Value) -> Result<()> {
    if b.is_null() {
        return Ok(());
    }
    if b["version"] != 1 {
        return Err("不支持的正文编辑版本".into());
    }
    if metadata(root, id)?["hasDocument"] == true || metadata(root, id)?["hasDraft"] == true {
        return Ok(());
    }
    for a in b["assets"].as_array().ok_or("编辑资源缺失")? {
        let mut req = a.clone();
        req["id"] = json!(id);
        let result = asset_put(root, &req)?;
        if result["id"] != a["id"] {
            return Err("编辑资源校验失败".into());
        }
    }
    for k in ["document", "draft"] {
        if !b[k].is_null() {
            validate(root, id, &b[k])?;
        }
    }
    let entries = b["history"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    for h in entries.iter().take(20) {
        validate(root, id, &h["document"])?;
        h["revision"].as_u64().ok_or("历史版本无效")?;
    }
    let mut c = library::db(root)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM article_documents WHERE item_id=?1 AND (document IS NOT NULL OR draft IS NOT NULL))", [id], |r| r.get(0)).map_err(err)?;
    if exists {
        return Ok(());
    }
    tx.execute("INSERT OR REPLACE INTO article_documents(item_id,revision,document,draft,updated_at) VALUES(?1,?2,?3,?4,?5)",params![id,b["revision"].as_u64().unwrap_or(0),b.get("document").filter(|v|!v.is_null()).map(Value::to_string),b.get("draft").filter(|v|!v.is_null()).map(Value::to_string),b["updatedAt"].as_u64().unwrap_or(0)]).map_err(err)?;
    for h in entries.iter().take(20) {
        tx.execute("INSERT OR IGNORE INTO article_history(item_id,revision,data,updated_at) VALUES(?1,?2,?3,?4)",params![id,h["revision"].as_u64().unwrap(),h["document"].to_string(),h["updatedAt"].as_u64().unwrap_or(0)]).map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (PathBuf, String, Value) {
        let root = std::env::temp_dir().join(format!("article-editor-{}", uuid::Uuid::new_v4()));
        library::init(&root).unwrap();
        let a = json!({"version":1,"source":"webpage","title":"剪藏","url":"https://example.test/","snapshot":{"html":"<h1>ORIGINAL_RAW</h1>"},"articleSnapshot":{"html":"<h1>CAPTURED_ARTICLE</h1>","mode":"article"}});
        let id = library::import(&root, a.clone()).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        (root, id, a)
    }
    fn document(text: &str) -> Value {
        json!({"schemaVersion":1,"content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]},"htmlTemplate":format!("<p>{text}</p>"),"text":text})
    }
    #[test]
    fn real_editor_fixture_roundtrip() {
        let Ok(path) = std::env::var("ARTICLE_EDITOR_FIXTURE") else {
            return;
        };
        let bundle: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let (root, id, mut archive) = setup();
        restore(&root, &id, &bundle).unwrap();
        let output = render(&root, &id).unwrap();
        let html = output["html"].as_str().unwrap();
        assert!(html.contains("EDITED_EXPORT_PROOF"));
        assert!(html.contains("GRAPH_PROOF"));
        assert!(!html.contains("shiye-image:"));
        assert!(!html.contains("shiye-block:"));
        archive["articleEditing"] = self::bundle(&root, &id).unwrap();
        assert!(
            archive["articleEditing"]["assets"]
                .as_array()
                .unwrap()
                .len()
                >= 2
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn drafts_revisions_conflicts_and_source_preserved() {
        let (r, id, a) = setup();
        let req = json!({"id":id,"baseRevision":0,"document":document("编辑草稿")});
        save(&r, &req, true).unwrap();
        assert_eq!(get(&r, &id).unwrap()["draft"]["text"], "编辑草稿");
        assert!(get(&r, &id).unwrap()["document"].is_null());
        save(&r, &req, false).unwrap();
        assert!(save(&r, &req, true).is_err());
        save(
            &r,
            &json!({"id":id,"baseRevision":1,"document":document("第二次修改")}),
            false,
        )
        .unwrap();
        assert_eq!(history(&r, &id, 1).unwrap()["text"], "编辑草稿");
        library::init(&r).unwrap();
        assert_eq!(get(&r, &id).unwrap()["revision"], 2);
        let loaded = library::load(&r, &id).unwrap();
        assert_eq!(loaded["snapshot"], a["snapshot"]);
        assert_eq!(loaded["articleSnapshot"], a["articleSnapshot"]);
        assert_eq!(metadata(&r, &id).unwrap()["hasDocument"], true);
        assert_eq!(library::search(&r, "第二次修改").unwrap()[0], id);
        fs::remove_dir_all(r).unwrap();
    }
    #[test]
    fn highlight_roundtrip_and_validation() {
        let (root, id, mut archive) = setup();
        let mut doc = document("已高亮的文字");
        doc["sourceHighlights"] = json!({"original-1":"123:revision-1"});
        doc["content"]["content"][0]["content"][0]["marks"] =
            json!([{"type":"highlight","attrs":{"color":"green","sourceIds":"original-1"}}]);
        doc["htmlTemplate"] = json!("<p><mark data-article-highlight=\"green\" data-source-highlights=\"original-1\" style=\"background-color:#bde8c7\">已高亮的文字</mark></p>");
        save(
            &root,
            &json!({"id":id,"baseRevision":0,"document":doc}),
            false,
        )
        .unwrap();
        let rendered = render(&root, &id).unwrap();
        assert_eq!(rendered["sourceHighlights"], doc["sourceHighlights"]);
        assert!(rendered["html"].as_str().unwrap().contains("#bde8c7"));
        archive["articleEditing"] = bundle(&root, &id).unwrap();
        let other =
            std::env::temp_dir().join(format!("highlight-restore-{}", uuid::Uuid::new_v4()));
        library::init(&other).unwrap();
        let id2 = library::import(&other, archive).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(get(&other, &id2).unwrap()["document"], doc);
        for bad_color in ["red", "url(https://invalid.test)"] {
            let mut bad = doc.clone();
            bad["content"]["content"][0]["content"][0]["marks"][0]["attrs"]["color"] =
                json!(bad_color);
            assert!(save(
                &root,
                &json!({"id":id,"baseRevision":1,"document":bad}),
                false
            )
            .is_err());
        }
        let mut bad = doc;
        bad["sourceHighlights"] = json!({"../escape":"123"});
        assert!(save(
            &root,
            &json!({"id":id,"baseRevision":1,"document":bad}),
            false
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(other).unwrap();
    }
    #[test]
    fn assets_validation_and_backup_roundtrip() {
        let (r, id, mut a) = setup();
        let asset = asset_put(
            &r,
            &json!({"id":id,"kind":"image","mime":"image/png","data":"aW1hZ2U="}),
        )
        .unwrap();
        let key = asset["id"].as_str().unwrap();
        let mut doc = document("有图片");
        doc["content"]["content"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"image","attrs":{"src":format!("shiye-image:{key}")}}));
        doc["htmlTemplate"] = json!(format!("<p>有图片</p><img src=\"shiye-image:{key}\">"));
        save(&r, &json!({"id":id,"baseRevision":0,"document":doc}), false).unwrap();
        assert!(render(&r, &id).unwrap()["html"]
            .as_str()
            .unwrap()
            .contains("data:image/png;base64,aW1hZ2U="));
        a["articleEditing"] = bundle(&r, &id).unwrap();
        let other = std::env::temp_dir().join(format!("article-restore-{}", uuid::Uuid::new_v4()));
        library::init(&other).unwrap();
        let id2 = library::import(&other, a).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(get(&other, &id2).unwrap()["document"]["text"], "有图片");
        assert_eq!(asset_get(&other, &id2, key).unwrap()["data"], "aW1hZ2U=");
        assert!(asset_get(&r, &id, "../../bad").is_err());
        let mut bad = document("bad");
        bad["content"]["content"][0]["type"] = json!("script");
        assert!(save(&r, &json!({"id":id,"baseRevision":1,"document":bad}), false).is_err());
        fs::remove_dir_all(r).unwrap();
        fs::remove_dir_all(other).unwrap();
    }
}
