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

## 正式数据与交接

默认数据根为 `~/.screendeck`，新任务保存在 `tasks/<ID>/task.json`；首次启动校验并复制旧预览记录，保留旧目录。普通文件夹可登记项目，任务归属可选；原生分派使用版本化交接，结束／验收后生成摘要，AGENTLOG 经用户显式导出。已有 Codex 专用运行目录保留复用，不改全局 Agent 配置。详见[存储](../docs/architecture/configuration-and-project-management.md)与[任务模块](../docs/architecture/task-module.md)。

## 当前能力

- 黑白工作台、新聊天、搜索、项目任务、时间线、设置浮窗和联动 Deck 小窗口。
- Deck在带刘海的Mac上默认停靠顶部：移入先探出，停留160ms展开；展开后点击外部收起，编辑时保持打开，悬停不抢焦点。无刘海或桥接不可用时使用380×380普通浮窗，可收起为96px高。
- Deck支持主目标创建正式任务、规划步骤、确认分工和 Jev 建议，也可原地编辑子项进度和具体Agent分工，与主窗口共享版本化存储。用量页保留未报告状态。任务页与聊天右栏复用本地详情，Deck 可显式返回同一任务。
- Chat Completions 真实无工具对话、流式回复、本地停止接收、历史保存和重启恢复。
- 普通／OpenCode聊天重命名、置顶、归档恢复；极简搜索浮窗在窗口上方水平居中，先显示输入框，输入后展示已加载模型／OpenCode／归档历史的标题和正文匹配、命中片段与消息定位。消息与代码可分别复制，代码长行横向滚动；输入自动增高，阅读历史时可回到最新。
- 输入工具栏以文字下拉选择“直接模型／OpenCode”；右侧显示实际模型名称或未连接状态，点击打开对应设置，下方不常驻说明。鼠标控件32px，粗指针保留44px；长模型名截断并保留完整提示。Cmd／Ctrl+N 新聊天，Cmd／Ctrl+K 搜索，Cmd／Ctrl+L 聚焦输入；保留 Enter发送、Shift+Enter换行与输入法保护。归档不删除历史，打开归档后先恢复再发送；消息编辑、重新生成、分叉和附件尚未实现。
- 明确选择项目后只读展示原 task/run 与受限附件；历史运行不冒充当前进程。
- 聊天页保留普通聊天正文与输入，任务页不放聊天输入；右栏显示任务概览、紧凑工作项及文件页签。编辑计划时展开原表单；“讨论这一步”只带入草稿。
- 独立预览分工计划可手动保存；规则只提建议。右栏收起保留当前窗口的页签、计划草稿与滚动位置，关闭最后页签后整栏收起，无上下文聊天不占空右栏。
- 独立知识页：左侧标题与摘要，右侧阅读与「用于任务」；筛选、编辑、归档和来源按需展开。复用先选择目标任务、预览并确认材料快照；任务详情从已接受原生成果提取知识，见[知识沉淀](../docs/architecture/knowledge-module.md)。
- 三分类设置浮窗：模型服务、Agent 设置、本地数据分别展示。切换分类保留输入，关闭清除未保存的密钥；模型保存与 Agent 启停分开。
- 已保存的工作项记录从任务时间线打开，在中心聊天中查看冻结输入、提交事实和成果；原任务不可读时右栏仍提供恢复入口。OpenCode 记录的停止、核对和验收仍绑定原尝试；旧假执行器记录只读。
- 独立模拟页面、生产假执行器与模拟选择器已删除，没有 SCREENDECK_TEST_TASK_EXECUTION 开关。旧 task-v2 固定使用 OpenCodeAcpAdapter 的无工具文本通道；新本地工作项由统一原生运行时调用 Codex／OpenCode，runtime 不可用时拒绝新执行。必要测试替身仅放在 tests/helpers，不进入应用。TypeSafe Jev 已接专用设置、外发预览、候选建议和确认保存；已验收合成任务的真实官方请求，生成模型负责步骤草稿，Jev 仅判断实际候选。尚无无人值守执行循环。

任务模块当前流程与限制见[任务模块](../docs/architecture/task-module.md)：v3 目标／条件／材料、三入口导航、选择材料进入未发送草稿、屏幕上下文幂等确认、原生工作项冻结／开始／工具审批／人工验收均已接线。人工进度不等于验收；宿主文件内容检查不冒称独立构建／测试命令通过。屏幕采集默认关闭，真实安装包与长期资源使用未验收。隔离检查：`node scripts/task-module-ui-smoke.mjs`、`node scripts/native-task-main-ui-smoke.mjs`、`node scripts/native-task-execution-ui-smoke.mjs`。

独立聊天基础的隔离界面检查：构建后运行 `node scripts/chat-foundation-ui-smoke.mjs`，使用临时HOME、合成历史和内存剪贴板替身，不调用模型或外部Agent。

## Codex 原生登录与聊天

支持Codex CLI 0.133.0；在Agent设置中显式连接，再点击“使用ChatGPT登录”。登录由Codex管理，保存在应用独立目录，下次连接继续使用；不读取或修改全局Codex账户配置，不使用模型服务API密钥。官方npm包装安装会解析到其原生二进制，避免GUI环境缺少Node导致启动失败。

支持原生连续聊天、文件／命令工具、单次审批与原Turn确认取消；不选目录即可纯聊天；需要本地工具时新建聊天并选择工作目录及变更前确认／自动编辑／完全访问，使用原生默认模型，模型切换与跨重启恢复未开放。详情见[Codex接入](../docs/architecture/codex-runtime-plan.md)。隔离UI：`node scripts/codex-ui-smoke.mjs`；真实CLI＋本机合成服务：`node --import tsx scripts/codex-native-smoke.mjs /absolute/path/to/codex`。这些检查不代表真实账户登录或套餐推理已验收。

## OpenCode 接入与受限工作项

当前固定支持官方 **OpenCode 1.19.0**，使用 `@agentclientprotocol/sdk@1.8.0` 连接稳定 **ACP v1**；SDK 发布号与协议版本分别锁定。应用不自动下载或安装；在设置的“模型服务”保存连接，再到“Agent 设置”查看自动检测结果并点击“连接 OpenCode”。只找到一个程序时无需文件选择；多个候选可选择本次位置，未找到时提供安装说明与“手动选择程序”。启动只建立受控 ACP stdio 连接，不发送模型请求；界面仅返回版本、冻结模型及是否需要重启，不返回连接认证或私有配置。

程序发现只检查文件元数据，不执行版本命令、不读取模型密钥。main 的 OpenCodeDiscovery 查找上次成功位置、进程 PATH 与有限标准目录（`~/.opencode/bin`、`~/.local/bin`、`~/.bun/bin`、`/opt/homebrew/bin`、`/usr/local/bin`），解析符号链接并去重；不加载 shell 配置或遍历磁盘。只有明确连接才取得凭据、校验固定版本／ACP 和有效配置、启动受控实例；成功后通过 LocalState 记住 canonical 路径，重启只检测、不自动连接。手动选择只暂存候选，连接失败不记忆、不回退其他程序。npm／Bun 启动包装脚本未单独适配，可能因受控解释器环境无法启动，可手动选择原生可执行文件。

在聊天右栏保存一个“讨论／待分工”工作项，点击“用 OpenCode 讨论”。聊天内先显示冻结输入和实际请求模型，分别点击“批准这次执行”与“开始这次执行”；保存计划、申请与批准都不会提交。此次仅发送明确展示的输入，OpenCode 使用独立空目录与内建系统指令，不读取关联项目、不附加文件或执行工具。结束后可单独接受／拒绝文本成果，不改变正式任务状态。

主进程管理自身创建的实例，使用独立 HOME/XDG、白名单环境、认证与有效配置核对；仅固定版本的受控协议子集，普通子进程不是 OS 沙箱。保存模型连接后禁止新提交，需关闭并重新启动；已提交尝试继续绑定原快照。更换实例会失效旧启动授权；断流、无法确认取消和原实例失效保留 unknown。取消通知仅请求停止，原 prompt 返回 cancelled 才确认。ACP 本版没有原提交远端查询或跨重启恢复；核对只接受同一活连接内保留的原终态证据，缓存淘汰后保持未知。应用重启不会自动启动 OpenCode、重建会话、重新提交或恢复订阅；旧实例不存在时只读保存记录并保留未知。已冻结的 finished 文本仍可人工验收，摘要绑定原助手消息 ID 与完整正文，后续轮次不会改其版本。

可重复的隔离验证：

```sh
npm run smoke:acp -- /absolute/path/to/opencode-1.19.0
node scripts/opencode-acp-ui-smoke.mjs
npm run smoke:opencode:discovery
```

前者使用官方二进制与本机合成模型服务，覆盖单次 ACP prompt、无原生标题额外调用、同活连接终态缓存、原 prompt 明确取消与中断重启不重发；后者使用 Node 协议夹具验证真实 Electron IPC 与界面，二者都不调用真实模型或读取用户任务。真实提供商兼容性以对应验证为准。旧 HTTP `smoke:opencode` 与 `opencode-ui-smoke.mjs` 留作旧实现参考／兼容验证，不作为当前默认 ACP 界面的测试入口。

## 模型校验与选择

现有单个服务配置支持显式“校验并保存”：main以输入地址和密钥请求Chat Completions兼容的`GET /models`，仅使用返回的模型ID，不推测视觉、工具、上下文或计费能力。当前模型不在返回列表时，等待用户明确选择后保存；不会默认使用第一个模型。服务返回404／405／501或空列表时，允许手工填写并明确“保存（未验证）”；HTTP拒绝、超时和坏响应保留输入，不覆盖原连接。列表成功只说明模型列表接口可访问，不等于所选模型的对话已测试。

`ProviderModelsService`协调草稿快照、成功查询与本地目录；`ProviderSettingsStore`唯一写配置和密钥；协议GET由core/providers中的`listChatCompletionsModels`负责。缓存经LocalState保存地址与ID，不含密钥、认证证明或能力猜测。打开设置、读取缓存和切换聊天来源不发HTTP；重启恢复的是上次模型建议，需刷新时再显式校验。修改地址或密钥使旧校验失效，同地址也不复用另一密钥的未保存校验。设置保存后读回主进程实际可用目录；缓存写入失败不保留界面中的临时建议列表。聊天输入框通过应用内灰度下拉菜单选择已保存模型，支持键盘、外点关闭和模型设置入口；保留原消息、草稿和已冻结请求；Agent模型仍遵循其原连接与配置代次，不冒用直连列表。

构建后运行`node scripts/provider-model-catalog-ipc-smoke.mjs`验证真实IPC、401、模型选择、持久化和重启；`provider-models-ui-smoke.mjs`验证Settings组件交互。两者均使用合成响应，不调用真实模型。首包仍是一套服务配置，多Provider目录和实际对话探测未实现。

## 品牌图标

[assets/brand](assets/brand/README.md) 保存官网 Fold 标志的 SVG 与对应 PNG。工作台／Deck 共用透明 SVG，开发态 Dock、窗口与 macOS 打包图标共用黑底白标 PNG；构建复制本地资源，打包不再重画图形。

## 分层

直接模型ExecutionDriver、连续Agent会话AgentChatDriver与任务TaskExecutionDriver是并列窄接口；ChatCompletionsAdapter 拼 HTTP 协议路径，OpenCodeNativeChatAdapter转换原生聊天工具事件，OpenCodeAcpAdapter保留工作项文本执行；两者使用独立Runtime实例，互不扩权。ProviderSettingsStore 管 `LLMProviderConfig`、关联凭据和只读 `ProviderRequestSnapshot.baseURL`；快照仅 main 使用。旧 HTTP OpenCodeAdapter 与旧 JSON 保留，ACP 使用独立 driverID，不把旧 unknown 当作新 ACP 可恢复提交。

core 已按职责归入 `sessions`、`tasks`、`approvals`、`storage` 与具体接入目录，根目录只保留 `index.ts`。三个现有 Driver 契约跟随会话调用方放在 `sessions`，不另设 drivers 模块。假任务执行器及 core/testing 已删除，必要测试替身只在 tests/helpers。直接模型实现在 [src/core/providers](src/core/providers)，OpenCode 协议实现在 [src/core/agents/opencode](src/core/agents/opencode)；程序发现、进程启停、配置、凭据与具体实例装配仍由 main 中的现有组件管理。

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

预览数据在 `~/.screendeck/previews/electron-v1/`：`provider.toml` 保存模型地址与名称，`credential.json` 以明文保存已配置的 API 密钥（文件权限 `0600`），sessions 按 UTC 创建日期归档，local-state 保存草稿和位置索引；`opencode-binary` 只保存已成功连接的程序位置，不含模型或凭据。预览计划可独立保存或以稳定项目/任务 ID 关联；v2增加Agent分工，v1只在明确保存升级时写v2，同一计划不双写，不写入既有task/run v1；新Agent聊天存入agent-sessions-v1，新任务会话存入 task-sessions-v2，启动与工具审批存入 execution-approvals-v1，人工验收存入 execution-acceptances-v1；独立于原聊天及旧预览审批。

普通聊天只外发本会话已完成消息和本次输入；OpenCode 首版只传展示的本次输入，不复制普通聊天历史。两者都不自动附加项目、日志、截图或其他聊天。密钥不返回界面、不写源码与日志。普通聊天停止仅取消本地接收；OpenCode 仅在原提交有明确中止证据时确认取消。未知结果不自动重发，保存失败可单独重试。

设置页默认保存到本机明文文件，应用启动时校验并加载，不再需要勾选记住。已保存密钥显示掩码与状态，替换时直接输入新值并校验保存；设置页不再提供移除密钥入口，留空继续使用原密钥。旧IPC的显式rememberKey:false仅保留兼容测试路径，界面不再提供临时模式。界面只接收 `hasKey` 与 `file`／`memory`／`none` 状态，已保存密钥不回填到输入框；没有系统加密、解锁或钥匙串授权流程。保存失败不会自动降为内存模式，配置与密钥文件分别原子写入，不是跨文件事务；部分保存失败会禁用当前连接，应重新检查并明确保存。旧 `credential.bin` 保持原件、不读取、不解密、不删除或迁移，旧用户需重新填写密钥。加载凭据不发送请求、不启动 OpenCode；显式连接 OpenCode 才准备其私有调用快照。

构建后可运行 `node scripts/credential-storage-ui-smoke.mjs`，使用临时HOME和合成密钥验证真实设置IPC、明文文件0600、旧密文保留、重启恢复、兼容内存模式和忘记密钥；不会调用模型或启动Agent。`credential-flow-smoke.mjs`另验证renderer准备失败、重复提交、草稿和停止边界；浏览器可通过`SCREENDECK_CHROMIUM_EXECUTABLE`指定已安装的独立测试可执行文件。

本版Agent聊天已开放原生文件／命令工具，正式Task仍只有受限文本执行；录屏、边缘吸附、手机同步和Windows安装包尚未实现。TaskOrchestrator 协调 OpenCode ACP 文本执行及独立人工验收，不回写原任务状态。Swift 的采集等功能仍在原版，未用空按钮冒充迁移完成。

普通聊天结果未知时不自动重发，也没有远端核对入口，可另开新会话。工作项执行的 unknown 会阻塞同任务的新尝试和计划修改，OpenCode 核对与停止只针对原绑定；旧假执行器记录只读，不能由新 ACP 实例核对、重绑或重发，已有 unknown 保持未知。`finished` 表示接口给出结束标记，不保证回答完整；暂不记录用量和详细结束原因。

本地包为临时签名预览，未做 Developer ID 签名、公证或公开发行验收。Node 路径检查不是 OS 沙箱；并发存储锁也不等同 Swift flock，不可让两版写同一会话库。

## 聊天来源

输入区默认“直接模型”，外部来源由 AgentChatRegistry 的实际注册列表提供；生产注册OpenCode与Codex。选择来源、打开设置或建空聊天不会启动进程或发送模型请求；未连接时在“Agent 设置”中显式连接。普通模型仍只传本会话已完成消息和本次输入；Agent每轮只传本次输入，并复用其原生上下文。没有Task也能与Agent聊天；无目录默认纯聊天，不启用文件与命令；新工具聊天另选目录与权限。

来源在创建后固定，切换会新开聊天并保留各来源草稿及旧消息。Agent记录以electron_agent_chat／schema_version=1单写agent-sessions-v1，使用专属创建、读取、发送、停止与本地补存IPC；不加字段到旧chat-v1／task-v2，不双写或迁移。SessionManager仍是本地唯一业务写入者，Store只校验、CAS与原子保存。

OpenCode通过ACP接入，Codex通过原生app-server接入；两者实现同一AgentChatDriver，经AgentExecutionController统一记录工具与单次决定。权限和执行记录单独保存在agent-execution-v1，不修改既有历史JSON。实际约束不同，详见[工具权限](../docs/architecture/tool-permissions.md)：Codex原生沙箱可写根还包含应用自有记忆目录，OpenCode只有原生权限规则，没有OS沙箱。

来源、工作目录与模式创建后固定；未配置工作目录的聊天走显式受限文本通道，既有失效绑定仍只读。断流、停止或重启不重绑、不重发，未决审批失效；Agent报告的完成不是宿主独立核对或人工验收。跨重启恢复和原生模型切换尚未开放；Deck可管理本地任务，尚不控制Agent聊天执行。工作项仍单独冻结范围、批准／开始与人工验收。

```sh
npm run smoke:agent-chat -- /absolute/path/to/opencode-1.19.0
npm run smoke:agent-chat:ui
```

前者使用已有官方二进制和本机合成模型服务，验证同一原生会话连续输入、取消与重启；后者用Node ACP夹具验证实际Electron IPC、来源切换和草稿隔离。不下载OpenCode、不读用户数据、不调用真实模型。

## 隔离验证

正式工作项只注册OpenCode ACP文本执行；聊天另注册OpenCode与Codex原生工具。缺少可用真实注册时拒绝新执行。保存计划仍只保存，批准后仍需单独开始；OpenCode 的取消和核对只针对原尝试，未知结果不重发。旧假执行器记录只读，不交给新 ACP 核对或重绑。许可决定与投递、结束与验收仍是不同事实；正式工作项的工具仍关闭。

已有依赖时可直接运行 `node scripts/build.mjs` 与 `node scripts/smoke.mjs`，避免触发安装器。`node scripts/layout-smoke.mjs` 检查三栏几何与窄窗焦点；`node scripts/chat-task-layout-smoke.mjs` 使用临时项目、普通聊天与预置的旧只读历史，验证聊天保留、任务／文件页签、计划草稿和旧记录恢复，不通过应用创建假执行。工作项批准／开始及文本验收的界面验证使用前述 ACP 协议夹具脚本。TaskDriverFixture 仅在 tests/helpers 中供单测使用，可导入 src 接口和错误类型；src 不依赖测试目录。

macOS构建会用本机Command Line Tools和已缓存Node头文件编译`native/deck-window.mm`，产物随`dist/native/`打包；不下载依赖，缺少编译条件时回退普通浮窗。构建后`node scripts/deck-notch-ui-smoke.mjs`验证刘海、焦点和编辑保护，`deck-workbench-ui-smoke.mjs`验证普通浮窗任务交互；均使用隔离HOME与合成计划。

隔离测试可由 main 环境设置 `SCREENDECK_PROJECT_HISTORY_ROOT` 指向临时私人历史根，配合 `SCREENDECK_PREVIEW_ROOT` 和 `SCREENDECK_INITIAL_PROJECT`；renderer 不可设置根路径。省略覆盖时仍使用既有默认目录。

原生工具专项（先构建）：`node --import tsx scripts/native-agent-tools-smoke.mjs /absolute/path/to/opencode /absolute/path/to/codex`；界面：`node scripts/native-agent-ui-smoke.mjs`。前者使用两个真实CLI和本机合成模型验证临时文件实际效果，后者使用合成Codex协议端验证真实界面。均不代表真实登录／提供商推理已经验收。

无目录Agent聊天：OpenCode复用受限文本实例，Codex首次发消息时启动单独受限文本进程，共享本应用原生登录、不要求第二次登录；应用创建内部工作目录，不给聊天开放本地工具。有目录聊天保持原生工具和审批，模式在创建时固定；发送前可移除目录恢复纯聊天。两个通道由AgentChatModeRouter分流，不变更旧历史JSON或正式Task权限。

新进程的显式本地启动参数 `--start-screen-recording` 仅开启本次屏幕采集，经过既有系统权限检查，不保存自动启动偏好。缺少权限时在系统中授权后从时间线重试；不开启音频。
