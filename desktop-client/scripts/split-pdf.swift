// Assemble region PDFs as searchable, paginated vector pages with navigation.
import Foundation
import PDFKit
import CoreGraphics
import AppKit
import CoreText
let source=URL(fileURLWithPath:CommandLine.arguments[1]), output=URL(fileURLWithPath:CommandLine.arguments[2])
let layout=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[3]))) as! [String:Any]
guard let cuts=layout["cuts"] as? [Double],cuts.count>=2 else {exit(2)}
let paper=layout["paper"] as? [String:Double] ?? ["width":595.28,"height":841.89,"margin":36,"contentWidth":523.28,"contentHeight":769.89]
let options=layout["options"] as? [String:Any] ?? [:]
let width=paper["width"]!, height=paper["height"]!, margin=paper["margin"]!, contentWidth=paper["contentWidth"]!,contentHeight=paper["contentHeight"]!
let cssWidth=layout["width"] as! Double, scale=contentWidth/cssWidth
let dark=options["darkMode"] as? Bool ?? false
var media=CGRect(x:0,y:0,width:width,height:height)
let staged=output.appendingPathExtension(UUID().uuidString+".partial")
defer{try? FileManager.default.removeItem(at:staged)}
guard let context=CGContext(staged as CFURL,mediaBox:&media,nil) else {exit(3)}
for index in 0..<(cuts.count-1){
 guard let doc=PDFDocument(url:source.appendingPathComponent("\(index).pdf")),let page=doc.page(at:0),let pageRef=page.pageRef else {exit(2)}
 let bounds=page.bounds(for:.mediaBox),localScale=contentWidth/bounds.width
 guard bounds.height*localScale<=contentHeight+1 else {fputs("Invalid page cut\n",stderr);exit(4)}
 context.beginPDFPage(nil)
 context.setFillColor(dark ? NSColor(srgbRed:32/255,green:37/255,blue:36/255,alpha:1).cgColor : CGColor(gray:1,alpha:1));context.fill(media)
 context.saveGState();context.clip(to:CGRect(x:margin,y:margin,width:contentWidth,height:contentHeight))
 context.translateBy(x:margin,y:height-margin);context.scaleBy(x:localScale,y:localScale);context.translateBy(x:-bounds.minX,y:-bounds.maxY)
 context.drawPDFPage(pageRef);context.restoreGState()
 if !(options["removePageNumber"] as? Bool ?? false){
  let line=CTLineCreateWithAttributedString(NSAttributedString(string:"\(index+1)",attributes:[.font:NSFont.systemFont(ofSize:9),.foregroundColor:dark ? NSColor.lightGray : NSColor.gray]))
  context.textMatrix = .identity;context.textPosition=CGPoint(x:(width-CTLineGetTypographicBounds(line,nil,nil,nil))/2,y:max(10,margin*0.45));CTLineDraw(line,context)
 }
 context.endPDFPage()
}
context.closePDF()
guard let rendered=PDFDocument(url:staged) else {exit(5)}
// Reinsert pages so PDFKit owns their references before serializing destinations.
let pdf=PDFDocument()
for index in 0..<rendered.pageCount{pdf.insert(rendered.page(at:index)!,at:index)}
let pages=(0..<pdf.pageCount).map{pdf.page(at:$0)!}
func pageIndex(_ y:Double)->Int{for i in 0..<(cuts.count-1){if y<cuts[i+1]-0.1{return i}};return cuts.count-2}
func destination(_ y:Double)->PDFDestination {let index=pageIndex(y);return PDFDestination(page:pages[index],at:CGPoint(x:margin,y:height-margin-(y-cuts[index])*scale))}
if options["outline"] as? Bool ?? true {
 let root=PDFOutline();var stack:[(Int,PDFOutline)]=[(0,root)]
 for heading in layout["headings"] as? [[String:Any]] ?? []{
  guard let text=heading["text"] as? String,let y=heading["y"] as? Double else {continue}
  let level=heading["level"] as? Int ?? 2
  while stack.count>1 && stack.last!.0>=level{stack.removeLast()}
  let node=PDFOutline();node.label=text;node.destination=destination(y)
  let parent=stack.last!.1;parent.insertChild(node,at:parent.numberOfChildren);stack.append((level,node))
 }
 pdf.outlineRoot=root.numberOfChildren>0 ? root : nil
}else{pdf.outlineRoot=nil}
for link in layout["links"] as? [[String:Any]] ?? [] {
 guard let x=link["x"] as? Double,let y=link["y"] as? Double,let w=link["width"] as? Double,let h=link["height"] as? Double else {continue}
 for index in 0..<(cuts.count-1){
  let top=max(y,cuts[index]),bottom=min(y+h,cuts[index+1]);if bottom<=top{continue}
  let rect=CGRect(x:margin+x*scale,y:height-margin-(bottom-cuts[index])*scale,width:w*scale,height:(bottom-top)*scale)
  let annotation=PDFAnnotation(bounds:rect,forType:.link,withProperties:nil);let border=PDFBorder();border.lineWidth=0;annotation.border=border
  if let target=link["targetY"] as? Double{annotation.action=PDFActionGoTo(destination:destination(target))}
  else if let url=link["url"] as? String,let address=URL(string:url),["http","https"].contains(address.scheme){annotation.url=address}else{continue}
  pages[index].addAnnotation(annotation)
 }
}
pdf.documentAttributes=[PDFDocumentAttribute.titleAttribute:layout["title"] as? String ?? "收藏",PDFDocumentAttribute.creatorAttribute:"拾页"]
guard pdf.write(to:output) else {exit(6)}
