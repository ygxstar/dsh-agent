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
一个登录令牌所绑定的一次完整工作单元：以首条指令开始（可携带源图），首条指令可展开一个或多个出图单元，其后仅可对 DSH 已产出的图片做修改，以用户确认完成为终点。
_Avoid_: 会话、job

**出图单元（Cell）**:
任务内的最小出图配对：一张源图（可为空）× 一个技能；单元间互不影响，任务的首条指令按笛卡尔积展开单元。
_Avoid_: 子任务、批次

**登录令牌（Token）**:
管理员预发、供前端登录的一次性凭证，可经收货码领取或由管理员直接下发；与一个任务一一绑定，任务确认完成后失效。
_Avoid_: 用户账号、session、API key

**收货码（Redeem Code）**:
与订单绑定的可复用入口凭证：签发令牌时生成，持码可领取该订单下全部令牌；码过期或作废则未使用令牌一并作废。
_Avoid_: 提货码、邀请码

**技能（Skill）**:
以 SKILL.md 为入口的可复用能力包，由 DSH 加载执行（如 mono-color）。
_Avoid_: 插件、prompt

**技能清单（Manifest）**:
网关为每个可用技能持有的薄元数据（标识、显示名、是否需要源图、参数 schema），仅用于前端表单渲染与格式校验，不含提示词语义。
_Avoid_: 技能注册表、参数模板

**插件（Plugin）**:
安装进 DSH profile 的扩展包，为 DSH 增加运行时能力（如 dsh-webapi 提供 HTTP API）。
_Avoid_: 技能、extension
