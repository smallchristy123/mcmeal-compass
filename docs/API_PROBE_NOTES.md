# MCD MCP 实测探针笔记（T0.3–T0.5）

> 采集时间：2026-10-10 17:04–17:12
> 采集方式：直连 MCP JSON-RPC（`initialize` → `tools/list` → `tools/call`）
> 原始留档：`docs/probe/*.raw.json`、`docs/probe/*.raw.txt`（脱敏，仅含公开菜单数据）

---

## 一、连通口径（T0.3）

| 项 | 值 |
|---|---|
| 端点 | `https://mcp.mcd.cn` —— **根路径** |
| 传输类型 | `streamablehttp` |
| 协议版本 | `2025-06-18` |
| 鉴权 | 请求头 `Authorization: Bearer <TOKEN>` |
| 服务标识 | `serverInfo: { name: "mcd-mcp", version: "1.0.0" }` |
| 响应耗时 | 握手 0.4s；各工具调用 0.4–0.5s |

**⚠️ 踩坑记录**：`/mcp`、`/sse`、`/messages`、`/api/mcp`、`/v1/mcp` 全部返回
`404 {"error_msg":"404 Route Not Found"}`。**正确入口就是根路径**，不要加后缀。

**⚠️ 响应格式**：工具返回 `content[0].text` 是**「文档说明 + 原始 JSON」的混合文本**，
JSON 体位于 `## Original Response` 之后。解析须先定位该锚点，不能整段 `json.loads`。

---

## 二、工具清单（T0.5）

`tools/list` 实测返回 **35 个工具**（计划书估 9 个，实际远超）。核心链路 5 件：

| 工具 | 用途 | 耗时 |
|---|---|---|
| `list-nutrition-foods` | 营养数据（TOON 格式） | — |
| `query-nearby-stores` | 门店列表（需 city + keyword） | — |
| `query-meals` | 门店菜单（分类 + 餐品映射） | ~0.5s |
| `query-meal-detail` | 套餐组成 / 选配轮次 | 0.45s |
| `calculate-price` | 官方计价（单位：分） | 0.43s |

其余：`now-time-info`（校时）、`delivery-*`（外送）、`mall-*`（积分商城）、
`party-*`（派对）、`query-*`（订单/券/积分）等。

---

## 三、TOON 结构实测（T0.4）—— 三个必须防的坑

`list-nutrition-foods` 返回的 `data` 字段是一段 **TOON 文本**：

```
[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
  猪柳麦满分,null,1288,308,16,16,24,781,213
  猪柳蛋麦满分,null,1618,387,23,21,25,846,243
  ...
```

| # | 坑 | 应对 |
|---|---|---|
| 1 | **每行首字段带 2 个前导空格** | 解析后必须 `trim()`，否则 `productName` 污染，名称匹配失败 |
| 2 | **`nutritionDescription` 160 条中 157 条为 `null`** | **原计划「靠它做可信度分层」不可行**，须改用其他信号 |
| 3 | 营养字段为**扁平列**（无嵌套） | 解析简单，但须明确 `null` ≠ 0（缺失不得填 0） |

核验结果：声明行数 `160` == 实际行数 `160`，**列数零错位**。

---

## 四、菜单结构（`query-meals`）

入参：`{storeCode, orderType, beType}`（到店自取：`orderType=1, beType=1`，**不传 beCode**）

返回 `data`：
- `data.categories[]`：**14 个分类**（人气热卖 / 精选单人餐 / 鸡肉汉堡卷 / …）
  - `.name` 分类名、`.meals[].code` 餐品编码、`.meals[].tags`
- `data.meals{}`：**119 条**餐品映射表（key = 餐品 code）
  - `.name` 名称、`.image` 图片、`.currentPrice` 现价（**字符串**）、
    `.originalPrice` 原价、`.discountType` 优惠类型、`.canWithOrder` 是否可随单购

**⚠️ 价格是字符串**（如 `"38"`），入库须转 Decimal 或整数分。

---

## 五、套餐详情（`query-meal-detail`）

入参：`{storeCode, orderType, beType, code}`

返回 `data`：
- `.code` / `.name`：餐品编码与名称
- `.rounds[]`：**选配轮次**（如「麦辣鸡腿汉堡」「选择套餐内小食」「选择饮品」）
  - `.name` 轮次名、`.quantity` 已选数、`.minQuantity` / `.maxQuantity` 可选范围
  - `.choices[]`：**可选替换项**
    - `.code` / `.name` / `.quantity` / `.maxQuantity`
    - `.isDefault`：是否默认选中（`1` = 默认）
    - `.diffPrice`：**与默认项的差价**，格式带符号与货币（如 `"+ ¥1.5"`、`"- ¥0.5"`）
    - `.supportModify`：是否支持特调
    - `.modification.items[]`：特调项（如「麦香鸡酱」「切块生菜」，含 `price`）

**实测样例**（麦辣鸡腿汉堡三件套 `9900005456`）：
- 轮次 1「麦辣鸡腿汉堡」→ 默认选中，`supportModify: true`，可加酱/生菜
- 轮次 2「选择套餐内小食」→ 默认「中薯条」，可换「大薯条 +¥2」「小杯玉米杯 -¥0.5」等
- **替换后差价须回算**——这正是「换饮料重算营养+价格」功能的依据

---

## 六、计价口径（`calculate-price`）—— 两个关键坑

入参：`{storeCode, orderType, beType, items:[{productCode, quantity}]}`

| # | 坑 | 说明 |
|---|---|---|
| 1 | **字段名是 `productCode`，不是 `code`** | 传错则静默返回空列表 + 全 0，**不报错**（极易误判为"该商品无价"） |
| 2 | **金额单位是「分」** | `3800` = ¥38.00，展示须 `/100` |

返回 `data`：
- `productOriginalPrice` / `productPrice`：商品原价 / 现价（分）
- `deliveryPrice` / `packingPrice` / `tablewarePrice`：运费 / 打包费 / 餐具费（分）
- `originalPrice` / `discount` / `price`：总原价 / 优惠额 / 总现价（分）
- `productList[]`：逐项 `{productCode, productName, quantity, originalSubtotal, subtotal}`
- `takeWayList[]`：可取餐方式（实测返回 `堂食` / `外带`）

**实测验证**：`productCode=9900005456, quantity=1` → `price = 3800 分 = ¥38.00`，
与 `query-meals` 中该餐品 `currentPrice: "38"` **完全吻合**。✅ 计价闭环成立。

---

## 七、对计划的修正建议

1. **可信度分层**：原方案依赖 `nutritionDescription`，实测 98% 为 null → 改用
   「能否在 `query-meal-detail` 取到组成」+「营养字段是否齐全」双信号分级。
2. **计价字段**：代码里统一用 `productCode`；金额一律以「分」为整数存储，展示再转元。
3. **TOON 解析**：必须 trim 行首空白；`null` 与 `0` 严格区分。
4. **门店入参**：到店自取 `beType=1` 时**不得传 `beCode`**（传了会报错）；
   得来速/外送才需要。
5. **工具数量**：实际 35 个，远超预期，可选能力（派对/积分/券）可作为后续扩展点。
