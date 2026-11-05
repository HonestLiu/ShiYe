// An isolated rendering probe; no browser installation or application UI automation.
import AppKit
import WebKit
import PDFKit
let input=CommandLine.arguments[1], output=CommandLine.arguments[2]
let application=NSApplication.shared
application.setActivationPolicy(.prohibited)
final class Probe: NSObject, WKNavigationDelegate {
 var view:WKWebView!
 func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){
  let config=WKPDFConfiguration()
  if CommandLine.arguments.count>3 {
   let layout=try! JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[3]))) as! [String:Any]
   config.rect=CGRect(x:0,y:CommandLine.arguments.count>4 ? Double(CommandLine.arguments[4])! : 0,width:layout["width"] as! Double,height:CommandLine.arguments.count>5 ? Double(CommandLine.arguments[5])! : layout["height"] as! Double)
  }
  webView.createPDF(configuration:config){result in
  guard case let .success(data)=result else {print(result);exit(2)}
  try! data.write(to:URL(fileURLWithPath:output))
  guard let pdf=PDFDocument(url:URL(fileURLWithPath:output)) else {exit(3)}
  let pages=(0..<pdf.pageCount).map{pdf.page(at:$0)!.string ?? ""}
  print(String(data:try! JSONSerialization.data(withJSONObject:["pages":pages,"count":pdf.pageCount,"engine":"WKWebView/createPDF"]),encoding:.utf8)!)
  let image=pdf.page(at:0)!.thumbnail(of:NSSize(width:850,height:1200),for:.mediaBox)
  let bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!
  try! bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:output+".png"))
  exit(0)
  }
 }
 func webView(_ webView:WKWebView,didFail navigation:WKNavigation!,withError error:Error){print(error);exit(4)}
}
let delegate=Probe()
let configuration=WKWebViewConfiguration()
configuration.defaultWebpagePreferences.allowsContentJavaScript=false
let view=WKWebView(frame:NSRect(x:0,y:0,width:900,height:1000),configuration:configuration)
delegate.view=view;view.navigationDelegate=delegate
let window=NSWindow(contentRect:NSRect(x:-20000,y:0,width:900,height:1000),styleMask:.borderless,backing:.buffered,defer:false)
window.contentView=view
view.loadHTMLString(try String(contentsOfFile:input,encoding:.utf8),baseURL:nil)
DispatchQueue.main.asyncAfter(deadline:.now()+90){print("TIMEOUT");exit(5)}
application.run()
