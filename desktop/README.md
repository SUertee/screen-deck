# ScreenDeck Desktop

React + Electron + TypeScript/Node.js 主版本。工作台与业务核心分离；旧 Swift 工程冻结在 [archive/swift-prototype](../archive/swift-prototype/README.md)，不自动迁移旧数据。

## 运行

需要 Node.js 22.12+（推荐 24）、npm；首次安装需联网。

dev、smoke 和 package:mac 会先运行 Electron 官方二进制安装器，已有锁定版本时直接复用，不修改全局配置。

```sh
cd desktop
npm ci
npm run dev
```

校验：`npm run typecheck`、`npm test`、`npm run build`、`npm run smoke`。本地 macOS 包：`npm run package:mac`；已有输出不会被覆盖。

## 当前能力

- 黑白工作台、新聊天、搜索、项目任务、时间线、附着设置和联动 Deck 小窗口。
- Chat Completions 真实无工具对话、流式回复、本地停止接收、历史保存和重启恢复。
- 明确选择项目后只读展示原 task/run 与受限附件；历史运行不冒充当前进程。
- 独立预览分工计划可手动保存；规则只提建议，不执行、不授权。JEV、对话改计划和完整任务调度尚未接入。

## 分层

| 位置 | 职责 |
| --- | --- |
| src/renderer | React 界面，只有固定桌面接口，无 Node.js，不能读取已保存密钥。 |
| src/main | 窗口、安全 IPC、设置和服务组装，不拥有另一份任务状态。 |
| src/core | SessionManager、TaskOrchestrator、DecisionEngine、ExecutionDriver、ApprovalService 与持久化。 |
| src/projects | 原项目记录的严格只读校验、注册快照与附件预览。 |
| src/shared | 桌面接口和记录类型；运行时仍校验外部输入。 |

## 数据与边界

预览数据在 `~/.screendeck/previews/electron-v1/`：provider.toml 保存非秘密配置，credential.bin 使用 Electron safeStorage 加密，sessions 按 UTC 创建日期归档，local-state 保存草稿和位置索引。预览计划以稳定项目/任务 ID 关联，不写入既有 task/run v1；审批核心仅为基础设施原型，尚无桌面审批与执行授权入口。

只外发当前会话中已完成的消息及本次输入；不自动附加项目、日志、截图或其他聊天。密钥不返回界面、不写源码与日志；加密不可用时只保留内存。停止仅表示本地接收取消，不能保证服务端停止；未知结果不自动重发，保存失败可单独重试。

勾选“记住 API 密钥”后加密保存在本机；发送时异步读取，不再需要手动解锁。启动、打开设置和修改模型不读取密钥；系统可能请求钥匙串授权，拒绝时保留草稿并提示重试或重填。不勾选则仅在内存保留。配置和密文分别原子写入，不是跨文件事务；部分保存失败会禁用当前连接，应重新检查并明确保存。

本版不是完整 coding Agent：没有工具执行、OpenCode/Codex CLI 适配、录屏、刘海吸附、手机同步或 Windows 安装包。TaskOrchestrator 目前只保存和校验预览计划，不调度或验收。Swift 的采集等功能仍在原版，未用空按钮冒充迁移完成。

结果未知的会话不自动重发，也没有远端核对入口，可另开新会话。`finished` 表示接口给出结束标记，不保证回答完整；暂不记录用量和详细结束原因。

本地包为临时签名预览，未做 Developer ID 签名、公证或公开发行验收。Node 路径检查不是 OS 沙箱；并发存储锁也不等同 Swift flock，不可让两版写同一会话库。
