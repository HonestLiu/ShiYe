// Snapshot scripts remain disabled. A mouse release in our own reader window
// notifies the trusted parent, which can inspect selection and annotation hits.
#[cfg(target_os = "macos")]
pub fn install(app: &tauri::AppHandle) {
    use objc2_app_kit::{NSEvent, NSEventMask};
    use tauri::Manager;
    let app=app.clone();
    let trace=std::env::var_os("ARCHIVE_READER_READING_TRACE").is_some();
    let block=block2::RcBlock::new(move |event:std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        let e=unsafe{event.as_ref()};
        let native=e.window(objc2::MainThreadMarker::new().expect("AppKit event thread"));
        if trace{eprintln!("reader-up associated={}",native.is_some());}
        let Some(native)=native else{return event.as_ptr();};
        let Some(window)=app.get_webview_window("main") else{return event.as_ptr();};
        if window.ns_window().ok()!=Some(&*native as *const _ as *mut std::ffi::c_void){return event.as_ptr();}
        let screen=native.convertPointToScreen(e.locationInWindow());
        let _=window.with_webview(move |platform|{
            let view=unsafe{&*(platform.inner() as *const objc2_web_kit::WKWebView)};
            let Some(native)=view.window() else{return;};
            let point=view.convertPoint_fromView(native.convertPointFromScreen(screen),None);
            let bounds=view.bounds();let x=point.x-bounds.origin.x;let y=if view.isFlipped(){point.y-bounds.origin.y}else{bounds.size.height-point.y+bounds.origin.y};
            // Tauri's view includes the titlebar inset; the DOM viewport starts below it.
            // Width gives the page scale; bottom alignment also handles page zoom/fullscreen.
            let event_code=format!("const scale=innerWidth/{width};const clientX={x}*scale,clientY=innerHeight+({y}-{height})*scale;window.dispatchEvent(new CustomEvent('reader-pointer-up',{{detail:{{x:clientX,y:clientY}}}}));",width=bounds.size.width,height=bounds.size.height);
            let script=format!("(()=>{{{event_code}}})()");
            if trace{
                let debug=format!("(()=>{{{event_code}const f=document.querySelector('#frame'),r=f?.getBoundingClientRect(),d=f?.contentDocument,s=d?.getSelection();return JSON.stringify({{x:clientX,y:clientY,rawX:{x},rawY:{y},frame:r?.toJSON(),viewHeight:{height},viewportHeight:innerHeight,range:s?.rangeCount?s.getRangeAt(0).getBoundingClientRect().toJSON():null,tools:document.querySelector('.read-selection-tools')?.getBoundingClientRect().toJSON(),toolsHidden:document.querySelector('.read-selection-tools')?.hidden,root:document.elementFromPoint(clientX,clientY)?.outerHTML.slice(0,100),caret:s?.anchorNode?.parentElement?.outerHTML.slice(0,130),selected:s?.toString(),notes:[...d.querySelectorAll('[data-reader-note]')].map(n=>({{text:n.textContent,rect:n.getBoundingClientRect().toJSON()}}))}})}})()",height=bounds.size.height);
                let done=block2::RcBlock::new(move |value:*mut objc2::runtime::AnyObject,error:*mut objc2_foundation::NSError|{if !error.is_null(){eprintln!("reader-up JavaScript failed");}else if !value.is_null(){let text=unsafe{&*(value as *const objc2_foundation::NSString)};eprintln!("reader-up {text}");}});
                unsafe{view.evaluateJavaScript_completionHandler(&objc2_foundation::NSString::from_str(&debug),Some(&done));}
            }else{unsafe{view.evaluateJavaScript_completionHandler(&objc2_foundation::NSString::from_str(&script),None);}}
        });
        event.as_ptr()
    });
    unsafe{NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::LeftMouseUp,&block);}
}
#[cfg(not(target_os = "macos"))]
pub fn install(_app:&tauri::AppHandle){}
