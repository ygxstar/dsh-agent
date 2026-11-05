# 前端设计（Frontend Design）

前端为 Vite+React+TS 静态页（部署于网关容器，见调研报告 §4）。接口契约的唯一规范源是 [gateway-interface.md](gateway-interface.md)，业务场景见 [use-cases.md](use-cases.md)；本文只描述**页面结构、模块划分与交互设计**，不重复定义协议字段。

决策依据：[ADR-0004](adr/0004-unified-skill-binding-layer.md)（显式选技能、薄 Manifest）、[ADR-0005](adr/0005-batch-cells-within-task.md)（任务内出图单元）、[ADR-0006](adr/0006-redeem-code-claims-tokens.md)（收货码仅做领取）。

## 1. 页面流

```
兑换页 /                     任务工作台 /task/:taskId
┌──────────────────┐        ┌─────────────────────────────────┐
│ 收货码输入        │        │ 任务要求（preset）只读卡片        │
│ POST /redeem     │ ─────▶ │ 上传区（限首条一次）              │
│ → 令牌列表       │ 选令牌  │ 技能多选 + paramsSchema 表单     │
└──────────────────┘        │ 出图单元图墙（cell grid）         │
                            │ 逐格修改 / 整批确认 + 满意度      │
                            └─────────────────────────────────┘
```

- **兑换页**：唯一公网入口页；持码换令牌列表（有效期内可重复领取），令牌列表暂存本地（localStorage），供进入工作台时逐个 `auth`。
- **任务工作台**：一个令牌对应一个工作台；同一收货码下的多个令牌 = 多个工作台标签页（每条独立 WS，见 ADR-0006）。

## 2. 模块划分

| 模块 | 职责 |
|---|---|
| `api/client` | HTTP 封装：`redeem`、`auth`、`skills`、`upload`、`files` 下载 |
| `ws/client` | 连接生命周期：`auth` 握手、`ping/pong` 心跳、断线指数退避重连、事件按 `cellId` 分发 |
| `store/task` | 任务快照：`{ taskId, state, preset, cells[] }`，`cells` 以 `cellId` 为键 |
| `store/cells` | 每格：`{ skill, state, outputs[], progress, error }`；任务级 `state` 由格态派生显示 |
| `form/skill-picker` | `GET /skills` 渲染 Manifest 目录；受 `preset.allowedSkillIds` 过滤、`preset.maxCells` 上限约束 |
| `form/skill-hint` | 选技能后展示该技能 `description`/`examples`（功能描述与用法举例），指导参数与补充说明填写（§3.6） |
| `form/params` | 按 Manifest `paramsSchema` 自动生成表单，`preset.params` 为预填值（可改） |
| `upload/refs` | 选图 → `POST /upload` → 收集 `imageRefs[]`；任务已展开后禁用 |
| `wall/cell-grid` | 单元图墙：每格显示进度流、产出图、错误与重试入口 |
| `wall/cell-editor` | 逐格修改：选格 → 沿用该格技能的表单 + `editTarget`（仅同格产出） |
| `confirm/bar` | 整批确认：满意度评分 → `confirm` |

## 3. 核心交互

### 3.1 展开预览（首条指令前）

用户选完源图与技能后，前端本地计算 `imageRefs.length × skillIds.length`：

- 结果为 0（未选图且未选技能）→ 禁止提交；
- 超过 `preset.maxCells` → 表单内提示，禁止提交（服务端仍会以 `LIMIT` 兜底）；
- 0×N（纯文生图）与 N×1、1×N、M×K 同一表单路径，无特例 UI。

### 3.2 图墙与进度

- `auth_ok` / `state` 返回的全格快照整体覆盖本地 store（重连即重建图墙）；
- `progress` 按 `cellId` 路由到对应格的流式文本区；
- `result` 追加到对应格的产出列表，点击走 `GET /files/:ref` 预览/下载；
- 任务级状态条由格态派生：任一格 `RUNNING` 显示"生成中"，全部终态才放开确认按钮。

### 3.3 逐格修改

- 进入某格编辑态 → 发送的 `command` 只带 `cellId`（省略 `skillIds`，服务端锁定校验）；
- `editTarget` 下拉只列出该格 `outputs`，跨格选项不渲染（服务端 `EDIT_TARGET_INVALID` 兜底）；
- 修改期间该格回到 `RUNNING`，其余格不受影响（失败隔离，见 use-cases 场景 3）。

### 3.4 失败格重试

- `error` 事件带 `cellId` 且 `retryable: true` 时，该格渲染重试按钮 → 以同 `cellId` 重发修改指令；
- 格级错误不弹全局遮罩，不阻塞整批确认。

### 3.5 整批确认

- 全部格到达可确认态才启用 `confirm`；一次提交（满意度评分）→ 等 `done` → 跳转回兑换页/完成页；
- 确认后令牌即废，前端清除本地该令牌记录。

### 3.6 技能说明提示（选技能 → 填参数）

- 位于「选择技能」与「参数与说明」之间，展示所选技能的功能描述与用法举例（Manifest `description`/`examples`），未选技能时显示引导文案；
- 宽屏 `position: sticky` 吸附视口顶部，滚动到参数表单时仍可见；≤640px 改为底部固定浮窗，默认折叠、点「看说明」展开（`max-height` 42vh 内滚动），页面预留底部 padding 避免遮挡提交按钮；
- 多选技能时逐个技能分节展示；技能页（`/skill/:skillId`）复用同一组件。

## 4. WS 客户端细则

1. 连接顺序：建连 → `auth {token}` → 收 `auth_ok`（含 `preset` + 全格快照）→ 进入交互；
2. 心跳：每 30s `ping`，30s 未收 `pong` 视为断线，触发重连；
3. 重连：指数退避（1s 起、上限 30s），重连后重新 `auth`，以服务端快照覆盖本地（不做本地状态回放）；
4. 令牌已作废（`TOKEN_USED`/`TOKEN_EXPIRED`）→ 停止重连，回兑换页并提示。

## 5. 错误处理

| 场景 | code | UI 行为 |
|---|---|---|
| 兑换页 | `REDEEM_INVALID/EXPIRED/REVOKED`、`LIMIT` | 表单行内提示，不跳转 |
| 登录/重连 | `TOKEN_INVALID/EXPIRED/USED` | 回兑换页，清本地令牌 |
| 提交指令 | `SKILL_UNKNOWN/LOCKED`、`BAD_PARAMS`、`EDIT_TARGET_INVALID`、`IMAGE_REF_INVALID`、`LIMIT` | 对应表单字段行内提示 |
| 格级执行 | `DSH_FAILED/DSH_TIMEOUT`（带 `cellId`） | 该格错误态 + 重试按钮 |
| 全局 | `STATE_INVALID`、`PAYLOAD_TOO_LARGE` | 顶部 toast |

错误码全集与语义见 gateway-interface.md §4.3；前端只做 code → 文案映射，不做语义判断。

## 6. 与服务端的强制规则对齐

前端只做体验优化，以下规则**以服务端为准**，前端不依赖自身控制：源图仅首条一次、技能格内锁定、`editTarget` 同格归属、`maxCells` 上限、收货码限频。
