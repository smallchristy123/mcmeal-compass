# McMeal Compass v3.3 · 复评（R11–R13 + 证据身份 + 外部证据）逐条对账

对账日期：2026-10-12（Asia/Shanghai）
本轮对应：《McMeal Compass v3.2 高要求复评报告》（2026-10-12 16:05，下称「复评」）
上一轮：`e8d82fd`（v3.2）→ 本轮修复提交见文末

---

## 一、复评「必须修复」三项

### ① 真实 CLI 会吞掉详情请求的原始错误（P1/P2）

| 要素 | 内容 |
|---|---|
| ① 问题反例 | CLI 的 `loadDetail` 在请求失败时 `catch { set null }`，把**超时 / HTTP / 解析**错误一律抹成「没有详情」；上层只能记 `EMPTY_DETAIL`，**原始错误码与消息全丢**。R13 探针之所以通过，是因为它直接注入了会抛错的 loader——**绕过了这条真实路径**。 |
| ② 对应修改 | 新增 `src/detail-loader.ts`：`createDetailLoader()` **失败即抛出** `McpError`（保留 `code`/`message`/`status`），并缓存「成功 / 失败」两态——命中失败缓存时**重放同一次错误**（不重复请求）。`cli.ts` 改用它（删掉原 `catch → null`）。 |
| ③ 实际入口 | `cli.ts::loadFromOnline` → `createDetailLoader(client, storeCode)` → `analyzeMenu` 的 `try/catch` → `detailReceipt(..., err.code, err.message)` |
| ④ 通过日志 | `tests/v33-review-regression.test.ts` **5 条**：超时 / HTTP(502) / 解析三类失败各自保留原始码与消息；缓存命中不重复请求且重放同一错误；成功与「真实空结果」如实返回。`npm run gate` **295 用例全绿**。 |
| ⑤ 适用范围 | 所有在线详情加载。**文案不变**：失败仍降级为单品直配，改的是**错误原貌不再被抹平**。 |

### ② 混合轮次名称会误判小食为主件（P1/P2）

| 要素 | 内容 |
|---|---|
| ① 问题反例 | `isStapleComponent` 同时匹配 `roundName` 与 `choiceName`，故 `('选择主食/小食','中薯条')` 返回 `true`——**混合轮次里的小食被当成主件**，一旦该小食未收录，整单被降 D、营养数字被清空（误伤）。 |
| ② 对应修改 | **优先按 `choiceName` 判定**；仅当选项名不是主件、且轮次名**不含**「小食/配菜/饮品」并列项（新增 `MIXED_ROUND_RE`）时，才用 `roundName` 兜底。同时补主件词表（巨无霸 / 麦香鸡 / 麦香鱼 / 鸡排）。 |
| ③ 实际入口 | `analyze.ts::isStapleComponent()` → `analyzeCombo()` 的「主件未收录」判定 |
| ④ 通过日志 | 回归断言复评给出的四条：`('选择主食/小食','中薯条')=false`、`(…,'麦乐鸡4块')=false`、`(…,'巨无霸')=true`、`('小食','中薯条')=false`；另加组合层面两条——**缺小食保持部分结果（不整单 D）**、缺主件仍降 D。 |
| ⑤ 适用范围 | 套餐展开。**已知边界**：轮次名本身含「主食」且**不含**任何并列词的（如「选择汉堡」）仍走 roundName 兜底——这是有意的。 |

### ③ 公共分析 API 会合成不存在的 live 成功回执（P2）

| 要素 | 内容 |
|---|---|
| ① 问题反例 | 调用方传 `source.channel='live'` 但未传真实收据时，`synthReceipts` 会造出 `ok:true` 的 `query-meals` 回执——**报告一次没有发生过的成功调用**。CLI 正常路径因注入了真实收据而掩盖了它。 |
| ② 对应修改 | `synthReceipts` **一律 `ok:false`**：`live` 却无真实收据 ⇒ `LIVE_RECEIPT_MISSING`；离线/历史 ⇒ `OFFLINE_FIXTURE` / `HISTORY_SNAPSHOT`。注释写明「合成即无真实收据，不得称成功」。 |
| ③ 实际入口 | `analyze.ts::synthReceipts()` ← `analyzeSingle` / `analyzeCombo` / `analyzeMenu` 的兜底路径 |
| ④ 通过日志 | 回归 3 条：`analyzeSingle` 仅给 live 无收据 → 轨迹 `ok:false` 且 `errorCode=LIVE_RECEIPT_MISSING`；**提供了真实收据则原样透传**；`analyzeMenu` 同场景下轨迹**不含任何 `ok:true`**。 |
| ⑤ 适用范围 | 全部公共分析 API。**取舍**：宁可留一条 `ok:false` 的说明，也不留一条假的成功。 |

---

## 二、复评「证据与交付声明问题」——**我们错了，已纠正**

复评指出：`human-review-samples-filled.csv` 的 `审核人` 字段实为
**「尼可·莱恩（AI辅助复核，待主君确认）」**，而我们的文档却写成「主君亲判 / 人工审核已完成」。

**核实结论：复评正确，我方错误。** 该表由 **AI 辅助复核预填**，主君尚未逐行确认。
把 AI 预填表述为人（主君）亲判，**弱化了证据身份**——这是必须纠正的。

**已纠正的 7 处**（把「主君亲判/已完成」改为「AI 辅助复核预填，待主君确认」）：

| 文件 | 位置 |
|---|---|
| `docs/HUMAN_REVIEW.md` | 顶部状态、第七节标题、结论与状态清单（改为「**未闭环**」） |
| `docs/REVIEW-RESPONSE-v3-2026-10-12.md` | 第七节标题、正文与「无法判」表述 |
| `src/analyze.ts` | 两处代码注释（主件规则的来源） |
| `tests/human-review-2026-10-12.test.ts` | 文件头与 describe 名 |
| `work/review-v3.2/REVIEW-GUIDE-v3.2.md` | 第 1 节、第 3 节证据表 |
| `outputs/mcmeal-v3.2-delivery-2026-10-12.md` | 标题、本轮内容、第一节标题 |

**当前口径**：人工审核门槛**保持未闭环**；35 条判定的**技术结论不变**（3 条 `diff` 确实指向真缺陷，
已修并有回归），但**证据身份**如实为「AI 预填，待主君确认」。
**待主君**：逐行确认后在表内签字（审核人 / 日期），届时方可升级状态。

---

## 三、复评「尚未闭环的外部证据」六项 —— 本轮补齐情况

| 项 | 状态 | 证据 |
|---|---|---|
| **≥3 个真实菜单案例**（覆盖单品/组合/折扣/变体） | ✅ **4 例** | 见下「四」 |
| **真实 `productList` 协议证据** | ✅ | `work/online-evidence/price-probe.json`：4 用例中 3 成功（单品/套餐/混合数量）**响应均含 `productList` 且与请求逐项一致**；1 例失败错误码 `60006`（正确拦截） |
| **modern-shape 真实接口验证** | ✅ **可用** | `work/online-evidence/modern-shape.json`：端点**同时接受** `2025-06-18`(legacy) 与 `2026-07-28`(modern)，两者门店搜索均返回 5 家、结果一致 |
| **SKILL.md** | ✅ | 仓库根 `SKILL.md`（可安装入口：frontmatter + 用法 + 输出约定 + 边界） |
| **secrets scan** | ✅ **clean** | `work/online-evidence/secrets-scan.json`：工作树 **72 文件** + 历史 **21 提交 / 16,990 行**，`findings=0`；6 条白名单均为**测试用假值**（`TESTONLY-…`、`DUMMY_REVIEW_TOKEN`） |
| **真实端点的请求/响应/错误/requestId 证据链** | ✅ | 各案例 JSON 含 `sourceTrace`（`channel/stage/requestId/ok/errorCode`）与计价收据（`argsSummary/at/attempt/responseHash/durationMs`）；探针另存 `responseHash`、`traceId`、`durationMs` |

> 说明：`secrets scan` 的实施脚本 `scripts/secrets-scan.mjs` 随包提供；
> 因本机 Node 子进程 spawn git 间歇性 `EBUSY`，采用「shell 导出补丁 → 脚本读文件」的可复现路径
> （命令：`git log --all -p --no-color --unified=0 > history-patch.txt` 后
> `node scripts/secrets-scan.mjs --history-file history-patch.txt`）；未给该参数时才自行 spawn。

---

## 四、真实案例（4 例，全部走真端点 `mcp.mcd.cn`，门店 3450024）

| # | 场景 | 覆盖维度 | 结果（节选） |
|---|---|---|---|
| 1 | `--budget 35 --avoid-sugary` | **单品** + 避糖 | 3 方案均 `official`／`verified`；**发起 20 次真实计价，成功 20**；薄皮焦香V翅 ¥16 / 那么大鸡排 ¥14.50 / 芝士安格斯厚牛堡 ¥34 |
| 2 | `--budget 45 --priority protein` | 偏好=首选 | 首选 `protein`（培根安格斯厚牛堡 ¥36）；**43 次真实计价全成功** |
| 3 | `--budget 60 --priority balance` | **组合（套餐）** | protein 卡＝**培根安格斯厚牛堡三件套**（combo）¥50.50 · 1143 kcal · 蛋白 38g · B 级 · `official` |
| 4 | `--variant 薯条=中 --variant 可乐=中杯` | **变体（显式份量）** | 薯条 → 命中「官方单品营养：**中薯条**」289 kcal；可乐 → 「**可乐中杯**」147 kcal（未指定份量本应拒绝） |

**真实端点另两项**：
- **计价协议**：单品 / 套餐 / 混合数量三例 `productList` 与请求一一对应；不存在的商品码 → `BUSINESS_FAILURE code=60006`（**未被当作 ¥0**）。
- **协议形态**：legacy 与 modern 双通（见第三节）。

> ⚠️ 如实声明：4 例均为**到店自取（beType=1）**、**未下单**（`createOrder` 恒 `ORDERING_DISABLED`）；
> 「折扣」维度本轮**未取到可用券**，故以「变体」满足复评的「折扣**或**变体」。

---

## 五、本轮提交与自检

```
（提交哈希见交付说明）
```

自检结果（本机）：
- `npm run gate`：夹具一致 · **295 用例全绿** · 类型干净 · 离线可跑
- 验收脚手架 R1–R10：**10/10 PASS**；补充探针 R11–R13：**3/3 PASS**
- `secrets-scan`：`clean`（含历史）

## 六、仍未闭环（**不提前关单**）

1. **人工审核 35 条的逐行确认**（待主君；见第二节）；
2. 真实端点的**限流**证据：本轮 60+ 次请求**未触发限流**，故无法给出真实限流样本
   （限流分类与退避行为由单测覆盖）；
3. `A` 级（官方单品）在当前实现中**不可达**——`assignConfidence(nutrition, hasComposition)` 的
   `A` 要求 `hasComposition=true`，而单品传 `false`、套餐走 `deriveMealConfidence`（上限 `B`）。
   **文档写「A 官方单品」与实现不符**，本轮**如实记入**，修法待定（涉验收口径，不擅改）。
