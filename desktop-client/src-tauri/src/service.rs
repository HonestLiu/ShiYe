use crate::library::{self, err, Result};
use serde_json::{json, Value};
use std::{fs, path::Path};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
pub fn settings(root: &Path) -> Value {
    let v: Value = fs::read(root.join("client-settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(json!({}));
    json!({"lightweight":v["lightweight"].as_bool().unwrap_or(true),"browserDownload":v["browserDownload"].as_bool().unwrap_or(true),"startupMode":v["startupMode"].as_str().filter(|m| ["window","background"].contains(m)).unwrap_or("window")})
}
pub fn save_settings(root: &Path, value: &Value) -> Result<Value> {
    let current = settings(root);
    let mode = value["startupMode"]
        .as_str()
        .unwrap_or(current["startupMode"].as_str().unwrap_or("window"));
    if !["window", "background"].contains(&mode) {
        return Err("无效启动方式".into());
    }
    let v = json!({"startupMode":mode,"lightweight":value["lightweight"].as_bool().ok_or("缺少轻量模式设置")?,"browserDownload":value["browserDownload"].as_bool().ok_or("缺少下载方式设置")?});
    let temporary = root.join("client-settings.tmp");
    fs::write(&temporary, serde_json::to_vec(&v).map_err(err)?).map_err(err)?;
    fs::rename(temporary, root.join("client-settings.json")).map_err(err)?;
    Ok(v)
}
pub fn dock_visible(lightweight: bool, has_windows: bool) -> bool {
    !lightweight || has_windows
}
pub fn apply_policy(app: &tauri::AppHandle) -> Result<()> {
    apply_policy_excluding(app, "")
}
pub fn apply_policy_excluding(app: &tauri::AppHandle, closed: &str) -> Result<()> {
    let windows = ["main", "settings"]
        .iter()
        .any(|name| *name != closed && app.get_webview_window(name).is_some());
    #[cfg(target_os = "macos")]
    app.set_activation_policy(
        if dock_visible(settings(&library::root())["lightweight"] == true, windows) {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        },
    )
    .map_err(err)?;
    Ok(())
}
pub fn show_main(app: &tauri::AppHandle) -> Result<()> {
    let w = if let Some(w) = app.get_webview_window("main") {
        w
    } else {
        WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title("拾页")
            .inner_size(1280., 860.)
            .min_inner_size(720., 520.)
            .build()
            .map_err(err)?
    };
    apply_policy(app)?;
    w.show().map_err(err)?;
    w.set_focus().map_err(err)?;
    Ok(())
}
pub fn show_settings(app: &tauri::AppHandle, section: &str) -> Result<()> {
    use tauri::Emitter;
    let section = if ["general", "reading", "pdf", "connection", "data", "about"].contains(&section)
    {
        section
    } else {
        "general"
    };
    let w = if let Some(w) = app.get_webview_window("settings") {
        let _ = w.emit("settings-section", section);
        w
    } else {
        WebviewWindowBuilder::new(
            app,
            "settings",
            WebviewUrl::App(format!("settings.html#{section}").into()),
        )
        .title("拾页设置")
        .inner_size(860., 700.)
        .min_inner_size(700., 520.)
        .build()
        .map_err(err)?
    };
    apply_policy(app)?;
    w.show().map_err(err)?;
    w.set_focus().map_err(err)?;
    Ok(())
}
pub fn opens_on_launch(root: &Path, background: bool) -> bool {
    !background && settings(root)["startupMode"] == "window"
}
pub fn ensure_worker(app: &tauri::AppHandle) -> Result<()> {
    if app.get_webview_window("worker").is_none() {
        WebviewWindowBuilder::new(app, "worker", WebviewUrl::App("worker.html".into()))
            .title("拾页导出服务")
            .inner_size(900., 1000.)
            .visible(false)
            .skip_taskbar(true)
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
            .build()
            .map_err(err)?;
    }
    Ok(())
}
pub fn tray(app: &tauri::AppHandle) -> Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };
    let open = MenuItem::with_id(app, "open", "打开拾页", true, None::<&str>).map_err(err)?;
    let light = MenuItem::with_id(app, "light", "进入轻量模式", true, None::<&str>).map_err(err)?;
    let quit = MenuItem::with_id(app, "quit", "退出拾页", true, None::<&str>).map_err(err)?;
    let settings_item =
        MenuItem::with_id(app, "settings", "设置…", true, None::<&str>).map_err(err)?;
    let menu = Menu::with_items(app, &[&open, &settings_item, &light, &quit]).map_err(err)?;
    // A template image follows the menu bar's light/dark appearance.
    let mut rgba = vec![0u8; 18 * 18 * 4];
    for y in 2..16 {
        for x in 3..15 {
            if x == 3
                || x == 14
                || y == 2
                || y == 15
                || x == 8
                || y == 6 && x > 9
                || y == 10 && x > 9
            {
                rgba[(y * 18 + x) * 4 + 3] = 255;
            }
        }
    }
    TrayIconBuilder::with_id("reader-service")
        .icon(tauri::image::Image::new_owned(rgba, 18, 18))
        .icon_as_template(true)
        .tooltip("拾页 · 本地导出服务")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                let _ = show_main(app);
            }
            "light" => {
                let mut s = settings(&library::root());
                s["lightweight"] = json!(true);
                let _ = save_settings(&library::root(), &s);
                let _ = apply_policy(app);
                for label in ["main", "settings"] {
                    if let Some(w) = app.get_webview_window(label) {
                        let _ = w.close();
                    }
                }
            }
            "settings" => {
                let _ = show_settings(app, "general");
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)
        .map_err(err)?;
    Ok(())
}

/// Native accelerator also works while focus is inside the script-disabled source frame.
pub fn reading_menu(app: &tauri::AppHandle) -> Result<()> {
    use tauri::{
        menu::{Menu, MenuItem, MenuItemKind, Submenu},
        Emitter,
    };
    let menu = Menu::default(app).map_err(err)?;
    let settings =
        MenuItem::with_id(app, "app-settings", "设置…", true, Some("CmdOrCtrl+,")).map_err(err)?;
    #[cfg(target_os = "macos")]
    if let Some(MenuItemKind::Submenu(application)) = menu.items().map_err(err)?.first() {
        application.insert(&settings, 2).map_err(err)?;
    }
    #[cfg(not(target_os = "macos"))]
    menu.append(&settings).map_err(err)?;
    let find = MenuItem::with_id(
        app,
        "reader-find",
        "查找当前正文",
        true,
        Some("CmdOrCtrl+F"),
    )
    .map_err(err)?;
    let reading = Submenu::with_items(app, "阅读", true, &[&find]).map_err(err)?;
    menu.append(&reading).map_err(err)?;
    app.set_menu(menu).map_err(err)?;
    app.on_menu_event(|app, event| {
        if event.id.as_ref() == "app-settings" {
            let _ = show_settings(app, "general");
        }
        if event.id.as_ref() == "reader-find" {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("reader-find", ());
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_is_independent_from_background_service() {
        let root = std::env::temp_dir().join(format!("reader-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        assert!(dock_visible(true, true));
        assert!(!dock_visible(true, false));
        assert!(dock_visible(false, false));
        assert!(opens_on_launch(&root, false));
        assert!(!opens_on_launch(&root, true));
        let saved = save_settings(
            &root,
            &json!({"lightweight":true,"browserDownload":true,"startupMode":"background"}),
        )
        .unwrap();
        assert_eq!(saved["startupMode"], "background");
        assert!(!opens_on_launch(&root, false));
        // Older callers without the new field must preserve the chosen launch mode.
        save_settings(&root, &json!({"lightweight":false,"browserDownload":false})).unwrap();
        assert!(!opens_on_launch(&root, false));
        assert!(save_settings(
            &root,
            &json!({"lightweight":true,"browserDownload":true,"startupMode":"invalid"})
        )
        .is_err());
        save_settings(
            &root,
            &json!({"lightweight":true,"browserDownload":true,"startupMode":"window"}),
        )
        .unwrap();
        assert!(opens_on_launch(&root, false));
        assert!(!opens_on_launch(&root, true));
        fs::write(
            root.join("client-settings.json"),
            r#"{"lightweight":true,"browserDownload":false}"#,
        )
        .unwrap();
        assert!(opens_on_launch(&root, false));
        assert_eq!(settings(&root)["browserDownload"], false);
        fs::remove_dir_all(root).unwrap();
    }
}
