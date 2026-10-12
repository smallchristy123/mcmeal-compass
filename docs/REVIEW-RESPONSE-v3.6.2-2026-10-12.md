# v3.6.2 · 真实限流样本取证与整改（2026-10-12）

> 来源：v3.6.1 复评「仍未闭环三项」之第 1 项（真实限流样本）。
> 授权：主君 2026-10-12 23:50 指示「换一个真样本」。
> 结论：**真实样本已取得**，并据其暴露的缺陷完成整改（`RATE_LIMITED` 分类 + 业务层有界重试 + 文档更正）。

## 一、真实端点实测（`mcp.mcd.cn`，门店 3450021）

**核心事实：限流不走 HTTP 429。**

| 观测 | 结果 |
|---|---|
| 响应状态 | **305 次全部 `HTTP 200`**，**未出现任何 429** |
| 被限形态 | 业务信封 `success=false`、**`code=508`**、`message="太火爆了，请稍后再试"` |
| 触发条件 | **短时突发**即触发；实测首现于并发梯度 12→24 档的**第 62 个请求**（约 2 秒内） |
| 并发档统计（一轮） | 并发 12：40 成功/8 被限；并发 24：42/54；并发 40：150/10 |
| 被限响应耗时 | 中位 ~98ms（**比成功更快**，说明是网关前置拦截） |

> 官方文档另有「每 Token 每分钟最多 600 次」的说法；**本仓库以实测为准**：
> 本轮在 60 秒内并未打满 600 次即已被限，故该「600/分」口径**不宜作为本项目的限流依据**。

**原始证据（可复核，含逐请求时间线与证据哈希）**

| 文件 | 说明 |
|---|---|
| `work/online-evidence/ratelimit-sample-prefix-raw.json` | **修前**首轮（305 次全 HTTP 200，72 次 `BUSINESS_FAILURE`） |
| `work/online-evidence/ratelimit-sample.json` | 修后 A 轮：并发梯度、`maxRetries=0`（见限流即停） |
| `work/online-evidence/ratelimit-retry-sample.json` | 修后 B 轮：并发梯度、`maxRetries=2` |
| `work/online-evidence/serial-attribution.json` | 修后 C 轮：**串行基线**（用于精确归因） |

## 二、据此暴露的缺陷（均在执行方）

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | `rpcOnce` 只把 **HTTP 429** 判为 `RATE_LIMITED` | 真实限流（HTTP 200 + 508）**完全判不到** |
| 2 | 业务失败一律映射为 `SERVER_ERROR`（`retryable=false`） | **不退避重试**；且计价层 `isRateLimited()` 的「限流即停」**永不触发**（形同虚设） |
| 3 | `MCP_INTEGRATION.md` 写「超限返回 `429`」 | 与实测不符，会误导后续实现与评审 |
| 4 | `DEFAULT_HINTS.RATE_LIMITED` 写「已做退避重试」 | 在业务层限流下**是句空话**——业务校验位于 `rpc()` 重试循环之外，HTTP 层重试**根本看不到它** |

> 附带发现（探针自身）：首版探针在中断时「先 `break` 后 `record`」，同一批未记录的请求已发出，
> 导致「`tools/call` 总数 − 业务调用数」虚高（曾被误读为 12 次重试）。**已修正为先全部入账、再判中断**，
> 修正后与串行基线一致（额外 = **0**）。

## 三、五要素对账

### ① 反例
同一门店、同一商品，并发 24 档下第 62 个请求起开始被限：
业务信封 `success=false, code=508, message="太火爆了，请稍后再试"`，**HTTP 状态 200**。
修前该失败被抛成 `SERVER_ERROR`（不可重试），**既不会退避、也不会触发止损**。

### ② 修改
| 文件 | 改动 |
|---|---|
| `src/toon.ts` | `ToonParseError` 新增 `businessCode`；`unwrapMcpEnvelope` 在业务失败时把信封 `code` 带出 |
| `src/mcp-client.ts` | 新增 `RATE_LIMIT_BUSINESS_CODES = {508}`（含实测出处注释）与文案兜底正则；`McpError` 新增 `businessCode`；新增 `toBusinessFailure()` 把「业务码/文案命中限流特征」的失败**升格为 `RATE_LIMITED`（可重试）**；**新增 `callToolEnvelope()`**：把业务校验放进**有界退避重试循环**，使「可重试」名副其实 |
| `src/pricing.ts` | `PriceReceipt` 新增 `businessCode`（两处收据构造同步写入）——限流证据可结构化留痕 |
| `src/cli.ts` | 在线计价收据同步写入 `businessCode` |
| `MCP_INTEGRATION.md` | §1 限流/错误码两行改为**实测形态**，并加更正说明 |
| `tests/v362-reallimit.test.ts` | 新增 11 条回归（分类/重试次数/非限流不重试/文案兜底/429 不回退/采集路径） |

### ③ 实际入口
`McpClient.callTool / callToolRaw → callToolEnvelope → toBusinessFailure`；
计价层 `confirmPrices → isRateLimited(receipt.errorCode)` 的止损自此**真正可达**。

### ④ 通过日志
`npm run gate` **327 用例全绿**（316 + 新增 11）；类型干净；夹具一致；离线可跑。
真实端点对照（同一门店、同一商品）：

| 跑法 | 业务调用 | 成功 | 失败 | 额外 `tools/call`（重试） | 客户端分类 |
|---|---:|---:|---:|---:|---|
| **A** 并发 · `maxRetries=0` | 73 | 62 | **11** | **0** | **全部 `RATE_LIMITED`（业务码 508）** |
| **B** 并发 · `maxRetries=2` | 305 | **305** | **0** | **80** | 无对外失败 |
| **C** 串行基线 · `maxRetries=0` | 30 | 30 | 0 | 0 | — |

→ 不重试：15%（11/73）请求对外失败；开重试：**80 次重试全部吸收，0 对外失败**。

### ⑤ 适用范围
全部 MCP 工具调用（`calculate-price` 及其他同信封工具）；离线夹具不受影响（不经此路径）。
**取值不变**：改的是**错误分类、重试与文档口径**，不改任何业务数值。

## 四、仍未闭环（2 项，均超出执行方单方能力）

1. **第三方独立在线复核** —— 在线 JSON 为执行方留档，需复评方自行请求真实端点；
2. **A 级在线分布** —— 需下一次独立真实端点复核确认，不能只引用执行方自留证据。
