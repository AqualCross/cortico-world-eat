#!/usr/bin/env node
/**
 * 重新生成 describe.json（与框架 `pnpm describe:extension` 对 World 的导出一致）：
 * 工具与事件取自定义的 describe，环境提示词模板原文一并带上。
 * 跑法：node tools/describe.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const mod = await import(pathToFileURL(join(pkgDir, 'src', 'index.js')).href);
const def = mod.default;

const ctx = {
  cfg: def.defaults(),
  dataDir: join(pkgDir, 'scratch', 'data'),
  botDir: join(pkgDir, 'scratch', 'bot'),
  packageDir: pkgDir,
  secret: () => '',
  storeSecret: () => {},
};
const world = def.create(ctx);
const docs = (world.webUi?.('zh')?.promptDocs ?? []).filter((doc) => doc.role === 'envPrompt' && existsSync(doc.path));
const prompts = docs.map((doc) => ({
  key: doc.key,
  title: doc.title,
  ...(doc.role ? { role: doc.role } : {}),
  content: readFileSync(doc.path, 'utf8'),
}));

const file = {
  tools: [...def.describe.tools],
  events: [...def.describe.events],
  ...(prompts.length ? { prompts } : {}),
};
writeFileSync(join(pkgDir, 'describe.json'), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
console.log(`describe.json 已写入：${file.tools.length} 个工具，${file.events.length} 个事件，${prompts.length} 份提示词。`);
