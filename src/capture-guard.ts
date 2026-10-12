/**
 * 采集写入保护（外部评审「采集路径保护」项的落地）
 *
 * 为什么单独成模块：这段判断既要在**采集脚本**里生效，
 * 也要能被**测试**直接验证（脚本本身带副作用，测试不能 import 它）。
 *
 * 三条判据：
 *   ① **规范化 + 大小写不敏感**——Windows 下 `Fixtures` / `FIXTURES` 指向同一目录，
 *      旧版的大小写敏感 `startsWith` 会被绕过；
 *   ② **按路径段判断**——`rel === 'fixtures'` 或首段以 `fixtures` 开头即拒，
 *      避免 `fixtures-extra` 这类「前缀像但其实是别的目录」的判据含糊；
 *   ③ **仓库外一律拒绝**——采集只允许写进仓库的 `work/` 下。
 */

import { relative, resolve, sep } from 'node:path';

/** 归一化：统一分隔符为 `/`、去尾部斜杠、小写（Windows 大小写不敏感） */
function normalizeRel(p: string): string {
  return p.split(sep).join('/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 目标目录是否被禁止写入。
 * @returns 禁止原因；允许写入时返回 `null`
 */
export function forbiddenWrite(outDir: string, repoRoot: string): string | null {
  const target = resolve(outDir);
  const rel = relative(resolve(repoRoot), target);

  // 仓库外（含不同盘符：relative 会返回绝对路径）
  if (rel === '' || rel.startsWith('..') || /^[A-Za-z]:/.test(rel)) {
    return `目标不在仓库内（${target}）——采集只允许写入仓库的 work/ 目录`;
  }

  const normalized = normalizeRel(rel);
  const firstSegment = normalized.split('/')[0] ?? '';

  if (firstSegment.startsWith('fixtures')) {
    return '采集不得写入 fixtures*/（那是不变快照，只由人工显式新建）';
  }
  if (firstSegment === '.git') {
    return '采集不得写入 .git/';
  }
  return null;
}
