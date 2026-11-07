import AppKit
import ApplicationServices
let pid=pid_t(CommandLine.arguments[1])!,app=AXUIElementCreateApplication(pid),original=CGEvent(source:nil)?.location
func finish(_ error:String?=nil)->Never{if let p=original{CGWarpMouseCursorPosition(p)};if let e=error{fputs("FAIL native reading: \(e)\n",stderr);exit(1)};exit(0)}
guard AXIsProcessTrusted(),CGPreflightPostEventAccess() else{finish("mouse/accessibility permission unavailable")}
func value(_ n:AXUIElement,_ key:String)->CFTypeRef?{var r:CFTypeRef?;AXUIElementCopyAttributeValue(n,key as CFString,&r);return r}
func name(_ n:AXUIElement)->String{for key in [kAXTitleAttribute,kAXDescriptionAttribute,kAXValueAttribute]{if let s=value(n,key) as? String,!s.isEmpty{return s}};return ""}
func role(_ n:AXUIElement)->String{value(n,kAXRoleAttribute) as? String ?? ""}
func nodes()->[AXUIElement]{var result=[AXUIElement](),queue=value(app,kAXWindowsAttribute) as? [AXUIElement] ?? [];while !queue.isEmpty&&result.count<1500{let n=queue.removeFirst();result.append(n);queue.append(contentsOf:value(n,kAXChildrenAttribute) as? [AXUIElement] ?? [])};return result}
func until(_ text:String,_ wanted:String?=nil,_ partial:Bool=false)->AXUIElement{let end=Date().addingTimeInterval(6);while Date()<end{if let n=nodes().first(where:{(partial ? name($0).contains(text):name($0)==text)&&(wanted==nil||role($0)==wanted)}){return n};Thread.sleep(forTimeInterval:0.05)};finish("missing \(text): "+nodes().map{role($0)+" "+name($0)}.joined(separator:"\n"))}
func rect(_ n:AXUIElement)->CGRect{var p=CGPoint.zero,s=CGSize.zero;guard let pv=value(n,kAXPositionAttribute),let sv=value(n,kAXSizeAttribute) else{finish("geometry "+name(n))};AXValueGetValue(pv as! AXValue,.cgPoint,&p);AXValueGetValue(sv as! AXValue,.cgSize,&s);return CGRect(origin:p,size:s)}
func send(_ type:CGEventType,_ p:CGPoint){CGWarpMouseCursorPosition(p);CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:p,mouseButton:.left)?.post(tap:.cghidEventTap)}
func click(_ n:AXUIElement){let r=rect(n),p=CGPoint(x:r.midX,y:r.midY);send(.leftMouseDown,p);Thread.sleep(forTimeInterval:0.04);send(.leftMouseUp,p);Thread.sleep(forTimeInterval:0.2)}
func rightClick(_ n:AXUIElement){let r=rect(n),p=CGPoint(x:r.midX,y:r.midY);CGWarpMouseCursorPosition(p);CGEvent(mouseEventSource:nil,mouseType:.rightMouseDown,mouseCursorPosition:p,mouseButton:.right)?.post(tap:.cghidEventTap);Thread.sleep(forTimeInterval:0.04);CGEvent(mouseEventSource:nil,mouseType:.rightMouseUp,mouseCursorPosition:p,mouseButton:.right)?.post(tap:.cghidEventTap);Thread.sleep(forTimeInterval:0.25)}
AXUIElementSetAttributeValue(app,kAXFrontmostAttribute as CFString,kCFBooleanTrue)
if let w=(value(app,kAXWindowsAttribute) as? [AXUIElement])?.first{AXUIElementPerformAction(w,kAXRaiseAction as CFString)}
rightClick(until("NATIVE_GROUP","AXButton",true));_ = until("删除收藏夹","AXMenuItem");_ = until("重命名","AXMenuItem");click(until("删除收藏夹","AXMenuItem"));_ = until("删除收藏夹","AXHeading");click(until("取消","AXButton"));
rightClick(until("NATIVE_TAG","AXButton",true));_ = until("删除标签","AXMenuItem");_ = until("重命名","AXMenuItem");click(until("删除标签","AXMenuItem"));_ = until("删除标签","AXHeading");click(until("取消","AXButton"));
print("PASS real Tauri right click folder and tag: correct menus and delete confirmation");finish()
