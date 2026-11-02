# 采用 toddpan/dsh-webapi 第三方插件作为 DSH 的 HTTP API 层

网关需要通过 HTTP 驱动 DSH。我们决定直接采用第三方插件 [toddpan/dsh-webapi](https://github.com/toddpan/dsh-webapi)（注意：task.md 中的 `oddpan` 为笔误），而非自研 API 层或走 DSH 原生 headless/SDK 模式。

## Considered Options

- **toddpan/dsh-webapi（选定）**：80+ REST/SSE 路由，覆盖会话、流式、技能、文件上传、OpenAI 兼容接口，内置 OpenAPI spec；与 DSH 同为 TypeScript，`dsh plugin` 一条命令安装。
- **自研薄封装**：功能上只是重复 dsh-webapi，且同样依赖 DSH 运行时注入，绕不开相同的权限面。
- **DSH 原生 `dsh headless` / `dsh sdk`**：无常驻 HTTP 服务与流式会话管理，需要自己实现进程生命周期、会话恢复与文件上传，工作量最大。

## Consequences

- 该插件第三方安全评级为 C3（执行系统命令、起网络服务、读凭证类环境变量）。缓解：只绑 `127.0.0.1`/容器内网、强制 API key、admin-token 不外露、DSH 容器不注入敏感环境变量（见调研报告安全清单）。
- 插件版本须匹配 DSH `0.1.0`–`0.2.x`；DSH 升级时需同步验证插件兼容性。
