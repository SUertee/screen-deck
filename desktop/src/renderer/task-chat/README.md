# 任务聊天组件

受控组件保留在本目录，生产接线由 `tasks/TaskDiscussion.tsx` 和 App 控制器负责；统一行为见[任务模块](../../../../docs/architecture/task-module.md)。

- `TaskChatPanel` 输出讨论草稿和明确选择的材料，不创建会话、不发送消息或执行命令。主控制器重读计划版本及材料后追加到可见聊天草稿，保留原输入，用户另行发送。
- 关联保存在 PreviewPlan v3 的 `task.chat_refs`；选择已有聊天后显式带入才保存关联。新讨论进入 composer，第一次发送时再创建会话。解除关联不删除历史或修改会话原始 scope。
- `TaskChatExecutionContext` 复用原权限控件，展示固定目录和模式；加载失败阻止交接，未读完不会冒称纯聊天。新会话由原 composer 明确选择范围。
- 原生工具审批仍由 `AgentTurnTools` 处理，绑定原 session/turn。`TaskChatApprovals` 是只读投影组件，没有第二条授权路径。
- `TaskPlanProposalCard` 仍是候选文本组件；生产未接自由文本生成／修改完整计划。Jev 已接入的候选分工另由 TaskJevAdvice 和固定主进程接口维护。

这里的 UI DTO 不是第二套落盘格式。任务用稳定引用和版本匹配，材料只能来自已保存条目；不能用标题、展示标签或同期画面推断关联。组件预览与单测不能代替实际桌面闭环；实际验证记录留在 AGENTLOG。
