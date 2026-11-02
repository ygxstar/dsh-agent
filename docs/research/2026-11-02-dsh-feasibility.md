# 调研 261102：基于 DeepSeek Harness 的公网图片任务网关——技术可行性评估

日期：2026-11-02 · 对应需求：[task.md](../../task.md)

## 1. 结论

**可行**。四项功能的关键链路均有现成支撑，唯一原本的硬缺口（DSH 无图像生成能力）已通过外接 APIMart `gpt-image-2` 闭合。两个前置条件与一个已知风险：

- **前置条件**：① 自写 `docker-compose.yml`（DSH 官方不提供）；② 实现期首项验证：DeepSeek 路线的视觉模型确实服务图像输入（文档明确"声明支持但网关不服务会被拒绝"）。
- **已知风险**：DSH 处于开发者预览期、有破坏性变更；dsh-webapi 为第三方（安全评级 C3）。均有对应缓解，见 §7、§8。

## 2. 需求回顾（task.md）

1. 通过 docker-compose.yml 安装 DeepSeek Harness；
2. 安装可复用技能（如 `yanliudesign/mono-color-skill`）；
3. 安装插件 dsh-webapi，把 DSH 功能以 HTTP API 提供给自研 agent；
4. 自研独立 agent（独立 docker 或并入 DSH docker），后端 DSH、前端网页、面向公网：
   - 登录后台 API：管理员发 token，前端凭 token 登录；
   - 登录后经 WebSocket 与 agent 连接，agent 校验命令、转发 DSH、回传结果；
   - 上传图片 + 指定技能创作（例："把这张街景照片做成钴蓝单色城市散步海报，粗网点，标题'向北步行'"），支持修改；
   - 任务返回后用户确认完成并评价满意度；**一个登录 token 只完成一次任务**。

## 3. 事实核查

| # | 事实 | 结论 | 依据 |
|---|---|---|---|
| 1 | DSH 存在 | ✅ [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，TypeScript，"Everything is a Plugin"（Cordis 架构），**开发者预览期、有破坏性变更** | 仓库 README |
| 2 | 官方 docker-compose / 产品级 Dockerfile | ❌ **不存在**；官方部署方式为 `npx @deepseek-ai/dsh web`（Node ≥24.9）或源码构建，Web UI 默认 `127.0.0.1:3080`，公网部署见 `docs/user/guide/public-deployments.md` | 仓库代码检索 |
| 3 | 插件安装机制 | ✅ `dsh plugin --profile <name> add <package>`（走 pnpm，记录进 profile `package.json`） | DSH 文档 `plugin-market.md` |
| 4 | 技能机制 | ✅ SKILL.md 格式，**与 Claude Code 技能兼容**；发现根含 `<project>/.dsh/skills`、`<dshHome>/skills` 等，热加载 | DSH 文档 `subsystems/skills.md` |
| 5 | `oddpan/dsh-webapi` | ❌ 不存在；实际为 **[toddpan/dsh-webapi](https://github.com/toddpan/dsh-webapi)**（task.md 笔误） | `gh repo view` |
| 6 | dsh-webapi 能力 | ✅ DSH 插件，80+ REST/SSE 路由：会话、流式、技能、文件上传、统计、设置，另有 OpenAI 兼容 `/chat/completions`；内置 OpenAPI 3.0（`/api/v1/docs`）；API key 鉴权（哈希存储）、admin-token 分离；默认绑 `127.0.0.1`，可配 `0.0.0.0`；上传上限 2 GiB；独立固定端口服务（31800–31899） | 仓库 README |
| 7 | dsh-webapi 安全评级 | ⚠️ 第三方审计 C3：执行系统命令、启动网络服务、读凭证类环境变量 | unStone/dsh-xray |
| 8 | DSH 无头/流式能力 | ✅ `dsh headless "task"`（`--json` NDJSON、`--session-id` 恢复、`--approval-policy`）；`dsh web` 暴露 `/api` 与 WebSocket `/api/remote.mux` | DSH 文档 `api-gateway.md` |
| 9 | mono-color-skill 存在与格式 | ✅ [yanliudesign/mono-color-skill](https://github.com/yanliudesign/mono-color-skill)，SKILL.md 格式（Claude Code/Agent 通用），单色/双色编辑海报创作，含设计系统目录与稳定 seed（支持重试一致性） | 仓库 SKILL.md |
| 10 | mono-color-skill 图像输入 | ✅ 支持参考照片输入（"preserve its identity… convert it to halftone"） | SKILL.md `Input Reading` |
| 11 | **DSH 图像生成能力** | ❌ **无**：官方工具目录（bash/run_code/文件/web…）无任何文生图工具，仅有 `read_image` 读图；skill 明言"无图像生成能力时只输出 prompt" | `docs/tool-catalog.md`、SKILL.md |
| 12 | DSH 视觉输入 | ✅ 模型可配 `input: [text, image]`；DeepSeek 路线默认 `deepseek-flash` 可带图像；消息附件（attachment）子系统存在；但**需验证所配网关实际服务图像模型** | `docs/user/guide/providers.md`、`subsystems/attachment.md` |
| 13 | APIMart 图像服务 | ✅ `/work/GPT-Image-Studio/.env` 含 `APIMART_API_KEY` / `APIMART_BASE_URL=https://api.apimart.ai/v1` / `APIMART_IMAGE_MODEL=gpt-image-2`；文档确认 `image_urls` 为参考图数组（OpenAI 标准字段），即图生图，≤15 张，支持 `data:image/...;base64` | 本地 .env、apimart 文档 |

**缺口闭合方式**：功能 3 的"产出位图"原为硬缺口（事实 11），现由 ADR-0003 闭合——DSH 内挂 MCP 图像服务调 APIMart `gpt-image-2`，`image_urls` 传 base64 参考图完成图生图/修改。

## 4. 目标架构

双容器（自写 compose），网关纯中转（ADR-0002），图像生成在 DSH 内（ADR-0003），HTTP 层用 toddpan/dsh-webapi（ADR-0001）：

```
公网/内网用户浏览器
   │  HTTPS(后期 nginx)      WS
   ▼                          ▼
┌─────────────────────────────────────┐
│ 容器 A：dsh-agent（本仓库）          │
│  · Vite+React+TS 前端静态页         │
│  · Node/TS 网关：令牌/状态机/频控/   │
│    协议转换（无 LLM）               │
└───────┬─────────────────────────────┘
        │ REST/SSE（仅容器网络，API key）
        ▼
┌─────────────────────────────────────┐
│ 容器 B：DSH + 插件                   │
│  · dsh web（Node ≥24.9）            │
│  · 插件：toddpan/dsh-webapi          │
│  · 技能：mono-color-skill           │
│  · MCP 图像服务 → APIMart gpt-image-2│
│  · APIMART_API_KEY（仅图像权限）      │
└─────────────────────────────────────┘
```

要点：

- **部署拓扑**：独立双容器。DSH 为预览版、变更频繁，网关与其解耦可独立升级；dsh-webapi 本身有独立端口服务，跨容器直连自然。
- **docker-compose.yml 自写**：DSH 官方不提供（事实 2），内容为 DSH 容器（`dsh web` + 插件 + 技能 + MCP 服务）与网关容器的编排、卷、内网互联、敏感环境变量注入。**这是本方案唯一必要的自建部署工件。**
- **网关职责**：令牌校验、任务状态机、消息大小/频控/白名单校验、WS↔REST/SSE 转发。不含模型。
- **技能安装**：`mono-color-skill` 放入技能发现根（如 `<dshHome>/skills/mono-color/`），或随镜像打入。
- **插件安装**：`dsh plugin --profile web add https://github.com/toddpan/dsh-webapi/releases/latest/download/dsh-web-service.tgz`，验证 `curl http://127.0.0.1:3080/api/v1/system/status`。

## 5. 协议与状态机（可直接照此实现）

### 5.1 令牌与任务语义（已确认）

- 管理员预发令牌，前端凭令牌登录；**一令牌绑定一个任务**。
- 一个任务 = 从首条携带源图的消息到用户确认完成，**期间的修改/重试均属同一任务，不消耗新令牌**。
- 首条消息允许上传图片；**任务内禁止再传新图**，后续只能对 DSH 已产出图片做修改（网关在服务端强制，不依赖前端控制）。
- 确认完成 → 令牌立即作废；24h 未确认自动过期；DSH 执行失败允许同令牌重试（不消耗任务）；任务态存网关侧，断线重连凭令牌恢复。

### 5.2 任务状态机

```
CREATED ──首个带图指令──▶ RUNNING ──DSH 返回──▶ AWAITING_MODIFY_OR_CONFIRM
   ▲                          │ │                      │
   │                     失败/超时                      ├── 修改指令 → RUNNING（同任务）
   └──── 同令牌重试 ◀──────────┘                       └── 确认完成 → DONE（令牌作废）
   （24h 无确认 → EXPIRED；网关内存态 + 结构化日志）
```

### 5.3 WebSocket 消息 schema（核心）

客户端 → 网关：

```jsonc
{ "type": "auth",    "token": "tk_..." }                  // 登录，绑定任务
{ "type": "command", "text": "把这张照片做成钴蓝单色海报…",  // 首条：multipart HTTP 上传图片，
  "imageRef": "img_01H..." }                              // 此处仅引用；后续消息无 imageRef
{ "type": "command", "text": "标题换成'向北步行'", "editTarget": "out_003" }  // 修改：只能指向 DSH 产出图
{ "type": "confirm", "satisfaction": 5 }                  // 确认完成 + 满意度
{ "type": "ping" }
```

网关 → 客户端：

```jsonc
{ "type": "auth_ok",  "taskId": "..." }
{ "type": "state",    "state": "RUNNING" }                // 状态机快照（重连恢复）
{ "type": "progress", "source": "dsh", "delta": "…" }     // DSH 流式输出片段（SSE 转发）
{ "type": "result",   "imageRef": "out_003", "url": "/files/out_003.png" }
{ "type": "error",    "code": "TOKEN_INVALID | LIMIT | DSH_FAILED | ..." }
{ "type": "done",     "taskId": "..." }                   // 确认后收尾
{ "type": "pong" }
```

图片经网关 HTTP 上传（multipart，首条一次）与结果文件路由下发；WS 只传引用，避免二进制帧复杂度。

## 6. 端到端流程（功能 3 示例）

1. 管理员发令牌 → 用户打开网页，`auth` 登录；
2. 前端 HTTP 上传街景照片，`command` 携 `imageRef` + 文本"做成钴蓝单色城市散步海报，粗网点，标题'向北步行'"；
3. 网关校验（令牌有效、状态允许首传、频控）→ 调 dsh-webapi 创建会话，消息带图片附件；
4. DSH 视觉模型理解照片 → 触发 mono-color-skill → 产出生成配方与 prompt → 经 MCP 调 APIMart `gpt-image-2`（源图 base64 入 `image_urls`）→ 返回位图；
5. 网关经 SSE 收流，`progress` 转发前端；位图落结果文件，`result` 下发；
6. 用户"标题改成…" → 网关校验 `editTarget` 为本任务 DSH 产出 → 同会话续跑，APIMart 以已产出图为参考图重生成（skill 的稳定 seed 保证风格延续）；
7. 用户确认 → 网关收满意度、令牌作废、`done`。

## 7. 安全清单（内网 demo；公网开放时逐项复核）

- **网络**：两容器置于同一 compose 内网；dsh-webapi 绑 `127.0.0.1`/内网、强制 API key；admin-token 仅存容器内（`<DSH home>/dsh-web-service/admin-token`），不进网关、不外露；公网阶段按 `public-deployments.md` 走域名 + nginx + TLS。
- **容器加固（对冲"C3"与 agent shell 能力）**：DSH 容器无敏感数据、限制出口（仅 DeepSeek/APIMart 等必需端点）、专用 profile 只装 mono-color 技能、权限 preset 自动拒绝危险操作、`APIMART_API_KEY` 仅图像权限。
- **网关侧**：一令牌一任务、每令牌消息频控、消息大小上限、首传图片仅一次（服务端强制）、上传仅允许图片 MIME。
- **后续升级项**（公网前）：prompt 模板化限制自由输入、内容审核（`APIMART_NSFW_CHECK` 已有开关可启用）、登录尝试限速。

## 8. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| DSH 预览期破坏性变更，插件/技能随版本失效 | 高 | compose 锁定版本；升级前跑验收清单；网关与 DSH 解耦 |
| dsh-webapi 第三方 C3 评级 | 中 | §7 网络隔离 + 最小权限 + 无敏感环境变量；必要时替换为 ADR-0001 中的备选路径 |
| 视觉输入未实际验证（声明≠服务） | 中 | **实现期验收第 1 条**：跑通带图消息；不通则换 vision provider |
| 公网暴露可执行 shell 的 agent | 高（现阶段低） | 内网 demo 先行（已确认）；公网开放前逐项过 §7 |
| APIMart 可用性/成本 | 低 | 按量付费；错误时同令牌重试；轮询与超时参数已有 `.env` 先例 |

## 9. 实现期待办（按序）

1. **验证视觉输入**：DSH 配置带图模型，跑通带图消息（验收第 1 条）；
2. 自写 `docker-compose.yml`：DSH 容器（web + dsh-webapi + mono-color 技能 + MCP 图像服务）+ 网关容器；
3. 网关（Node/TS）：令牌、状态机、频控、WS↔REST/SSE、图片上传/结果下发；
4. 前端（Vite+React+TS）：登录、WS 流、上传、结果预览、修改、确认+满意度；
5. 端到端跑通 §6 流程，含失败重试与断线恢复。

**验收清单**：① 带图消息被模型理解；② mono-color 产出位图（非 prompt-only）；③ 修改循环复用参考图；④ 令牌确认后作废、过期生效；⑤ 任务内二次上传被拒；⑥ 断线重连恢复状态。

## 10. 决策索引

已确认决策见 [ADR-0001](../adr/0001-adopt-dsh-webapi.md)、[ADR-0002](../adr/0002-gateway-is-llm-free-relay.md)、[ADR-0003](../adr/0003-image-gen-via-mcp-in-dsh.md)；术语定义见 [GLOSSARY.md](../../GLOSSARY.md)。
