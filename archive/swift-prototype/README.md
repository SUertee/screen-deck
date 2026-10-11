# Swift 原型归档

旧 macOS 工程已冻结，保留归档时的源码、测试与未提交改动，仅供参考和恢复。主开发入口仍是 [desktop](../../desktop/README.md)。

- `Sources/`、`Tests/`、`Package.swift`、`Package.resolved`：原工程，源码字节未改写。
- `Resources/`、`scripts/package-local.sh`：原打包资源；schema 是冻结副本，现行共享契约仍在根 `Resources/Schemas/`。
- `.build/`：Git 忽略的历史缓存，含旧路径，不作为可运行性或验收依据。

需要恢复运行时，使用 Swift 6、macOS 14+，在本目录重新构建：

```sh
swift run --scratch-path /private/tmp/screendeck-swift-rebuild ScreenDeck
```

依赖未缓存时需联网。本地包用 `zsh scripts/package-local.sh`，脚本使用独立临时构建目录。先核对测试数据，不让两版共用可写会话库。

归档没有移动用户聊天、密钥、任务、采集数据或已有应用包；刘海原生实现保留作未来桥接参考，不参与默认桌面开发。
