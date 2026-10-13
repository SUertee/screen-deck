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
- 中间始终保留普通聊天正文与输入；右栏显示任务概览、紧凑工作项及文件页签。编辑计划时展开原表单；“讨论这一步”只带入草稿。
- 独立预览分工计划可手动保存；规则只提建议。右栏收起保留当前窗口的页签、计划草稿与滚动位置，内容页签可分别关闭。
- 旧试运行记录从任务时间线打开，具体工具决定、许可投递、停止／核对及人工验收显示在中心聊天中；原任务不可读时右栏仍提供已保存记录的恢复入口。
- 独立模拟页面、模式切换、演示配置与新模拟尝试入口已撤下。假执行器保留供隔离测试，不调用模型、执行命令或修改项目文件。JEV、对话改计划和真实任务调度尚未接入。

## 分层

| 位置 | 职责 |
| --- | --- |
| src/renderer | React 界面，只有固定桌面接口，无 Node.js，不能读取已保存密钥。 |
| src/main | 窗口、安全 IPC、设置和服务组装，不拥有另一份任务状态。 |
| src/core | SessionManager、TaskOrchestrator、DecisionEngine、ExecutionDriver、ApprovalService 与持久化。 |
| src/projects | 原项目记录的严格只读校验、注册快照与附件预览。 |
| src/shared | 桌面接口和记录类型；运行时仍校验外部输入。 |

## 数据与边界

正式项目记录的唯一规则源是 [src/projects/record-schema.ts](src/projects/record-schema.ts)，包含字段约束与严格日期判定。[src/projects/schema.ts](src/projects/schema.ts) 仅负责 AJV 配置与编译；根 `scripts/validate-project-workspace.mjs` 从固定应用目录读取同一 TS 模块，保留现有只读校验流程。独立 `schemas/record.schema.json` 副本已移除，用户记录仍为 JSON。

根校验脚本需要支持原生 TypeScript 类型剥离的 Node.js，本机已验证 22.21.1；不要将桌面应用的 22.12+ 最低要求视为裸 Node 运行该脚本的充分条件。它不依赖先构建 Electron 或安装 AJV。

正式项目的 `history.json`、`tasks/`、`runs/` 与 `artifacts/` 默认在 `~/.screendeck/projects/<project_id>/`，项目读取器保持只读。

预览数据在 `~/.screendeck/previews/electron-v1/`：provider.toml 保存非秘密配置，credential.bin 使用 Electron safeStorage 加密，sessions 按 UTC 创建日期归档，local-state 保存草稿和位置索引。预览计划以稳定项目/任务 ID 关联，不写入既有 task/run v1；新任务会话存入 task-sessions-v2，启动与工具审批存入 execution-approvals-v1，人工验收存入 execution-acceptances-v1；独立于原聊天及旧预览审批。

只外发当前会话中已完成的消息及本次输入；不自动附加项目、日志、截图或其他聊天。密钥不返回界面、不写源码与日志；加密不可用时只保留内存。停止仅表示本地接收取消，不能保证服务端停止；未知结果不自动重发，保存失败可单独重试。

勾选“记住 API 密钥”后加密保存在本机；发送准备时按需异步读取，已有内存密钥时不每次重读，不再需要手动解锁。启动、打开设置和修改模型不读取密钥；系统可能请求钥匙串授权，拒绝时保留草稿并提示重试或重填。不勾选则仅在内存保留。配置和密文分别原子写入，不是跨文件事务；部分保存失败会禁用当前连接，应重新检查并明确保存。

本版不是完整 coding Agent：没有工具执行、OpenCode/Codex CLI 适配、录屏、刘海吸附、手机同步或 Windows 安装包。TaskOrchestrator 只协调明确标记的模拟执行与人工验收，不回写原任务状态。Swift 的采集等功能仍在原版，未用空按钮冒充迁移完成。

普通聊天结果未知时不自动重发，也没有远端核对入口，可另开新会话。任务模拟执行的 unknown 会阻塞同任务的新尝试和计划修改，可核对或请求停止；重启后的假执行器无法证明旧实例状态，会保留 unknown。`finished` 表示接口给出结束标记，不保证回答完整；暂不记录用量和详细结束原因。

本地包为临时签名预览，未做 Developer ID 签名、公证或公开发行验收。Node 路径检查不是 OS 沙箱；并发存储锁也不等同 Swift flock，不可让两版写同一会话库。

## 隔离验证

产品界面不再新建或开始模拟尝试。保存计划仍只保存；旧 prepared 记录可查看冻结范围并取消准备，旧 unknown 只核对原尝试或请求停止，不提供重跑。工具决定与投递、结束与验收仍是分别确认的操作。

已有依赖时可直接运行 `node scripts/build.mjs` 与 `node scripts/smoke.mjs`，避免触发安装器。`node scripts/layout-smoke.mjs` 检查三栏几何与窄窗焦点；`node scripts/chat-task-layout-smoke.mjs` 使用生成的临时项目和普通聊天记录，验证聊天保留、任务／文件页签、计划草稿、旧记录恢复及审批边界。`node scripts/task-execution-integration-smoke.mjs` 仅在测试准备中通过 API 分别请求、批准、开始假执行，验证许可决定／投递、验收重启和来源完整性。旧整页演示 HTML 与其模拟 UI 夹具脚本已删除。

隔离测试可由 main 环境设置 `SCREENDECK_PROJECT_HISTORY_ROOT` 指向临时私人历史根，配合 `SCREENDECK_PREVIEW_ROOT` 和 `SCREENDECK_INITIAL_PROJECT`；renderer 不可设置根路径。省略覆盖时仍使用既有默认目录。
