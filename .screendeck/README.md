# 项目身份与约定

本目录只保存可共享的项目设置，不存聊天、任务执行或附件。

- `project.json`：稳定项目 ID、名称和创建时间。
- `config.toml`：项目范围、验证和交接约定；声明不授予执行权限。
- `.gitignore`：防止旧版任务和附件误入版本控制。

正式项目任务、执行记录和原始产物默认存于 `~/.screendeck/projects/<project_id>/` 的
`tasks/`、`runs/`、`artifacts/`；`history.json` 绑定本机项目位置。
任务是状态来源；一个任务可以关联多次 run。

Electron 聊天、任务模拟、预览计划与审批另存于
`~/.screendeck/previews/electron-v1/`，不迁移、双写或回写上述正式记录。
记录仍使用 JSON；字段与日期校验的唯一规则源是
[`desktop/src/projects/record-schema.ts`](../desktop/src/projects/record-schema.ts)。

接手时如有本地 `AGENTLOG.md`，先读摘要，再按稳定 ID 查看记录。
日志被 Git 忽略；新克隆项目不包含本机执行历史。
工作台中选择项目，右侧查看详情；刷新不会执行任务。

在项目根目录运行只读校验，使用支持原生 TypeScript 类型剥离的 Node.js；
本机已验证 Node.js 22.21.1。脚本读取固定应用目录内的规则，不采用项目自带规则：

```sh
node scripts/validate-project-workspace.mjs
```

**产物库留证，docs 整理，AGENTLOG 串起过程。**
私人数据不随 Git 同步；分享需另行导出。详情见
[项目说明](../README.md#数据与隐私)。
