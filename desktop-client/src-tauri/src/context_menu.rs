// WKWebView forbids DOM listeners inside script-disabled snapshots. Route only
// our own webview's context gestures to the trusted parent without enabling scripts.
#[cfg(target_os = "macos")]
pub fn install(app: &tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use std::{cell::Cell, ptr};
    use tauri::Manager;
    let app = app.clone();
    let control_click = Cell::new(false);
    let block = RcBlock::new(move |pointer: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        let event = unsafe { pointer.as_ref() };
        let kind = event.r#type();
        let right = kind == NSEventType::RightMouseDown || kind == NSEventType::RightMouseUp;
        let control = kind == NSEventType::LeftMouseDown && event.modifierFlags().contains(NSEventModifierFlags::Control);
        let release = kind == NSEventType::LeftMouseUp && control_click.replace(false);
        if !right && !control && !release {return pointer.as_ptr();}
        let Some(native) = event.window(objc2::MainThreadMarker::new().expect("AppKit event thread")) else { return pointer.as_ptr(); };
        for label in ["main", "settings"] {
            let Some(window) = app.get_webview_window(label) else { continue; };
            if window.ns_window().ok() != Some(&*native as *const _ as *mut std::ffi::c_void) { continue; }
            if control { control_click.set(true); }
            if kind == NSEventType::RightMouseDown || control {
                native.setAcceptsMouseMovedEvents(true);
                let screen=native.convertPointToScreen(event.locationInWindow());
                let _=window.with_webview(move |platform| {
                    let view=unsafe{&*(platform.inner() as *const objc2_web_kit::WKWebView)};
                    let Some(window)=view.window() else{return;};
                    let point=view.convertPoint_fromView(window.convertPointFromScreen(screen),None);
                    let bounds=view.bounds();
                    let x=point.x-bounds.origin.x;
                    let y=if view.isFlipped(){point.y-bounds.origin.y}else{bounds.size.height-point.y+bounds.origin.y};
                    let script=format!("(()=>{{const scale=innerWidth/{width};const x={x}*scale,y=innerHeight+({y}-{height})*scale;window.dispatchEvent(new CustomEvent('shiye-context-request',{{detail:{{x,y}}}}));}})()",width=bounds.size.width,height=bounds.size.height);
                    unsafe{view.evaluateJavaScript_completionHandler(&objc2_foundation::NSString::from_str(&script),None);}
                });
            }
            return ptr::null_mut();
        }
        pointer.as_ptr()
    });
    // AppKit owns the monitor and copied block until process exit.
    unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::RightMouseDown | NSEventMask::RightMouseUp | NSEventMask::LeftMouseDown | NSEventMask::LeftMouseUp, &block); }
}
#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::AppHandle) {}
