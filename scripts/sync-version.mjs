/**
 * 版本唯一源同步（复评 v3.7.1 · P2）
 *
 * 复评原话：「建立唯一版本源，例如生成 `src/version.ts`，由 package.json、CLI、MCP client、
 * 采集脚本和证据脚本共同读取」——此前 `package.json` 改成了 3.7.1，而 MCP 客户端仍对外
 * 报 `0.1.0`、采集脚本仍写 `0.3.0`，服务端日志与协议审计会把本版识别成旧版。
 *
 * 规则：
 *   · **唯一源 = package.json 的 `version`**；
 *   · `src/version.ts` 由本脚本**生成**（不要手改）；
 *   · `--check` 模式只校验不改写，供 `npm run gate` 使用——两边一旦漂移，门禁即失败。
 *
 * 用法：
 *   node scripts/sync-version.mjs           # 由 package.json 生成 src/version.ts
 *   node scripts/sync-version.mjs --check   # 仅校验（不一致则以退出码 1 失败）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const outPath = join(root, 'src', 'version.ts');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
if (typeof version !== 'string' || version.length === 0) {
  console.error('✗ package.json 里没有可用的 version 字段');
  process.exit(1);
}

const banner = `/**
 * ⚠️ **本文件由 \`scripts/sync-version.mjs\` 生成，请勿手改。**
 *
 * 版本的**唯一源是 \`package.json\` 的 \`version\`**；运行时（CLI / MCP 客户端 / 采集与证据脚本）
 * 一律从这里取版本，避免"包名写着新版本、客户端却对外报旧版本"。
 * 两边漂移会被 \`npm run verify:version\`（并入 \`npm run gate\`）当场拦下。
 */
`;

const body = `${banner}export const NAME = ${JSON.stringify(pkg.name ?? 'mcmeal-compass')};
export const VERSION = ${JSON.stringify(version)};
`;

const check = process.argv.includes('--check');
let current = '';
try {
  current = readFileSync(outPath, 'utf8');
} catch {
  current = '';
}

if (check) {
  if (current !== body) {
    const m = /VERSION = "([^"]+)"/.exec(current);
    console.error(
      `✗ 版本源不一致：package.json=${version}｜src/version.ts=${m ? m[1] : '(缺失或格式异常)'}\n` +
        '  ⇒ 请运行 `node scripts/sync-version.mjs` 重新生成。',
    );
    process.exit(1);
  }
  console.log(`✅ 版本源一致：${version}`);
  process.exit(0);
}

if (current === body) {
  console.log(`✓ src/version.ts 已是最新（${version}），无需改写`);
} else {
  writeFileSync(outPath, body, 'utf8');
  console.log(`✓ 已由 package.json 生成 src/version.ts（${version}）`);
}
