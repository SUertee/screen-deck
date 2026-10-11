import Foundation
import CryptoKit
import Darwin

/// File storage with injected URLs: tests and previews never need the live user directory.
/// No directory/file is created by load. Save performs a bounded compare-and-swap and atomic replacement.
struct ConfigurationStore {
    let userFileURL: URL

    init(userFileURL: URL) { self.userFileURL = userFileURL }

    func loadUser() throws -> UserConfigurationSnapshot {
        guard let data = try ConfigurationFile.read(userFileURL) else {
            return UserConfigurationSnapshot(configuration: UserConfiguration(), digest: nil,
                                             sourceURL: userFileURL, backupURL: nil)
        }
        return UserConfigurationSnapshot(configuration: try ConfigurationParser.user(data),
                                         digest: Self.digest(data), sourceURL: userFileURL, backupURL: nil)
    }

    func loadProject(at projectRoot: URL) throws -> ProjectConfigurationSnapshot? {
        let url = projectRoot.appendingPathComponent(".screendeck", isDirectory: true)
            .appendingPathComponent("config.toml")
        guard let data = try ConfigurationFile.read(url) else { return nil }
        return ProjectConfigurationSnapshot(configuration: try ConfigurationParser.project(data),
                                            digest: Self.digest(data), sourceURL: url)
    }

    /// nil expectedDigest is only valid if config.toml is still absent.
    /// Formatting/comments are retained exactly in a private backup before any changed rewrite.
    /// Unknown/corrupt input is never overwritten by an ordinary preferences save.
    @discardableResult
    func saveUser(_ configuration: UserConfiguration, expectedDigest: String?) throws -> UserConfigurationSnapshot {
        let encoded = try ConfigurationParser.encode(configuration)
        let parent = try ConfigurationFile.openParent(userFileURL, create: true)
        defer { close(parent) }
        let name = userFileURL.lastPathComponent
        let lock = openat(parent, ".\(name).lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
        guard lock >= 0 else { throw ConfigurationFile.issue("无法锁定配置文件") }
        defer { close(lock) }
        var lockInfo = stat()
        guard fstat(lock, &lockInfo) == 0, lockInfo.st_mode & S_IFMT == S_IFREG, lockInfo.st_nlink == 1,
              flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw ConfigurationFile.issue("另一写入正在进行或锁文件无效，请稍后重试") }
        defer { flock(lock, LOCK_UN) }

        let previous = try ConfigurationFile.read(userFileURL)
        guard previous.map(Self.digest) == expectedDigest else {
            throw ConfigurationFile.issue("文件已被外部修改，请重新读取后再保存")
        }
        if let previous {
            let old = try ConfigurationParser.user(previous)
            if old == configuration {
                return UserConfigurationSnapshot(configuration: old, digest: expectedDigest,
                                                 sourceURL: userFileURL, backupURL: nil)
            }
        }

        var backupURL: URL?
        if let previous {
            let backupName = ".\(name).backup-\(UUID().uuidString.lowercased())"
            try ConfigurationFile.writeNew(previous, name: backupName, parent: parent)
            backupURL = userFileURL.deletingLastPathComponent().appendingPathComponent(backupName)
        }
        let temporary = ".\(name).\(UUID().uuidString.lowercased()).tmp"
        try ConfigurationFile.writeNew(encoded, name: temporary, parent: parent)
        defer { unlinkat(parent, temporary, 0) }
        // Detect pathname substitution as well as ordinary edits immediately before replacement.
        guard try ConfigurationFile.read(userFileURL).map(Self.digest) == expectedDigest else {
            throw ConfigurationFile.issue("保存前配置发生变化，原文件未覆盖")
        }
        let currentParent = try ConfigurationFile.openParent(userFileURL, create: false)
        defer { close(currentParent) }
        var originalInfo = stat(), currentInfo = stat()
        guard fstat(parent, &originalInfo) == 0, fstat(currentParent, &currentInfo) == 0,
              originalInfo.st_dev == currentInfo.st_dev, originalInfo.st_ino == currentInfo.st_ino else {
            throw ConfigurationFile.issue("配置目录发生变化，原文件未覆盖")
        }
        guard renameat(parent, temporary, parent, name) == 0 else { throw ConfigurationFile.issue("原子保存失败，保留原文件") }
        _ = fsync(parent)
        return UserConfigurationSnapshot(configuration: configuration, digest: Self.digest(encoded),
                                         sourceURL: userFileURL, backupURL: backupURL)
    }

    static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

private enum ConfigurationFile {
    static func issue(_ reason: String) -> ConfigurationError { ConfigurationError(field: "文件", reason: reason) }

    /// Every component is opened separately with O_NOFOLLOW. Ancestor symlinks are rejected too.
    static func openParent(_ url: URL, create: Bool) throws -> Int32 {
        guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost",
              url.path.hasPrefix("/"), !url.path.contains("\0"), !url.lastPathComponent.isEmpty else {
            throw issue("只支持本机绝对文件地址")
        }
        // macOS Foundation deliberately returns /var temporary URLs even after
        // resolvingSymlinksInPath. Permit only the two known OS aliases, never
        // project/user-created links; all remaining components stay no-follow.
        let components = try physicalSystemPath(url.path).split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard !components.contains(where: { $0 == "." || $0 == ".." }) else { throw issue("拒绝非规范文件地址") }
        var descriptor = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw issue("无法读取配置目录") }
        for component in components.dropLast() {
            var child = openat(descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            if child < 0, errno == ENOENT, create {
                guard mkdirat(descriptor, component, 0o700) == 0 || errno == EEXIST else {
                    close(descriptor); throw issue("无法创建私人配置目录")
                }
                child = openat(descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            }
            guard child >= 0 else {
                let code = errno
                close(descriptor)
                if code == ENOENT { throw Missing.parent }
                throw issue("目录不可读或包含符号链接")
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

    static func read(_ url: URL) throws -> Data? {
        let parent: Int32
        do { parent = try openParent(url, create: false) }
        catch Missing.parent { return nil }
        defer { close(parent) }
        let file = openat(parent, url.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard file >= 0 else {
            if errno == ENOENT { return nil }
            throw issue("文件不可读或是符号链接")
        }
        defer { close(file) }
        var before = stat()
        guard fstat(file, &before) == 0, before.st_mode & S_IFMT == S_IFREG else { throw issue("配置必须是普通文件") }
        guard before.st_size >= 0, before.st_size <= ConfigurationParser.maximumBytes else { throw issue("超过 128 KiB 上限") }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(file, $0.baseAddress, $0.count) }
            if count < 0 {
                if errno == EINTR { continue }
                throw issue("读取失败")
            }
            if count == 0 { break }
            guard data.count + count <= ConfigurationParser.maximumBytes else { throw issue("超过 128 KiB 上限") }
            data.append(contentsOf: buffer.prefix(count))
        }
        var after = stat(), pathInfo = stat()
        guard fstat(file, &after) == 0, fstatat(parent, url.lastPathComponent, &pathInfo, AT_SYMLINK_NOFOLLOW) == 0,
              before.st_dev == after.st_dev, before.st_ino == after.st_ino,
              before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              after.st_dev == pathInfo.st_dev, after.st_ino == pathInfo.st_ino,
              data.count == before.st_size else { throw issue("读取期间文件发生变化，请重试") }
        return data
    }

    static func writeNew(_ data: Data, name: String, parent: Int32) throws {
        let file = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard file >= 0 else { throw issue("无法创建私人配置文件") }
        defer { close(file) }
        do {
            try data.withUnsafeBytes { bytes in
                var position = 0
                while position < bytes.count {
                    let count = Darwin.write(file, bytes.baseAddress!.advanced(by: position), bytes.count - position)
                    if count < 0, errno == EINTR { continue }
                    guard count > 0 else { throw issue("写入配置失败") }
                    position += count
                }
            }
            guard fsync(file) == 0 else { throw issue("配置同步失败") }
        } catch {
            unlinkat(parent, name, 0)
            throw error
        }
    }
    private enum Missing: Error { case parent }
}
