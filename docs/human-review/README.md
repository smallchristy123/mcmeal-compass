# docs/human-review · 人工审核判定与留档

> 这里的文件与交付包 `human-review/` 目录**同一份内容**，用于让「人工审核已完成」这一主张**可被复核**。
> 口径、分层精确率、误配处置与确认凭证，见上级 [`../HUMAN_REVIEW.md`](../HUMAN_REVIEW.md)。

## 文件身份对照（**先看这张表，别把中间版本当结论**）

| 文件 | 身份 | 是否权威 |
|---|---|---|
| `human-review-samples-blank.csv` | **空白抽样表**（35 条分层已生成，判定列待人工填写） | 否——是发放给审核人的原表 |
| `human-review-samples-filled-before-signoff.csv` | **主君逐行确认之前**的版本（审核人字段原为 AI 辅助复核预填） | **否**——保留为改前原件，供对照「哪一处被改过」 |
| `human-review-samples-filled.csv` | **主君逐行确认后**的最终版本（审核人字段已登记确认方式与时间） | ✅ **权威** |
| `human-review-samples-reclassified.csv` | 最终版按 v3.4 新分层**重分类**后的表（分层标签更正，判定未改） | ✅ 用于分层统计 |
| `human-review-score.txt` | 汇总脚本对**最终版**的输出（精确率与误配清单） | ✅ 结论凭据 |
| `human-review-score-reclassified.txt` | 对**重分类版**的汇总输出 | ✅ 结论凭据 |

> **为什么留「改前原件」**：v3.2 复评曾指出一处身份错记（把 AI 预填写成人工判定）。
> 修正后**两笔事实并存**——原件不删，读者可自行比对。这是刻意的，不是残留。

## 复算方法（任何人可独立复核）

```bash
node scripts/review-samples.ts --score "docs/human-review/human-review-samples-filled.csv"
node scripts/review-samples.ts --score "docs/human-review/human-review-samples-reclassified.csv"
```

- `same` 计分子；`diff` 计分母并进误配清单；`unknown` **单列**，不算对也不算错；**留空不算通过**。
- 因此**只对「可判定项」**报告精确率，**不对「机器主动拒绝」的行为**声称准确率。

## 隐私

表中只有**公开菜单项名称、菜单价与营养字段**，**不含**任何个人身份信息；
唯一的「人名」字段是审核人角色标注（**主君**），系署名而非个人信息收集。
