import Foundation
import PDFKit
let document=PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments[1]))!
var bookmarks=0
func walk(_ item:PDFOutline){if let title=item.label,!title.isEmpty {bookmarks += 1};for index in 0..<item.numberOfChildren{if let child=item.child(at:index){walk(child)}}}
if let root=document.outlineRoot{walk(root)}
let result:[String:Any]=["pages":document.pageCount,"bookmarks":bookmarks,"text":document.string ?? ""]
print(String(data:try JSONSerialization.data(withJSONObject:result),encoding:.utf8)!)
