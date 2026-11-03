# 收货码仅做领取，登录令牌仍是唯一登录凭证

商户接单后签发令牌并生成订单绑定的收货码，发货时把收货码交给客户；客户持码登录前端执行一个或多个生图任务。我们决定：**收货码只用于"领取"**——客户先经 `POST /redeem` 凭码换回该订单的令牌列表，之后仍用既有令牌走 `auth` 逐任务登录；收货码不进入 WS 协议。

## Considered Options

- **收货码仅做领取（选定）**：令牌仍是唯一登录凭证（GLOSSARY 无需改），WS 协议零改动；一单 N 个任务 = N 条独立 WS，断线恢复互不影响，前端自行聚合"码 → 令牌列表"视图。
- **收货码直登 WS**：一条连接承载订单下所有任务——`auth`、`state`、`command`、`error` 全线要加 `taskId` 路由，协议重设计，收益只是少几条连接。
- **双凭证并行**：码与令牌都可直登——两套校验路径与错误码，边界含糊。

## Consequences

- 一次性语义分层：**令牌**一次性（用一次即废），**收货码**可复用（有效期内可重复领取，单码领取限频）；码过期/吊销联动作废未使用令牌。
- 码本身错误/过期/吊销对应 `REDEEM_INVALID / REDEEM_EXPIRED / REDEEM_REVOKED` 确定性拒绝路径。
- 签发 API 返回 `{ redeemCode, expiresAt, tokens: [{token, taskId}] }`；订单只以不透明 `orderRef` 存在，业务语义留在商户侧。
- 规范见 [docs/gateway-interface.md](../gateway-interface.md)，场景见 [docs/use-cases.md](../use-cases.md)。
