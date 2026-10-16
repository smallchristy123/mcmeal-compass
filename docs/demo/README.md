# docs/demo · 演示取材留档

> 本目录存放**演示材料所引用的真实运行留档**（不是手写示例）。
> 规则：**先跑、后存**——文件内容逐字取自 `node src/cli.ts` 的 stdout/stderr，未经编辑；
> 文件名绑定**观测时刻**，与第八节「快照口径」一致（门店码 + 观测时间 + 协议版本 + 总数）。
> **不含任何凭据**：入库前已按 `scripts/secrets-scan.mjs` 同源规则自检（Token 前后各 6 位全零命中）。

## 清单

| 文件 | 类型 | 观测时刻（+08:00） | 命令要点 |
|---|---|---|---|
| `online-20261014-194006-budget35-balance.txt` | 真在线 | 2026-10-14 19:40:06 | `--city 重庆市 --keyword 观音桥 --budget 35` |
| `online-20261014-194102-budget40-variant.txt` | 真在线 | 2026-10-14 19:41:02 | 同上 + `--budget 40 --variant 可乐=中杯` |
| `online-20261014-194119-budget28-balance.txt` | 真在线 | 2026-10-14 19:41:19 | 同上 + `--budget 28` |
| `online-20261014-194136-budget45-protein.txt` | 真在线 | 2026-10-14 19:41:36 | 同上 + `--budget 45 --priority protein` |
| `online-20261014-194155-budget45-json.json` | 真在线（机读） | 2026-10-14 19:41:55 | 同上 + `--json` |
| `offline-20261014-budget35-balance.txt` | 离线夹具 | 数据快照 `baseline-20261010-3450024` | `--offline --budget 35` |
| `online-20261016-103614-budget80-protein35.txt` | 真在线 | 2026-10-16 10:36:14 | `--budget 80 --min-protein 35`（**首选即套餐**） |
| `online-20261016-103621-budget80-protein35-variant-colalarge.txt` | 真在线 | 2026-10-16 10:36:21 | 同上 ＋ `--variant 可乐=大杯`（**与上一条逐字相同**，见「已知局限」） |
| `online-20261016-103730-budget65-protein35.txt` | 真在线 | 2026-10-16 10:37:30 | `--budget 65 --min-protein 35`（含 O4 的「¥62.00」实例） |

门店均为 **麦当劳重庆嘉年华餐厅（3450024）**（由 `--city 重庆市 --keyword 观音桥` 解析所得）。

## 四次真在线运行的一致结果（可复核）

| 项 | 实测 |
|---|---|
| 协议 | `mcd-mcp 1.0.0` · 协议 `2025-06-18 / legacy` |
| 计价请求 | 每次 **28 项候选全部成功**（发起后失败 0、重试 0、缓存命中 0） |
| 三方案价格来源 | 全部 **`official`（官方计价已核实）**——非「未核实实付」 |
| 可信度分层 | 落在 A 与 B（A＝精确直配且字段完整、无推断） |
| 下单 | 每次都印出 `⛔ 本版本不能下单`（`ORDERING_DISABLED`） |

## 已知局限（如实记，勿当成果）

- **家常预算下前三为单品，是排序结果而非缺陷**（2026-10-16 结案）：
  套餐在线**不会**被降级（41 个套餐中 B 级 26 个）、**不会**被误判为非正餐（复算命中 0）、
  菜单价与在线价 37/38 完全一致；真正原因是套餐官方实付价多集中在 **¥32–50+**（中位 ¥38.00），
  而单品「蛋白/元」效率更高。**放宽预算即可让套餐入画**——见 `online-20261016-103614-budget80-protein35.txt`。
  完整推导见 `docs/DECISION_NOTES.md`「10-16 追加 · O3 结案」。
- **`--variant` 够不到套餐内部轮次**（O5）：`online-20261016-103621-...-variant-colalarge.txt`
  与 `...103614-...txt` **逐字相同**，即为该现象的留档证据（替换能力已实现但有入口缺失）。
- **部分弹性套餐的官方计价高于菜单价**（O4）：如「不素之霸双层牛堡四件套」菜单 ¥32.00 → 官方 ¥62.00；
  **成因尚未查明**，见 `docs/DECISION_NOTES.md`「10-16 追加 · O4」。
- **离线留档的数据是 2026-10-10 快照**，输出中的时效行会明确标注「已超时效 · 只能作历史样例」。

## SHA-256（入库时冻结）

```text
d4b178e8c5b7c88fef8b56134434ba70c40d03820218ef344272ddc63f052c68  offline-20261014-budget35-balance.txt
632fb34463993a5a13064bd4cf5e6c86a2dc30fb2a2aa4fb5c75f40a3af61578  online-20261014-194006-budget35-balance.txt
862f1a0971752487650b1373c95b90af1dbbb51f5e55cdaff604a368bfd4afe3  online-20261014-194102-budget40-variant.txt
9c3a8d64b207a7c9a109ff51862b02aa5a6fbf440973fbfaa465614bfdc959a8  online-20261014-194119-budget28-balance.txt
cff818dc35ddf426472d86f3a412459b1e7a13739ee1604cd8ab32729c915316  online-20261014-194136-budget45-protein.txt
59cbd2f3d5e3491cd50f7ed65ea63e2282316cf2166f0c775e71489be8c22be6  online-20261014-194155-budget45-json.json
89debd75b66b0cbdd50eea747b88b708ae850e016a4f62b7173a2cb836a0a4bc  online-20261016-103614-budget80-protein35.txt
4c609e48b8d2f16dff9836a913e5a19208528ce7e97bd391f9a5654cf7cd6931  online-20261016-103621-budget80-protein35-variant-colalarge.txt
3c6547ad405075d07d82756a113fa4c01e708351fff54c157c919e0a51b665f4  online-20261016-103730-budget65-protein35.txt
```

> 复现提示：在线留档需要自己的 Token（`MCD_MCP_TOKEN`），且**门店菜单与价格随时间变化**，
> 重跑**不应期待逐字一致**；可比对的是**结构与口径**（价源三态、可信度分层、收据计数）。
