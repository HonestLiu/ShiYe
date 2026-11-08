use crate::library::{self, err, Result};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};
const HOST: &str = "io.local.archive_reader";
pub fn read_frame(stream: &mut impl Read) -> Result<Value> {
    let mut size = [0; 4];
    stream.read_exact(&mut size).map_err(err)?;
    let size = u32::from_le_bytes(size) as usize;
    if size > 2 * 1024 * 1024 {
        return Err("通信消息过大".into());
    }
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes).map_err(err)?;
    serde_json::from_slice(&bytes).map_err(err)
}
pub fn write_frame(stream: &mut impl Write, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(err)?;
    stream
        .write_all(&(bytes.len() as u32).to_le_bytes())
        .map_err(err)?;
    stream.write_all(&bytes).map_err(err)?;
    stream.flush().map_err(err)
}
#[cfg(unix)]
pub fn serve(root: std::path::PathBuf, app: tauri::AppHandle) -> Result<()> {
    use std::os::unix::{fs::PermissionsExt, net::UnixListener};
    use tauri::{Emitter, Manager};
    let socket = root.join("reader.sock");
    let _ = fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).map_err(err)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).map_err(err)?;
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(20)));
            let result = read_frame(&mut stream).and_then(|req| {
                if req["action"] == "show" {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        let _ = crate::service::show_main(&handle);
                    });
                    return Ok(json!({"ok":true}));
                }
                if req["action"]
                    .as_str()
                    .is_some_and(|a| a.starts_with("connection_"))
                {
                    let mut response = app.state::<crate::connections::Monitor>().receive(&root, &req)?;
                    response["readingRevision"] = json!(crate::reading::revision(&root));
                    return Ok(response);
                }
                let committed = req["action"] == "commit";
                let reading_changed=if req["action"]=="reading_merge"{req["url"].as_str().map(str::to_owned)}else{None};
                let before_reading = crate::reading::revision(&root);
                let hello = req["action"] == "hello";
                let inspect_policy = req["includePolicy"] == true;
                let inspect_connections = req["includeConnections"] == true;
                let mut value = library::dispatch(&root, req)?;
                if let Some(url)=reading_changed.filter(|_| before_reading != crate::reading::revision(&root)) {let _=app.emit("reading-changed",json!({"url":url}));let _=app.emit("library-changed",json!({}));}
                if hello {
                    if inspect_connections {
                        value["connections"] =
                            app.state::<crate::connections::Monitor>().snapshot(&root)?;
                    }
                    value["lightweight"] = crate::service::settings(&root)["lightweight"].clone();
                    value["readerOpen"] = json!(app.get_webview_window("main").is_some());
                    value["workerActive"] = json!(app.get_webview_window("worker").is_some());
                    value["dockExpected"] = json!(crate::service::dock_visible(
                        crate::service::settings(&root)["lightweight"] == true,
                        ["main", "settings"]
                            .iter()
                            .any(|n| app.get_webview_window(n).is_some())
                    ));
                    #[cfg(target_os = "macos")]
                    if inspect_policy {
                        let (tx, rx) = std::sync::mpsc::channel();
                        let _ = app.run_on_main_thread(move || {
                            use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
                            if let Some(mtm) = objc2::MainThreadMarker::new() {
                                let _ = tx.send(
                                    NSApplication::sharedApplication(mtm).activationPolicy()
                                        == NSApplicationActivationPolicy::Regular,
                                );
                            }
                        });
                        if let Ok(visible) = rx.recv_timeout(std::time::Duration::from_secs(2)) {
                            value["dockVisible"] = json!(visible);
                        }
                    }
                }
                if committed {
                    if value["jobId"].is_string() {
                        let handle = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            let _ = crate::service::ensure_worker(&handle);
                        });
                    }
                    let _ = app.emit("library-changed", &value);
                }
                Ok(value)
            });
            let response = match result {
                Ok(data) => json!({"data":data}),
                Err(error) => json!({"error":error}),
            };
            let _ = write_frame(&mut stream, &response);
        }
    });
    Ok(())
}
#[cfg(unix)]
pub fn call(root: &Path, req: &Value) -> Result<Value> {
    use std::os::unix::net::UnixStream;
    let mut stream = UnixStream::connect(root.join("reader.sock")).map_err(err)?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(120)))
        .map_err(err)?;
    write_frame(&mut stream, req)?;
    read_frame(&mut stream)
}
#[cfg(not(unix))]
pub fn call(_root: &Path, _req: &Value) -> Result<Value> {
    Err("此预览版的浏览器连接暂支持macOS".into())
}
pub fn native_host() -> Result<()> {
    let root = library::root();
    let origin = std::env::args().nth(1).unwrap_or_default();
    let origin = if origin == "--native-host" {
        std::env::args().nth(2).unwrap_or_default()
    } else {
        origin
    };
    let allowed: Vec<String> =
        serde_json::from_slice(&fs::read(root.join("origins.json")).map_err(err)?).map_err(err)?;
    if !allowed.contains(&origin) {
        return Err("扩展未配对".into());
    }
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    let first = read_frame(&mut input)?;
    let presence = first["action"] == "connection_open";
    if call(&root, &json!({"action":"hello"})).is_err() {
        // Cancelling a transfer is local cleanup and must not relaunch a stopped app.
        if first["action"] == "abort" {
            let result = library::dispatch(&root, first)?;
            write_frame(&mut output, &json!({"data":result}))?;
            return Ok(());
        }
        if presence {
            return Err("客户端未运行，等待下一次主动连接".into());
        }
        let exe = std::env::current_exe().map_err(err)?;
        #[cfg(target_os = "macos")]
        {
            if let Some(app) = exe
                .ancestors()
                .find(|p| p.extension().is_some_and(|e| e == "app"))
            {
                std::process::Command::new("/usr/bin/open")
                    .arg("-g")
                    .arg(app)
                    .arg("--args")
                    .arg("--background")
                    .spawn()
                    .map_err(err)?;
            } else {
                std::process::Command::new(&exe)
                    .arg("--background")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(err)?;
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            std::process::Command::new(&exe).spawn().map_err(err)?;
        }
        let mut connected = false;
        for _ in 0..300 {
            if call(&root, &json!({"action":"hello"})).is_ok() {
                connected = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if !connected {
            return Err("客户端启动超时，请手动打开拾页后重试".into());
        }
    }
    let session = uuid::Uuid::new_v4().to_string();
    let mut next = Some(first);
    let result = (|| -> Result<()> {
        loop {
            let req = if let Some(r) = next.take() {
                r
            } else {
                match read_frame(&mut input) {
                    Ok(r) => r,
                    Err(_) => break,
                }
            };
            let action = req["action"].as_str().unwrap_or("");
            let response = if presence {
                if !["connection_open", "connection_heartbeat", "connection_pong"].contains(&action)
                {
                    json!({"error":"此通道仅用于连接检测"})
                } else {
                    let mut trusted = req.clone();
                    trusted["origin"] = json!(origin);
                    trusted["sessionId"] = json!(session);
                    call(&root, &trusted).unwrap_or_else(|e| json!({"error":e}))
                }
            } else {
                if action.starts_with("connection_") {
                    json!({"error":"连接检测必须使用独立通道"})
                } else {
                    let r = call(&root, &req).unwrap_or_else(|e| json!({"error":e}));
                    if r["data"].is_object() {
                        let _ = call(
                            &root,
                            &json!({"action":"connection_recent","origin":origin}),
                        );
                    }
                    r
                }
            };
            write_frame(&mut output, &response)?;
            if response["error"].is_string() {
                break;
            }
        }
        Ok(())
    })();
    if presence {
        let _ = call(
            &root,
            &json!({"action":"connection_closed","origin":origin,"sessionId":session}),
        );
    }
    result?;
    Ok(())
}
pub fn register(root: &Path, id: &str) -> Result<Value> {
    if id.len() != 32 || !id.bytes().all(|c| (b'a'..=b'p').contains(&c)) {
        return Err("扩展ID应为32位a-p字母，可在扩展设置页复制".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = root;
        return Err("此预览版的自动注册暂支持macOS".into());
    }
    #[cfg(target_os = "macos")]
    {
        let origin = format!("chrome-extension://{id}/");
        let path = root.join("origins.json");
        let mut origins: Vec<String> = fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        if !origins.contains(&origin) {
            origins.push(origin)
        }
        atomic_write(
            &path,
            &serde_json::to_vec_pretty(&origins).map_err(err)?,
            false,
        )?;
        // A launcher keeps Native Messaging stdout free of application diagnostics.
        let launcher = root.join("native-host");
        let exe = std::env::current_exe().map_err(err)?;
        let quoted = exe.to_string_lossy().replace('\'', "'\\''");
        atomic_write(
            &launcher,
            format!("#!/bin/sh\nexec '{quoted}' --native-host \"$@\"\n").as_bytes(),
            true,
        )?;
        let manifest = json!({"name":HOST,"description":"拾页客户端连接","path":launcher,"type":"stdio","allowed_origins":origins});
        let base = browser_base();
        let mut registered = Vec::new();
        for (browser, _) in BROWSERS {
            let dir = base.join(browser).join("NativeMessagingHosts");
            if base.join(browser).exists() {
                fs::create_dir_all(&dir).map_err(err)?;
                atomic_write(
                    &dir.join(format!("{HOST}.json")),
                    &serde_json::to_vec_pretty(&manifest).map_err(err)?,
                    false,
                )?;
                registered.push(browser);
            }
        }
        Ok(json!({"browsers":registered,"id":id}))
    }
}

const BROWSERS: &[(&str, &str)] = &[
    ("Google/Chrome", "Chrome"),
    ("Google/Chrome Beta", "Chrome Beta"),
    ("Google/Chrome Dev", "Chrome Dev"),
    ("Google/Chrome Canary", "Chrome Canary"),
    ("Microsoft Edge", "Edge"),
    ("Microsoft Edge Beta", "Edge Beta"),
    ("BraveSoftware/Brave-Browser", "Brave"),
    ("Chromium", "Chromium"),
    ("Arc/User Data", "Arc"),
    ("com.operasoftware.Opera", "Opera"),
];
fn browser_base() -> std::path::PathBuf {
    std::env::var_os("ARCHIVE_READER_BROWSER_ROOT")
        .map(Into::into)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                .join("Library/Application Support")
        })
}
pub fn audit(root: &Path, id: &str) -> Vec<Value> {
    let base = browser_base();
    let origin = format!("chrome-extension://{id}/");
    BROWSERS
        .iter()
        .filter(|(dir, _)| base.join(dir).exists())
        .map(|(dir, name)| {
            let path = base
                .join(dir)
                .join("NativeMessagingHosts")
                .join(format!("{HOST}.json"));
            let v: Option<Value> = fs::read(&path)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok());
            let status = match v {
                None => {
                    if path.exists() {
                        "invalid"
                    } else {
                        "missing"
                    }
                }
                Some(ref v) if v["name"] != HOST || v["type"] != "stdio" => "invalid",
                Some(ref v)
                    if !v["allowed_origins"]
                        .as_array()
                        .is_some_and(|a| a.contains(&json!(origin))) =>
                {
                    "id_missing"
                }
                Some(ref v)
                    if v["path"].as_str() != root.join("native-host").to_str()
                        || !launcher_usable(root) =>
                {
                    "path_invalid"
                }
                Some(_) => "configured",
            };
            json!({"browser":name,"status":status})
        })
        .collect()
}
pub fn unregister(root: &Path, id: &str) -> Result<()> {
    if id.len() != 32 || !id.bytes().all(|c| (b'a'..=b'p').contains(&c)) {
        return Err("无效扩展ID".into());
    }
    let origin = format!("chrome-extension://{id}/");
    let mut allowed = crate::connections::origins(root);
    allowed.retain(|o| o != &origin);
    atomic_write(
        &root.join("origins.json"),
        &serde_json::to_vec_pretty(&allowed).map_err(err)?,
        false,
    )?;
    for (dir, _) in BROWSERS {
        let path = browser_base()
            .join(dir)
            .join("NativeMessagingHosts")
            .join(format!("{HOST}.json"));
        if let Ok(b) = fs::read(&path) {
            if let Ok(mut v) = serde_json::from_slice::<Value>(&b) {
                if let Some(a) = v["allowed_origins"].as_array_mut() {
                    a.retain(|o| o.as_str() != Some(&origin));
                    atomic_write(&path, &serde_json::to_vec_pretty(&v).map_err(err)?, false)?;
                }
            }
        }
    }
    Ok(())
}

fn launcher_usable(root: &Path) -> bool {
    let path = root.join("native-host");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !fs::metadata(&path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0) {
            return false;
        }
    }
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let quoted = exe.to_string_lossy().replace('\'', "'\\''");
    fs::read_to_string(path).is_ok_and(|s| s.contains(&format!("exec '{quoted}' --native-host")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registrations_keep_multiple_ids() {
        let base = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let root = base.join("client");
        let browsers = base.join("browsers");
        fs::create_dir_all(&root).unwrap();
        for p in ["Google/Chrome", "Microsoft Edge"] {
            fs::create_dir_all(browsers.join(p)).unwrap();
        }
        let previous = std::env::var_os("ARCHIVE_READER_BROWSER_ROOT");
        std::env::set_var("ARCHIVE_READER_BROWSER_ROOT", &browsers);
        let a = "a".repeat(32);
        let b = "b".repeat(32);
        register(&root, &a).unwrap();
        register(&root, &b).unwrap();
        assert!(audit(&root, &a).iter().all(|v| v["status"] == "configured"));
        assert_eq!(crate::connections::origins(&root).len(), 2);
        unregister(&root, &a).unwrap();
        assert_eq!(
            crate::connections::origins(&root),
            vec![format!("chrome-extension://{b}/")]
        );
        assert!(audit(&root, &b).iter().all(|v| v["status"] == "configured"));
        assert!(audit(&root, &a).iter().all(|v| v["status"] == "id_missing"));
        fs::write(root.join("native-host"), "stale launcher").unwrap();
        assert!(audit(&root, &b)
            .iter()
            .all(|v| v["status"] == "path_invalid"));
        if let Some(v) = previous {
            std::env::set_var("ARCHIVE_READER_BROWSER_ROOT", v);
        } else {
            std::env::remove_var("ARCHIVE_READER_BROWSER_ROOT");
        }
        fs::remove_dir_all(base).unwrap();
    }
}

fn atomic_write(path: &Path, bytes: &[u8], executable: bool) -> Result<()> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut f = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(err)?;
        f.write_all(bytes).map_err(err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                &temp,
                fs::Permissions::from_mode(if executable { 0o700 } else { 0o600 }),
            )
            .map_err(err)?;
        }
        fs::rename(&temp, path).map_err(err)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
