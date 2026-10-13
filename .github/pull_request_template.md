PR 标题使用 `type(scope): 描述`（scope 可省略），完整约定见 [AGENTS.md](https://github.com/SUertee/screen-deck/blob/dev/AGENTS.md)。

## 改动

说明解决的问题、用户可见变化与影响的模块。界面改动附使用临时数据的截图；不包含私人任务、聊天或本机路径。

## 验证

填写实际命令和结果，未执行项说明原因，不默认勾选。

- [ ] `cd desktop && npm run typecheck && npm test && npm run build`
- [ ] `git diff --check`
- [ ] 涉及记录规则时：`node --test scripts/validate-project-workspace.test.mjs`
- [ ] 涉及界面、IPC 或执行状态时：相应隔离 smoke、键盘和窄窗检查（写明范围）

`Desktop checks` 仅验证类型、单元测试、构建和临时记录校验器测试；不代替 Electron 实机界面、真实模型、外部执行或发行验收。

## 风险与交接

说明未覆盖验证、兼容性影响与回退方式；区分已实现、测试模拟与后续设计。数据格式变化须说明迁移与恢复方案，不静默改写旧记录。

dev PR 可选。发布 PR（dev → main）由 SUertee 确认检查通过、分支最新、讨论已解决后手动使用 merge commit 合并；不需要额外 approval。AI 不自行合并 main；合并代码不等于已签名、公证或发布安装包。
