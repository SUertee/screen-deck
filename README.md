# ScreenDeck

聊天为中心的人机任务工作台。主版本为 **React + Electron + TypeScript/Node.js**，代码在 [desktop](desktop/README.md)；旧 Swift macOS 工程已冻结归档。

## 当前版本

- 黑白工作台、新聊天、项目任务与执行时间线、任务/文件标签页、附着设置和联动 Deck 小窗口。
- 真实 Chat Completions 无工具对话、流式回复、本地停止、历史保存和重启恢复。
- 只读查看已关联项目的 task/run 与受限附件；预览分工计划可手动保存，不执行或验收任务。

这还不是完整 coding Agent：OpenCode/Codex CLI、工具循环、完整审批、录屏、刘海吸附、手机同步和 Windows 安装包尚未迁移或实现。

## 运行

需要 Node.js 22.12+（推荐 24）和 npm。

```sh
cd desktop
npm ci
npm run dev
```

验证：`npm run typecheck`、`npm test`、`npm run build`、`npm run smoke`。macOS 本地临时签名预览包：`npm run package:mac`；不覆盖已有输出，未做公开发行签名与公证。

## 数据与隐私

新版预览数据在 `~/.screendeck/previews/electron-v1/`，与 Swift 原型隔离；不自动迁移、合并或双写旧数据。项目内 `.screendeck/` 仍只保存身份与约定，私人 task/run 留在用户数据区。

设置中显式配置模型与凭据；API Key 只由 main 进程保管，支持系统加密保存。聊天仅外发本会话已完成消息和当前输入，不自动附加项目文件、其他聊天、日志或屏幕记录。停止不保证远端停止，未知结果不自动重发。聊天文件未加密，仍需保护本机数据。

配置、日志、计划和模型建议都不授予工具执行权限。详细能力、分层与限制见 [桌面说明](desktop/README.md)，开发约定见 [AGENTS.md](AGENTS.md)。

## Swift 原型

旧源码、测试、Package 和打包资源在 [archive/swift-prototype](archive/swift-prototype/README.md)，保留未提交改动及被 Git 忽略的历史缓存；不参与默认开发。刘海与采集的旧实现仍可供原生桥接参考，未迁移到 Electron。

根 `Resources/Schemas/` 与记录校验脚本仍是现行共享契约。归档只移动仓库文件，不移动用户数据或已安装应用；两版不能共用可写会话目录。

docs 与 AGENTLOG 是被 Git 忽略的本机资料，不随克隆或推送。当前任务记录不代表自动开发日志已实现。
