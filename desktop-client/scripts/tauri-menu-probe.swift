import AppKit
import ApplicationServices
let pid=pid_t(CommandLine.arguments[1])!,app=AXUIElementCreateApplication(pid)
let original=CGEvent(source:nil)?.location
func finish(_ error:String?=nil)->Never {if let p=original{CGWarpMouseCursorPosition(p)};if let e=error{fputs("FAIL Tauri mouse: \(e)\n",stderr);exit(1)};exit(0)}
guard AXIsProcessTrusted(),CGPreflightPostEventAccess(),CGPreflightScreenCaptureAccess() else{finish("mouse/accessibility permission unavailable")}
func value(_ node:AXUIElement,_ key:String)->CFTypeRef?{var result:CFTypeRef?;AXUIElementCopyAttributeValue(node,key as CFString,&result);return result}
func name(_ node:AXUIElement)->String{for key in [kAXTitleAttribute,kAXDescriptionAttribute,kAXValueAttribute]{if let text=value(node,key) as? String,!text.isEmpty{return text}};return ""}
func role(_ node:AXUIElement)->String{value(node,kAXRoleAttribute) as? String ?? ""}
func nodes()->[AXUIElement]{var result=[AXUIElement](),queue=value(app,kAXWindowsAttribute) as? [AXUIElement] ?? [];while !queue.isEmpty&&result.count<3000{let n=queue.removeFirst();result.append(n);queue.append(contentsOf:value(n,kAXChildrenAttribute) as? [AXUIElement] ?? [])};return result}
func find(_ text:String,_ wanted:String?=nil)->AXUIElement?{nodes().first{name($0)==text&&(wanted==nil||role($0)==wanted)}}
func until(_ text:String,_ wanted:String?=nil)->AXUIElement{let end=Date().addingTimeInterval(5);while Date()<end{if let n=find(text,wanted){return n};Thread.sleep(forTimeInterval:0.05)};let dump=nodes().map{role($0)+" "+name($0)}.joined(separator:"\n");finish("missing \(text) \(wanted ?? ""): \(dump)")}
func center(_ node:AXUIElement)->CGPoint{var p=CGPoint.zero,s=CGSize.zero;guard let pv=value(node,kAXPositionAttribute),let sv=value(node,kAXSizeAttribute) else{finish("missing geometry "+name(node))};AXValueGetValue(pv as! AXValue,.cgPoint,&p);AXValueGetValue(sv as! AXValue,.cgSize,&s);return CGPoint(x:p.x+s.width/2,y:p.y+s.height/2)}
func send(_ type:CGEventType,_ p:CGPoint){CGWarpMouseCursorPosition(p);CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:p,mouseButton:type == .rightMouseDown || type == .rightMouseUp ? .right:.left)?.post(tap:.cghidEventTap)}
func click(_ node:AXUIElement,_ right:Bool=false){let p=center(node);send(right ? .rightMouseDown:.leftMouseDown,p);Thread.sleep(forTimeInterval:0.05);send(right ? .rightMouseUp:.leftMouseUp,p);Thread.sleep(forTimeInterval:0.15)}
func focusedName()->String{guard let node=value(app,kAXFocusedUIElementAttribute) else{return ""};return name(node as! AXUIElement)}
func highlighted(_ node:AXUIElement)->Bool {
 let windows=CGWindowListCopyWindowInfo(.optionOnScreenOnly,kCGNullWindowID) as? [[String:Any]] ?? []
 guard let w=windows.first(where:{($0[kCGWindowOwnerPID as String] as? Int)==Int(pid)&&($0[kCGWindowLayer as String] as? Int)==0}),let id=w[kCGWindowNumber as String] as? Int,let frame=w[kCGWindowBounds as String] as? [String:Any],let bounds=CGRect(dictionaryRepresentation:frame as CFDictionary) else{finish("missing own screenshot window")}
 let output=CommandLine.arguments[2]+"/hover-"+name(node)+".png",process=Process();process.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture");process.arguments=["-x","-o","-l",String(id),output];try! process.run();process.waitUntilExit()
 guard let data=try? Data(contentsOf:URL(fileURLWithPath:output)),let image=NSBitmapImageRep(data:data) else{finish("window screenshot failed")}
 let mid=center(node);var origin=CGPoint.zero;AXValueGetValue(value(node,kAXPositionAttribute) as! AXValue,.cgPoint,&origin)
 let scale=Double(image.pixelsWide)/bounds.width,x=Int((origin.x+5-bounds.minX)*scale),y=Int((mid.y-bounds.minY)*scale)
 guard x>=0,y>=0,x<image.pixelsWide,y<image.pixelsHigh,let c=image.colorAt(x:x,y:y)?.usingColorSpace(.deviceRGB) else{finish("invalid screenshot sample")}
 print("native highlight \(name(node)): \(c.redComponent) \(c.greenComponent) \(c.blueComponent)")
 return c.blueComponent-c.redComponent>0.025 || c.redComponent-c.greenComponent>0.025
}
func hover(_ node:AXUIElement){let expected=name(node),start=Date();send(.mouseMoved,center(node));Thread.sleep(forTimeInterval:0.15);if highlighted(node){print("native hover \(expected): \(Int(Date().timeIntervalSince(start)*1000))ms incl screenshot");return};Thread.sleep(forTimeInterval:0.15);if highlighted(node){return};finish("hover not visually highlighted; focus=\(focusedName()) target=\(expected)")}

AXUIElementSetAttributeValue(app,kAXFrontmostAttribute as CFString,kCFBooleanTrue)
if let w=(value(app,kAXWindowsAttribute) as? [AXUIElement])?.first{AXUIElementPerformAction(w,kAXRaiseAction as CFString)}
Thread.sleep(forTimeInterval:0.3)
AXUIElementPerformAction(until("回收站"),kAXPressAction as CFString);Thread.sleep(forTimeInterval:0.15);click(until("MENU_NATIVE_FIXTURE"),true)
let restore=until("恢复收藏","AXMenuItem"),remove=until("永久删除","AXMenuItem")
if nodes().contains(where:{role($0)=="AXMenuItem" && name($0)==focusedName()}){finish("pointer-opened menu preselects \(focusedName())")}
hover(remove);hover(restore);hover(remove)
// A second right gesture inside an open menu must not desynchronize tracking.
click(remove,true);hover(restore);hover(remove)
click(remove);_ = until("永久删除收藏")
// Confirm in the isolated temporary library only.
click(until("永久删除","AXButton"));Thread.sleep(forTimeInterval:0.4)
print("PASS actual packaged Tauri accessibility + system mouse hover/click.")
finish()
