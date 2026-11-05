// Repage WKWebView's vector PDF without rasterizing searchable text.
import Foundation
import PDFKit
import CoreGraphics
let source=URL(fileURLWithPath:CommandLine.arguments[1]), output=URL(fileURLWithPath:CommandLine.arguments[2])
let layout=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[3]))) as! [String:Any]
guard let cuts=layout["cuts"] as? [Double],cuts.count>=2 else {exit(2)}
var media=CGRect(x:0,y:0,width:595.28,height:841.89)
guard let context=CGContext(output as CFURL,mediaBox:&media,nil) else {exit(3)}
for index in 0..<(cuts.count-1){
 guard let doc=PDFDocument(url:source.appendingPathComponent("\(index).pdf")),let page=doc.page(at:0),let pageRef=page.pageRef else {exit(2)}
 let bounds=page.bounds(for:.mediaBox),scale=523.28/bounds.width
 guard bounds.height*scale<=770.5 else {fputs("Invalid page cut\n",stderr);exit(4)}
 context.beginPDFPage(nil)
 context.saveGState()
 context.clip(to:CGRect(x:36,y:36,width:523.28,height:769.89))
 context.translateBy(x:36,y:805.89)
 context.scaleBy(x:scale,y:scale)
 context.translateBy(x:-bounds.minX,y:-(bounds.maxY))
 context.drawPDFPage(pageRef)
 context.restoreGState()
 context.endPDFPage()
}
context.closePDF()
