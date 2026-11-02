// Headless document-image rendering for saved-HTML integration checks.
import Foundation
import AppKit
let source = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
guard let image = NSImage(data: source) else { fatalError("SVG decode failed") }
let width = Int(CommandLine.arguments[3])!
let height = Int(CommandLine.arguments[4])!
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
image.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
