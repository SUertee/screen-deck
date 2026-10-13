# ScreenDeck

聊天为中心的人机任务工作台。主版本为 **React + Electron + TypeScript/Node.js**，代码在 [desktop](desktop/README.md)；旧 Swift macOS 工程已冻结归档。

## 当前版本

- 黑白工作台、新聊天、项目任务与执行时间线、任务／文件页签、附着设置和联动 Deck 小窗口。
- 真实 Chat Completions 无工具对话、流式回复、本地停止、历史保存和重启恢复。
- 中心常驻聊天正文与输入区，右栏展示任务和文件；预览计划可手动保存，“讨论这一步”只带入草稿。正式项目 task/run 与受限附件保持只读。
- 旧试运行记录可在中心聊天查看并处理既有工具许可、核对和人工验收；原任务不可读时仍有恢复入口。新模拟尝试入口已撤下，假执行器保留供隔离测试，不改正式任务状态。

这还不是完整 coding Agent：真实工具循环、OpenCode/Codex CLI、正式任务创建／编辑、对话改计划、录屏、刘海吸附、手机同步和 Windows 安装包尚未迁移或实现。

## 运行

需要 Node.js 22.12+ 和 npm；本机及 CI 使用 22.21.1。

```sh
cd desktop
npm ci
npm run dev
```

验证：`npm run typecheck`、`npm test`、`npm run build`、`npm run smoke`。macOS 本地临时签名预览包：`npm run package:mac`；不覆盖已有输出，未做公开发行签名与公证。首次安装需联网，隔离检查与已有依赖的脚本入口见 [桌面说明](desktop/README.md)。

## 团队协作

| 分支 | 用途与操作 |
| --- | --- |
| `main` | 稳定主线；必须通过 PR、`Desktop checks`、分支最新与讨论解决，由 SUertee 手动合并。禁止直接推送、强推和删除，AI 不自行合并。 |
| `dev` | 长期集成分支，承载当前开发代码；协作者可直接提交与 push，不强制 PR。 |
| `feat/*`、`fix/*` 等 | 从最新 dev 创建，适合并行或较大改动，完成后合入 dev。 |

短期分支如 `feat/task-editor`，提交与 PR 标题如 `fix(chat): 修复窄窗焦点恢复`。一次提交围绕一个目的，保留他人修改，不强推或删除长期分支。集成版本通过 `dev → main` PR 更新主线，使用 merge commit 保留长期分支共同历史。

开始开发：

```sh
git fetch origin
git switch dev
git pull --ff-only origin dev
git switch -c feat/task-editor
```

小改动可直接留在 dev；并行开发先明确修改范围。主线 PR 无需额外 approval，由 main 保护与 `main-owner-merge-only` 规则限制更新。提交、推送和主线合并是不同操作，AI 按用户本次授权执行。

[`Desktop checks`](.github/workflows/desktop-checks.yml) 在 macOS runner 上对 dev/main 的 push 与 PR 执行类型检查、单元测试、构建及根记录校验器的临时数据测试。它不验证 Electron 实机界面、真实模型或外部执行，也不自动发布安装包。界面／IPC 改动补相应本地隔离 smoke；PR 使用[模板](.github/pull_request_template.md)。完整规则见 [AGENTS.md](AGENTS.md)，远端限制以实际分支保护与规则集为准。

## 数据与隐私

正式项目的 JSON 历史默认在 `~/.screendeck/projects/<project_id>/`：`history.json` 绑定项目根目录，`tasks/`、`runs/`、`artifacts/` 保存任务、执行记录与原件。项目内 `.screendeck/` 只保存身份与约定。

Electron 聊天、task-v2 任务会话、预览计划与审批另存于 `~/.screendeck/previews/electron-v1/`，与正式项目历史及 Swift 原型隔离；不自动迁移、合并、双写或回写正式任务。

设置中显式配置模型与凭据；API Key 只由 main 进程保管，支持系统加密保存。聊天仅外发本会话已完成消息和当前输入，不自动附加项目文件、其他聊天、日志或屏幕记录。停止不保证远端停止，未知结果不自动重发。聊天文件未加密，仍需保护本机数据。

配置、日志、计划和模型建议都不授予工具执行权限。批准／开始、工具决定／投递、执行结束／验收保持分别确认；详细能力、分层与限制见 [桌面说明](desktop/README.md)。

正式项目记录的唯一规则源是 [`desktop/src/projects/record-schema.ts`](desktop/src/projects/record-schema.ts)，Electron 的 AJV 入口与根只读校验脚本复用字段和日期规则；独立 JSON Schema 副本已移除，用户记录仍是 JSON。根脚本需要支持原生 TypeScript 类型剥离的 Node.js，本机已验证 22.21.1；桌面应用的 22.12+ 最低要求不等于所有该版本 Node 都能直接运行此脚本。

## Swift 原型

旧源码、测试、Package 和打包资源在 [archive/swift-prototype](archive/swift-prototype/README.md)，保留未提交改动及被 Git 忽略的历史缓存；不参与默认开发。刘海与采集的旧实现仍可供原生桥接参考，未迁移到 Electron。

归档只移动仓库文件，不移动用户数据或已安装应用；两版不能共用可写会话目录。

docs 与 AGENTLOG 是被 Git 忽略的本机资料，不随克隆或推送。当前任务记录不代表自动开发日志已实现。
