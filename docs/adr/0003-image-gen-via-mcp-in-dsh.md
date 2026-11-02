# 图像生成在 DSH 内经 MCP 调用 APIMart gpt-image-2

DSH 没有内置文生图/图生图工具（官方工具目录仅有 `read_image` 读图），mono-color-skill 在"宿主无图像生成能力"时只输出 prompt。我们决定在 **DSH 容器内**挂一个小型 MCP 图像服务，由 agent 在技能流程中直接调用 APIMart 的 `gpt-image-2`（`image_urls` 传 base64 参考图实现图生图），而非由网关侧代调。

## Considered Options

- **DSH 内经 MCP 调用（选定）**：与 mono-color-skill 的设计同构——agent 产出 prompt、生成位图、看到结果后进入"修改"循环，全链路在一个会话内闭环；DSH 原生支持 MCP，接入成本低。
- **网关侧调用**：`APIMART_API_KEY` 不进 agent 容器，但技能流程被打断，需要自造"DSH 输出 prompt → 网关生成 → 图回灌 DSH 会话"的协议，修改循环更绕。

## Consequences

- `APIMART_API_KEY` 注入 DSH 容器。该 key 权限仅限图像 API，且容器无敏感数据、出口受限（见调研报告安全清单），风险可接受。
- 图像服务选型与凭据来源：`/work/GPT-Image-Studio/.env` 的 `APIMART_API_KEY` / `APIMART_BASE_URL=https://api.apimart.ai/v1` / `APIMART_IMAGE_MODEL=gpt-image-2`；图生图参考图 ≤15 张、支持 `data:image/...;base64`。
