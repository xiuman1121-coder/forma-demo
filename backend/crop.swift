import Foundation
import CoreGraphics
import ImageIO

let arguments = CommandLine.arguments
guard arguments.count >= 6,
      let rows = Int(arguments[2]), let cols = Int(arguments[3]),
      rows > 0, cols > 0, arguments.count == 4 + rows * cols,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: arguments[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      image.width >= cols, image.height >= rows else {
    fputs("Invalid crop input\n", stderr)
    exit(1)
}

for row in 0..<rows {
    for col in 0..<cols {
        let x0 = col * image.width / cols
        let x1 = (col + 1) * image.width / cols
        let y0 = row * image.height / rows
        let y1 = (row + 1) * image.height / rows
        let rect = CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
        guard let tile = image.cropping(to: rect),
              tile.width == x1 - x0, tile.height == y1 - y0,
              let destination = CGImageDestinationCreateWithURL(
                  URL(fileURLWithPath: arguments[4 + row * cols + col]) as CFURL,
                  "public.png" as CFString, 1, nil) else {
            fputs("Crop failed at row \(row + 1), col \(col + 1)\n", stderr)
            exit(1)
        }
        CGImageDestinationAddImage(destination, tile, nil)
        guard CGImageDestinationFinalize(destination) else {
            fputs("Could not save crop at row \(row + 1), col \(col + 1)\n", stderr)
            exit(1)
        }
    }
}
