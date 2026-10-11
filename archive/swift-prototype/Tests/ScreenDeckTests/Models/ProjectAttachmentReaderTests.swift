import XCTest
import Darwin
import ImageIO
import UniformTypeIdentifiers
@testable import ScreenDeck

final class ProjectAttachmentReaderTests: XCTestCase {
    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("screendeck-attachment-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("docs"), withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    @discardableResult
    private func write(_ data: Data, path: String, root: URL) throws -> ProjectFileReference {
        try data.write(to: root.appendingPathComponent(path))
        return ProjectFileReference(path: path, label: "预览材料")
    }

    private func rejects(_ reference: ProjectFileReference, root: URL, containing text: String? = nil,
                         file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try ProjectAttachmentReader().read(reference: reference, root: root), file: file, line: line) { error in
            XCTAssertTrue(error is ProjectRecordReadError, "\(error)", file: file, line: line)
            if let text {
                XCTAssertTrue(error.localizedDescription.contains(text), "\(error)", file: file, line: line)
            }
        }
    }

    private func imageData(type: UTType = .png, frames: Int = 1) throws -> Data {
        let context = try XCTUnwrap(CGContext(data: nil, width: 2, height: 3, bitsPerComponent: 8,
                                             bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
                                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, type.identifier as CFString, frames, nil))
        if type == .gif && frames > 1 {
            CGImageDestinationSetProperties(destination, [kCGImagePropertyGIFDictionary as String:
                [kCGImagePropertyGIFLoopCount as String: 0]] as CFDictionary)
        }
        for index in 0..<frames {
            // Identical frames without timing may be coalesced by the GIF writer.
            // Make the animation fixture visibly distinct and explicitly timed.
            context.setFillColor(index.isMultiple(of: 2)
                                 ? CGColor(red: 1, green: 1, blue: 1, alpha: 1)
                                 : CGColor(red: 1, green: 0, blue: 0, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: 2, height: 3))
            let image = try XCTUnwrap(context.makeImage())
            let properties: CFDictionary? = type == .gif && frames > 1
                ? [kCGImagePropertyGIFDictionary as String:
                    [kCGImagePropertyGIFDelayTime as String: 0.2]] as CFDictionary : nil
            CGImageDestinationAddImage(destination, image, properties)
        }
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    // Valid CRC on a tiny PNG's enlarged IHDR tests bounds before decompression.
    // The mismatched tiny pixel payload must never be decoded into a huge bitmap.
    private func pngHeaderDimensions(width: UInt32, height: UInt32) throws -> Data {
        var bytes = [UInt8](try imageData())
        for (offset, value) in [(16, width), (20, height)] {
            for index in 0..<4 { bytes[offset + index] = UInt8(truncatingIfNeeded: value >> (24 - index * 8)) }
        }
        var crc = UInt32.max
        for byte in bytes[12..<29] {
            crc ^= UInt32(byte)
            for _ in 0..<8 { crc = (crc >> 1) ^ ((crc & 1) == 1 ? 0xEDB88320 : 0) }
        }
        crc ^= UInt32.max
        for index in 0..<4 { bytes[29 + index] = UInt8(truncatingIfNeeded: crc >> (24 - index * 8)) }
        return Data(bytes)
    }

    func testUTF8TextPreviewKeepsLiteralContentsMetadataAndSource() throws {
        let root = try fixture()
        let literal = "# 工作材料\n<script>not executed</script>\n[remote](https://example.com)\n{invalid JSON is displayed literally}\n"
        let data = Data(literal.utf8)
        let earliest = Date()
        for ext in ["md", "txt", "json", "MD"] {
            let reference = try write(data, path: "docs/material.\(ext)", root: root)
            let first = try ProjectAttachmentReader().read(reference: reference, root: root)
            let second = try ProjectAttachmentReader().read(reference: reference, root: root)
            XCTAssertEqual(first.content, .text(literal))
            XCTAssertEqual(first.content, second.content)
            XCTAssertEqual(first.fileName, "material.\(ext)")
            XCTAssertEqual(first.bytes, data.count)
            XCTAssertEqual(first.sourceURL, root.standardizedFileURL.appendingPathComponent(reference.path))
            XCTAssertGreaterThanOrEqual(first.loadedAt, earliest)
            XCTAssertLessThanOrEqual(first.loadedAt, Date())
            XCTAssertEqual(try Data(contentsOf: first.sourceURL), data)
        }
    }

    func testEmptyTextIsValidButMalformedUTF8IsRejected() throws {
        let root = try fixture()
        let empty = try write(Data(), path: "docs/empty.txt", root: root)
        XCTAssertEqual(try ProjectAttachmentReader().read(reference: empty, root: root).content, .text(""))
        let malformed = try write(Data([0xC3, 0x28, 0xFF]), path: "docs/broken.md", root: root)
        rejects(malformed, root: root, containing: "UTF-8")
    }

    func testTraversalAbsoluteRemoteAndNoncanonicalReferencesAreRejected() throws {
        let root = try fixture()
        for path in ["../outside.md", "/tmp/outside.txt", "https://example.com/a.md", "file:/tmp/a.txt",
                     "docs/../outside.md", "docs//a.txt", "docs/a.md#anchor", "docs/a.md?download", "docs\\a.txt"] {
            rejects(ProjectFileReference(path: path, label: "不可信引用"), root: root)
        }
        let reference = try write(Data("test".utf8), path: "docs/test.txt", root: root)
        rejects(reference, root: URL(string: "https://example.com")!, containing: "本机")
    }

    func testLeafIntermediateAndRootSymlinksAreRejected() throws {
        let root = try fixture()
        let original = try write(Data("source".utf8), path: "docs/original.txt", root: root)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("docs/link.txt"),
                                                  withDestinationURL: root.appendingPathComponent(original.path))
        rejects(ProjectFileReference(path: "docs/link.txt", label: "leaf link"), root: root, containing: "符号链接")
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("alias"),
                                                  withDestinationURL: root.appendingPathComponent("docs"))
        rejects(ProjectFileReference(path: "alias/original.txt", label: "directory link"), root: root, containing: "符号链接")
        let alias = root.deletingLastPathComponent().appendingPathComponent("screendeck-attachment-alias-\(UUID().uuidString)")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: root)
        addTeardownBlock { try? FileManager.default.removeItem(at: alias) }
        rejects(original, root: alias, containing: "符号链接")
        rejects(original, root: URL(fileURLWithPath: alias.path + "/", isDirectory: true), containing: "符号链接")
    }

    func testFIFOAndDirectoryDoNotBlockOrGetReadAsAttachments() throws {
        let root = try fixture()
        let fifo = root.appendingPathComponent("docs/pipe.txt")
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
        rejects(ProjectFileReference(path: "docs/pipe.txt", label: "FIFO"), root: root, containing: "普通文件")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("docs/folder.md"), withIntermediateDirectories: false)
        rejects(ProjectFileReference(path: "docs/folder.md", label: "目录"), root: root, containing: "普通文件")
    }

    func testTextSizeLimitAcceptsBoundaryAndRejectsExcess() throws {
        let root = try fixture()
        let boundary = try write(Data(repeating: 65, count: 2 * 1024 * 1024), path: "docs/boundary.txt", root: root)
        XCTAssertEqual(try ProjectAttachmentReader().read(reference: boundary, root: root).bytes, 2 * 1024 * 1024)
        let excess = try write(Data(repeating: 65, count: 2 * 1024 * 1024 + 1), path: "docs/excess.txt", root: root)
        rejects(excess, root: root, containing: "上限")
    }

    func testRawReferenceReadEnforcesCallerMaximumAndGlobalCeiling() throws {
        let root = try fixture()
        let data = Data("12345678".utf8)
        let reference = try write(data, path: "docs/raw.txt", root: root)
        let reader = ProjectRecordReader()
        XCTAssertEqual(try reader.readReferenceData(reference, root: root, maximumBytes: 8), data)
        for maximum in [-1, 0, 7, 16 * 1024 * 1024 + 1, Int.max] {
            XCTAssertThrowsError(try reader.readReferenceData(reference, root: root, maximumBytes: maximum))
        }
    }

    func testUnsupportedFormatsStayUnavailableForInlinePreview() throws {
        let root = try fixture()
        for ext in ["html", "svg", "pdf", "bin", "swift", ""] {
            let reference = try write(Data("not interpreted".utf8), path: "docs/unsupported.\(ext)", root: root)
            rejects(reference, root: root, containing: "系统应用")
        }
    }

    func testPNGJPEGAndGIFPreviewsRetainBoundedOriginalImageData() throws {
        let root = try fixture()
        for (ext, type) in [("png", UTType.png), ("jpg", UTType.jpeg), ("jpeg", UTType.jpeg), ("gif", UTType.gif)] {
            let data = try imageData(type: type)
            let reference = try write(data, path: "docs/image.\(ext)", root: root)
            let preview = try ProjectAttachmentReader().read(reference: reference, root: root)
            XCTAssertEqual(preview.content, .image(data))
            XCTAssertEqual(preview.bytes, data.count)
            XCTAssertEqual(try Data(contentsOf: preview.sourceURL), data)
        }
        let animated = try imageData(type: .gif, frames: 2)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(animated as CFData, nil))
        XCTAssertEqual(CGImageSourceGetCount(source), 2)
        let firstFrame = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let secondFrame = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 1, nil))
        XCTAssertEqual(firstFrame.width, 2)
        XCTAssertEqual(firstFrame.height, 3)
        let firstPixels = try XCTUnwrap(firstFrame.dataProvider?.data) as Data
        let secondPixels = try XCTUnwrap(secondFrame.dataProvider?.data) as Data
        XCTAssertNotEqual(firstPixels, secondPixels, "The fixture must contain two distinct frames, not duplicate still images")
        let reference = try write(animated, path: "docs/animated.gif", root: root)
        XCTAssertEqual(try ProjectAttachmentReader().read(reference: reference, root: root).content, .image(animated))
    }

    func testDamagedMislabeledAndOversizedImagesAreRejected() throws {
        let root = try fixture()
        let damaged = try write(Data("not an image".utf8), path: "docs/damaged.png", root: root)
        rejects(damaged, root: root, containing: "图片")
        let mislabeled = try write(imageData(type: .png), path: "docs/mislabeled.jpg", root: root)
        rejects(mislabeled, root: root, containing: "扩展名")
        let truncated = try write(Data(try imageData().prefix(33)), path: "docs/truncated.png", root: root)
        rejects(truncated, root: root, containing: "图片")
        let excess = try write(Data(repeating: 0, count: 16 * 1024 * 1024 + 1), path: "docs/excess.png", root: root)
        rejects(excess, root: root, containing: "上限")
    }

    func testImageDimensionAndPixelLimitsRejectBeforeDecode() throws {
        let root = try fixture()
        for (index, dimensions) in [(UInt32(8193), UInt32(1)), (UInt32(1), UInt32(8193)),
                                    (UInt32(5000), UInt32(4001))].enumerated() {
            let data = try pngHeaderDimensions(width: dimensions.0, height: dimensions.1)
            let reference = try write(data, path: "docs/oversized-\(index).png", root: root)
            rejects(reference, root: root, containing: "尺寸")
        }
    }
}
