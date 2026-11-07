import AppKit
import WebKit

final class Probe: NSObject, WKNavigationDelegate {
 let window = NSWindow(contentRect:NSRect(x:120,y:120,width:840,height:620),styleMask:[.titled,.closable],backing:.buffered,defer:false)
 let web = WKWebView()
 var monitor: Any?
 let originalPointer=CGEvent(source:nil)?.location
 func start() {
  window.title="拾页菜单回归检查";window.contentView=web;web.navigationDelegate=self
  window.acceptsMouseMovedEvents=true;window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
  // Same right-gesture-only boundary as the production Rust monitor.
  monitor=NSEvent.addLocalMonitorForEvents(matching:[.rightMouseDown,.rightMouseUp]) { [self] event in
   guard event.window === window else { return event }
   if event.type == .rightMouseDown {
    let p=web.convert(event.locationInWindow,from:nil),y=web.isFlipped ? p.y : web.bounds.height-p.y
    web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('shiye-context-request',{detail:{x:\(p.x),y:\(y)}}));")
   }
   return nil
  }
  web.load(URLRequest(url:URL(string:CommandLine.arguments[1])!))
 }
 func fail(_ message:String)->Never { if let point=originalPointer{CGWarpMouseCursorPosition(point)};fputs("FAIL native context: \(message)\n",stderr);exit(1) }
 func js(_ source:String,_ done:@escaping(Any?)->Void) {
  web.evaluateJavaScript(source) { result,error in if let error=error { self.fail(String(describing:error)) };done(result) }
 }
 func later(_ fn:@escaping()->Void) { DispatchQueue.main.asyncAfter(deadline:.now()+0.15,execute:fn) }
 func mouse(_ type:NSEvent.EventType,_ x:Double,_ y:Double) {
  let p=web.convert(NSPoint(x:x,y:web.isFlipped ? y : web.bounds.height-y),to:nil)
  let screen=window.convertPoint(toScreen:p);CGWarpMouseCursorPosition(CGPoint(x:screen.x,y:(NSScreen.screens.first?.frame.height ?? 0)-screen.y))
  let event=NSEvent.mouseEvent(with:type,location:p,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:window.windowNumber,context:nil,eventNumber:1,clickCount:1,pressure:type == .leftMouseDown ? 1 : 0)!
  NSApp.postEvent(event,atStart:false)
 }
 func rect(_ selector:String,_ done:@escaping(Double,Double)->Void) {
  js("(()=>{const r=document.querySelector(\(String(data:try! JSONSerialization.data(withJSONObject:selector,options:.fragmentsAllowed),encoding:.utf8)!)).getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()") { value in
   guard let a=value as? [Double],a.count==2 else {self.fail("missing rect \(selector)")};done(a[0],a[1])
  }
 }
 func check(_ expression:String,_ message:String,_ done:@escaping()->Void) {js(expression){ value in guard value as? Bool == true else {self.fail(message)};done()}}
 func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!) {waitReady(0)}
 func waitReady(_ count:Int) {js("window.probeReady===true"){ value in if value as? Bool == true {self.test()}else if count<50 {self.later{self.waitReady(count+1)}}else{self.fail("fixture did not initialize")}}}
 func test() {
  rect("#card") { x,y in self.mouse(.rightMouseDown,x,y);self.mouse(.rightMouseUp,x,y);self.later {
   self.check("document.querySelector('#context-menu-layer').open","right gesture failed") {
    self.rect("#context-menu button:first-child") { x,y in self.mouse(.mouseMoved,x,y);self.later {
     self.check("document.querySelector('#context-menu [data-active]')?.textContent==='恢复收藏'","first hover failed") {
      self.rect("#context-menu button:last-child") { x,y in self.mouse(.mouseMoved,x,y);self.later {
       self.check("document.querySelector('#context-menu [data-active]')?.textContent==='永久删除' && document.querySelectorAll('#context-menu [data-active]').length===1","hover did not follow pointer") {
        self.mouse(.leftMouseDown,x,y);self.later {
         self.check("document.querySelector('#context-menu-layer').open && behindClicks===0","mousedown dismissed or passed through") {
          self.mouse(.leftMouseUp,x,y);self.later {
           self.check("document.querySelector('#delete-dialog').open && behindClicks===0 && !window.probeError","permanent delete click failed or passed through") {self.testOutside()}
          }
         }
        }
       }
      }}
     }
    }}
   }
  }}
 }
 func testOutside() {
  js("document.querySelector('#delete-dialog').close()") { _ in self.rect("#card") { x,y in self.mouse(.rightMouseDown,x,y);self.mouse(.rightMouseUp,x,y);self.later {
   self.mouse(.leftMouseDown,32,40);self.mouse(.leftMouseUp,32,40);self.later {
    self.check("!document.querySelector('#context-menu-layer').open && behindClicks===0","outside click passed through") {self.testSnapshot()}
   }
  }}}
 }
 func testSnapshot() {
  rect("iframe") { x,y in self.mouse(.rightMouseDown,x,y);self.mouse(.rightMouseUp,x,y);self.later {
   self.check("document.querySelector('#context-menu-layer').open","inert snapshot right gesture failed") {
    print("PASS real WKWebView + AppKit mouse events: right gesture, hover follows pointer, mousedown/up permanent delete, no click-through, outside dismissal, script-disabled snapshot. Storage mocked.")
    if let point=self.originalPointer{CGWarpMouseCursorPosition(point)};exit(0)
   }
  }}
 }
}
let application=NSApplication.shared
application.setActivationPolicy(.accessory)
let probe=Probe();probe.start();application.run()
