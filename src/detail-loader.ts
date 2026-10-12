/**
 * 套餐详情加载器（独立成模块，便于测试注入）。
 *
 * 复评 P1/P2（2026-10-12）指出：CLI 此前把 `getMealDetail` 的所有异常
 * `catch { set null }` 一并抹成「没有详情」，上层只能记 `EMPTY_DETAIL`，
 * **原始错误（超时 / HTTP / 解析）的错误码与消息全部丢失**——与「错误进入 receipt」的
 * 说法不符（R13 探针之所以通过，是因为它直接注入了会抛错的 loader，绕过了这条真实路径）。
 *
 * 本模块的契约：
 *   · 成功          → 返回 `MealDetail`（可能 `rounds` 为空，**空结果由上层**判为 EMPTY_DETAIL）；
 *   · 请求失败      → **抛出** `McpError`（保留 code/message），由 `analyzeMenu` 写真实失败收据；
 *   · 缓存          → 缓存「成功 / 失败」两态；命中失败缓存时**重放同一次错误**（不重复请求）。
 */
import { McpError } from './mcp-client.ts';
import type { MealDetail } from './schema.ts';

/** 只依赖 `getMealDetail` 这一个方法，便于测试传入假实现 */
export interface DetailLoaderClient {
  getMealDetail(params: {
    storeCode: string;
    orderType: 1 | 2;
    beType: 1 | 2 | 5 | 6;
    code: string;
  }): Promise<MealDetail>;
}

type DetailCacheEntry =
  | { status: 'ok'; detail: MealDetail }
  | { status: 'failed'; error: McpError };

/**
 * 造一个套餐详情加载器。
 * @param client 至少实现 `getMealDetail`
 * @param storeCode 门店码（详情请求要带）
 */
export function createDetailLoader(
  client: DetailLoaderClient,
  storeCode: string,
): (code: string) => Promise<MealDetail | null> {
  const cache = new Map<string, DetailCacheEntry>();

  return async (code: string): Promise<MealDetail | null> => {
    const hit = cache.get(code);
    if (hit) {
      if (hit.status === 'failed') throw hit.error; // 缓存命中（同一次失败，重放原始错误）
      return hit.detail;
    }
    try {
      const detail = await client.getMealDetail({ storeCode, orderType: 1, beType: 1, code });
      cache.set(code, { status: 'ok', detail });
      return detail;
    } catch (e) {
      const err =
        e instanceof McpError
          ? e
          : new McpError(
              'BAD_RESPONSE',
              `套餐详情请求失败：${e instanceof Error ? e.message : String(e)}`,
            );
      cache.set(code, { status: 'failed', error: err });
      throw err; // ← 关键：保留原始错误码与消息，不抹平
    }
  };
}
