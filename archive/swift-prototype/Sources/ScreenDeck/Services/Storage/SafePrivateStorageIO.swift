import Foundation
import Darwin

struct SafePrivateStorageError: LocalizedError {
    let reason: String
    var errorDescription: String? { "私人数据：\(reason)" }
}

struct PrivateStorageDirectoryEntry: Equatable {
    enum Kind: Equatable { case directory, regularFile, other }
    let name: String
    let kind: Kind
}

enum PrivateStorageDirectoryError: LocalizedError, Equatable {
    case directoryChanged, tooManyEntries

    var errorDescription: String? {
        switch self {
        case .directoryChanged: return "私人数据：读取期间目录发生变化，请重试"
        case .tooManyEntries: return "私人数据：目录条目超过读取上限"
        }
    }
}

/// Shared private JSON I/O. URLs are injected; loading never creates data.
/// Arbitrary symlink ancestors/leaves are forbidden even if introduced after construction.
enum SafePrivateStorageIO {
    static let defaultMaximumBytes = 32 * 1024 * 1024
    static let defaultMaximumDirectoryEntries = 100_000

    /// Read-only directory detection with the same no-symlink traversal as private file I/O.
    /// Missing components are absent; inaccessible, non-directory or linked components are errors.
    static func directoryExists(_ url: URL) throws -> Bool {
        let descriptor: Int32
        do { descriptor = try openParent(url.appendingPathComponent(".directory-validation"), create: false) }
        catch Missing.parent { return false }
        defer { close(descriptor) }
        return true
    }

    /// A bounded, read-only snapshot. Only a missing directory returns nil.
    /// Child links are reported as other; neither the directory path nor its children follow links.
    static func directoryEntries(_ url: URL, maximumEntries: Int) throws -> [PrivateStorageDirectoryEntry]? {
        guard maximumEntries > 0, maximumEntries <= defaultMaximumDirectoryEntries else {
            throw issue("目录读取上限无效")
        }
        let directoryPath = url.appendingPathComponent(".directory-validation")
        let descriptor: Int32
        do { descriptor = try openParent(directoryPath, create: false) }
        catch Missing.parent { return nil }
        guard let stream = fdopendir(descriptor) else {
            close(descriptor)
            throw issue("无法读取数据目录")
        }
        defer { closedir(stream) }
        var before = stat()
        guard fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFDIR else {
            throw issue("位置必须是目录")
        }
        var entries: [PrivateStorageDirectoryEntry] = []
        while true {
            errno = 0
            guard let entry = readdir(stream) else {
                guard errno == 0 else { throw issue("读取目录失败") }
                break
            }
            let nameLength = Int(entry.pointee.d_namlen)
            let name = try withUnsafeBytes(of: &entry.pointee.d_name) { bytes -> String in
                guard nameLength > 0, nameLength < bytes.count, bytes[nameLength] == 0,
                      let value = String(bytes: bytes.prefix(nameLength), encoding: .utf8),
                      !value.contains("/"), !value.contains("\0") else {
                    throw issue("目录条目名称无效")
                }
                return value
            }
            if name == "." || name == ".." { continue }
            guard entries.count < maximumEntries else { throw PrivateStorageDirectoryError.tooManyEntries }
            var info = stat()
            guard fstatat(descriptor, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else {
                if errno == ENOENT { throw PrivateStorageDirectoryError.directoryChanged }
                throw issue("目录条目不可读")
            }
            guard entry.pointee.d_ino == 0 || entry.pointee.d_ino == info.st_ino else {
                throw PrivateStorageDirectoryError.directoryChanged
            }
            let kind: PrivateStorageDirectoryEntry.Kind
            switch info.st_mode & S_IFMT {
            case S_IFDIR: kind = .directory
            case S_IFREG: kind = .regularFile
            default: kind = .other
            }
            entries.append(.init(name: name, kind: kind))
        }
        let currentDirectory: Int32
        do { currentDirectory = try openParent(directoryPath, create: false) }
        catch { throw PrivateStorageDirectoryError.directoryChanged }
        defer { close(currentDirectory) }
        do { try sameDirectory(descriptor, currentDirectory) }
        catch { throw PrivateStorageDirectoryError.directoryChanged }
        var after = stat()
        guard fstat(descriptor, &after) == 0,
              before.st_dev == after.st_dev, before.st_ino == after.st_ino,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else {
            throw PrivateStorageDirectoryError.directoryChanged
        }
        return entries
    }

    static func read(_ url: URL, maximumBytes: Int) throws -> Data? {
        guard maximumBytes > 0, maximumBytes <= defaultMaximumBytes else { throw issue("读取上限无效") }
        let parent: Int32
        do { parent = try openParent(url, create: false) }
        catch Missing.parent { return nil }
        defer { close(parent) }
        let data = try read(name: url.lastPathComponent, parent: parent, maximumBytes: maximumBytes)
        let currentParent: Int32
        do { currentParent = try openParent(url, create: false) }
        catch { throw issue("读取期间目录发生变化，请重试") }
        defer { close(currentParent) }
        try sameDirectory(parent, currentParent)
        return data
    }

    /// Compare exact bytes under a per-file advisory lock before atomic rename.
    /// Cooperating writers serialize; external changes are checked immediately before replacement.
    static func write(_ data: Data, to url: URL, expected: Data?,
                      maximumBytes: Int = defaultMaximumBytes) throws {
        guard maximumBytes > 0, maximumBytes <= defaultMaximumBytes,
              data.count <= maximumBytes else { throw issue("文件超过保存上限，原文件未覆盖") }
        let parent = try openParent(url, create: true)
        defer { close(parent) }
        let name = url.lastPathComponent
        let lock = openat(parent, ".\(name).lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
        guard lock >= 0 else { throw issue("无法锁定保存位置") }
        defer { close(lock) }
        var lockInfo = stat()
        guard fstat(lock, &lockInfo) == 0, lockInfo.st_mode & S_IFMT == S_IFREG,
              lockInfo.st_nlink == 1, flock(lock, LOCK_EX | LOCK_NB) == 0 else {
            throw issue("正在被其他写入占用或锁文件无效，请重试")
        }
        defer { flock(lock, LOCK_UN) }
        guard try read(name: name, parent: parent, maximumBytes: maximumBytes) == expected else {
            throw issue("文件已被外部修改，请重新读取后再保存")
        }
        if data == expected { return }
        let temporary = ".\(name).\(UUID().uuidString.lowercased()).tmp"
        let file = openat(parent, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard file >= 0 else { throw issue("无法创建私人临时文件") }
        defer { close(file); unlinkat(parent, temporary, 0) }
        try data.withUnsafeBytes { bytes in
            var position = 0
            while position < bytes.count {
                let written = Darwin.write(file, bytes.baseAddress!.advanced(by: position), bytes.count - position)
                if written < 0, errno == EINTR { continue }
                guard written > 0 else { throw issue("写入失败，原文件未覆盖") }
                position += written
            }
        }
        guard fsync(file) == 0 else { throw issue("同步失败，原文件未覆盖") }
        let currentParent = try openParent(url, create: false)
        defer { close(currentParent) }
        try sameDirectory(parent, currentParent)
        guard try read(name: name, parent: parent, maximumBytes: maximumBytes) == expected else {
            throw issue("保存前文件发生变化，原文件未覆盖")
        }
        guard renameat(parent, temporary, parent, name) == 0 else { throw issue("原子保存失败，原文件未覆盖") }
        _ = fsync(parent)
    }

    private static func read(name: String, parent: Int32, maximumBytes: Int) throws -> Data? {
        let file = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard file >= 0 else {
            if errno == ENOENT { return nil }
            throw issue("文件不可读或是符号链接")
        }
        defer { close(file) }
        var before = stat()
        guard fstat(file, &before) == 0, before.st_mode & S_IFMT == S_IFREG else { throw issue("位置必须是普通文件") }
        guard before.st_size >= 0, before.st_size <= maximumBytes else { throw issue("文件超过读取上限，原文件未覆盖") }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(file, $0.baseAddress, $0.count) }
            if count < 0 {
                if errno == EINTR { continue }
                throw issue("读取失败")
            }
            if count == 0 { break }
            guard data.count + count <= maximumBytes else { throw issue("文件超过读取上限") }
            data.append(contentsOf: buffer.prefix(count))
        }
        var after = stat(), entry = stat()
        guard fstat(file, &after) == 0, fstatat(parent, name, &entry, AT_SYMLINK_NOFOLLOW) == 0,
              before.st_dev == after.st_dev, before.st_ino == after.st_ino,
              before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              after.st_dev == entry.st_dev, after.st_ino == entry.st_ino,
              after.st_mode & S_IFMT == S_IFREG, data.count == before.st_size else {
            throw issue("读取期间文件发生变化，请重试")
        }
        return data
    }

    private static func openParent(_ url: URL, create: Bool) throws -> Int32 {
        guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost",
              url.path.hasPrefix("/"), !url.path.contains("\0"), !url.lastPathComponent.isEmpty else { throw issue("文件地址无效") }
        let components = try physicalSystemPath(url.path).split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard !components.contains(where: { $0 == "." || $0 == ".." }) else { throw issue("拒绝非规范文件地址") }
        var descriptor = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw issue("无法读取数据目录") }
        for component in components.dropLast() {
            var child = openat(descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            if child < 0, errno == ENOENT, create {
                guard mkdirat(descriptor, component, 0o700) == 0 || errno == EEXIST else {
                    close(descriptor); throw issue("无法创建私人数据目录")
                }
                child = openat(descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            }
            guard child >= 0 else {
                let code = errno
                close(descriptor)
                if code == ENOENT { throw Missing.parent }
                throw issue("数据目录不可读或包含符号链接")
            }
            close(descriptor)
            descriptor = child
        }
        return descriptor
    }

    private static func physicalSystemPath(_ path: String) throws -> String {
        for alias in ["var", "tmp"] where path == "/\(alias)" || path.hasPrefix("/\(alias)/") {
            var bytes = [CChar](repeating: 0, count: 128)
            let count = readlink("/\(alias)", &bytes, bytes.count - 1)
            guard count >= 0, String(cString: bytes) == "private/\(alias)" || String(cString: bytes) == "/private/\(alias)" else {
                throw issue("系统目录别名无效")
            }
            return "/private" + path
        }
        return path
    }
    private static func sameDirectory(_ first: Int32, _ second: Int32) throws {
        var a = stat(), b = stat()
        guard fstat(first, &a) == 0, fstat(second, &b) == 0,
              a.st_dev == b.st_dev, a.st_ino == b.st_ino else { throw issue("数据目录发生变化，请重新读取") }
    }
    private static func issue(_ reason: String) -> SafePrivateStorageError { SafePrivateStorageError(reason: reason) }
    private enum Missing: Error { case parent }
}
