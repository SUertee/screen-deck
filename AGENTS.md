# ScreenDeck 开发与协作约定

## 工作入口

- 当前开发在 `desktop/`（React、Electron、TypeScript）；先读根 [README.md](README.md) 和 [桌面说明](desktop/README.md)。Swift 原型冻结在 `archive/swift-prototype/`，不默认扫描、修改或运行。
- 接手先读本地 `AGENTLOG.md` 的任务、状态、下一步及相关记录，再按需读源码、文档和 skill；不加载全部历史。文档不能替代源码核对，设计完成不等于功能完成。
- 每轮明确目标、范围、依赖与验收，保留已有未提交修改，不泄露密钥或私人数据；不修改全局 Agent 配置、账户或密钥来绕过能力限制。
- `docs/`、`DESIGN.md`、`AGENTLOG.md` 保持现有 Git 忽略规则，不强制加入版本库；缺失时依据代码与用户要求工作，不补造历史或另建 `agent.md`。

## 协作与 Git

- 操作前检查分支、工作区和远端差异，只暂存本次授权文件；禁止强推、删除长期分支、`reset --hard` 或覆盖他人改动。
- `dev` 是日常集成分支，小修改可直接提交／推送；并行或较大修改从最新 `origin/dev` 建短期分支。提交授权不包含推送、合并或发布授权。
- `main` 禁止直接提交／推送，只经 PR 由 **SUertee 本人手动合并**，AI 不代为合并。长期分支使用 merge commit，合并后同步回 dev；主线合并不等于发布桌面安装包。
- 并行先明确文件与模块维护者，优先独立分支／工作树；共享文件、任务编号与日志摘要串行合并，写入前重读，不用最后写入覆盖冲突。
- 分支用 `<type>/<topic>`，提交与 PR 用 `<type>(<scope>): <subject>`，一次提交一个目的。详细命名、hotfix 和远端保护见[开发工作流](docs/architecture/development-workflow.md#git-细则)；远端规则须实际核验，不能仅凭本文宣称已生效。

## 文档目录

完整索引见 [docs/README.md](docs/README.md)，按任务需要读取：

| 目录 | 内容 |
| --- | --- |
| [product/](docs/product/) | 产品目标与协作方式 |
| [design/](docs/design/) | 工作台、Deck、界面规范与原型 |
| [architecture/](docs/architecture/) | 代码结构、配置存储、Agent 接入、权限与执行设计 |
| [roadmap/](docs/roadmap/) | 开发现状、下一步与阶段计划 |
| [references/](docs/references/) | 其他项目的参考与比较 |
| [decisions/](docs/decisions/) | 已采用的方案及原因 |

实现现状查 [desktop/README.md](desktop/README.md) 与源码；涉及数据或执行时，按需查[配置与存储](docs/architecture/configuration-and-project-management.md)、[工具权限](docs/architecture/tool-permissions.md)和[任务调度](docs/architecture/task-orchestration.md)。本文只提供协作约定和入口，不代替运行时权限控制。

## 文档编写

- 面向用户，用平实语言先讲结论，再写用途、做法与边界；参考[多端规划](docs/architecture/multi-device-deployment.md)。少量标题、短段落，对照用表格、步骤用列表，避免长句和多层嵌套。
- 一篇回答一个主要问题，优先更新已有文档；同一规则只留一个主版本，其余用链接，不为每轮讨论新增重复方案。
- 普通说明以约 40–80 行为参考，按内容调整；不凑行数，也不删除必要契约、权限、恢复或兼容边界。字段链接源码／schema，测试过程与历史证据留执行记录或专项材料。
- 明确已实现、拟设计、待验证与后续能力。方案变化时重写当前结论、同步入口，移除重复或失效正文，不堆日期补丁；独有历史证据保留可追溯出处。

## 验证与交接

- 按风险在 `desktop/` 运行 typecheck、test、build，必要时补隔离 smoke；已有依赖不重复安装。UI 改动检查窄窗、键盘、焦点与减少动态效果，并保留截图／审核材料。
- 文档修改检查链接、锚点、事实与 `git diff --check`，不重跑无关业务测试。`Desktop checks` 不覆盖 GUI、真实模型、外部执行或发行验收；不以官网检查代替桌面验证，也不声称命名已由 CI 强制执行。
- 完成、失败、中断或交接均更新 `AGENTLOG.md` 三项摘要并追加记录：稳定 task_id、唯一 run_id、时间、改动、实际 skill／Agent／模型、验证、提交／推送、限制及下一步。未知写 unknown，未提交写 none，不用 HEAD 冒充本轮提交。
- 日志标题只写任务名，ID 留注释；外部编号另存 external_run_id，更正保留追溯。已登记任务以正式 tasks 为唯一状态源，日志不复制看板，也不提供额外授权；测试通过不等于用户验收。
- 记录格式见[日志规范](docs/architecture/agent-worklog.md)，流程见[开发工作流](docs/architecture/development-workflow.md)；资料缺失时按本文交接，不自动提交或推送。
