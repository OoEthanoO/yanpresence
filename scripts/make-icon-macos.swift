// Draws assets/yanpresence.icns, the macOS app icon.
//
// The same icon as assets/yanpresence.ico -- Apple Music's red, a beamed pair
// of notes in white -- laid out on macOS's icon grid rather than filling the
// canvas: the body is the 824-unit rounded square centred in 1024, which is
// the shape Finder, the Dock and System Settings expect an app icon to have.
// The notes use the website logo's 64-unit geometry, mapped onto that body.
//
// Committed output, run by hand, like scripts/make-icon.ps1:
//
//   swift scripts/make-icon-macos.swift

import AppKit
import ImageIO
import UniformTypeIdentifiers

let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let output = repo.appendingPathComponent("assets/yanpresence.icns")

/// The body: Apple's app icon shape, a squircle rather than a circular-arc
/// rounded rectangle. A superellipse of exponent 5 is close to it at every
/// size this is drawn at.
func body(in rect: CGRect) -> CGPath {
  let path = CGMutablePath()
  let a = rect.width / 2, b = rect.height / 2
  let steps = 720
  for i in 0..<steps {
    let t = Double(i) / Double(steps) * 2 * .pi
    let c = cos(t), s = sin(t)
    let x = a * CGFloat(copysign(pow(abs(c), 2.0 / 5.0), c))
    let y = b * CGFloat(copysign(pow(abs(s), 2.0 / 5.0), s))
    let point = CGPoint(x: rect.midX + x, y: rect.midY + y)
    if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
  }
  path.closeSubpath()
  return path
}

func render(_ pixels: Int) -> CGImage {
  let size = CGFloat(pixels)
  let context = CGContext(
    data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  // Top-left origin, so the coordinates below read like the SVG they came from.
  context.translateBy(x: 0, y: size)
  context.scaleBy(x: 1, y: -1)
  context.interpolationQuality = .high
  context.setShouldAntialias(true)

  let unit = size / 1024
  let box = CGRect(x: 100 * unit, y: 100 * unit, width: 824 * unit, height: 824 * unit)

  context.saveGState()
  context.addPath(body(in: box))
  context.clip()
  let gradient = CGGradient(
    colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
    colors: [
      CGColor(srgbRed: 250 / 255, green: 36 / 255, blue: 60 / 255, alpha: 1),
      CGColor(srgbRed: 251 / 255, green: 92 / 255, blue: 116 / 255, alpha: 1),
    ] as CFArray,
    locations: [0, 1])!
  context.drawLinearGradient(
    gradient, start: CGPoint(x: box.minX, y: box.minY), end: CGPoint(x: box.maxX, y: box.maxY), options: [])
  context.restoreGState()

  // The logo's body spans 1...63 of its 64 units; ours spans the box.
  func map(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
    CGPoint(x: box.minX + (x - 1) / 62 * box.width, y: box.minY + (y - 1) / 62 * box.height)
  }
  func scale(_ length: CGFloat) -> CGFloat { length / 62 * box.width }

  context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
  for (x, y, w, h) in [(28.4, 11.5, 24.8, 8.6), (28.4, 15, 4.8, 30), (48.4, 11.5, 4.8, 30)] as [(CGFloat, CGFloat, CGFloat, CGFloat)] {
    let origin = map(x, y)
    let rect = CGRect(x: origin.x, y: origin.y, width: scale(w), height: scale(h))
    context.addPath(CGPath(roundedRect: rect, cornerWidth: scale(1.6), cornerHeight: scale(1.6), transform: nil))
    context.fillPath()
  }
  for (cx, cy) in [(23.6, 44.8), (43.6, 41.9)] as [(CGFloat, CGFloat)] {
    let center = map(cx, cy)
    context.fillEllipse(in: CGRect(
      x: center.x - scale(9.6), y: center.y - scale(7.5), width: scale(19.2), height: scale(15)))
  }

  return context.makeImage()!
}

func writePNG(_ image: CGImage, to url: URL) {
  let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { fatalError("Could not write \(url.path)") }
}

let iconset = FileManager.default.temporaryDirectory
  .appendingPathComponent("yanpresence-\(ProcessInfo.processInfo.processIdentifier).iconset")
try? FileManager.default.removeItem(at: iconset)
try! FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: iconset) }

// Every size iconutil knows, each drawn at its own resolution rather than
// scaled from the largest: the notes stay crisp at 16px.
for points in [16, 32, 128, 256, 512] {
  writePNG(render(points), to: iconset.appendingPathComponent("icon_\(points)x\(points).png"))
  writePNG(render(points * 2), to: iconset.appendingPathComponent("icon_\(points)x\(points)@2x.png"))
}

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["--convert", "icns", "--output", output.path, iconset.path]
try! iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { fatalError("iconutil failed: \(iconutil.terminationStatus)") }

let bytes = (try? FileManager.default.attributesOfItem(atPath: output.path)[.size] as? Int) ?? 0
print("Wrote \(output.path) (\(bytes) bytes)")
