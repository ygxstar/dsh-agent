# 技能清单只列 DSH 可执行的技能

网关的技能清单（Manifest）原含 `duo-poster`、`text-poster` 两个条目，但 DSH 侧从未安装对应技能，也没有别名映射：`duo-poster` 无源可用，`text-poster` 的"文生图"方向在 DSH 内无对应技能可接。对账（reconcile）长期不匹配，网关降级为静态清单，条目却是死的——前端能选、提交必败。我们决定：**Manifest 只列 DSH 实际可执行的技能**，下线 `duo-poster` 与 `text-poster`。

## Considered Options

- **只列可执行技能（选定）**：清单与 DSH `/skills` 一致，对账可通过，前端所见即所得；产品面收敛为 6 个技能（mono-color + skills/ 下 5 个），全部需要源图。
- **保留条目、标记不可用**：前端要为"禁用态"多做一套渲染与解释，且与"清单仅用于表单渲染与格式校验"的定位相悖。
- **别名映射到近似技能**：`text-poster` 映射到文生图类技能在 DSH 内无解，`duo-poster` 映射会静默改变出图语义——两者都会让提示词语义泄漏进清单。

## Consequences

- 清单条目 = 提交路径；新增技能必须先装进 DSH（或提供别名），再进清单。
- 参考测试中 fake-dsh 的 `duo-poster`/`text-poster` 桩随清单同步移除。
- 前端通用工作台与技能页都只出现 6 个可执行技能；`requiresSourceImage` 全为 `true`。
- 规范见 [docs/gateway-interface.md](../gateway-interface.md)。
