#!/usr/bin/env node
/**
 * 离线自检：不联网、不碰安装目录、不启动 World。
 * 检查清单、工具声明、配置路径、事件、环境提示词，以及状态模型的几条底线。
 * 跑法：node tools/check.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'eat-check-'));
let passed = 0;
let failed = 0;

const ok = (line) => { passed += 1; console.log(`  ok    ${line}`); };
const bad = (line) => { failed += 1; console.log(`  FAIL  ${line}`); };
const check = (label, fn) => {
  try {
    fn();
    ok(label);
  } catch (err) {
    bad(`${label} — ${err?.message ?? err}`);
  }
};
async function checkAsync(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (err) {
    bad(`${label} — ${err?.message ?? err}`);
  }
}

/** 键序无关的 JSON 形态：对比 describe.json 与代码里的声明。 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

const mod = await import(pathToFileURL(join(pkgDir, 'src', 'index.js')).href);
const def = mod.default;
const config = await import(pathToFileURL(join(pkgDir, 'src', 'config.js')).href);
const state = await import(pathToFileURL(join(pkgDir, 'src', 'state.js')).href);

try {
  console.log('清单与声明');

  check('package.json 的 cortico 段与 describe', () => {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'cortico-world-eat');
    assert.equal(manifest.cortico?.kind, 'world');
    assert.equal(manifest.cortico?.api, 6);
    assert.equal(manifest.cortico?.displayName, '吃饭');
    assert.equal(manifest.cortico?.describe, 'describe.json');
    assert.equal(manifest.cortico?.webUiClient, 'dist/webui.js');
    assert.ok(existsSync(join(pkgDir, 'describe.json')), 'describe.json 不在包里');
    assert.ok(existsSync(join(pkgDir, 'dist', 'webui.js')), 'dist/webui.js 不在包里');
    assert.ok(Array.isArray(manifest.files) && manifest.files.includes('describe.json'));
    assert.ok(Array.isArray(manifest.files) && manifest.files.includes('dist'));
    assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.includes('cortico-world'));
  });

  check('CHANGELOG.md 有当前版本的一节', () => {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const src = readFileSync(join(pkgDir, 'CHANGELOG.md'), 'utf8');
    const version = String(manifest.version ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.ok(new RegExp(`^##\\s*\\[?${version}\\]?`, 'm').test(src), `CHANGELOG.md 缺 ## ${manifest.version} 一节`);
  });

  check('默认导出是 WorldDefinition', () => {
    assert.equal(def.id, 'eat');
    assert.equal(def.label, '吃饭');
    const defaults = def.defaults();
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.hungerPerHour, 5);
    assert.equal(defaults.satietyPerBowl, 25);
    assert.equal(defaults.riceBinCapacityKg, 5);
    assert.equal(defaults.cookerCapacityBowls, 6);
    assert.equal(defaults.cookMinutes, 30);
    assert.equal(defaults.growHours, 24);
    assert.equal(defaults.rainChancePerHour, 0.2);
    assert.equal(defaults.harvestYieldKg, 1.5);
    assert.equal(defaults.fertilizeYieldBonus, 1.5);
    assert.equal(defaults.pestChancePerHour, 0.03);
    assert.equal(defaults.birdChancePerHour, 0.03);
    assert.equal(defaults.scarecrowHours, 72);
    assert.equal(defaults.harvestBonusChance, 0.06);
    assert.equal(Object.hasOwn(defaults, 'initialSatiety'), false);
    assert.equal(Object.hasOwn(defaults, 'initialRiceKg'), false);
    assert.equal(Object.hasOwn(defaults, 'initialCookedBowls'), false);
    def.preflight?.();
  });

  check('describe 与 describe.json 一致，实例工具都在声明里', () => {
    assert.equal(def.describe.tools.length, 9);
    assert.equal(def.describe.events.length, 2);
    const file = JSON.parse(readFileSync(join(pkgDir, 'describe.json'), 'utf8'));
    const world = def.create({
      cfg: def.defaults(),
      dataDir: join(scratch, 'data'),
      botDir: join(scratch, 'bot'),
      packageDir: pkgDir,
    });
    const docs = (world.webUi('zh').promptDocs ?? []).filter((doc) => doc.role === 'envPrompt' && existsSync(doc.path));
    const prompts = docs.map((doc) => ({
      key: doc.key,
      title: doc.title,
      ...(doc.role ? { role: doc.role } : {}),
      content: readFileSync(doc.path, 'utf8'),
    }));
    const expected = JSON.parse(JSON.stringify({
      tools: def.describe.tools,
      events: def.describe.events,
      ...(prompts.length ? { prompts } : {}),
    }));
    assert.equal(stable(file), stable(expected), 'describe.json 与代码里的 describe 不一致');
    assert.equal(file.events[0].type, 'eat.hunger');
    assert.equal(file.events[0].trigger, 'debounce');
    assert.equal(file.events[1].type, 'eat.cooked');
    assert.equal(file.events[1].trigger, 'debounce');
    assert.ok(file.prompts?.[0]?.content.trim().length > 0, '环境提示词模板不应为空');
    const names = new Set(file.tools.map((t) => t.name));
    for (const tool of world.tools()) assert.ok(names.has(tool.name), `工具 ${tool.name} 不在 describe.tools 里`);
  });

  check('工具形状与标签', () => {
    const world = def.create({
      cfg: def.defaults(),
      dataDir: join(scratch, 'data'),
      botDir: join(scratch, 'bot'),
      packageDir: pkgDir,
    });
    const tools = world.tools();
    const names = tools.map((t) => t.name);
    assert.deepEqual(names, [
      'eat_status',
      'eat_cook',
      'eat_meal',
      'farm_status',
      'farm_sow',
      'farm_water',
      'farm_fertilize',
      'farm_harvest',
      'farm_scarecrow',
    ]);
    assert.equal(new Set(names).size, names.length);
    for (const tool of tools) {
      assert.ok(Array.isArray(tool.tags) && tool.tags.length > 0, `${tool.name} 缺 tags`);
      assert.equal(tool.parameters?.type, 'object', `${tool.name} 参数不是 object`);
      assert.equal(typeof tool.handler, 'function', `${tool.name} 缺 handler`);
      assert.ok(/^(eat|farm)_/.test(tool.name), `${tool.name} 前缀不对`);
    }
    assert.ok(tools[0].tags.includes('read'));
    assert.ok(tools[1].tags.includes('write'));
    assert.equal(tools[1].parameters.required?.[0], 'bowls');
    assert.equal(tools[2].parameters.required?.[0], 'bowls');
    assert.equal(Object.hasOwn(tools[1].parameters.properties, 'who'), false);
    assert.equal(Object.hasOwn(tools[2].parameters.properties, 'who'), false);
    assert.equal(tools.some((tool) => tool.name === 'eat_add_rice'), false);
    assert.equal(tools.some((tool) => tool.name === 'farm_fill_pool'), false);
    // 稻田工具都不要参数：桌宠只描述“做什么”，不填量。
    for (const tool of tools.filter((item) => item.name.startsWith('farm_'))) {
      assert.deepEqual(Object.keys(tool.parameters.properties ?? {}), [], `${tool.name} 不该要参数`);
    }
  });

  await checkAsync('WebUI 厨房面板与稻田面板声明与 data plane', async () => {
    const world = def.create({
      cfg: def.defaults(),
      dataDir: join(scratch, 'data'),
      botDir: join(scratch, 'bot'),
      packageDir: pkgDir,
    });
    const decl = world.webUi('zh');
    assert.ok(decl.panels?.some((panel) => panel.id === 'kitchen'), '缺 kitchen 面板');
    assert.ok(decl.panels?.some((panel) => panel.id === 'farm'), '缺 farm 面板');
    assert.equal(typeof decl.invoke, 'function', '缺 invoke');
    const bundle = await import(pathToFileURL(join(pkgDir, 'dist', 'webui.js')).href);
    assert.equal(typeof bundle.default?.panels?.kitchen?.mount, 'function', '浏览器 bundle 缺 kitchen.mount');
    assert.equal(typeof bundle.default?.panels?.farm?.mount, 'function', '浏览器 bundle 缺 farm.mount');
  });

  check('配置组覆盖 DEFAULTS 的其余键（enabled 由框架开关管理），且都在 worlds.eat 段内', () => {
    const group = config.configGroup('zh');
    const paths = Object.keys(group.schema.properties);
    assert.equal(group.owner, 'world:eat');
    for (const path of paths) {
      assert.ok(path.startsWith('worlds.eat.'), `配置路径不在 worlds.eat：${path}`);
      const short = path.slice('worlds.eat.'.length);
      assert.ok(Object.hasOwn(config.DEFAULTS, short), `配置 ${short} 没有默认值`);
    }
    for (const short of Object.keys(config.DEFAULTS)) {
      if (short === 'enabled') {
        assert.ok(!paths.includes('worlds.eat.enabled'), 'World 启用开关由框架渲染，不该进配置 schema');
        continue;
      }
      assert.ok(paths.includes(`worlds.eat.${short}`), `默认值 ${short} 没有进 schema`);
    }
  });

  console.log('状态模型');

  check('初始状态、时间结算与饥饿阶段', () => {
    const s = state.newState(0);
    assert.equal(s.satiety, 100);
    assert.equal(s.riceGrams, 0);
    assert.equal(s.cookedGrams, 0);
    assert.equal(s.cooking, null);
    s.satiety = 70;
    s.riceGrams = 1000;
    const step = state.advanceState(s, 2 * state.HOUR_MS, 5);
    assert.equal(step.fromStage, 0);
    assert.equal(step.toStage, 1);
    assert.equal(s.satiety, 60);
    const long = state.advanceState(s, 100 * state.HOUR_MS, 5);
    assert.equal(long.toStage, 4);
    assert.equal(s.satiety, 0);
  });

  check('做饭、吃饭、加米与容量', () => {
    const s = state.newState(0);
    s.satiety = 70;
    s.riceGrams = 1000;
    const cooked = state.cook(s, { bowls: 2, who: 'pet', cookerCapacityBowls: 6, cookMinutes: 1, nowMs: 0 });
    assert.equal(cooked.rawGrams, 200);
    assert.equal(s.riceGrams, 800);
    assert.equal(s.cookedGrams, 0);
    assert.equal(s.cooking.bowls, 2);
    assert.throws(() => state.cook(s, { bowls: 1, who: 'pet', cookerCapacityBowls: 6, cookMinutes: 1, nowMs: 0 }), /正在煮/);

    const advanced = state.advanceState(s, 60_000, 0);
    assert.equal(advanced.cookingFinished.bowls, 2);
    assert.equal(s.cooking, null);
    assert.equal(s.cookedGrams, 400);

    const meal = state.eat(s, { bowls: 1, who: 'pet', satietyPerBowl: 25 });
    assert.equal(s.cookedGrams, 200);
    assert.equal(s.satiety, 95);
    assert.equal(meal.gained, 25);
    const ownerMeal = state.eat(s, { bowls: 1, who: 'owner', satietyPerBowl: 25 });
    assert.equal(s.cookedGrams, 0);
    assert.equal(s.satiety, 95);
    assert.equal(ownerMeal.gained, 0);
    const added = state.addRice(s, { kg: 0.5, riceCapacityGrams: 5000 });
    assert.equal(added.afterGrams, 1300);
    assert.throws(() => state.cook(s, { bowls: 6.5, who: 'pet', cookerCapacityBowls: 6, cookMinutes: 1 }), /电饭煲/);
  });

  check('状态文件校验与迁移', () => {
    const s = state.newState(123);
    assert.ok(state.validState(s));
    assert.equal(state.migrateState(s).updatedAtMs, 123);
    assert.equal(state.validState({ ...s, satiety: 101 }), false);
    assert.equal(state.validState({ ...s, riceGrams: -1 }), false);
    assert.equal(state.validState({ ...s, version: 4 }), false);
    assert.equal(state.validState({ ...s, farm: null }), false);
    const { farm, ...v1 } = s;
    assert.ok(farm.planted === false);
    assert.ok(state.validState({ ...v1, version: 1 }));
    assert.equal(state.migrateState({ ...v1, version: 1 }).farm.poolLiters, state.INITIAL_POOL_LITERS);
  });

  check('稻田: 播种、浇水、施肥、收割与下雨', () => {
    const cfg = state.farmConfig({ moistureDryPerHour: 0, growHours: 1, rainChancePerHour: 0, pestChancePerHour: 0, birdChancePerHour: 0 });
    const s = state.newState(0);
    assert.equal(s.farm.planted, false);

    state.sowField(s, { nowMs: 0 });
    assert.equal(s.farm.planted, true);
    assert.equal(s.farm.progress, 0);

    const water = state.waterField(s, cfg);
    assert.equal(water.cost, cfg.waterPerWatering);
    assert.equal(s.farm.poolLiters, state.INITIAL_POOL_LITERS - cfg.waterPerWatering);
    assert.ok(s.farm.progress > 0);
    assert.equal(water.boost, 4.8); // 发芽期 ×1.6 × 3 点

    assert.equal(state.farmStage(85).name, '灌浆期');
    assert.equal(state.farmStage(100).name, '成熟期');
    assert.ok(state.farmStage(0).waterFactor > state.farmStage(85).waterFactor);

    const fert = state.fertilizeField(s, cfg);
    assert.equal(fert.yieldKg, 2.25);
    assert.throws(() => state.fertilizeField(s, cfg), /已经施过肥/);

    // 一小时、水分足够，应该刚好成熟。
    const step = state.advanceState(s, 2 * state.HOUR_MS, 0, { farm: cfg, random: () => 1 });
    assert.equal(step.farm.rain, null);
    assert.equal(s.farm.progress, 100);

    const harvest = state.harvestField(s, { ...cfg, riceCapacityGrams: 5000, random: () => 1 });
    assert.equal(harvest.grams, 2250);
    assert.equal(s.riceGrams, 2250);
    assert.equal(s.farm.planted, false);

    // 下雨：免费浇田 + 补水。
    const wet = state.newState(0);
    state.sowField(wet, { nowMs: 0 });
    wet.farm.moisture = 0;
    wet.farm.poolLiters = 10;
    const rainy = state.advanceState(wet, state.HOUR_MS, 0, {
      farm: state.farmConfig({ moistureDryPerHour: 0, pestChancePerHour: 0, birdChancePerHour: 0 }),
      random: () => 0,
    });
    assert.ok(rainy.farm.rain);
    // 1 小时切成两个半步，每步一场雨。
    assert.equal(rainy.farm.rains, 2);
    assert.equal(wet.farm.poolLiters, 10 + state.FARM_DEFAULTS.rainWaterLiters * 2);
    assert.ok(wet.farm.lastRainAtMs > 0);
  });

  check('灾害: 虫会啃进度，鸟先吃虫再吃稻，稻草人只赶鸟', () => {
    const cfg = state.farmConfig({
      moistureDryPerHour: 0, growHours: 1000, rainChancePerHour: 0,
      pestChancePerHour: 0, birdChancePerHour: 0,
    });

    const buggy = state.newState(0);
    state.sowField(buggy, { nowMs: 0 });
    buggy.farm.progress = 50;
    buggy.farm.pests = state.PEST_INITIAL;
    state.advanceFarm(buggy, 0, 4 * state.HOUR_MS, cfg, () => 1, false);
    assert.equal(buggy.farm.pests, 28);
    assert.ok(buggy.farm.progress < 50);

    const flock = state.newState(0);
    state.sowField(flock, { nowMs: 0 });
    flock.farm.progress = 50;
    flock.farm.pests = 40;
    flock.farm.birds = state.BIRD_INITIAL;
    state.advanceFarm(flock, 0, state.HOUR_MS, cfg, () => 1, false);
    assert.ok(flock.farm.pests < 5, '鸟先把虫吃掉');
    const afterPests = flock.farm.progress;
    state.advanceFarm(flock, state.HOUR_MS, 4 * state.HOUR_MS, cfg, () => 1, false);
    assert.equal(flock.farm.pests, 0);
    assert.ok(flock.farm.progress < afterPests, '虫没了就啄稻子');

    const guarded = state.newState(0);
    state.sowField(guarded, { nowMs: 0 });
    guarded.farm.progress = 40;
    guarded.farm.pests = 40;
    guarded.farm.birds = state.BIRD_INITIAL;
    const built = state.buildScarecrow(guarded, cfg);
    assert.equal(built.chased, state.BIRD_INITIAL);
    assert.equal(guarded.farm.birds, 0);
    assert.equal(guarded.farm.pests, 40, '稻草人不管虫');
    assert.throws(() => state.buildScarecrow(guarded, cfg), /还立着/);

    // 旱情：土壤干透才标记。
    const dry = state.newState(0);
    state.sowField(dry, { nowMs: 0 });
    dry.farm.moisture = 3;
    assert.equal(state.farmSummary(dry, cfg).drought, true);
    dry.farm.moisture = 40;
    assert.equal(state.farmSummary(dry, cfg).drought, false);
  });

  check('收割彩蛋: 米仓越空越容易多收一点，且只报总数', () => {
    const cfg = state.farmConfig({
      moistureDryPerHour: 0, growHours: 1000, rainChancePerHour: 0,
      pestChancePerHour: 0, birdChancePerHour: 0, harvestBonusChance: 0.06,
    });
    const ripe = (riceGrams) => {
      const s = state.newState(0);
      state.sowField(s, { nowMs: 0 });
      s.farm.progress = 100;
      s.riceGrams = riceGrams;
      return s;
    };

    const hit = state.harvestField(ripe(0), { ...cfg, riceCapacityGrams: 5000, random: () => 0.05 });
    assert.equal(hit.baseGrams, 1500);
    assert.ok(hit.luckyGrams >= 75 && hit.luckyGrams <= 225, '空仓应该多收一点');
    assert.equal(hit.grams, hit.baseGrams + hit.luckyGrams);

    const miss = state.harvestField(ripe(2500), { ...cfg, riceCapacityGrams: 5000, random: () => 0.05 });
    assert.equal(miss.luckyGrams, 0, '半仓时概率减半，同一个骰子不该中');

    // 预计产量不含彩蛋，桌宠只能自己对账发现。
    assert.equal(state.farmSummary(ripe(0), cfg).expectedYieldKg, 1.5);
  });

  await checkAsync('状态文件读写与跨重启保留', async () => {
    const file = join(scratch, 'state.json');
    const s = state.newState(456);
    s.satiety = 80;
    s.riceGrams = 2000;
    await state.saveState(file, s);
    const again = await state.loadState(file);
    assert.equal(again.satiety, 80);
    assert.equal(again.riceGrams, 2000);
    assert.equal(again.updatedAtMs, 456);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 项通过，${failed} 个失败`);
process.exit(failed === 0 ? 0 : 1);
