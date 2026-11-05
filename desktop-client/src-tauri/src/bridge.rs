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
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    return Ok(json!({"ok":true}));
                }
                let committed = req["action"] == "commit";
                let value = library::dispatch(&root, req)?;
                if committed {
                    if value["jobId"].is_string() {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
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
    if call(&root, &json!({"action":"hello"})).is_err() {
        let exe = std::env::current_exe().map_err(err)?;
        #[cfg(target_os = "macos")]
        {
            if let Some(app) = exe
                .ancestors()
                .find(|p| p.extension().is_some_and(|e| e == "app"))
            {
                std::process::Command::new("/usr/bin/open")
                    .arg(app)
                    .spawn()
                    .map_err(err)?;
            } else {
                std::process::Command::new(&exe)
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
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    while let Ok(req) = read_frame(&mut input) {
        let response = call(&root, &req).unwrap_or_else(|error| json!({"error":error}));
        write_frame(&mut output, &response)?;
    }
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
        fs::write(&path, serde_json::to_vec_pretty(&origins).map_err(err)?).map_err(err)?;
        // A launcher keeps Native Messaging stdout free of application diagnostics.
        let launcher = root.join("native-host");
        let exe = std::env::current_exe().map_err(err)?;
        let quoted = exe.to_string_lossy().replace('\'', "'\\''");
        fs::write(
            &launcher,
            format!("#!/bin/sh\nexec '{quoted}' --native-host \"$@\"\n"),
        )
        .map_err(err)?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).map_err(err)?;
        let manifest = json!({"name":HOST,"description":"拾页客户端连接","path":launcher,"type":"stdio","allowed_origins":origins});
        let base = std::path::PathBuf::from(std::env::var_os("HOME").ok_or("缺少用户目录")?)
            .join("Library/Application Support");
        let mut registered = Vec::new();
        for browser in [
            "Google/Chrome",
            "Microsoft Edge",
            "BraveSoftware/Brave-Browser",
            "Chromium",
            "Arc/User Data",
            "com.operasoftware.Opera",
        ] {
            let dir = base.join(browser).join("NativeMessagingHosts");
            if base.join(browser).exists() {
                fs::create_dir_all(&dir).map_err(err)?;
                fs::write(
                    dir.join(format!("{HOST}.json")),
                    serde_json::to_vec_pretty(&manifest).map_err(err)?,
                )
                .map_err(err)?;
                registered.push(browser);
            }
        }
        Ok(json!({"browsers":registered,"id":id}))
    }
}
