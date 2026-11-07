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
func selectQuote(){Thread.sleep(forTimeInterval:0.3);let r=rect(until("READ_ONLY_SELECTION_PROOF","AXStaticText",true)),a=CGPoint(x:r.minX+0.5,y:r.midY),b=CGPoint(x:r.maxX-0.5,y:r.midY);send(.leftMouseDown,a);for i in 1...20{send(.leftMouseDragged,CGPoint(x:a.x+(b.x-a.x)*Double(i)/20,y:a.y));Thread.sleep(forTimeInterval:0.01)};send(.leftMouseUp,b);_ = until("阅读选区操作");Thread.sleep(forTimeInterval:0.3)}
AXUIElementSetAttributeValue(app,kAXFrontmostAttribute as CFString,kCFBooleanTrue)
if let w=(value(app,kAXWindowsAttribute) as? [AXUIElement])?.first{AXUIElementPerformAction(w,kAXRaiseAction as CFString)}
click(until("NATIVE_READ_ANNOTATION","AXButton"));selectQuote();click(until("蓝色高亮","AXButton"));Thread.sleep(forTimeInterval:0.3)
selectQuote();click(until("添加标注","AXButton"));let field=until("段落批注");AXUIElementSetAttributeValue(field,kAXValueAttribute as CFString,"NATIVE_READ_NOTE_PROOF" as CFString);click(until("保存批注","AXButton"));Thread.sleep(forTimeInterval:0.3)
func assertClosed(){
 Thread.sleep(forTimeInterval:0.35)
 if nodes().contains(where:{name($0)=="关闭笔记面板" || (name($0)=="标注与笔记" && role($0)=="AXHeading")}){finish("sidebar reopened after close")}
}
click(until("关闭笔记面板","AXButton"));assertClosed()
click(until("ONLY_SELECTION","AXStaticText",true));_ = until("标注与笔记","AXHeading")
if !((value(until("段落批注"),kAXValueAttribute) as? String ?? "").contains("NATIVE_READ_NOTE_PROOF")){finish("saved note not shown after click")}
for _ in 0..<3 {
 click(until("关闭笔记面板","AXButton"));assertClosed()
 click(until("ONLY_SELECTION","AXStaticText",true));_ = until("关闭笔记面板","AXButton")
}
if nodes().contains(where:{name($0)=="编辑文章正文"}){finish("article editor unexpectedly opened")}
print("PASS real Tauri mouse selection + native sidebar close stays closed, four click-to-note reopen cycles.");finish()
