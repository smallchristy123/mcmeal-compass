# fixtures/ —— 不可变快照（测试基线的唯一来源）

## 一句话规矩

> **`fixtures/` 里的内容一旦定下就不再改动。要新数据，就新建一个快照——绝不就地覆盖。**

## 为什么

此前采集脚本 `capture` 直接覆盖 `docs/probe/`，而**测试也读那同一个目录**。
后果：谁跑一次采集，测试基线就漂移一次；别人拿到仓库复现，`npm test` 不再全绿。
（这不是假设——外部评审方实跑后即出现 187→186 通过、1 条失败，失败原因正是菜单条目数变了。）

## 目录形态

```text
fixtures/
├── README.md                        # 本文件
└── baseline-20261010-3450024/       # 快照 id = <用途>-<采集日>-<门店码>
    ├── manifest.json                # 来源 + 每文件 SHA-256 + 条数统计
    ├── list-nutrition-foods.raw.json
    ├── query-meals.raw.txt
    ├── query-nearby-stores.raw.txt
    ├── meal-details.bundle.json
    ├── query-meal-detail.raw.txt
    └── calculate-price.raw.txt
```

## 当前快照（测试基线）

| 快照 id | 采集时间 | 门店 | 营养表 | 菜单（去重前/后） | 套餐详情 |
|---|---|---|---|---|---|
| `baseline-20261010-3450024` | 2026-10-10 20:08:56 | 3450024 麦当劳重庆嘉年华餐厅 | 160 行 | 130 / 121 | 20 |

> 精确数字以 `manifest.json` 的 `counts` 为准；本表只是给人看的摘要。

## 三道闸门（代码里怎么保证）

| 闸门 | 位置 | 作用 |
|---|---|---|
| 采集不落快照 | `scripts/capture-fixtures.ts` | 只写 `work/captures/<时间戳>-<门店码>/`；若目标路径以 `fixtures` 开头则**直接拒绝执行** |
| 哈希校验 | `scripts/fixture-manifest.ts` | 比对每个文件的 SHA-256 与 `counts`，不一致即非 0 退出 |
| 测试即校验 | `tests/fixtures.test.ts` | 测试启动即校验哈希、统计、连续两次加载结果一致 |

跑一遍：

```bash
npm run verify:fixtures   # 校验所有快照（CI 门槛之一）
npm run gate              # 校验 + 测试 + 类型检查 + 离线演示，一条命令走完
```

## 如何换快照（必须人工，且要写清"为何换"）

1. 采集到工作区（**不会**碰基线）：
   ```bash
   npm run capture -- 3450024 --details 20      # → work/captures/<时间戳>-3450024/
   ```
2. 人工核对：新数据是否值得作基线？条数变化是否合理？有无新品/下架？
3. 复制为新快照并生成 manifest：
   ```bash
   cp -r work/captures/<时间戳>-3450024 fixtures/baseline-<新日期>-3450024
   node scripts/fixture-manifest.ts --dir fixtures/baseline-<新日期>-3450024 --write
   ```
4. **同步更新**依赖具体数字的断言与文档（`tests/*.test.ts`、`docs/MATCHING_NOTES.md` 等），
   并在提交信息里写明：**为何换、换了什么、断言如何随之更新**。
5. 旧快照**保留**（它是历史证据），除非明确要废止。

## 快照里没有、也不该有的东西

- 任何账号、手机号、地址、订单、Token —— 只有**公开菜单与营养数据**；
- 与测试无关的临时采集 —— 那些留在 `work/`（已被 `.gitignore` 忽略）。
