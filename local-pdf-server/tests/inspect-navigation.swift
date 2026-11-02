import Foundation
import PDFKit
let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!
var outline: [[String:Any]] = []
func walk(_ item: PDFOutline, _ depth: Int) {
    if let label = item.label, !label.isEmpty {
        let destination = item.destination ?? (item.action as? PDFActionGoTo)?.destination
        let page = destination?.page.map { document.index(for: $0) } ?? -1
        outline.append(["title":label,"depth":depth,"page":page])
    }
    for index in 0..<item.numberOfChildren { if let child = item.child(at:index) { walk(child,depth+1) } }
}
if let root=document.outlineRoot {walk(root,0)}
var links: [[String:Any]] = []
for index in 0..<document.pageCount {
    let page=document.page(at:index)!
    for annotation in page.annotations where annotation.type == "Link" {
        let destination=annotation.destination ?? (annotation.action as? PDFActionGoTo)?.destination
        let target=destination?.page.map {document.index(for:$0)} ?? -1
        links.append(["from":index,"target":target,"text":destination?.page?.string ?? "","url":(annotation.action as? PDFActionURL)?.url?.absoluteString ?? ""])
    }
}
let result:[String:Any] = ["pages":document.pageCount,"outline":outline,"links":links]
let data=try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys])
print(String(data:data,encoding:.utf8)!)
