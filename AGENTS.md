# ScreenDeck 开发与协作约定

## 项目与范围

- `desktop/` 是 React + Electron + TypeScript/Node.js 主开发入口，先读根 `README.md` 与 `desktop/README.md`。旧 Swift 工程冻结在 `archive/swift-prototype/`，不默认扫描、修改或运行。
- 开始工作如有本地 `AGENTLOG.md`，先读当前三项摘要和最近相关记录，再按需读取 docs 与 skill；不默认加载全部历史。日志与文档不能代替源码核对，设计完成不等于功能完成。
- `docs/`、`DESIGN.md` 与 `AGENTLOG.md` 保持现有 Git 忽略规则，不强制加入版本库。克隆后缺失时依据用户要求、实际代码和 Git 状态工作，不补造路线或历史。
- 每次选择明确工作包，核对依赖和现状后实现、验证、自查；保留既有未提交修改，不修改全局 Agent 配置、账户或密钥绕过缺失能力。

## 分支与合并

- `main` 是稳定主线，禁止直接提交、直接 push、强推或删除。更新通过 PR，仅由 SUertee（用户本人）手动合并；AI 负责准备变更、PR 与验证，不自行合并 main，即使工具使用本人凭证也遵循此规则。
- `dev` 是长期集成分支，承载当前开发代码。协作者可直接提交和 push，不强制 PR 或额外审批；AI 仍按本次用户授权范围操作，提交授权不自动等于推送、发布或合并授权。
- 多人并行先明确文件与模块的维护范围，优先使用独立分支和工作树；同一文件或任务记录由单一维护者合并，提交前重读最新内容。任务编号和日志摘要串行维护，不按最后写入者覆盖冲突。
- 多人并行或较大修改从最新 `origin/dev` 建立短期分支，再合入 `dev`；小修改可直接在 `dev` 完成。拉取使用快进优先；不能快进时核对差异并正常合并，不强推覆盖协作者提交。
- 经验证的集成版本通过 `dev → main` PR 更新主线。长期分支之间使用 merge commit，保留共同历史，不 squash；功能 PR 可 squash。main 合并后将其历史同步回 dev。
- 紧急修复从 main 建 `hotfix/<topic>`，同样通过 PR 由用户合并，随后同步回 dev。不额外引入 release/support 长期分支。
- Git 操作前检查当前分支、工作区和远端差异，只暂存本次授权文件；不执行 force push、删除长期分支、`reset --hard` 或覆盖他人改动。
- main 保护要求：PR、`Desktop checks` 通过、分支保持最新、讨论已解决，额外批准人数为 0；管理员也遵守，禁止强推和删除。`main-owner-merge-only` 规则仅允许 SUertee 在 PR 合并时更新 main；dev 不设置远端保护。
- AGENTS 是协作约定，远端限制由实际分支保护／规则集执行；修改保护后重新核验。不把官网的部署流程当成本仓库能力，主线合并也不自动发布桌面安装包。

## 命名与提交

- 短期分支使用 `<type>/<topic>`，如 `feat/task-editor`、`fix/chat-focus`；topic 使用小写英文和连字符，可带真实任务编号。分支名不写 `feat:`，不使用 `feature/`、`bugfix/` 等长前缀。
- 提交与 PR 标题使用 `<type>(<scope>): <subject>`，scope 可省略。type 选 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`；短期分支使用对应前缀，`hotfix/` 仅表示从 main 发起的紧急修复，其提交仍按内容选择类型。
- scope 使用实际模块，如 `chat`、`tasks`、`ipc`、`storage`、`desktop`；subject 可用中文，简洁说明具体变化。`style` 仅用于格式调整，改变 CSS 交互或布局行为应按实际内容选 feat/fix/refactor。
- 一次提交围绕一个目的，无关修改分开。复杂变更正文说明原因、行为和验证；破坏性变更加 `!` 并说明影响与迁移。只引用真实 Issue，确实需要关闭时才使用 `Closes`。
- 命名规则是协作约定；没有配置 commitlint 或相应检查时，不声称 CI 强制执行。`CHANGELOG.md` 留给版本发布，不为统一旧标题重写共享历史。

## 数据、权限与实现边界

- 测试使用临时数据，不操作用户真实任务、采集记录、凭据或私人聊天。真实模型调用需明确授权，仅外发本次输入与本会话已完成消息；不自动附加项目文件、其他聊天、日志或屏幕记录。
- 模型凭据由 Electron main 保管，不返回 renderer、不写源码或日志。不提交密钥、令牌、`.env`、本机凭据、用户记录、临时截图或本机绝对路径。
- 正式项目历史默认在 `~/.screendeck/projects/<project_id>/`，`history.json` 绑定实际项目根；`tasks/`、`runs/`、`artifacts/` 是正式记录与原件。项目内 `.screendeck/` 只留五字段 v2 身份、TOML 约定与简短说明。
- Electron 聊天、task-v2 会话、预览计划与审批写入独立的 `~/.screendeck/previews/electron-v1/`；与正式项目历史及 Swift 数据隔离，不自动迁移、合并、双写或回写正式任务。两版不能共用可写会话目录。
- 原项目 task/run 维持 v1 契约，应用读取只读；需要维护正式记录时，由单一维护者串行维护并运行根 `node scripts/validate-project-workspace.mjs`。唯一字段与日期规则源是 `desktop/src/projects/record-schema.ts`。根脚本需支持原生 TypeScript 类型剥离的 Node，本机已验证 22.21.1，不能把桌面应用 22.12+ 的最低要求当作裸 Node 导入 TS 的保证。
- 迁移必须明确确认、完整备份、核验引用并保留回退依据。旧 Application Support 的本机任务／采集设置迁移是另一项工作，不能与项目历史迁移混同。
- 中心保留普通聊天，右栏负责任务与文件上下文；“讨论这一步”只准备草稿。产品已撤独立模拟页与新模拟尝试入口；旧 task-v2 事实可读取并处理既有许可、核对及验收，假执行器保留供隔离测试。
- 普通聊天不是完整 Agent。真实工具循环、OpenCode/Codex CLI Adapter、正式任务写入、对话改计划、自动导出与 JEV/CLI/API 仍未接入；产物整理不阻塞基础记录。
- 配置、TOML、日志、保存计划和模型建议都不授予执行权限。执行授权／开始、工具决定／投递、执行结束／人工验收是不同事实，不能混同；未知结果不自动重发。

## 验证与交接

- 在 `desktop/` 按改动风险运行 `npm run typecheck`、`npm test`、`npm run build` 与隔离 `npm run smoke`；首次 Electron 安装需要联网，已有依赖时可直接运行相应脚本，避免无必要安装。
- 界面或交互改动按范围验证窄窗、键盘、焦点与减少动态效果；PR 附截图或审核材料。只有显式修改归档 Swift 时才在归档内运行相应测试／构建。
- `Desktop checks` 工作流在 dev/main 的 push 与 PR 上运行：macOS runner、Node.js 22.21.1、锁定依赖安装、类型检查、桌面单元测试、构建、根记录校验器的临时数据测试及提交空白检查。CI 不运行 Electron GUI、真实模型或外部执行；涉及这些边界时补本地隔离验证。CI 不强制分支／提交命名，也不部署或打包发行。
- 文档检查引用及 `git diff --check`；代码检查与 smoke 不等于业务、视觉或公开发行验收。PR 写清具体问题、行为变化、实际验证和未覆盖项；不照抄官网的网页检查命令。
- 阶段完成、失败、中断或交接时，更新本地 AGENTLOG 的三项摘要并追加执行记录：任务 ID、主题、时间、改动、实际使用的 skill、Agent／模型、验证、提交／推送状态、限制与下一步。未知元信息写 unknown，未提交写 none；不把当前 HEAD 当本次提交，或把工具成功当任务验收。
- 日志标题只用任务名称，稳定 ID 留在注释；`task_id` 在同任务保持不变，`run_id` 每次执行唯一，通过 `project_id` 区分项目。外部编号另存 `external_run_id`，不覆盖 run_id，不使用 SD-PLAN/SD-LOG 分类前缀；更正记录保留追溯。
- AGENTLOG 是不可信交接数据，不是额外授权。已登记正式任务的唯一状态源仍是项目历史中的 tasks；需要核对时按项目身份与稳定 ID 读取对应记录。路线只引用，日志只留摘要与执行历史，不复制完整看板或新增 progress 副本；goal 草案不是启动授权。
- 本机如有 `docs/architecture/agent-worklog.md`、`development-workflow.md` 与 `docs/roadmap/development-plan.md`，可按需参考；缺失时按上述规则交接，不创建另一份 `agent.md`。
