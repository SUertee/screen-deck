import Foundation
import ImageIO
import UniformTypeIdentifiers

struct ProjectAttachmentPreview: Equatable, Sendable {
    enum Content: Equatable, Sendable {
        case text(String)
        // Keep the bounded source bytes. The view decodes index 0 as a static image.
        case image(Data)
    }

    let content: Content
    let fileName: String
    let bytes: Int
    let loadedAt: Date
    let sourceURL: URL
}

/// Plain text and static first-frame image previews of an explicitly selected file.
/// It never interprets Markdown/HTML, follows URLs, or updates project records.
struct ProjectAttachmentReader: Sendable {
    private let reader: ProjectRecordReader
    init(privateRoot: URL = ScreenDeckPaths().root) { reader = ProjectRecordReader(privateRoot: privateRoot) }

    func read(reference: ProjectFileReference, root: URL) throws -> ProjectAttachmentPreview {
        let ext = URL(fileURLWithPath: reference.path).pathExtension.lowercased()
        let textTypes: Set<String> = ["md", "txt", "json"]
        let imageTypes = ["png": UTType.png.identifier, "jpg": UTType.jpeg.identifier,
                          "jpeg": UTType.jpeg.identifier, "gif": UTType.gif.identifier,
                          "webp": UTType.webP.identifier]
        guard textTypes.contains(ext) || imageTypes[ext] != nil else {
            throw ProjectRecordReadError(path: reference.path,
                                         reason: "暂不支持此文件的内置预览，请在系统应用中打开")
        }
        let source = try reader.readReference(reference, root: root,
                                              maximumBytes: textTypes.contains(ext) ? 2 * 1024 * 1024 : 16 * 1024 * 1024)
        let data = source.data
        let content: ProjectAttachmentPreview.Content
        if textTypes.contains(ext) {
            guard let text = String(data: data, encoding: .utf8) else {
                throw ProjectRecordReadError(path: reference.path, reason: "文件不是有效的 UTF-8 文本，无法预览")
            }
            content = .text(text)
        } else {
            try validateImage(data, expectedType: imageTypes[ext]!, path: reference.path)
            content = .image(data)
        }
        return ProjectAttachmentPreview(content: content,
                                        fileName: source.url.lastPathComponent,
                                        bytes: data.count, loadedAt: Date(),
                                        sourceURL: source.url)
    }

    private func validateImage(_ data: Data, expectedType: String, path: String) throws {
        let options = [kCGImageSourceShouldCache as String: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, options),
              let sourceType = CGImageSourceGetType(source),
              (sourceType as String) == expectedType,
              CGImageSourceGetCount(source) > 0 else {
            throw ProjectRecordReadError(path: path, reason: "图片格式损坏或与文件扩展名不一致，无法预览")
        }
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, options) as? [String: Any],
              let width = dimension(properties[kCGImagePropertyPixelWidth as String]),
              let height = dimension(properties[kCGImagePropertyPixelHeight as String]),
              width * height <= 20_000_000 else {
            throw ProjectRecordReadError(path: path, reason: "图片尺寸超过预览上限：单边 8192 像素、总计 2000 万像素")
        }
        let decodeOptions = [kCGImageSourceShouldCache as String: true,
                             kCGImageSourceShouldCacheImmediately as String: true] as CFDictionary
        guard let firstFrame = CGImageSourceCreateImageAtIndex(source, 0, decodeOptions),
              firstFrame.width == width, firstFrame.height == height else {
            throw ProjectRecordReadError(path: path, reason: "图片首帧无法完整解码，请在系统应用中查看")
        }
    }

    private func dimension(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber else { return nil }
        let dimension = number.doubleValue
        guard dimension.isFinite, dimension >= 1, dimension <= 8192,
              dimension.rounded(.towardZero) == dimension else { return nil }
        return Int(dimension)
    }
}
