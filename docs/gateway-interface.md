# 网关接口定义（Gateway Interface Specification）

网关（Gateway，见 GLOSSARY）是本项目自研的**纯中转服务**：位于前端网页与 DSH 之间，只做校验与转发，不含 LLM（[ADR-0002](adr/0002-gateway-is-llm-free-relay.md)），不调用 APIMart（[ADR-0003](adr/0003-image-gen-via-mcp-in-dsh.md)）。本文是网关功能定义与双侧接口的唯一规范源，对接入方式的决策依据见 [ADR-0004](adr/0004-unified-skill-binding-layer.md)，批量出图决策见 [ADR-0005](adr/0005-batch-cells-within-task.md)，收货码决策见 [ADR-0006](adr/0006-redeem-code-claims-tokens.md)；端到端用户场景见 [use-cases.md](use-cases.md)，实现设计见 [frontend-design.md](frontend-design.md) 与 [backend-design.md](backend-design.md)。

```
浏览器（WS + HTTP）
   │
   ▼
网关容器（本规范的对象）
   │ Bearer DSH_WEB_API_KEY，仅内网
   ▼
DSH 容器（toddpan/dsh-webapi，前缀 /api/v1）→ 技能 → MCP → APIMart
```

## 1. 功能定义

网关承担且仅承担以下职责：

1. **令牌与任务管理**：管理员按订单签发一次性登录令牌（可一次签发多枚，绑定同一订单的收货码），令牌与任务 1:1 绑定（签发即创建任务，状态 `CREATED`）；确认完成即作废，24h 未确认过期。收货码供客户领取令牌（见 [ADR-0006](adr/0006-redeem-code-claims-tokens.md)）。
2. **确定性校验**：令牌有效性、收货码有效性（错误/过期/吊销/限频）、任务状态机、技能白名单（对照技能清单与签发侧 `preset`）、参数 JSON Schema、消息大小、频控、`cellId`/`editTarget` 归属、源图仅首条一次（服务端强制）。
3. **协议转换**：前端 WebSocket ↔ dsh-webapi REST/SSE；将 DSH 流式输出转为 WS `progress`。
4. **技能清单提供**：持有每个技能的薄元数据（Manifest），对前端提供目录与差异化表单依据；启动时与 dsh-webapi 的技能清单对账。
5. **产出登记**：逐轮对 DSH 会话文件做差量，登记本任务产出图引用，供 `editTarget` 校验、状态快照与重连恢复。
6. **文件纯代理**：源图上传与结果图下发均透传 dsh-webapi 文件路由，网关不落盘、无持久存储（任务态仅内存 + 结构化日志）。
7. **管理员 API**：签发令牌与收货码、列表、吊销令牌/收货码（仅内网暴露）。

**非职责**：任何 LLM 调用、提示词模板拼装与语义理解、APIMart 调用、用户账号体系、图片加工逻辑。

## 2. 核心语义

- **任务状态机**（沿用调研报告 §5.2）：

```
CREATED ──首个有效指令──▶ RUNNING ──DSH 返回──▶ AWAITING_MODIFY_OR_CONFIRM
   ▲                         │                       │
   │                    失败/超时                     ├── 修改指令 → RUNNING（同任务）
   └──── 同令牌重试 ◀─────────┘                       └── 确认完成 → DONE（令牌作废）
                                                     24h 无确认 → EXPIRED
```

- **出图单元（Cell）**：任务内最小出图配对 = 一张源图（可为空）× 一个技能。首条 `command` 以 `imageRefs × skillIds` 笛卡尔积展开单元（0×N 即纯文生图），1×4 / 4×1 / 2×3 无特例；展开受签发侧 `preset`（`allowedSkillIds`、`maxCells`、预填 `params`/`text`）约束。任务↔会话为 1:N，每格独立 DSH 会话（见 [ADR-0005](adr/0005-batch-cells-within-task.md)）。
- **单元状态聚合**：单元状态机同任务状态机（单格版）；任务状态 = 各单元状态聚合——任一格 `RUNNING` 则任务 `RUNNING`，全部格到达终态（`DONE`/`EXPIRED`/失败）任务才结束。`confirm` 整批一次，将全部格置 `DONE`、令牌作废。
- **技能锁定（单元级）**：每个单元的 `skill` 由首条指令展开时确定，该格内不可更换；修改指令带 `cellId`、省略 `skill`。
- **图片规则（单元级）**：源图仅首条指令携带一次；每格只能以展开时分配的源图（或空）执行，任务内禁止再传新图；后续修改只能 `editTarget` 指向**同格**已产出图片。
- **失败隔离**：单格失败/超时只标记该格（`DSH_FAILED`/`DSH_TIMEOUT`），其余格继续，失败格可单独重试，不阻塞整批确认。
- **源图进入 DSH 的路径**：上传文件放入该任务 DSH 会话的工作区，prompt 中附文件路径，由 DSH agent 原生 `read_image` 读入——不依赖 dsh-webapi `prompt.images` 字段（当前版本该字段未生效，见 ADR-0004）。

## 3. 技能清单（Manifest）

网关静态配置 + 启动时与 dsh-webapi `GET /skills` 对账（不一致则告警并降级为网关侧清单）。仅含元数据，不含提示词语义：

```jsonc
[{
  "id": "mono-color",                 // 白名单标识，command.skill 必须命中
  "displayName": "单色海报",
  "kind": "img2img",                  // txt2img | img2img
  "requiresSourceImage": true,        // 首条是否必须携带源图
  "paramsSchema": {                   // JSON Schema：前端渲染表单 + 网关格式校验
    "type": "object",
    "properties": { "title": { "type": "string", "maxLength": 40 } },
    "required": ["title"]
  }
}]
```

## 4. 前端接口（网关对公网/浏览器）

### 4.1 HTTP

| 方法与路径 | 说明 |
|---|---|
| `POST /admin/tokens` `{ orderRef, tasks: [{ preset? }], codeExpiresAt }` | 签发（仅内网）；`orderRef` 为不透明订单引用，每元素创建一个任务；返回 `{ redeemCode, expiresAt, tokens: [{ token, taskId }] }`，收货码与本单绑定（见 [ADR-0006](adr/0006-redeem-code-claims-tokens.md)） |
| `GET /admin/tokens` | 令牌列表（含状态、所属 `orderRef`） |
| `DELETE /admin/tokens/:token` | 吊销单个令牌（仅内网） |
| `POST /admin/codes/:code/revoke` | 吊销收货码（仅内网）；联动作废该码下未使用令牌 |
| `POST /redeem` `{ code }` | **公网**：凭收货码领取令牌列表，返回 `{ tokens: [{ token, taskId, preset? }] }`；有效期内可重复领取，单码限频（错误/过期/吊销 → `REDEEM_*`，限频 → `LIMIT`） |
| `POST /auth` `{ token }` | 校验令牌，返回 `{ taskId, state, preset, cells: [...] }`（`preset` 即任务要求表单，`cells` 为全格快照）；WS `auth` 的 HTTP 等价，供首登与断线恢复 |
| `GET /skills` | 返回 Manifest 数组（§3），前端渲染目录与差异化表单 |
| `POST /upload` | multipart 上传（仅图片 MIME、限首条一次），透传 DSH 会话工作区，返回 `{ imageRef }` |
| `GET /files/:ref` | 代理下载（源图 `img_*`、产出图 `out_*`），底层为 dsh-webapi 文件下载路由 |

### 4.2 WebSocket 消息 schema

客户端 → 网关：

```jsonc
{ "type": "auth",    "token": "tk_..." }
{ "type": "command",
  "skillIds": ["mono-color", "poster-a"],   // 首条必填：与 imageRefs 做笛卡尔积展开单元；受 preset.allowedSkillIds 白名单约束
  "params": { "title": "向北步行" },         // 按 Manifest paramsSchema 校验（preset 预填值可被覆盖）
  "text": "把建筑处理成粗网点",               // 可选自由补充，仅做大小/频控检查
  "imageRefs": ["img_01H..."],              // 可选：仅首条，须为已 upload 的引用；[] = 纯文生图
  "cellId": "cell_02",                      // 修改指令必填：目标单元，省略 skillIds（该格锁定）
  "editTarget": "out_003" }                 // 可选：须为同 cellId 下登记的产出
{ "type": "confirm", "satisfaction": 5 }    // 整批一次：全部格置 DONE
{ "type": "ping" }
```

网关 → 客户端（凡涉及单元的事件均带 `cellId`；单单元任务同样携带，无双 schema）：

```jsonc
{ "type": "auth_ok",  "taskId": "...", "state": "CREATED", "preset": { ... },
  "cells": [{ "cellId": "cell_01", "skill": "mono-color", "state": "CREATED", "outputs": [] }] }  // preset = 任务要求；全格快照，重连即恢复
{ "type": "state",    "state": "RUNNING",
  "cells": [{ "cellId": "cell_01", "state": "RUNNING", "outputs": ["out_001"] }] }
{ "type": "progress", "cellId": "cell_01", "source": "dsh", "delta": "…" }   // prompt-stream SSE 转发，按格路由
{ "type": "result",   "cellId": "cell_01", "imageRef": "out_003", "url": "/files/out_003" }  // 逐格逐图下发
{ "type": "error",    "cellId": "cell_02", "code": "DSH_FAILED", "retryable": true }          // 格级失败，其余格不受影响
{ "type": "done",     "taskId": "..." }    // 全部格终态
{ "type": "pong" }
```

### 4.3 错误码

| 类别 | code |
|---|---|
| 令牌 | `TOKEN_INVALID`、`TOKEN_EXPIRED`、`TOKEN_USED` |
| 收货码 | `REDEEM_INVALID`、`REDEEM_EXPIRED`、`REDEEM_REVOKED`（领取限频归 `LIMIT`） |
| 状态/校验 | `STATE_INVALID`、`SKILL_UNKNOWN`、`SKILL_LOCKED`、`EDIT_TARGET_INVALID`、`IMAGE_REF_INVALID`、`BAD_PARAMS` |
| 限流/大小 | `LIMIT`、`PAYLOAD_TOO_LARGE` |
| 后端 | `DSH_FAILED`、`DSH_TIMEOUT`（均带 `cellId`，格级可重试） |

每个错误码对应一条确定性拒绝路径，可单元测试。

## 5. 网关 ↔ dsh-webapi 接口

前缀 `/api/v1`，独立 API 服务端口 31800–31899，网关持 `DSH_WEB_API_KEY`，统一 `Authorization: Bearer`；仅内网可达。

| 网关动作 | 调用 | 说明 |
|---|---|---|
| 任务创建（令牌签发时） | `POST /sessions` | 会话与任务 1:1，记 `sessionId` |
| 单元展开（首条指令） | `POST /sessions` × N | 每格独立会话（任务↔会话 1:N），记 `cellId → sessionId`；按并发上限调度，超出的格排队 |
| 技能清单对账 | `GET /skills` | 仅启动/定时对账，不直连前端 |
| 每轮执行（首条/修改） | `POST /sessions/:id/prompt-stream` | 按 `cellId` 路由到该格会话；SSE：`progress` 转 WS（带 `cellId`）；停滞看门超时 → `DSH_TIMEOUT`（格级） |
| 源图上传 | `POST /sessions/:id/files` | multipart，入各格会话工作区 |
| 产出发现 | `GET /sessions/:id/files` | 每格每轮结束后差量，新图登记为 `out_*`（归属 `cellId`） |
| 结果下发 | `GET /sessions/:id/files/download?path=` | 网关 `GET /files/:ref` 的底层 |
| 取消（过期/放弃） | `POST /sessions/:id/cancel` | 逐会话：过期/吊销时遍历任务下全部格会话 |
| 健康检查 | `GET /system/status` | 启动与探活 |

prompt 消息体：`{ "prompt": "<skill 指令序列化文本>", "stallTimeoutMs": ... }`。其中指令为网关对该格 `{skill, params, text}` 的**确定性 JSON 序列化**（无语义加工），并附该格源图工作区路径；由 DSH 侧技能解释。
