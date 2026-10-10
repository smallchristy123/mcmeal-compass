/**
 * 统一数据 schema（T1.2）
 *
 * 把 MCP 三个核心工具返回的原始结构，转成本项目内部的统一类型契约。
 * 三条硬规矩（皆有实测依据）：
 *   1. 金额一律为整数「分」（见 money.ts）——绝不出现「元/分」混用；
 *   2. 缺失的营养值一律为 `null`，**绝不被填成 0**（0 是「可乐蛋白质为 0」这种真值）；
 *   3. 结构里没见过的字段不猜、不丢，原样留在 `unknown` 里备查。
 */

import { z } from 'zod';
import { centsFromApi, centsFromYuan, parseDiffPriceToCents, type Cents } from './money.ts';
import type { ToonRow, ToonTable } from './toon.ts';

/** 金额（整数分）的 zod 校验器 */
export const MoneySchema = z
  .number()
  .int()
  .refine((v) => Number.isSafeInteger(v), { message: '金额必须是安全整数（分）' });

/** 可空字符串：外部 JSON 常把缺失写成 null */
const NullableString = z.string().nullable();
/** 把「'null' 字面量」也一并归为 null 的字符串 */
const LooseString = z
  .union([z.string(), z.null()])
  .transform((v) => (v === null || v === 'null' ? null : v))
  .nullable();

// ────────────────────────────── 营养（list-nutrition-foods） ──────────────────────────────

/**
 * 单条营养记录。原始表里所有数值都是字符串，这里统一转成 number | null。
 * 转换失败或原本就是 null 的，保持 null——**绝不落成 0**。
 */
export const NutritionRowSchema = z.object({
  productName: z.string().min(1, 'productName 不可为空'),
  nutritionDescription: LooseString,
  energyKj: z.number().nullable(),
  energyKcal: z.number().nullable(),
  protein: z.number().nullable(),
  fat: z.number().nullable(),
  carbohydrate: z.number().nullable(),
  sodium: z.number().nullable(),
  calcium: z.number().nullable(),
});

export type NutritionRow = z.infer<typeof NutritionRowSchema>;

/** TOON 单元格字符串 → number | null（空串/非法 → null，保留 0） */
function num(cell: string | null): number | null {
  if (cell === null) return null;
  const s = cell.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 把一行 TOON 表格数据转成 NutritionRow（不改语义，只做类型转换） */
export function toNutritionRow(row: ToonRow): NutritionRow {
  const name = (row['productName'] ?? '').trim();
  const raw: NutritionRow = {
    productName: name,
    nutritionDescription: row['nutritionDescription'] ?? null,
    energyKj: num(row['energyKj'] ?? null),
    energyKcal: num(row['energyKcal'] ?? null),
    protein: num(row['protein'] ?? null),
    fat: num(row['fat'] ?? null),
    carbohydrate: num(row['carbohydrate'] ?? null),
    sodium: num(row['sodium'] ?? null),
    calcium: num(row['calcium'] ?? null),
  };
  return NutritionRowSchema.parse(raw);
}

/** 整表转换，跳过名称为空的行（并汇报跳过了几条） */
export function toNutritionRows(table: ToonTable): {
  rows: NutritionRow[];
  skipped: number;
} {
  const rows: NutritionRow[] = [];
  let skipped = 0;
  for (const r of table.rows) {
    const name = (r['productName'] ?? '').trim();
    if (name === '') {
      skipped++;
      continue;
    }
    rows.push(toNutritionRow(r));
  }
  return { rows, skipped };
}

// ────────────────────────────── 菜单（query-meals） ──────────────────────────────

export const MenuItemSchema = z.object({
  /** 餐品唯一编码（工具的入参 key） */
  code: z.string().min(1),
  name: z.string().min(1),
  image: NullableString.optional(),
  /** 现价（销售价）——已在转换时统一为「分」 */
  currentPrice: MoneySchema.nullable(),
  /** 原价（划线价） */
  originalPrice: MoneySchema.nullable(),
  canWithOrder: z.boolean(),
  /** 优惠类型：null / "早餐卡优惠" / "促销优惠" / … */
  discountType: NullableString.optional(),
  tags: z.array(z.string()),
  /** 所属分类名（由调用方补，便于展示） */
  category: z.string().optional(),
});

export type MenuItem = z.infer<typeof MenuItemSchema>;

/** query-meals 返回体里的单条 meals[key] 原始结构（宽松解读） */
const RawMenuItemSchema = z
  .object({
    name: z.string(),
    image: z.string().nullable().optional(),
    currentPrice: z.union([z.string(), z.number()]).nullable().optional(),
    originalPrice: z.union([z.string(), z.number()]).nullable().optional(),
    canWithOrder: z.boolean().optional(),
    discountType: z.string().nullable().optional(),
  })
  .passthrough();

export const QueryMealsDataSchema = z
  .object({
    categories: z
      .array(
        z
          .object({
            name: z.string(),
            meals: z
              .array(
                z
                  .object({
                    code: z.string(),
                    tags: z.array(z.string()).optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    meals: z.record(z.string(), RawMenuItemSchema).optional(),
  })
  .passthrough();

export type QueryMealsData = z.infer<typeof QueryMealsDataSchema>;

/**
 * 把 query-meals 的返回体摊平成 MenuItem[]。
 * 价格由「元」的字符串转为「分」；不在 meals 映射表里的 code 会被跳过（计入 missing）。
 */
export function toMenuItems(data: QueryMealsData): {
  items: MenuItem[];
  missing: string[];
} {
  const items: MenuItem[] = [];
  const missing: string[] = [];
  const map = data.meals ?? {};

  for (const cat of data.categories ?? []) {
    for (const m of cat.meals ?? []) {
      const raw = map[m.code];
      if (!raw) {
        missing.push(m.code);
        continue;
      }
      items.push(
        MenuItemSchema.parse({
          code: m.code,
          name: raw.name,
          image: raw.image ?? null,
          currentPrice: centsFromYuan(raw.currentPrice ?? null),
          originalPrice: centsFromYuan(raw.originalPrice ?? null),
          canWithOrder: raw.canWithOrder ?? false,
          discountType: raw.discountType ?? null,
          tags: m.tags ?? [],
          category: cat.name,
        }),
      );
    }
  }
  return { items, missing };
}

// ────────────────────────────── 套餐组成（query-meal-detail） ──────────────────────────────

export const MealChoiceSchema = z.object({
  code: z.string(),
  name: z.string(),
  quantity: z.number(),
  maxQuantity: z.number(),
  /** 是否默认选中（原始字段 isDefault=1） */
  isDefault: z.boolean(),
  /** 与默认项的差价（分，可为负） */
  diffPrice: MoneySchema.nullable(),
  supportModify: z.boolean(),
  /** 该选项下的组成项（特调） */
  composition: z
    .array(
      z.object({
        code: z.string(),
        name: z.string(),
        price: MoneySchema.nullable(),
        quantity: z.number(),
      }),
    )
    .optional(),
});

export type MealChoice = z.infer<typeof MealChoiceSchema>;

export const MealRoundSchema = z.object({
  id: z.number(),
  name: z.string(),
  quantity: z.number(),
  minQuantity: z.number(),
  maxQuantity: z.number(),
  choices: z.array(MealChoiceSchema),
});

export type MealRound = z.infer<typeof MealRoundSchema>;

export const MealDetailSchema = z.object({
  code: z.string(),
  name: z.string(),
  rounds: z.array(MealRoundSchema),
});

export type MealDetail = z.infer<typeof MealDetailSchema>;

/** query-meal-detail 的宽松原始结构 */
export const RawMealDetailSchema = z
  .object({
    code: z.string(),
    name: z.string(),
    rounds: z
      .array(
        z
          .object({
            id: z.number(),
            name: z.string(),
            quantity: z.number().optional(),
            minQuantity: z.number().optional(),
            maxQuantity: z.number().optional(),
            choices: z
              .array(
                z
                  .object({
                    code: z.string(),
                    name: z.string(),
                    quantity: z.number().optional(),
                    maxQuantity: z.number().optional(),
                    isDefault: z.number().optional(),
                    diffPrice: z.string().nullable().optional(),
                    supportModify: z.boolean().optional(),
                    modification: z
                      .object({
                        items: z
                          .array(
                            z
                              .object({
                                values: z
                                  .array(
                                    z
                                      .object({
                                        code: z.string(),
                                        name: z.string(),
                                        price: z.number().optional(),
                                        quantity: z.number().optional(),
                                        selectedQuantity: z.number().optional(),
                                      })
                                      .passthrough(),
                                  )
                                  .optional(),
                              })
                              .passthrough(),
                          )
                          .optional(),
                      })
                      .passthrough()
                      .optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** 把 query-meal-detail 原始体转成 MealDetail（差价字符串 → 分） */
export function toMealDetail(raw: unknown): MealDetail {
  const d = RawMealDetailSchema.parse(raw);
  return MealDetailSchema.parse({
    code: d.code,
    name: d.name,
    rounds: (d.rounds ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      quantity: r.quantity ?? 0,
      minQuantity: r.minQuantity ?? 0,
      maxQuantity: r.maxQuantity ?? 0,
      choices: (r.choices ?? []).map((c) => {
        const composition: { code: string; name: string; price: Cents | null; quantity: number }[] =
          [];
        for (const item of c.modification?.items ?? []) {
          for (const v of item.values ?? []) {
            composition.push({
              code: v.code,
              name: v.name,
              price: centsFromApi(v.price ?? null),
              quantity: v.selectedQuantity ?? v.quantity ?? 0,
            });
          }
        }
        return {
          code: c.code,
          name: c.name,
          quantity: c.quantity ?? 0,
          maxQuantity: c.maxQuantity ?? 0,
          isDefault: c.isDefault === 1,
          diffPrice: parseDiffPriceToCents(c.diffPrice ?? null),
          supportModify: c.supportModify ?? false,
          composition,
        };
      }),
    })),
  });
}

// ────────────────────────────── 计价（calculate-price） ──────────────────────────────

export const PriceResultSchema = z.object({
  productOriginalPrice: MoneySchema.nullable(),
  productPrice: MoneySchema.nullable(),
  deliveryPrice: MoneySchema.nullable().optional(),
  packingPrice: MoneySchema.nullable().optional(),
  tablewarePrice: MoneySchema.nullable().optional(),
  originalPrice: MoneySchema.nullable(),
  discount: MoneySchema.nullable(),
  /** 总现价（分）——最终展示的实付金额 */
  price: MoneySchema,
  productList: z.array(
    z.object({
      productCode: z.string(),
      productName: z.string(),
      quantity: z.number(),
      originalSubtotal: MoneySchema.nullable(),
      subtotal: MoneySchema.nullable(),
    }),
  ),
  takeWayList: z.array(
    z.object({
      code: z.string(),
      title: z.string(),
      subtitle: z.string().optional(),
    }),
  ),
});

export type PriceResult = z.infer<typeof PriceResultSchema>;

const RawPriceResultSchema = z
  .object({
    productOriginalPrice: z.number().optional(),
    productPrice: z.number().optional(),
    deliveryPrice: z.number().optional(),
    packingPrice: z.number().optional(),
    tablewarePrice: z.number().optional(),
    originalPrice: z.number().optional(),
    discount: z.number().optional(),
    price: z.number(),
    productList: z
      .array(
        z
          .object({
            productCode: z.string(),
            productName: z.string(),
            quantity: z.number(),
            originalSubtotal: z.number().optional(),
            subtotal: z.number().optional(),
          })
          .passthrough(),
      )
      .optional(),
    takeWayList: z
      .array(
        z
          .object({
            code: z.string(),
            title: z.string(),
            subtitle: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export function toPriceResult(raw: unknown): PriceResult {
  const d = RawPriceResultSchema.parse(raw);
  return PriceResultSchema.parse({
    productOriginalPrice: centsFromApi(d.productOriginalPrice ?? null),
    productPrice: centsFromApi(d.productPrice ?? null),
    deliveryPrice: centsFromApi(d.deliveryPrice ?? null),
    packingPrice: centsFromApi(d.packingPrice ?? null),
    tablewarePrice: centsFromApi(d.tablewarePrice ?? null),
    originalPrice: centsFromApi(d.originalPrice ?? null),
    discount: centsFromApi(d.discount ?? null),
    price: centsFromApi(d.price) ?? 0,
    productList: (d.productList ?? []).map((p) => ({
      productCode: p.productCode,
      productName: p.productName,
      quantity: p.quantity,
      originalSubtotal: centsFromApi(p.originalSubtotal ?? null),
      subtotal: centsFromApi(p.subtotal ?? null),
    })),
    takeWayList: (d.takeWayList ?? []).map((t) => ({
      code: t.code,
      title: t.title,
      subtitle: t.subtitle,
    })),
  });
}
