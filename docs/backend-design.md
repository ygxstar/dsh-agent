# 网关后端设计（Gateway Backend Design）

网关为 Node/TS 独立容器（调研报告 §4），纯中转定位（[ADR-0002](adr/0002-gateway-is-llm-free-relay.md)）。接口契约的唯一规范源是 [gateway-interface.md](gateway-interface.md)，本文只描述**模块划分、数据模型、状态与调度的设计**；字段与错误码不在此重复定义。

决策依据：[ADR-0004](adr/0004-unified-skill-binding-layer.md)（Manifest 对接层）、[ADR-0005](adr/0005-batch-cells-within-task.md)（任务内出图单元、会话 1:N）、[ADR-0006](adr/0006-redeem-code-claims-tokens.md)（收货码仅做领取）。

## 1. 约束

- 无 LLM、无提示词语义、无 APIMart 调用；一切消息处理为**确定性规则**（校验 → 序列化 → 转发）。
- 无持久存储：任务/令牌/收货码状态仅内存 + 结构化日志（重启即失效，24h 过期窗口内可接受；日志用于审计与排障）。
- 每个错误码对应一条可单测的确定性拒绝路径。

## 2. 模块划分

```
                 ┌────────────────────────────────────────────┐
  公网 ──HTTP──▶ │ http-api      redeem/auth/skills/upload/files │
                 │               admin/*（仅内网绑定）           │
  公网 ──WS────▶ │ ws-server     auth/command/confirm/ping 路由  │
                 └──────┬─────────────────────────────────────┘
                        ▼
                 ┌──────────────┐   ┌──────────────┐
                 │ validation   │   │ manifest     │ 静态配置+启动对账
                 │ 校验管道      │   └──────────────┘
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐   ┌──────────────┐
                 │ task-runtime │◀─▶│ token-store  │ Token / RedeemCode
                 │ 任务/单元状态机│   │ code-store   │（含限频计数）
                 └──────┬───────┘   └──────────────┘
                        ▼
                 ┌──────────────┐
                 │ scheduler    │ 并发上限、格会话排队
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐
                 │ dsh-client   │ REST/SSE 封装（sessions/prompt-stream/files/cancel/skills/status）
                 └──────────────┘
```

| 模块 | 职责 |
|---|---|
| `http-api` | gateway-interface.md §4.1 全部 HTTP 路由；`/admin/*` 单独监听内网地址 |
| `ws-server` | §4.2 消息路由；单连接绑定单令牌；按 `cellId` 分发下行事件 |
| `validation` | 校验管道（§7），输出错误码即终止 |
| `manifest` | 静态技能清单加载；启动/定时与 dsh-webapi `GET /skills` 对账，不一致告警并降级网关侧清单 |
| `token-store` / `code-store` | 令牌 1:1 任务；收货码 1:N 令牌、有效期、吊销、单码领取限频 |
| `task-runtime` | 任务与单元状态机、状态聚合（§4）、产出登记表、过期看门狗（24h） |
| `scheduler` | 格级会话并发上限调度（§6） |
| `dsh-client` | 对 dsh-webapi 的唯一出口：Bearer `DSH_WEB_API_KEY`、SSE 消费、超时/停滞看门 |
| `files` | 上传与下载透传：`imageRef`/`out_*` → `(sessionId, path)` 映射表 |

## 3. 数据模型（内存）

```jsonc
Token    { token, taskId, state: ACTIVE|USED|EXPIRED|REVOKED, createdAt }
RedeemCode { code, orderRef, expiresAt, state: ACTIVE|REVOKED, claimCount, tokenRefs[] }
Task     { taskId, orderRef?, codeRef?, preset, state, cells: {cellId → Cell}, outputs 索引 }
Cell     { cellId, skill, sourceRef|null, sessionId|null, state, outputs: [imageRef], error? }
```

- `orderRef` 为不透明字符串，网关不解析其业务含义（ADR-0006）。
- `preset = { allowedSkillIds, maxCells, params, text }`，签发时注入，`auth` 时原样返回给前端作为"任务要求"。
- `imageRef → (sessionId, path)` 映射支撑 `GET /files/:ref`，源图与产出图同一张表。

## 4. 状态与聚合

- 单元状态机与任务状态机同构（gateway-interface.md §2 图）；单元是实际执行者，任务状态是派生值：
  - 任一格 `RUNNING` → 任务 `RUNNING`；
  - 全部格终态（`DONE`/`EXPIRED`/失败）→ 任务终态；
  - `confirm` 校验"全部格可确认"后一次置 `DONE`、令牌 `USED`。
- `error` 下行事件必须带 `cellId`；任务级仅 `state`/`done` 不带格。
- 失败格保持可重试（同 `cellId` 再收修改指令），不改变任务聚合态为终态。

## 5. 会话生命周期与源图分发（任务↔会话 1:N）

```
签发            首条 command 展开              每格执行              确认/过期
 │  POST /sessions    │  POST /sessions ×N       │  prompt-stream      │  cancel ×N
 ▼                    ▼                          ▼                     ▼
任务会话(staging) ──复制源图──▶ 格会话_1 … 格会话_N（并发受 scheduler约束）
```

1. **签发即建任务会话**（staging）：此后前端 `POST /upload` 的源图进入该会话工作区，`imageRef` 指向此处；
2. **首条指令展开**：按 `imageRefs × skillIds` 生成 `cellId`，为每格 `POST /sessions` 建格会话；
3. **源图分发**：网关把 staging 中的源图 `GET .../files/download` → `POST .../files` 逐格复制（确定性文件中转，无语义加工）——因为 DSH agent 只能 `read_image` 本会话工作区（ADR-0004）；
4. **产出发现**：每格每轮结束后对格会话 `GET /sessions/:id/files` 差量，新图登记 `out_*` 并记入该格 `outputs`；
5. **收尾**：任务终态时对全部会话 `POST /sessions/:id/cancel`（含 staging）。

prompt 消息为该格 `{skill, params, text}` 的确定性 JSON 序列化 + 源图工作区路径（gateway-interface.md §5）。

## 6. 并发调度（scheduler）

- 全局并发上限 `maxConcurrentCells`（配置项）：格会话创建/执行按队列取号，超出的格保持 `CREATED/排队` 态并下发对应 `state` 快照；
- 调度粒度为**格**（ADR-0005：格间并行、技能上下文隔离）；单格多轮（首条 → 修改）串行占用该格额度；
- 格失败/完成即释放额度，队列推进。

## 7. 校验管道（command 到达后顺序执行）

```
令牌(ACTIVE) → 任务状态机 → 首条: preset 白名单/maxCells + Manifest 存在性
            → 修改: cellId 归属 + 格锁定(省略 skillIds)
            → params JSON Schema → editTarget 同格产出登记
            → 源图(仅首条, imageRef 已 upload) → 大小/频控
            → 展开或入格 → scheduler → dsh-client
```

任一步失败即回 `error`（带 `cellId` 若已知），不触碰 DSH。收货码管道独立：`code 存在 → 未过期 → 未吊销 → 限频` → `REDEEM_*`/`LIMIT`。

## 8. 部署与网络

- compose 新增 `gateway` 服务（调研报告 §4 容器 A）：托管前端静态页 + 网关进程；依赖 `dsh` 服务，密钥经 `.env` 注入（现有 docker-compose.yml 注释的待办③④）；
- 暴露面：公网仅 `redeem/auth/skills/upload/files/ws`；`/admin/*` 绑内网地址（不发布宿主端口）；
- 与 DSH 仅容器网络互通，`DSH_WEB_API_KEY` 只存在于网关与 dsh 容器环境变量。

## 9. 可测试性与日志

- `dsh-client` 以接口抽象，测试注入 fake，校验管道/状态机/聚合规则全部可离线单测（每个错误码一条用例）；
- 结构化日志字段：`ts, level, taskId, cellId, token(哈希), code, event`；令牌只记哈希，收货码只记前缀。
