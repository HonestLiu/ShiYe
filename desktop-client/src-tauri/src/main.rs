#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use tauri::Emitter;
mod batch;
mod bridge;
mod library;
mod reading;
mod service;
mod connections;
use library::{err, Result};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, sync::Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
struct PrintJobs(Mutex<HashMap<String, String>>);
fn require_main(window: &WebviewWindow) -> Result<()> {
    if window.label() != "main" {
        Err("阅读文档没有应用权限".into())
    } else {
        Ok(())
    }
}
#[tauri::command]
async fn load_archive_bytes(window: WebviewWindow,id: String) -> Result<tauri::ipc::Response> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let archive=library::load(&library::root(),&id)?;
        Ok(tauri::ipc::Response::new(serde_json::to_vec(&archive).map_err(err)?))
    }).await.map_err(err)?
}
#[tauri::command]
async fn command(window: WebviewWindow, app: tauri::AppHandle, request: Value) -> Result<Value> {
    // Keep archive/file/SQLite work off AppKit's event thread. Permission checks
    // remain in the shared dispatcher, for both execution paths.
    if ["load","list","search","update","reading_get","reading_list","reading_merge","export_file","import_file","backup"].contains(&request["action"].as_str().unwrap_or("")) {
        return tauri::async_runtime::spawn_blocking(move || command_dispatch(window,app,request)).await.map_err(err)?;
    }
    // Clipboard, native windows and activation policy must stay on AppKit.
    let (tx,rx)=std::sync::mpsc::sync_channel(1);let handle=app.clone();
    app.run_on_main_thread(move ||{let _=tx.send(command_dispatch(window,handle,request));}).map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(err)?).await.map_err(err)?
}
fn command_dispatch(window: WebviewWindow, app: tauri::AppHandle, request: Value) -> Result<Value> {
    let action = request["action"].as_str().unwrap_or("");
    if window.label() == "worker" {
        if ![
            "pending_exports",
            "claim_export",
            "finish_export",
            "load_export",
            "write_export",
            "prepare_export",
            "show_main",
            "service_idle",
        ]
        .contains(&action)
        {
            return Err("后台任务没有此权限".into());
        }
    } else if window.label() == "settings" {
        if !["info", "settings", "save_settings", "register", "backup", "import_file", "show_main", "connections", "connection_check", "unpair"].contains(&action) { return Err("设置窗口没有此权限".into()); }
    } else {
        require_main(&window)?;
    }
    let root = library::root();
    let id = request["id"].as_str().unwrap_or("");
    match request["action"].as_str().unwrap_or("") {
        "batch_update" => batch::update(&root, &request),
        "batch_create" => {
            let result = batch::create(&root, &request)?;
            service::ensure_worker(&app)?;
            Ok(result)
        }
        "batch_list" => batch::list(&root),
        "batch_cancel" => {
            batch::cancel(&root, request["batchId"].as_str().ok_or("缺少批量任务ID")?)
        }
        "write_export" => batch::write_export(&root, &request),
        "copy_text" => {
            let text = request["text"]
                .as_str()
                .filter(|s| s.len() <= 8 * 1024 * 1024)
                .ok_or("代码内容过长")?;
            #[cfg(target_os = "macos")]
            {
                use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
                use objc2_foundation::NSString;
                let board = NSPasteboard::generalPasteboard();
                board.clearContents();
                if !board
                    .setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString })
                {
                    return Err("无法写入系统剪贴板".into());
                }
                Ok(json!({"ok":true}))
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = text;
                Err("此平台暂不支持复制".into())
            }
        }
        "open_settings" => {
            service::show_settings(&app, request["section"].as_str().unwrap_or("general"))?;
            Ok(json!({"ok":true}))
        }
        "settings" => Ok(service::settings(&root)),
        "save_settings" => {
            let v = service::save_settings(&root, &request["settings"])?;
            service::apply_policy(&app)?;
            Ok(v)
        }
        "enter_lightweight" => {
            let mut v = service::settings(&root);
            v["lightweight"] = json!(true);
            service::save_settings(&root, &v)?;
            service::apply_policy(&app)?;
            window.close().map_err(err)?;
            Ok(json!({"ok":true}))
        }
        "show_main" => {
            service::show_main(&app)?;
            Ok(json!({"ok":true}))
        }
        "service_idle" => {
            let idle = library::pending_exports(&root)?
                .as_array()
                .is_some_and(|v| v.is_empty());
            if idle && window.label() == "worker" {
                window.close().map_err(err)?;
            }
            Ok(json!({"idle":idle}))
        }
        "prepare_export" => {
            let job_id = request["jobId"].as_str().ok_or("缺少任务ID")?;
            let job = library::export_status(&root, job_id)?;
            if job["batchId"] != "" {
                return Ok(json!({"delivery":"client","path":job["path"]}));
            }
            if job["delivery"] == "browser" {
                Ok(json!({"delivery":"browser","path":library::browser_export_path(&root,job_id)?}))
            } else {
                service::show_main(&app)?;
                Ok(json!({"delivery":"client"}))
            }
        }
        "reading_list"=>reading::all(&root),
        "reading_get"=>reading::get(&root,request["url"].as_str().ok_or("缺少笔记来源")?),
        "reading_merge"=>{let result=reading::merge(&root,request["url"].as_str().ok_or("缺少笔记来源")?,&request["record"])?;let _=app.emit("reading-changed",json!({"url":result["url"]}));let _=app.emit("library-changed",json!({}));Ok(result)},
        "list" => library::list(&root),
        "pending_exports" => library::pending_exports(&root),
        "claim_export" => {
            library::claim_export(&root, request["jobId"].as_str().ok_or("缺少任务ID")?)
        }
        "finish_export" => library::finish_export(&root, &request),
        "search" => library::search(&root, request["query"].as_str().unwrap_or("")),
        "load" => library::load(&root, id),
        "load_export" => {
            library::load_export(&root, request["jobId"].as_str().ok_or("缺少任务ID")?)
        }
        "update" => {let result=library::update(&root,id,&request["patch"])?;if ["title","folder","tags","starred","read","notes"].iter().any(|k|request["patch"].get(k).is_some()){let _=app.emit("reading-changed",json!({}));}Ok(result)},
        "register" => { let id=request["extensionId"].as_str().unwrap_or(""); let result=bridge::register(&root,id)?; connections::save_label(&root,id,request["label"].as_str().unwrap_or(""))?; Ok(result) },
        "connections" => app.state::<connections::Monitor>().snapshot(&root),
        "connection_check" => app.state::<connections::Monitor>().check(request["sessionId"].as_str().ok_or("缺少连接ID")?),
        "unpair" => { bridge::unregister(&root,request["extensionId"].as_str().ok_or("缺少扩展ID")?)?; Ok(json!({"ok":true})) },
        "info" => Ok(
            json!({"dataDir":root,"platform":std::env::consts::OS,"nativePdf":cfg!(target_os="macos"),"version":"0.10.2"}),
        ),
        "import_file" => {
            let path = request["path"].as_str().ok_or("缺少文件路径")?;
            if fs::metadata(path).map_err(err)?.len() > 256 * 1024 * 1024 {
                return Err("导入文件超过256MiB".into());
            }
            let data = fs::read_to_string(path).map_err(err)?;
            if path.to_lowercase().ends_with(".html") || path.to_lowercase().ends_with(".htm") {
                library::import(
                    &root,
                    json!({"version":1,"title":std::path::Path::new(path).file_stem().and_then(|s|s.to_str()).unwrap_or("导入网页"),"url":"","source":"html","snapshot":{"html":data},"text":"","warnings":["直接导入的HTML只保留文件内嵌资源；建议通过扩展保存完整快照。"]}),
                )
            } else {
                let value: Value = serde_json::from_str(&data).map_err(err)?;
                if value["backupVersion"] == 1 {
                    if let Some(pages)=value["readingPages"].as_array(){for page in pages{reading::merge(&root,page["url"].as_str().ok_or("缺少笔记来源")?,page)?;}}
                    let mut count = 0;
                    for item in value["items"].as_array().ok_or("无效备份")? {
                        let result = library::import(&root, item["archive"].clone())?;
                        library::update(&root, result["id"].as_str().unwrap(), &item["meta"])?;
                        count += 1;
                    }
                    Ok(json!({"count":count}))
                } else {
                    library::import(&root, value)
                }
            }
        }
        "export_notes"=>{let record=reading::get(&root,request["url"].as_str().ok_or("缺少笔记来源")?)?;fs::write(request["path"].as_str().ok_or("缺少保存路径")?,reading::markdown(&record)?).map_err(err)?;Ok(json!({"ok":true}))},
        "export_file" => {
            let path = request["path"].as_str().ok_or("缺少保存路径")?;
            let format = request["format"].as_str().ok_or("缺少格式")?;
            let archive = library::load(&root, id)?;
            let data =
                library::export_contents(&archive, format, &request["html"], &request["text"])?;
            fs::write(path, data).map_err(err)?;
            Ok(json!({"ok":true}))
        }
        "backup" => {
            let path = request["path"].as_str().ok_or("缺少保存路径")?;
            let entries = library::list(&root)?;
            let mut items = Vec::new();
            for meta in entries.as_array().unwrap() {
                items.push(json!({"archive":library::load(&root,meta["id"].as_str().unwrap())?,"meta":meta}));
            }
            let data =
                serde_json::to_vec(&json!({"backupVersion":1,"items":items,"readingPages":reading::all(&root)?})).map_err(err)?;
            fs::write(path, data).map_err(err)?;
            Ok(json!({"ok":true}))
        }
        "open_source" => {
            let url = request["url"].as_str().ok_or("缺少链接")?;
            let parsed = tauri::Url::parse(url).map_err(err)?;
            if !["https", "http"].contains(&parsed.scheme()) {
                return Err("只允许打开网页链接".into());
            }
            #[cfg(target_os = "macos")]
            {
                std::process::Command::new("/usr/bin/open")
                    .arg(url)
                    .spawn()
                    .map_err(err)?;
            }
            Ok(json!({"ok":true}))
        }
        _ => Err("未知操作".into()),
    }
}
#[cfg(target_os = "macos")]
unsafe fn capture_pages(
    view: *const objc2_web_kit::WKWebView,
    cuts: std::sync::Arc<Vec<f64>>,
    width: f64,
    index: usize,
    folder: std::path::PathBuf,
    sender: std::sync::Arc<Mutex<Option<std::sync::mpsc::Sender<Result<()>>>>>,
) {
    use objc2_foundation::{NSData, NSError, NSPoint, NSRect, NSSize};
    if index >= cuts.len() - 1 {
        if let Some(tx) = sender.lock().unwrap().take() {
            let _ = tx.send(Ok(()));
        }
        return;
    }
    let config = objc2_web_kit::WKPDFConfiguration::new(objc2::MainThreadMarker::new().unwrap());
    config.setRect(NSRect::new(
        NSPoint::new(0., cuts[index]),
        NSSize::new(width, cuts[index + 1] - cuts[index]),
    ));
    let callback = block2::RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
        let result = if !error.is_null() {
            Err((*error).localizedDescription().to_string())
        } else if data.is_null() {
            Err("系统未返回PDF".into())
        } else {
            fs::write(folder.join(format!("{index}.pdf")), (*data).to_vec()).map_err(err)
        };
        if let Err(error) = result {
            if let Some(tx) = sender.lock().unwrap().take() {
                let _ = tx.send(Err(error));
            }
        } else {
            capture_pages(
                view,
                cuts.clone(),
                width,
                index + 1,
                folder.clone(),
                sender.clone(),
            );
        }
    });
    (*view).createPDFWithConfiguration_completionHandler(Some(&config), &callback);
}
#[tauri::command]
async fn print_pdf(
    window: WebviewWindow,
    app: tauri::AppHandle,
    html: String,
    path: String,
    layout: Value,
    job_id: Option<String>,
) -> Result<Value> {
    if window.label() != "worker" {
        require_main(&window)?;
    }
    if !cfg!(target_os = "macos") {
        return Err("当前预览版尚未提供此平台的PDF导出".into());
    }
    let batch_output = if let Some(id) = job_id.as_deref() {
        let job = library::export_status(&library::root(), &id)?;
        if job["batchId"] != "" {
            if job["path"] != path {
                return Err("批量输出位置不匹配".into());
            }
            true
        } else {
            false
        }
    } else {
        false
    };
    let width = layout["width"].as_f64().ok_or("缺少页面宽度")?;
    let height = layout["height"].as_f64().ok_or("缺少页面高度")?;
    if width <= 0. || height <= 0. || height > 500_000. || width > 20_000. {
        return Err("页面尺寸超出导出范围".into());
    }
    let cuts = layout["cuts"]
        .as_array()
        .ok_or("缺少分页数据")?
        .iter()
        .map(|v| v.as_f64().ok_or_else(|| "分页数据无效".to_string()))
        .collect::<Result<Vec<_>>>()?;
    if cuts.len() < 2
        || cuts.len() > 1000
        || cuts[0] != 0.
        || cuts.last().copied() != Some(height)
        || cuts.windows(2).any(|p| p[1] <= p[0])
    {
        return Err("分页数据无效".into());
    }
    let key = uuid::Uuid::new_v4().to_string();
    let label = format!("print-{key}");
    app.state::<PrintJobs>()
        .0
        .lock()
        .map_err(err)?
        .insert(key.clone(), html);
    let temporary = library::root().join("incoming").join(format!("pdf-{key}"));
    fs::create_dir(&temporary).map_err(err)?;
    let continuous = temporary.clone();
    let output = continuous.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let sender = Mutex::new(Some(sender));
    let build = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::External(tauri::Url::parse(&format!("archive://{key}/")).map_err(err)?),
    )
    .title("正在生成 PDF")
    .inner_size(900., 1000.)
    .visible(false)
    .disable_javascript()
    .on_navigation(|url| url.scheme() == "archive")
    .on_page_load(move |view, payload| {
        if payload.event() != tauri::webview::PageLoadEvent::Finished {
            return;
        }
        let Some(tx) = sender.lock().ok().and_then(|mut s| s.take()) else {
            return;
        };
        let output = output.clone();
        let cuts = cuts.clone();
        let _ = view.with_webview(move |webview| {
            #[cfg(target_os = "macos")]
            unsafe {
                capture_pages(
                    webview.inner().cast(),
                    std::sync::Arc::new(cuts),
                    width,
                    0,
                    output,
                    std::sync::Arc::new(Mutex::new(Some(tx))),
                );
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = tx.send(Err::<(), String>("未支持的PDF平台".into()));
            }
        });
    })
    .build();
    if let Err(e) = build {
        app.state::<PrintJobs>().0.lock().map_err(err)?.remove(&key);
        return Err(err(e));
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(std::time::Duration::from_secs(120))
            .map_err(err)?
    })
    .await
    .map_err(err)?;
    if let Some(view) = app.get_webview_window(&label) {
        let _ = view.close();
    }
    app.state::<PrintJobs>().0.lock().map_err(err)?.remove(&key);
    result?;
    let layout_path = temporary.with_extension("json");
    fs::write(&layout_path, serde_json::to_vec(&layout).map_err(err)?).map_err(err)?;
    let adapter = app
        .path()
        .resource_dir()
        .map_err(err)?
        .join("resources/pdf-split");
    let rendered_path = if batch_output {
        temporary.with_extension("pdf")
    } else {
        std::path::PathBuf::from(&path)
    };
    let destination = rendered_path.clone();
    let input = continuous.clone();
    let metadata = layout_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new(adapter)
            .arg(input)
            .arg(destination)
            .arg(metadata)
            .output()
            .map_err(err)
    })
    .await
    .map_err(err)?;
    let _ = fs::remove_dir_all(continuous);
    let _ = fs::remove_file(layout_path);
    let result = result?;
    if !result.status.success() {
        return Err(format!(
            "PDF分页失败：{}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    if fs::metadata(&rendered_path).map_err(err)?.len() < 10 {
        return Err("PDF为空".into());
    }
    if batch_output {
        let result = batch::copy_exclusive(&rendered_path, std::path::Path::new(&path));
        let _ = fs::remove_file(rendered_path);
        result?;
        if let Some(id) = job_id.as_deref() {
            batch::mark_output(&library::root(), id)?;
        }
    }
    Ok(json!({"ok":true,"engine":"WKWebView/CoreGraphics"}))
}

fn main() {
    if std::env::args().any(|s| s == "--native-host") {
        if let Err(error) = bridge::native_host() {
            let _ = bridge::write_frame(&mut std::io::stdout(), &json!({"error":error}));
        }
        return;
    }
    let root = library::root();
    if fs::create_dir_all(&root).is_err() {
        return;
    }
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(root.join("instance.lock"))
        .expect("Application lock");
    if lock.try_lock().is_err() {
        if !std::env::args().any(|s| s == "--background") {
            let _ = bridge::call(&root, &json!({"action":"show"}));
        }
        return;
    }
    if let Err(e) = library::init(&root) {
        eprintln!("{e}");
        return;
    }
    tauri::Builder::default().plugin(tauri_plugin_dialog::init()).manage(PrintJobs(Mutex::new(HashMap::new()))).manage(connections::Monitor::default())
 .register_uri_scheme_protocol("archive",|context,request|{
  let key=request.uri().host().unwrap_or("");let html=context.app_handle().state::<PrintJobs>().0.lock().ok().and_then(|m|m.get(key).cloned()).unwrap_or_else(||"<p>导出任务不存在</p>".into());
  tauri::http::Response::builder().header("Content-Type","text/html; charset=utf-8").header("Content-Security-Policy","default-src 'none'; script-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'").body(html.into_bytes()).unwrap()
 })
 .setup(move|app|{
 service::apply_policy(app.handle()).map_err(std::io::Error::other)?;
 service::tray(app.handle()).map_err(std::io::Error::other)?;
 service::reading_menu(app.handle()).map_err(std::io::Error::other)?;
 #[cfg(unix)] bridge::serve(root.clone(),app.handle().clone()).map_err(std::io::Error::other)?;
 let background=std::env::args().any(|s|s=="--background");
 if service::opens_on_launch(&root,background){service::show_main(app.handle()).map_err(std::io::Error::other)?;}
 if library::pending_exports(&root).ok().and_then(|v|v.as_array().map(|a|!a.is_empty())).unwrap_or(false){service::ensure_worker(app.handle()).map_err(std::io::Error::other)?;}
 Ok(())})
 .on_window_event(|w,event|{if ["main","settings"].contains(&w.label()){if let tauri::WindowEvent::Destroyed=event{let _=service::apply_policy_excluding(w.app_handle(),w.label());}}})
 .invoke_handler(tauri::generate_handler![command,load_archive_bytes,print_pdf]).build(tauri::generate_context!()).expect("Failed to start reader").run(|app,event|{
 if let tauri::RunEvent::ExitRequested{code:None,ref api,..}=event{api.prevent_exit();}
 if let tauri::RunEvent::Reopen{..}=event{let _=service::show_main(app);}
 });
}
