# v3 整改对账（2026-10-12）

对象：《McMeal Compass v2 复评与执行建议》（外部评审，含独立反例脚本）
＋《v3 交办与复验包》（第三方独立复核出具，附验收脚手架 `mcmeal-v3-acceptance-harness.mjs`）

本文件是**执行方的逐条对账**。每条按评审要求的**五要素**给出：
**① 问题反例 ② 对应修改 ③ 实际入口 ④ 通过日志 ⑤ 适用范围**。
凡只做到一部分的，写「**部分完成**」，不提前关单。

复现命令（本机 Node 24.14.0，Windows）：

```powershell
npm run gate                                       # 夹具校验 → 测试 → 类型 → 离线可跑
node <验收脚手架> <项目目录>                        # 期望 10/10 PASS、exit 0
```

本轮实测：**`npm run gate` 全过（264 用例）**；**验收脚手架 R1–R10 全部 PASS（10/10，exit 0）**。

---

## 一、第一批：硬条件不可绕过、错误不得变成功

### A / R1 —— 折扣回补绕过最低蛋白

| 要素 | 内容 |
|---|---|
| ① 反例 | 预算 ¥35、最低蛋白 25g；唯一商品菜单价 ¥40、蛋白 1g、官方报价 ¥20 |
| ② 修改 | `constraints.ts` 重排为「**非价格硬条件先验** → 菜单价预筛」；新增 `checkNonPriceConstraints()` 作为**唯一**判定入口；`recommend.ts` 的回补池（菜单价超预算者）在计价后**再过同一函数**，被否者记账说明 |
| ③ 实际入口 | `applyHardConstraints()`（主池与回补池的同一入口）、`recommendForMenu()`（回补后复验） |
| ④ 通过日志 | 脚手架 **R1 PASS**；单测 `tests/v3-acceptance.test.ts` →「唯一候选蛋白不达标、即使官方价更低，也不得生成推荐」「低价不得让低蛋白方案冒出来」 |
| ⑤ 适用范围 | 最低蛋白、避糖、正餐范围三项**非价格条件**；价格下降/回补/报价失败/替换组成任一情形下均成立。**不含**价格条件本身（价格条件仍由报价决定，这是设计意图） |

### B / R2 —— 已匹配的含普通可乐组件逃过避糖

| 要素 | 内容 |
|---|---|
| ① 反例 | `--offline --budget 35 --avoid-sugary --json` 仍推荐「鱼牛汉堡四件套随心选」（证据含「可乐中杯」） |
| ② 修改 | `analyze.ts` 新增**结构化组件** `AnalyzedItem.components`（轮次/选项/是否匹配到营养/匹配方式/数量），套餐展开时写入；`constraints.ts` 新增 `assessSugary()`，按组件判定并**三态分类**：`sugary` / `sugar-free` / `unknown`；**未知的疑似饮品组件**（未匹配到营养）判为「不满足避糖」而不是放行 |
| ③ 实际入口 | `analyzeCombo()`（写入组件）→ `checkNonPriceConstraints()`（判定）→ CLI `--avoid-sugary` |
| ④ 通过日志 | 脚手架 **R2 PASS**；单测：离线避糖方案中无「可乐中杯」、`零度可乐`/`雪碧纤维+` 不误杀、未核实饮品组件判 `unverified` |
| ⑤ 适用范围 | 单品与套餐**同一套语义**；只对「显式开启避糖」时生效。**已知局限**：判定基于**名称语义**（官方未提供配料表），因此「名称上看不出含糖」的含糖商品仍可能漏判——这一点在 CLI 与 README 中均未作过度承诺 |

### D / R8 —— 显式失败被当成成功价格

| 要素 | 内容 |
|---|---|
| ① 反例 | 注入 `result.isError=true`、业务 `success=false`、`data.price=0`、空清单 → 客户端仍返回正常价格对象 |
| ② 修改 | `mcp-client.ts` 把 `callTool` 拆为 `callToolText()` + 分层校验：**工具级 `isError` → 业务级 `success/code`**（`toon.ts` 新增 `unwrapMcpEnvelope()`，`success===false` 或 `code>=400` 即抛 `BUSINESS_FAILURE`） |
| ③ 实际入口 | `McpClient.callTool()` / `calculatePrice()`（故所有业务封装一并受控） |
| ④ 通过日志 | 脚手架 **R8 PASS**；单测：「工具 isError ⇒ 抛错」「业务 success=false ⇒ 抛错」「正常响应仍可解析（不误伤）」 |
| ⑤ 适用范围 | 所有经客户端的工具调用。HTTP/JSON-RPC 层此前已校验；本轮补的是**工具级与业务级**两层 |

### D / R9 —— 空清单 ¥0 被当作「官方已核实」

| 要素 | 内容 |
|---|---|
| ① 反例 | 对非空购物篮提供 `productList: []` ＋ `price: 0` 的报价 → 被标 `verified=true` |
| ② 修改 | `pricing.ts` 新增 `verifyQuoteBasket()`：请求与响应的**商品码与数量逐项核对**（`matched` / `empty-response` / `mismatch`）；未通过者**不采纳该金额**并标「未核实实付」 |
| ③ 实际入口 | `confirmPrices()`（初次确认）与 `requoteFinal()`（最终复核）**同一函数** |
| ④ 通过日志 | 脚手架 **R9 PASS**；单测：空清单 ¥0 不算已核实、对象对得上的 ¥0（赠品）**照常采纳**、商品码不符标未核实 |
| ⑤ 适用范围 | **合法 0 元仍受支持**（补的是核实条件，不是禁 0 元）。**已知局限**：真实端点若恒不返回 `productList`，则一律降级为「未核实」——本轮未在线验证该分支（见「遗留」） |

---

## 二、第二批：统一组成与报价对象、接最终验证、重算评分、生成真实收据

### C / R3 —— 最终复核未接入主流程

| 要素 | 内容 |
|---|---|
| ① 反例 | 首次报价 ¥20、复核预设 ¥40、预算 ¥35 → 只调用计价器一次，仍展示「预算内 ¥20」 |
| ② 修改 | `recommend.ts` 新增 `finalizeWithRequote()`：对**每个入选方案**调用 `requoteFinal()`；变价后**重算预算/评分/解释**；复核后超预算者**撤下**并写明原因 |
| ③ 实际入口 | `recommendForMenu()`（第 ⑤ 步）——即 CLI 与 Skill 真正走的那条路 |
| ④ 通过日志 | 脚手架 **R3 PASS**（观测 `calls: 2`）；单测：「必须真的执行最终复核」「复核后不得继续以旧价出现」 |
| ⑤ 适用范围 | 所有入选方案。**注**：复核采用「强制绕过旧价缓存」方案（评审允许的二择一之一），收据 `stage=final` 与组成指纹可核对 |

### C / R4 —— 复核丢组件与数量

| 要素 | 内容 |
|---|---|
| ① 反例 | 传 `A×2 + B×3` 实际只把 `list[0].productCode` 交给计价器（收据 `A×1`） |
| ② 修改 | 引入 **`PriceRequest`**（`items` + `composition` + `fingerprint` + `stage`），`Pricer` 契约扩展为 `(item, request?)`；`requoteFinal()` 的收据由**本次请求**生成（完整清单 + 阶段 + 指纹） |
| ③ 实际入口 | `requoteFinal()`、`confirmPrices()`、CLI 计价器的**缓存键**（含指纹：组成变→键变） |
| ④ 通过日志 | 脚手架 **R4 PASS**（`receipt: items=[A×2,B×3]`）；单测断言收据含完整清单、`stage=final`、带指纹 |
| ⑤ 适用范围 | 全部报价。**套餐按官方契约整体报价**（不拆件相加）；组件与数量进入**指纹与缓存标识**，并在收据留痕 |

### E / R5 —— 评分用旧菜单价

| 要素 | 内容 |
|---|---|
| ① 反例 | A 菜单 ¥10/官方 ¥30、B 菜单 ¥20/官方 ¥5 → 预算卡选对了 B，但 B 的价格分为 0 |
| ② 修改 | `score.ts` 新增 `PriceResolver`（默认菜单价，向后兼容）；`buildScoreContext` / `scoreItem` 接受取价器；`recommend.ts` 用**实付价索引**统一供给预算判定、归一化、帕累托、性价比与对比句 |
| ③ 实际入口 | `buildRecommendation()` / `finalizeWithRequote()` → `scoreItem(...)`、`paretoFront(...)`、`comparePlans(...)` |
| ④ 通过日志 | 脚手架 **R5 PASS**（B 的 `budgetScore = 1`）；单测「菜单价顺序与官方价相反时，价格分随实付变化」 |
| ⑤ 适用范围 | 本轮推荐的全部价格相关输出。菜单价**保留为原始证据**（`item.price` 未被覆盖），来源混淆不再发生 |

### F / R6 —— 回执虚报调用次数

| 要素 | 内容 |
|---|---|
| ① 反例 | 完全离线却显示「本次共发起 29 次官方计价请求」（统计的是 `pricer` 调用数） |
| ② 修改 | `PriceReceipt` 增 `channel`（`live`/`cache`/`offline`/`not-attempted`）；新增 `summarizeReceipts()` 分别统计**候选评估 / 离线读取 / 缓存命中 / 真实请求 / 未发起 / 成功 / 失败 / 重试** |
| ③ 实际入口 | `confirmPrices()` 的 notes；CLI 计价器按渠道标注；离线计价器标 `offline` |
| ④ 通过日志 | 脚手架 **R6 PASS**（离线 → `本次共发起 0 次真实官方计价请求（候选 15 项；离线读取 15；…）`）；单测同断言 |
| ⑤ 适用范围 | 全部报价回执。**注**：`maxRequests` 仍按**业务调用次数**计（不是 HTTP 尝试数），已在回执中分列，未混为一谈 |

### F / R7 —— 离线溯源虚构成功调用

| 要素 | 内容 |
|---|---|
| ① 反例 | 离线推荐的工具轨迹仍写 `query-meals: ok=true` |
| ② 修改 | 轨迹改由**取数方**产生：`AnalyzedItem.sourceTrace`（`DataSourceReceipt[]`，含 `channel`/`ok`/`at`/`argsSummary`/`errorCode`/`snapshotId`）；`explain.ts` 的 `buildToolCallTrace()` **只引用**，无收据就不写 |
| ③ 实际入口 | `analyzeMenu({ source })`（CLI 传入 `live` / `offline` + 快照 id）→ `explainPlan()` |
| ④ 通过日志 | 脚手架 **R7 PASS**；单测：离线轨迹不得有 `ok:true`，且 `channel === 'offline'` |
| ⑤ 适用范围 | 全部解释输出。在线模式如实记 `live/ok:true`；无来源信息的历史条目不再伪造 |

---

## 三、第三批：收窄只读入口 + 工程健壮性

### G / R10 —— `--priority` 不改变结果（**取甲案**）

| 要素 | 内容 |
|---|---|
| ① 反例 | 同一输入分别 `--priority budget / protein / balance`，三次方案 code 顺序与分数**完全相同** |
| ② 修改 | 甲案：`priority` **决定首选**——`plans[0]` 即该视角选出的方案，并在结果中给出 `primaryKey` 与如实说明 `primaryNote`；CLI 首卡标「（首选）」 |
| ③ 实际入口 | `buildRecommendation()` → `Recommendation.primaryKey/primaryNote` → CLI 文本与 JSON |
| ④ 通过日志 | 脚手架 **R10 PASS**；单测**三组反向输入**（`budget` 与 `protein` 首选不同，且 `plans[0].key` 与偏好一致） |
| ⑤ 适用范围 | 三种偏好。**产品契约**：三个视角仍全部展示（对照用），偏好只改变**首选与顺序**——已在 CLI/README 写明，不暗示「过滤掉了其他视角」 |

### 正餐候选范围

| 要素 | 内容 |
|---|---|
| ① 反例 | ¥5、93 kcal、蛋白 2g 的圆筒冰淇淋作为「预算优先」方案出现 |
| ② 修改 | 新增 `MealScope`（默认 `main-meal`）与 `isNonMealItem()`：按**可解释的名称/分类关键词**排除甜品/冰饮/饮品；CLI 新增 `--scope meal|all` |
| ③ 实际入口 | `checkNonPriceConstraints()` → `--scope` |
| ④ 通过日志 | 实机入口日志（`outputs/mcmeal-v3-entry-evidence-*.log`）：默认模式首选为「人气超值四件套」，`--scope all` 时才出现「圆筒冰淇淋」 |
| ⑤ 适用范围 | 仅推荐模式的候选池；概览模式不受影响。**未引入医学热量下限**（评审也提示不宜由评审擅自加入） |

### P1-4 新鲜度（JSON + 分数据源 + 时区与未来边界）

| 要素 | 内容 |
|---|---|
| ① 反例 | 文本有 freshness，**JSON 没有**；四类数据共用一个时间戳 |
| ② 修改 | `fixtures.ts` 分别读取**菜单/营养/门店/套餐/价格**的 `datetime`；`cli.ts` 新增 `freshnessReport()` 并同时进入两种 JSON 出口；`freshness.ts` 增 `parseCapturedAt()`（无时区按 +08:00 解读并标注 `timezoneAssumed`）与**未来时间判 `unknown`** |
| ③ 实际入口 | `--json` 的 `freshness.sources.{menu,nutrition,combo-detail,price}` |
| ④ 通过日志 | 单测三条（时区解读、fresh/stale、未来时间 ⇒ unknown）；入口日志可见 `timezoneAssumed = true` |
| ⑤ 适用范围 | 离线与在线（在线按本次调用时刻记账）。TTL 仍为产品保守值（价格 10 分钟） |

### P1-5 措辞

| 要素 | 内容 |
|---|---|
| ① 反例 | 无热量目标却输出「热量更多，此项更优」；降级菜单价时仍写「实付最低」 |
| ② 修改 | `explain.ts` 增 `ExplainOptions`：无热量目标时热量对比**中性化**（只报数值）；`recommend.ts` 的 `budgetReason()` 按来源分支——未核实只写「**菜单价最低**（实付未核实）」 |
| ③ 实际入口 | `explainPlan()` / `comparePlans()` / `budgetReason()` |
| ④ 通过日志 | 单测：「无目标时中性化」「未核实不得声称实付最低」；入口日志实测句式为「未设该目标，仅报数值、不作优劣判断」 |
| ⑤ 适用范围 | 解释层全部对比句与方案理由 |

### 采集路径保护（`capture-fixtures.ts`）

| 要素 | 内容 |
|---|---|
| ① 反例 | `startsWith(root/fixtures)` 大小写敏感（Windows 变体可绕过）；校验排在**读凭据与网络之后**；目录名仅到分钟（同分钟重采会覆盖） |
| ② 修改 | 抽出 `src/capture-guard.ts`：规范化 + **大小写不敏感** + **按路径段**判断（`fixtures*`、`.git`、仓库外一律拒）；校验**前置于读凭据与网络**；runId 含秒与短随机串，且**目标目录已存在即拒** |
| ③ 实际入口 | `scripts/capture-fixtures.ts` 顶层（先校验后连接） |
| ④ 通过日志 | 单测三条：`fixtures`/`Fixtures`/`FIXTURES`/`Fixtures-extra` 均拒、仓库外拒、`work/captures/*` 允许 |
| ⑤ 适用范围 | 采集脚本。**注**：`fixtures*` 前缀一并拒绝属**从严**选择（宁多拒一个合法目录，不留绕过口） |

### 探针复用

| 要素 | 内容 |
|---|---|
| ① 反例 | `capture`、`check:combo` 自建 fetch 与握手——脚本跑通不代表**应用入口**通 |
| ② 修改 | 新增 `McpClient.callToolRaw()`（保留原始文本，同时过同一套 `isError`/业务校验）；两个脚本改为复用 `McpClient`（同一套协议形态、会话与错误分类） |
| ③ 实际入口 | `scripts/capture-fixtures.ts`、`scripts/check-combo-decomposition.ts` |
| ④ 通过日志 | 类型检查通过（脚本随 `tsc` 一并检）；**本轮未实跑在线采集**（需 Token，见「遗留」） |
| ⑤ 适用范围 | 两个在线脚本。**部分完成**：未能在真实端点复跑一次以证明端到端一致 |

### 版本协商（legacy `initialize`）

| 要素 | 内容 |
|---|---|
| ① 反例 | 回执写「版本协商」，但代码从不检查服务端返回的 `protocolVersion` |
| ② 修改 | `initialize()` 按三态如实记录：`agreed` / `server-different`（记下服务端版本，**不静默改口径**）/ `not-returned`；`describeProtocol()` 一并暴露；「不支持」态由既有 `-32022` 分支负责 |
| ③ 实际入口 | `McpClient.initialize()` / `describeProtocol()` / 采集脚本首行 |
| ④ 通过日志 | 单测三条（一致 / 不同 / 未回）；附：本地协议集成测试（`tests/protocol.test.ts`）仍全绿 |
| ⑤ 适用范围 | legacy 路径；modern 路径无握手，`protocolNegotiation` 记 `not-returned` |

---

## 四、遗留与「部分完成」（不提前关单）

| 项 | 状态 | 说明 |
|---|---|---|
| **真实案例（≥3 个有差异）** | ⏳ **待执行** | 需真实 Token 与门店；本轮只提供**离线夹具经真实应用入口**的脱敏输出（`outputs/mcmeal-v3-entry-evidence-*.log`）。不做「脚本成功」冒充「入口成功」 |
| **人工审核 35 条判定** | ⏳ **待主君** | 抽样表与汇总工具已就绪（`docs/HUMAN_REVIEW.md`、`npm run review:samples`）；**判定须人做**，不代劳、不以机器测量冒称准确率 |
| **报价对象核对在真实端点上的表现** | ⚠️ **未在线验证** | 若官方对某些商品不回 `productList`，将一律降级为「未核实」——这是**保守选择**，但需一次真实调用确认影响面 |
| SKILL.md / 可安装入口 | ⏳ 未做 | 本轮聚焦已承诺功能的正确性；未新增功能交付物 |
| secrets scan 证据 | ⏳ 未做 | 仓库从未提交 Token（`.gitignore` + 环境变量）；扫描证据待补 |
| modern 形态真实端点验证 | ⏳ 未做 | 对外仍只声明「legacy 已实测」 |

---

## 五、一句话结论

**评审指出的六组业务错误，本轮已逐条修到「用户真的走得到」的位置**：
非价格硬条件统一先验、避糖看组件、最终复核真接线、评分随实付价、报价对象核对、回执只算真实请求；
`--priority` 已按甲案生效，入口收窄为「正餐候选 + 显式 `all`」。
`npm run gate` 264 用例全绿，验收脚手架 **10/10 PASS**。
**仍不应视为「验收通过」**：真实案例、人工审核与在线端验证尚未完成。

---

## 六、v3 复审（R11–R13）的整改 · 2026-10-12 追加

复审来源：《McMeal Compass V3 高要求复审报告》＋补充探针 `mcmeal-v3-additional-probes-2026-10-12.mjs`。
复审结论为「代码与离线测试大体通过，生产验收暂缓（Hold）」，新增三项阻断：**R12 为 P0，R11/R13 为 P1**。

复跑结果（本机，Node 24.14.0）：**R11/R12/R13 全部 PASS**；R1–R10 仍 10/10 PASS；`npm run gate` **279 用例全绿**。

### R12（P0）· 最终复核失败仍渲染「官方已核」

| 要素 | 内容 |
|---|---|
| ① 反例 | 初次报价 ¥20；最终复核 TIMEOUT → 仍输出 `priceSource=official`、`verified=false`，解释句写「官方计价实付 ¥20.00（含优惠与费用，**已核**）。」 |
| ② 修改 | `pricing.ts` 引入**三态来源** `PriceSource = official \| menu \| official-unverified`；`applyRequote` 在复核未通过时**不得**回退成 `official`（沿用初次金额者降为 `official-unverified`）；`explain.ts` 的价格句与证据标签**同时检查来源与 `verified`**，未核实一律不得出现「已核」，并明写「初次官方报价；最终复核未成功——未核实，不代表当前实付」；`cli.ts` 同步三分支标注 |
| ③ 实际入口 | `applyRequote()` → `explainPlan()/collectEvidence()` → CLI 文本 |
| ④ 通过日志 | 探针 **R12 PASS**（`priceSource=official-unverified`、`verified=false`、句中无「已核」）；回归测试 4 条（TIMEOUT / BAD_RESPONSE / SERVER_ERROR / 抛错）+ 正向 1 条（成功仍写「已核」） |
| ⑤ 适用范围 | 全部报价展示与解释。**取值不变**：仍沿用初次金额作参考，改的是**来源与措辞的如实性** |

### R11（P1）· 首选方案被淘汰后元数据失真

| 要素 | 内容 |
|---|---|
| ① 反例 | 最终复核撤下 budget 方案后：`plans=[protein]` 但 `primaryKey='budget'`、`primaryNote` 仍称「首选即按该偏好选出」 |
| ② 修改 | `finalizeWithRequote` 在过滤后**重算** `primaryKey`（原偏好仍在则保持；已被撤下则降级为实际第 1 张）、**重排展示顺序**使第一张恒等于 `primaryKey`、重写 `primaryNote`（明写「降级」）与 `shortfallNote`，并在推导过程留「首选降级」记录 |
| ③ 实际入口 | `recommendForMenu() → finalizeWithRequote()` → `Recommendation.primaryKey/primaryNote` → CLI/JSON |
| ④ 通过日志 | 探针 **R11 PASS**（`plans[0].key === primaryKey`）；回归测试 3 条（首选被撤 / 非首选被撤 / 全部被撤） |
| ⑤ 适用范围 | 最终复核存在淘汰的所有情形。**注**：三个视角仍全部展示，偏好只决定首选与顺序 |

### R13（P1）· 详情失败未写入真实失败收据

| 要素 | 内容 |
|---|---|
| ① 反例 | 注入抛 TIMEOUT 的详情加载器 → `sourceTrace` 只有 `query-meals ok=true`，**没有** `query-meal-detail` 的失败记录（收据是按 `live` 上下文合成的） |
| ② 修改 | 收据改为**在实际调用点产生**：`analyzeMenu` 在调用 `loadDetail` 处按真实结果写 `query-meal-detail` 收据，区分**成功 / 空详情（`EMPTY_DETAIL`）/ 抛错（`DETAIL_LOAD_FAILED` 或原错误码）**；收据新增 `stage`（menu/nutrition/combo-detail）与 `requestId`（可关联），`argsSummary` 含**实际餐品 code**（门店码脱敏）；`options.sourceReceipts` 允许取数方注入其在真实调用点产生的菜单/营养收据（`cli.ts` 离线=OFFLINE_FIXTURE、在线=live 均已接入）；**离线/历史的成功展开也不得记 `ok:true`** |
| ③ 实际入口 | `analyzeMenu()`（调用点）→ `AnalyzedItem.sourceTrace` → `explainPlan()`；`cli.ts` 离线/在线两条取数路径 |
| ④ 通过日志 | 探针 **R13 PASS**；回归测试 5 条（成功 / 空详情 / TIMEOUT / 解析错误 / 离线不得记成功），并断言**收据数量与实际调用次数相符** |
| ⑤ 适用范围 | 全部取数轨迹。**已知边界**：单一候选未展开时不会有 detail 收据（因为确实没调用详情） |

### 复审次要项

| 项 | 处置 |
|---|---|
| 最终复核的请求未计入回执（低报） | `recommendForMenu` 在复核后**合并**初始与最终收据并重算 `summary`，替换「本次共发起…」条目 |
| 离线未发起被计入「失败」 | `RequestSummary` 拆为 `attemptedFailures` / `offlineNotInitiated` / `skippedByBudget`，并注明「**未发起不等于失败**」 |
| 包内缺 acceptance harness 与哈希清单 | 交付包改为**自包含**：内含 `mcmeal-v3-acceptance-harness.mjs`、`mcmeal-v3-additional-probes-2026-10-12.mjs`、两组结果与 **`SHA256SUMS.txt`** |
| 上轮对本机 npm 的判断有误 | 本轮实测 `npm 11.9.0` 可用，`npm run gate` 全过；不再引用「无 npm」作为风险 |

---

## 七、人工审核（2026-10-12 · **AI 辅助复核预填，待主君确认**）与随之而修的误配

复审把「35 行人工核对表」列为解除 Hold 前的必办项。该表已由 **AI（尼可·莱恩）辅助复核预填** 35 条判定，
本项目的规则修正即据其 3 条 `diff` 推导而来；但 **AI 预填 ≠ 主君亲判**（v3.2 复评指出，
表内 `审核人` 字段原文为「尼可·莱恩（AI辅助复核，待主君确认）」）。
故本节结论仅为「**预填结果**」——**人工审核门槛保持未闭环**，直到主君逐行确认并在表内签字。

### 7.1 审核结果

- 判定分布：**一致 18 / 误配 3 / 无法判 14 / 未填 0** → 对可判定项精确率 **85.7%（18/21）**；
- 分层：单品·精确 100%（8/8）、饮料 100%（4/4）、别名（可判定 1/1）、**套餐·展开求和 62.5%（5/8）**；
- 14 条「无法判」中，**11 条经 AI 预填确认为"机器正确拒绝"**（份量 3／口味 3／新品 4／非食品 1），
  3 条为"别名推断但份量证据不足"——**不计入精确率分母**，避免用"空"抬高精确率。
- 明细与口径见 `docs/HUMAN_REVIEW.md`「审核结果」；已填表 `outputs/人工审核样本-2026-10-11-已填-2026-10-12.csv`。

### 7.2 误配（3 条）与根因

| # | 套餐 | 机器给出的合计 | AI 预填判定（**待主君确认**） |
|---|---|---|---|
| 13 | 龙焰芝士棒鸡腿堡三件套 | 436 kcal | 仅＝中薯条 + 可乐，**汉堡本体未收录** |
| 16 | 枫糖风味厚松饼猪柳蛋堡三件套 | 161 kcal | 仅＝脆薯饼 + 小杯鲜萃咖啡，**主件未收录** |
| 19 | 龙焰鸡腿堡四件套 | 606 kcal | 仅＝中薯条 + 麦乐鸡4块 + 可乐，**汉堡本体未收录** |

**取证**：全快照扫描 → **20 个套餐中 7 个**存在主件未收录（「龙焰」「枫糖松饼」两个新品系列）。
根因：套餐展开后主件未命中营养表时，系统仍给出「已知部分之和」（标 `≥`、降 C 级）。
**C 级虽已挡住 A/B，但数字本身会误导**（436 vs 含汉堡的真实值）。

### 7.3 处置（v3.2）

| 要素 | 内容 |
|---|---|
| ① 反例 | 上表三条：主件缺失时合计低到不具代表性，`≥` 标记不足以抵消 |
| ② 修改 | `analyze.ts` 新增**主件识别**（汉堡/主食/主餐/堡/卷/饭/面/披萨，且**非食品周边不计入**）：主件未收录 ⇒ **不提供营养数字**（关键字段 null）并**降为 D 级**，notes 写明「主件未收录」；导出 `isStapleComponent()` 供测试 |
| ③ 实际入口 | `analyzeCombo()` → `AnalyzedItem.totals/confidence` → 推荐（D 级自动不进推荐）与展示（无数字） |
| ④ 通过日志 | `tests/human-review-2026-10-12.test.ts` **5 条全绿**（含全快照不变量）；`npm run gate` **295 用例全绿**；R1–R10 仍 10/10、R11–R13 仍 3/3；离线演示仍为三方案（均 B 级） |
| ⑤ 适用范围 | 套餐；单品不受影响。**已知影响面**：快照内 7 个套餐由「C 级有数字」变为「D 级无数字」（均为新品主件未收录），其余 13 个套餐不受影响 |

> 附带说明：这三条**不是别名问题**，故未改 `aliases.ts` 禁配条目；
> 处置落在「匹配/展示规则」，与 `docs/HUMAN_REVIEW.md` 的要求（落禁配或改规则）一致。
