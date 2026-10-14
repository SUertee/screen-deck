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

- 黑白工作台、新聊天、搜索、项目任务、时间线、设置浮窗和联动 Deck 小窗口。
- Chat Completions 真实无工具对话、流式回复、本地停止接收、历史保存和重启恢复。
- 明确选择项目后只读展示原 task/run 与受限附件；历史运行不冒充当前进程。
- 中间始终保留普通聊天正文与输入；右栏显示任务概览、紧凑工作项及文件页签。编辑计划时展开原表单；“讨论这一步”只带入草稿。
- 独立预览分工计划可手动保存；规则只提建议。右栏收起保留当前窗口的页签、计划草稿与滚动位置，关闭最后页签后整栏收起，无上下文聊天不占空右栏。
- 三分类设置浮窗：模型服务、编码工具、本地数据分别展示。切换分类保留输入，关闭清除未保存的密钥；模型保存与工具启停分开。
- 旧试运行记录从任务时间线打开，具体工具决定、许可投递、停止／核对及人工验收显示在中心聊天中；原任务不可读时右栏仍提供已保存记录的恢复入口。
- 独立模拟页面、模式切换、演示配置与新模拟尝试入口已撤下。假执行器保留供隔离测试，不调用模型、执行命令或修改项目文件。JEV、对话改计划和真实任务调度尚未接入。

## OpenCode 无工具接入

当前固定支持官方 **OpenCode 1.19.0**，使用 `@agentclientprotocol/sdk@1.8.0` 连接稳定 **ACP v1**；SDK 发布号与协议版本分别锁定。应用不自动下载或安装；在设置的“模型服务”保存连接，再到“编码工具”查看自动检测结果并点击“连接 OpenCode”。只找到一个程序时无需文件选择；多个候选可选择本次位置，未找到时提供安装说明与“手动选择程序”。启动只建立受控 ACP stdio 连接，不发送模型请求；界面仅返回版本、冻结模型及是否需要重启，不返回连接认证或私有配置。

程序发现只检查文件元数据，不执行版本命令、不读取模型密钥。main 的 OpenCodeDiscovery 查找上次成功位置、进程 PATH 与有限标准目录（`~/.opencode/bin`、`~/.local/bin`、`~/.bun/bin`、`/opt/homebrew/bin`、`/usr/local/bin`），解析符号链接并去重；不加载 shell 配置或遍历磁盘。只有明确连接才取得凭据、校验固定版本／ACP 和有效配置、启动受控实例；成功后通过 LocalState 记住 canonical 路径，重启只检测、不自动连接。手动选择只暂存候选，连接失败不记忆、不回退其他程序。npm／Bun 启动包装脚本未单独适配，可能因受控解释器环境无法启动，可手动选择原生可执行文件。

在聊天右栏保存一个“讨论／待分工”工作项，点击“用 OpenCode 讨论”。聊天内先显示冻结输入和实际请求模型，分别点击“批准这次执行”与“开始这次执行”；保存计划、申请与批准都不会提交。此次仅发送明确展示的输入，OpenCode 使用独立空目录与内建系统指令，不读取关联项目、不附加文件或执行工具。结束后可单独接受／拒绝文本成果，不改变正式任务状态。

主进程管理自身创建的实例，使用独立 HOME/XDG、白名单环境、认证与有效配置核对；仅固定版本的受控协议子集，普通子进程不是 OS 沙箱。保存模型连接后禁止新提交，需关闭并重新启动；已提交尝试继续绑定原快照。更换实例会失效旧启动授权；断流、无法确认取消和原实例失效保留 unknown。取消通知仅请求停止，原 prompt 返回 cancelled 才确认。ACP 本版没有原提交远端查询或跨重启恢复；核对只接受同一活连接内保留的原终态证据，缓存淘汰后保持未知。应用重启不会自动启动 OpenCode、重建会话、重新提交或恢复订阅；旧实例不存在时只读保存记录并保留未知。已冻结的 finished 文本仍可人工验收，摘要绑定原助手消息 ID 与完整正文，后续轮次不会改其版本。

可重复的隔离验证：

```sh
npm run smoke:acp -- /absolute/path/to/opencode-1.19.0
node scripts/opencode-acp-ui-smoke.mjs
npm run smoke:opencode:discovery
```

前者使用官方二进制与本机合成模型服务，覆盖单次 ACP prompt、无原生标题额外调用、同活连接终态缓存、原 prompt 明确取消与中断重启不重发；后者使用 Node 协议夹具验证真实 Electron IPC 与界面，二者都不调用真实模型或读取用户任务。真实提供商兼容性仍需另行授权验证。旧 HTTP `smoke:opencode` 与 `opencode-ui-smoke.mjs` 留作旧实现参考／兼容验证，不作为当前默认 ACP 界面的测试入口。

## 分层

直接模型ExecutionDriver、连续Agent会话AgentChatDriver与任务TaskExecutionDriver是并列窄接口；ChatCompletionsAdapter 拼 HTTP 协议路径，OpenCodeAgentChatAdapter与OpenCodeAcpAdapter分别转换连续聊天和工作项事件，共用私有OpenCodeAcpSessionClient。ProviderSettingsStore 管 `LLMProviderConfig`、关联凭据和只读 `ProviderRequestSnapshot.baseURL`；快照仅 main 使用。旧 HTTP OpenCodeAdapter 与旧 JSON 保留，ACP 使用独立 driverID，不把旧 unknown 当作新 ACP 可恢复提交。

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

预览数据在 `~/.screendeck/previews/electron-v1/`：provider.toml 保存非秘密配置，credential.bin 使用 Electron safeStorage 加密，sessions 按 UTC 创建日期归档，local-state 保存草稿和位置索引；`opencode-binary` 只保存已成功连接的程序位置，不含模型或凭据。预览计划以稳定项目/任务 ID 关联，不写入既有 task/run v1；新Agent聊天存入agent-sessions-v1，新任务会话存入 task-sessions-v2，启动与工具审批存入 execution-approvals-v1，人工验收存入 execution-acceptances-v1；独立于原聊天及旧预览审批。

普通聊天只外发本会话已完成消息和本次输入；OpenCode 首版只传展示的本次输入，不复制普通聊天历史。两者都不自动附加项目、日志、截图或其他聊天。密钥不返回界面、不写源码与日志；加密不可用时只保留内存。普通聊天停止仅取消本地接收；OpenCode 仅在原提交有明确中止证据时确认取消。未知结果不自动重发，保存失败可单独重试。

勾选“记住 API 密钥”后加密保存在本机；发送准备时按需异步读取，已有内存密钥时不每次重读，不再需要手动解锁。应用启动、打开设置和修改模型不读取密钥；显式启动 OpenCode 才准备私有调用快照；系统可能请求钥匙串授权，拒绝时保留草稿并提示重试或重填。不勾选则仅在内存保留。配置和密文分别原子写入，不是跨文件事务；部分保存失败会禁用当前连接，应重新检查并明确保存。

本版不是完整 coding Agent：OpenCode 只开放无工具文本执行，没有文件／命令工具、Codex CLI 适配、录屏、刘海吸附、手机同步或 Windows 安装包。TaskOrchestrator 协调已注册的文本执行、测试模拟及独立人工验收，不回写原任务状态。Swift 的采集等功能仍在原版，未用空按钮冒充迁移完成。

普通聊天结果未知时不自动重发，也没有远端核对入口，可另开新会话。任务模拟执行的 unknown 会阻塞同任务的新尝试和计划修改，可核对或请求停止；重启后的假执行器无法证明旧实例状态，会保留 unknown。`finished` 表示接口给出结束标记，不保证回答完整；暂不记录用量和详细结束原因。

本地包为临时签名预览，未做 Developer ID 签名、公证或公开发行验收。Node 路径检查不是 OS 沙箱；并发存储锁也不等同 Swift flock，不可让两版写同一会话库。

## 聊天来源

输入区默认“模型聊天”，可选择“OpenCode”。选择来源、打开设置或建空聊天不会启动进程或发送模型请求；未连接时从“编码工具”设置显式启动。普通模型仍只传本会话已完成消息和本次输入；Agent每轮只传本次输入，并复用其原生上下文。没有Task也能与Agent聊天，工具仍全部关闭。

来源在创建后固定，切换会新开聊天并保留各来源草稿及旧消息。Agent记录以electron_agent_chat／schema_version=1单写agent-sessions-v1，使用专属创建、读取、发送、停止与本地补存IPC；不加字段到旧chat-v1／task-v2，不双写或迁移。SessionManager仍是本地唯一业务写入者，Store只校验、CAS与原子保存。

当前仅固定OpenCode受控配置的单一模型，不提供通用模型列表、附件或原生命令。原native binding必须属于同一活连接，消息身份不明或结果unknown就拒绝继续；配置改变需显式重启，旧绑定不能重绑。跨重启只读历史，不自动恢复上下文、load或重发；Agent聊天Deck暂未开放。工作项执行仍要求独立冻结范围、批准／开始与人工验收。

```sh
npm run smoke:agent-chat -- /absolute/path/to/opencode-1.19.0
npm run smoke:agent-chat:ui
```

前者使用已有官方二进制和本机合成模型服务，验证同一原生会话连续输入、取消与重启；后者用Node ACP夹具验证实际Electron IPC、来源切换和草稿隔离。不下载OpenCode、不读用户数据、不调用真实模型。

## 隔离验证

产品界面不再新建或开始模拟尝试。保存计划仍只保存；旧 prepared 记录可查看冻结范围并取消准备，旧 unknown 只核对原尝试或请求停止，不提供重跑。工具决定与投递、结束与验收仍是分别确认的操作。

已有依赖时可直接运行 `node scripts/build.mjs` 与 `node scripts/smoke.mjs`，避免触发安装器。`node scripts/layout-smoke.mjs` 检查三栏几何与窄窗焦点；`node scripts/chat-task-layout-smoke.mjs` 使用生成的临时项目和普通聊天记录，验证聊天保留、任务／文件页签、计划草稿、旧记录恢复及审批边界。`node scripts/task-execution-integration-smoke.mjs` 仅在测试准备中通过 API 分别请求、批准、开始假执行，验证许可决定／投递、验收重启和来源完整性。旧整页演示 HTML 与其模拟 UI 夹具脚本已删除。

隔离测试可由 main 环境设置 `SCREENDECK_PROJECT_HISTORY_ROOT` 指向临时私人历史根，配合 `SCREENDECK_PREVIEW_ROOT` 和 `SCREENDECK_INITIAL_PROJECT`；renderer 不可设置根路径。省略覆盖时仍使用既有默认目录。
