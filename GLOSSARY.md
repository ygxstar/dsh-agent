# 图片任务网关（dsh-agent）

面向公网用户的图片生成/编辑任务网关：前端网页 + 独立网关服务，以后端的 DeepSeek Harness（DSH）为执行引擎。

## Language

**DSH（DeepSeek Harness）**:
本项目的执行引擎：一个开源 agent 运行时，负责理解指令、调用技能并产出结果。
_Avoid_: harness、DeepSeek

**网关（Gateway）**:
本项目自研的独立服务，位于前端与 DSH 之间；只做校验与转发，自身不含 LLM。
_Avoid_: agent（易与 DSH 混淆）、后端

**任务（Task）**:
一个登录令牌所绑定的一次完整工作单元：首条消息携带源图，其后仅可对 DSH 已产出的图片做修改，以用户确认完成为终点。
_Avoid_: 会话、job

**登录令牌（Token）**:
管理员预发、供前端登录的一次性凭证；与一个任务一一绑定，任务确认完成后失效。
_Avoid_: 用户账号、session、API key

**技能（Skill）**:
以 SKILL.md 为入口的可复用能力包，由 DSH 加载执行（如 mono-color）。
_Avoid_: 插件、prompt

**插件（Plugin）**:
安装进 DSH profile 的扩展包，为 DSH 增加运行时能力（如 dsh-webapi 提供 HTTP API）。
_Avoid_: 技能、extension
