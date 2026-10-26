import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BIRD_INITIAL,
  BOWL_GRAMS,
  FARM_DEFAULTS,
  HOUR_MS,
  INITIAL_MOISTURE,
  INITIAL_POOL_LITERS,
  PEST_INITIAL,
  WATER_BOOST_POINTS,
  addRice,
  advanceFarm,
  advanceState,
  bellyLabel,
  buildScarecrow,
  cook,
  eat,
  farmConfig,
  farmStage,
  farmSummary,
  fertilizeField,
  fillPool,
  formatBowlsZh,
  harvestField,
  loadState,
  migrateState,
  moistureFactor,
  newState,
  saveState,
  sowField,
  stageLabel,
  stageOf,
  validState,
  waterField,
} from '../src/state.js';

test('newState: 饱食度满，米仓和电饭煲为空，电饭煲空闲，田里空着', () => {
  const s = newState(123);
  assert.equal(s.satiety, 100);
  assert.equal(s.riceGrams, 0);
  assert.equal(s.cookedGrams, 0);
  assert.equal(s.cooking, null);
  assert.equal(s.updatedAtMs, 123);
  assert.deepEqual(s.farm, {
    planted: false,
    plantedAtMs: 0,
    progress: 0,
    moisture: INITIAL_MOISTURE,
    fertilized: false,
    poolLiters: INITIAL_POOL_LITERS,
    lastRainAtMs: 0,
    pests: 0,
    birds: 0,
    scarecrow: 0,
    lastPestAtMs: 0,
    lastBirdAtMs: 0,
  });
});

/** 只留生长的稻田参数：不下雨、不闹虫、不来鸟，方便断言进度。 */
const quietFarm = (over = {}) => farmConfig({
  moistureDryPerHour: 0,
  rainChancePerHour: 0,
  pestChancePerHour: 0,
  birdChancePerHour: 0,
  ...over,
});

test('advanceState: 按小时扣饱食度，阶段只在跨过阈值时变化', () => {
  const s = newState(0);
  s.satiety = 70;
  const first = advanceState(s, 2 * HOUR_MS, 5);
  assert.equal(s.satiety, 60);
  assert.equal(first.fromStage, 0);
  assert.equal(first.toStage, 1);
  assert.equal(stageLabel(first.toStage), '有点饿了');

  const none = advanceState(s, 1 * HOUR_MS, 5);
  assert.equal(none.toStage, 1);
  assert.equal(none.fromStage, 1);

  const long = advanceState(s, 100 * HOUR_MS, 5);
  assert.equal(s.satiety, 0);
  assert.equal(long.toStage, 4);
  assert.equal(stageLabel(long.toStage), '饿得不行了');
});

test('advanceState: 消耗为 0 时只推进时间，不扣饱食度', () => {
  const s = newState(0);
  s.satiety = 55;
  const step = advanceState(s, 10 * HOUR_MS, 0);
  assert.equal(s.satiety, 55);
  assert.equal(step.hours, 10);
  assert.equal(step.toStage, 1);
});

test('cook: 先进入煮饭中，到点才变熟饭，且这一锅不能改量', () => {
  const s = newState(0);
  s.riceGrams = 1000;
  const result = cook(s, { bowls: 2, who: 'pet', cookerCapacityBowls: 6, cookMinutes: 1, nowMs: 0 });
  assert.equal(result.rawGrams, 200);
  assert.equal(result.producedGrams, 400);
  assert.equal(result.cookMs, 60000);
  assert.equal(s.riceGrams, 800);
  assert.equal(s.cookedGrams, 0);
  assert.equal(s.cooking.bowls, 2);
  assert.equal(s.cooking.finishesAtMs, 60000);

  // 煮饭中：不能开始下一锅，也不能改这一次的量。
  assert.throws(() => cook(s, { bowls: 1, who: 'pet', cookerCapacityBowls: 6, cookMinutes: 1, nowMs: 0 }), /正在煮两碗/);
  assert.throws(() => cook(s, { bowls: 4, who: 'pet', cookerCapacityBowls: 6, cookMinutes: 1, nowMs: 0 }), /正在煮/);

  const advanced = advanceState(s, 60000, 0);
  assert.equal(advanced.cookingFinished.bowls, 2);
  assert.equal(s.cooking, null);
  assert.equal(s.cookedGrams, 400);
});

test('cook: 米不够或锅放不下会失败', () => {
  const empty = newState(0);
  assert.throws(() => cook(empty, { bowls: 0.5, who: 'pet', cookerCapacityBowls: 6, cookMinutes: 1 }), /米仓/);

  const full = newState(0);
  full.riceGrams = 1000;
  full.cookedGrams = 1000;
  assert.throws(() => cook(full, { bowls: 2, who: 'pet', cookerCapacityBowls: 6, cookMinutes: 1 }), /只放得下/);
});

test('cook: 0.5 碗和 owner 角色都可用', () => {
  const s = newState(0);
  s.riceGrams = 1000;
  const result = cook(s, { bowls: 0.5, who: 'owner', cookerCapacityBowls: 6, cookMinutes: 1, nowMs: 0 });
  assert.equal(result.who, 'owner');
  assert.equal(result.rawGrams, 50);
  assert.equal(s.riceGrams, 950);
  assert.equal(s.cookedGrams, 0);
  assert.equal(s.cooking.bowls, 0.5);
  advanceState(s, 60000, 0);
  assert.equal(s.cookedGrams, 100);
  assert.throws(() => cook(s, { bowls: 1.2, who: 'pet', cookerCapacityBowls: 6, cookMinutes: 1 }), /半碗/);
  assert.throws(() => cook(s, { bowls: 1, who: 'cat', cookerCapacityBowls: 6, cookMinutes: 1 }), /who/);
});

test('eat: 宠物吃恢复饱食度，主人吃只消耗饭', () => {
  const s = newState(0);
  s.satiety = 70;
  s.cookedGrams = 3 * BOWL_GRAMS;
  const pet = eat(s, { bowls: 1, who: 'pet', satietyPerBowl: 25 });
  assert.equal(s.cookedGrams, 400);
  assert.equal(s.satiety, 95);
  assert.equal(pet.gained, 25);

  const owner = eat(s, { bowls: 1, who: 'owner', satietyPerBowl: 25 });
  assert.equal(s.cookedGrams, 200);
  assert.equal(s.satiety, 95);
  assert.equal(owner.gained, 0);

  assert.throws(() => eat(s, { bowls: 3, who: 'pet', satietyPerBowl: 25 }), /不够吃/);
});

test('eat: 饱食度封顶 100', () => {
  const s = newState(0);
  s.satiety = 90;
  s.cookedGrams = 2 * BOWL_GRAMS;
  const result = eat(s, { bowls: 1, who: 'pet', satietyPerBowl: 25 });
  assert.equal(s.satiety, 100);
  assert.equal(result.gained, 10);
});

test('eat: 宠物一次只吃一碗或半碗，想多吃就再盛一碗', () => {
  const s = newState(0);
  s.satiety = 50;
  s.cookedGrams = 3 * BOWL_GRAMS;
  assert.throws(
    () => eat(s, { bowls: 2, who: 'pet', maxBowls: 1, satietyPerBowl: 25 }),
    /一碗或半碗|一碗一碗/,
  );
  assert.equal(s.cookedGrams, 3 * BOWL_GRAMS);

  const half = eat(s, { bowls: 0.5, who: 'pet', maxBowls: 1, satietyPerBowl: 25 });
  assert.equal(half.grams, 100);
  assert.equal(s.satiety, 62.5);
  const whole = eat(s, { bowls: 1, who: 'pet', maxBowls: 1, satietyPerBowl: 25 });
  assert.equal(whole.grams, BOWL_GRAMS);
  assert.equal(s.satiety, 87.5);

  // 主人面板不受一碗限制。
  const owner = eat(s, { bowls: 1.5, who: 'owner', satietyPerBowl: 25 });
  assert.equal(owner.grams, 1.5 * BOWL_GRAMS);
  assert.equal(s.satiety, 87.5);
});

test('eat: 煮饭中还没有现成饭时不能吃，饭好后可以吃', () => {
  const s = newState(0);
  s.satiety = 50;
  s.riceGrams = 1000;
  cook(s, { bowls: 2, who: 'pet', cookerCapacityBowls: 6, cookMinutes: 1, nowMs: 0 });
  assert.throws(() => eat(s, { bowls: 1, who: 'pet', satietyPerBowl: 25 }), /正在煮两碗/);

  advanceState(s, 60000, 0);
  const meal = eat(s, { bowls: 1, who: 'pet', satietyPerBowl: 25 });
  assert.equal(meal.gained, 25);
  assert.equal(s.cookedGrams, 200);
});

test('addRice: 加米、容量上限和最小量', () => {
  const s = newState(0);
  const added = addRice(s, { kg: 0.5, riceCapacityGrams: 5000 });
  assert.equal(added.grams, 500);
  assert.equal(added.afterGrams, 500);
  assert.throws(() => addRice(s, { kg: 10, riceCapacityGrams: 5000 }), /只加得下/);
  assert.throws(() => addRice(s, { kg: 0.05, riceCapacityGrams: 5000 }), /至少/);

  s.riceGrams = 5000;
  assert.throws(() => addRice(s, { kg: 0.1, riceCapacityGrams: 5000 }), /已经满了/);
});

test('formatBowlsZh: 半碗、一碗、一碗半、两碗', () => {
  assert.equal(formatBowlsZh(0.5), '半碗');
  assert.equal(formatBowlsZh(1), '一碗');
  assert.equal(formatBowlsZh(1.5), '一碗半');
  assert.equal(formatBowlsZh(2), '两碗');
  assert.equal(formatBowlsZh(2.5), '两碗半');
  assert.equal(formatBowlsZh(10), '十碗');
  assert.equal(formatBowlsZh(12.5), '十二碗半');
  assert.equal(formatBowlsZh(20), '二十碗');
  assert.equal(formatBowlsZh(0), '0 碗');
});

test('bellyLabel: 肚子感觉跟着饥饿阶段走', () => {
  assert.equal(bellyLabel(100), '撑得有点坐不住');
  assert.equal(bellyLabel(85), '肚子饱饱的');
  assert.equal(bellyLabel(70), '有点饱了');
  assert.equal(bellyLabel(50), '还有点饿');
  assert.equal(bellyLabel(20), '肚子空落落的');
  assert.equal(bellyLabel(10), '饿得慌');
  assert.equal(bellyLabel(0), '饿得前胸贴后背');
});

test('stageOf: 阈值边界', () => {
  assert.equal(stageOf(100), 0);
  assert.equal(stageOf(60.1), 0);
  assert.equal(stageOf(60), 1);
  assert.equal(stageOf(35.1), 1);
  assert.equal(stageOf(35), 2);
  assert.equal(stageOf(15.1), 2);
  assert.equal(stageOf(15), 3);
  assert.equal(stageOf(0.1), 3);
  assert.equal(stageOf(0), 4);
});

test('validState / migrateState: 坏数据会被拒绝，v1 存档会补一块空田', () => {
  const s = newState(456);
  assert.equal(validState(s), true);
  assert.equal(migrateState(s).updatedAtMs, 456);
  assert.equal(validState({ ...s, satiety: 101 }), false);
  assert.equal(validState({ ...s, satiety: -1 }), false);
  assert.equal(validState({ ...s, riceGrams: -1 }), false);
  assert.equal(validState({ ...s, version: 4 }), false);
  assert.equal(validState(null), false);
  assert.equal(validState({ ...s, farm: { ...s.farm, progress: 101 } }), false);
  assert.equal(validState({ ...s, farm: { ...s.farm, planted: false, progress: 12 } }), false);
  assert.equal(validState({ ...s, farm: null }), false);

  const cooking = { startedAtMs: 0, finishesAtMs: 60000, bowls: 1, rawGrams: 100, producedGrams: 200 };
  assert.equal(validState({ ...s, cooking }), true);
  assert.equal(migrateState({ ...s, cooking }).cooking.bowls, 1);
  assert.equal(validState({ ...s, cooking: { ...cooking, bowls: 0 } }), false);
  assert.throws(() => migrateState({ version: 4 }), /格式/);

  // v1 是没有稻田的旧存档：读进来补一块空田，其余字段原样保留。
  const { farm, ...v1 } = s;
  assert.equal(farm.planted, false);
  const upgraded = migrateState({ ...v1, version: 1 });
  assert.equal(upgraded.version, 3);
  assert.equal(upgraded.satiety, s.satiety);
  assert.equal(upgraded.farm.planted, false);
  assert.equal(upgraded.farm.poolLiters, INITIAL_POOL_LITERS);

  // v2 有田但没有虫鸟稻草人：缺的键补 0，别把存档判成坏的。
  const { pests, birds, scarecrow, lastPestAtMs, lastBirdAtMs, ...v2Farm } = farm;
  assert.equal([pests, birds, scarecrow, lastPestAtMs, lastBirdAtMs].length, 5);
  const upgradedV2 = migrateState({ ...s, version: 2, farm: v2Farm });
  assert.equal(upgradedV2.version, 3);
  assert.equal(upgradedV2.farm.pests, 0);
  assert.equal(upgradedV2.farm.scarecrow, 0);
});

test('farmStage: 阶段按进度切换，100 就是成熟', () => {
  assert.equal(farmStage(0).name, '发芽期');
  assert.equal(farmStage(9.9).name, '发芽期');
  assert.equal(farmStage(10).name, '幼苗期');
  assert.equal(farmStage(30).name, '分蘖期');
  assert.equal(farmStage(55).name, '抽穗期');
  assert.equal(farmStage(80).name, '灌浆期');
  assert.equal(farmStage(99.9).name, '灌浆期');
  assert.equal(farmStage(100).name, '成熟期');
  assert.equal(farmStage(100).waterFactor, 0);
  assert.equal(farmStage(0).waterFactor, 1.6);
});

test('水分: 干土也有底速，浇透才是满速', () => {
  assert.equal(moistureFactor(0), 0.3);
  assert.equal(moistureFactor(100), 1);
  assert.ok(moistureFactor(50) > moistureFactor(20));
});

test('advanceState: 水稻按水分生长，水分同时蒸发', () => {
  const s = newState(0);
  sowField(s, { nowMs: 0 });
  s.farm.moisture = 100;
  const cfg = quietFarm({ moistureDryPerHour: 10, growHours: 24 });
  advanceState(s, 2 * HOUR_MS, 0, { farm: cfg, random: () => 1 });
  // 2 小时：水分 100 → 80，平均 90 → 倍率 0.93，进度 ≈ 100/24*0.93*2 = 7.75
  assert.ok(Math.abs(s.farm.moisture - 80) < 1e-6);
  assert.ok(s.farm.progress > 7 && s.farm.progress < 8.5, `进度 ${s.farm.progress}`);

  // 田里没种东西时只掉水分，不涨进度。
  const empty = newState(0);
  advanceState(empty, 2 * HOUR_MS, 0, { farm: cfg, random: () => 1 });
  assert.equal(empty.farm.progress, 0);
  assert.ok(empty.farm.moisture < INITIAL_MOISTURE);
});

test('advanceState: 下雨等于免费浇一次水，还往水池补水', () => {
  const s = newState(0);
  sowField(s, { nowMs: 0 });
  s.farm.moisture = 10;
  s.farm.poolLiters = 20;
  const cfg = quietFarm({ rainChancePerHour: 0.2 });
  const step = advanceState(s, HOUR_MS, 0, { farm: cfg, random: () => 0 });
  // 1 小时被切成两个半步，每步都会落一场雨。
  assert.equal(step.farm.rains, 2);
  assert.ok(step.farm.rain, '应该下雨');
  assert.equal(step.farm.rain.watered, true);
  assert.equal(step.farm.rain.poolAfter, 20 + cfg.rainWaterLiters * 2);
  assert.ok(s.farm.moisture > cfg.moisturePerWatering);
  assert.equal(s.farm.lastRainAtMs, HOUR_MS);
  assert.ok(s.farm.progress >= WATER_BOOST_POINTS * 1.6);

  // rollEvents=false 的预览不会掷雨，也不会掷虫鸟。
  const preview = newState(0);
  sowField(preview, { nowMs: 0 });
  const none = advanceState(preview, HOUR_MS, 0, { farm: cfg, random: () => 0, rollEvents: false });
  assert.equal(none.farm.rain, null);
  assert.equal(preview.farm.lastRainAtMs, 0);
  assert.equal(preview.farm.pests, 0);
});

test('waterField: 扣水池、补水分、按阶段推进进度', () => {
  const s = newState(0);
  sowField(s, { nowMs: 0 });
  s.farm.moisture = 50;
  const cfg = farmConfig({});
  const first = waterField(s, cfg);
  assert.equal(first.cost, cfg.waterPerWatering);
  assert.equal(s.farm.poolLiters, INITIAL_POOL_LITERS - cfg.waterPerWatering);
  assert.equal(s.farm.moisture, 85);
  assert.equal(first.boost, 4.8);
  assert.equal(s.farm.progress, first.boost);

  // 抽穗期浇水效果比灌浆期强。
  const heading = newState(0);
  sowField(heading, { nowMs: 0 });
  heading.farm.progress = 60;
  const headingBoost = waterField(heading, cfg).boost;

  const filling = newState(0);
  sowField(filling, { nowMs: 0 });
  filling.farm.progress = 85;
  const fillingBoost = waterField(filling, cfg).boost;
  assert.ok(headingBoost > fillingBoost, `${headingBoost} 应大于 ${fillingBoost}`);

  // 空田、成熟、水池没水都会失败。
  assert.throws(() => waterField(newState(0), cfg), /先播种/);
  const ripe = newState(0);
  sowField(ripe, { nowMs: 0 });
  ripe.farm.progress = 100;
  assert.throws(() => waterField(ripe, cfg), /已经成熟/);
  const dry = newState(0);
  sowField(dry, { nowMs: 0 });
  dry.farm.poolLiters = 1;
  assert.throws(() => waterField(dry, cfg), /水池里只有/);
});

test('fertilizeField: 整季一次，只提高产量', () => {
  const s = newState(0);
  sowField(s, { nowMs: 0 });
  const cfg = farmConfig({});
  const result = fertilizeField(s, cfg);
  assert.equal(s.farm.fertilized, true);
  assert.equal(result.yieldKg, cfg.harvestYieldKg * cfg.fertilizeYieldBonus);
  assert.throws(() => fertilizeField(s, cfg), /已经施过肥/);

  const ripe = newState(0);
  sowField(ripe, { nowMs: 0 });
  ripe.farm.progress = 100;
  assert.throws(() => fertilizeField(ripe, cfg), /成熟/);

  // 重新播种才会重置。
  s.farm.progress = 100;
  harvestField(s, { ...cfg, riceCapacityGrams: 5000, random: () => 1 });
  assert.equal(s.farm.fertilized, false);
  sowField(s, { nowMs: 0 });
  fertilizeField(s, cfg);
  assert.equal(s.farm.fertilized, true);
});

test('harvestField: 成熟才能收，稻谷进米仓，田重新空出来', () => {
  const s = newState(0);
  sowField(s, { nowMs: 0 });
  const cfg = farmConfig({});
  s.farm.progress = 99;
  assert.throws(() => harvestField(s, { ...cfg, riceCapacityGrams: 5000, random: () => 1 }), /没成熟/);

  s.farm.progress = 100;
  const result = harvestField(s, { ...cfg, riceCapacityGrams: 5000, random: () => 1 });
  assert.equal(result.grams, Math.round(cfg.harvestYieldKg * 1000));
  assert.equal(s.riceGrams, result.grams);
  assert.equal(s.farm.planted, false);
  assert.equal(s.farm.progress, 0);
  assert.equal(s.farm.fertilized, false);

  // 米仓放不下就整单失败，不会丢一半。
  const tight = newState(0);
  sowField(tight, { nowMs: 0 });
  tight.farm.progress = 100;
  tight.riceGrams = 4900;
  assert.throws(() => harvestField(tight, { ...cfg, riceCapacityGrams: 5000, random: () => 1 }), /只放得下/);
  assert.equal(tight.farm.planted, true);
});

test('收割彩蛋: 米仓越空越容易多收一点点', () => {
  const cfg = quietFarm({ harvestBonusChance: 0.06 });
  const ripe = (riceGrams) => {
    const s = newState(0);
    sowField(s, { nowMs: 0 });
    s.farm.progress = 100;
    s.riceGrams = riceGrams;
    return s;
  };

  // 空仓：6% 的概率，0.05 的骰子能中；多收基础产量的 5%–15%，按 5 g 取整。
  const hit = harvestField(ripe(0), { ...cfg, riceCapacityGrams: 5000, random: () => 0.05 });
  assert.equal(hit.baseGrams, 1500);
  assert.ok(hit.luckyGrams >= 75 && hit.luckyGrams <= 225, `lucky=${hit.luckyGrams}`);
  assert.equal(hit.luckyGrams % 5, 0);
  assert.equal(hit.grams, hit.baseGrams + hit.luckyGrams);

  // 半仓：概率降到 3%，同一个骰子不中。
  const miss = harvestField(ripe(2500), { ...cfg, riceCapacityGrams: 5000, random: () => 0.05 });
  assert.equal(miss.luckyGrams, 0);
  assert.equal(miss.grams, 1500);

  // 米仓刚好只放得下基础产量：不会因为彩蛋把收割搞失败。
  const tight = harvestField(ripe(3500), { ...cfg, riceCapacityGrams: 5000, random: () => 0 });
  assert.equal(tight.luckyGrams, 0);
  assert.equal(tight.grams, 1500);

  // 概率配 0 就永远没有。
  const off = harvestField(ripe(0), { ...cfg, harvestBonusChance: 0, riceCapacityGrams: 5000, random: () => 0 });
  assert.equal(off.luckyGrams, 0);

  // 预计产量不包含彩蛋，桌宠得自己对一下才会发现。
  assert.equal(farmSummary(ripe(0), cfg).expectedYieldKg, 1.5);
});

test('fillPool: 打水受容量限制', () => {
  const s = newState(0);
  const cfg = farmConfig({});
  const filled = fillPool(s, { liters: 100, ...cfg });
  assert.equal(filled.afterLiters, INITIAL_POOL_LITERS + 100);
  assert.throws(() => fillPool(s, { liters: 100, ...cfg }), /只打得进|已经满了/);
  assert.throws(() => fillPool(s, { liters: 0, ...cfg }), /大于 0/);
  assert.throws(() => fillPool(s, { liters: 501, ...cfg }), /最多打 500/);
});

test('farmConfig: 缺省与越界都会被夹住', () => {
  const cfg = farmConfig({});
  assert.equal(cfg.growHours, FARM_DEFAULTS.growHours);
  assert.equal(farmConfig({ growHours: -5 }).growHours, 0.5);
  assert.equal(farmConfig({ growHours: 99999 }).growHours, 720);
  assert.equal(farmConfig({ fertilizeYieldBonus: 0.2 }).fertilizeYieldBonus, 1);
  assert.equal(farmConfig({}).pestChancePerHour, FARM_DEFAULTS.pestChancePerHour);
  assert.equal(farmConfig({ scarecrowHours: 0 }).scarecrowHours, 1);
});

test('虫灾: 虫口自己会退，退之前一直啃进度', () => {
  const s = newState(0);
  sowField(s, { nowMs: 0 });
  s.farm.progress = 50;
  s.farm.pests = PEST_INITIAL;
  const cfg = quietFarm({ growHours: 1000 });
  advanceFarm(s, 0, 4 * HOUR_MS, cfg, () => 1, false);
  assert.equal(s.farm.pests, 28); // 每小时净减 3
  assert.ok(s.farm.progress < 50, '虫应该啃掉一些进度');

  advanceFarm(s, 4 * HOUR_MS, 14 * HOUR_MS, cfg, () => 1, false);
  assert.equal(s.farm.pests, 0);
  assert.equal(s.farm.birds, 0);
});

test('鸟灾: 先吃虫，虫吃光了才啄稻穗', () => {
  const s = newState(0);
  sowField(s, { nowMs: 0 });
  s.farm.progress = 50;
  s.farm.pests = 40;
  s.farm.birds = BIRD_INITIAL;
  const cfg = quietFarm({ growHours: 1000 });
  advanceFarm(s, 0, HOUR_MS, cfg, () => 1, false);
  assert.ok(s.farm.pests < 5, `虫应该被吃掉大半：${s.farm.pests}`);
  assert.ok(s.farm.progress > 49, '吃虫期间不该大幅啄稻子');
  const afterPests = s.farm.progress;

  advanceFarm(s, HOUR_MS, 4 * HOUR_MS, cfg, () => 1, false);
  assert.equal(s.farm.pests, 0);
  assert.ok(s.farm.progress < afterPests, '虫没了就该啄稻穗');
});

test('稻草人: 立刻赶鸟、挡住新鸟群、到点自己倒', () => {
  const s = newState(0);
  sowField(s, { nowMs: 0 });
  s.farm.progress = 40;
  s.farm.pests = 40;
  s.farm.birds = BIRD_INITIAL;
  const cfg = quietFarm({ growHours: 1000, birdChancePerHour: 6 });
  const built = buildScarecrow(s, cfg);
  assert.equal(built.chased, BIRD_INITIAL);
  assert.equal(s.farm.birds, 0);
  assert.equal(s.farm.pests, 40, '稻草人不管虫');
  assert.equal(s.farm.scarecrow, 100);
  assert.throws(() => buildScarecrow(s, cfg), /还立着/);

  // 立着的时候怎么掷都不会来鸟。
  advanceFarm(s, 0, 71 * HOUR_MS, cfg, () => 0, true);
  assert.equal(s.farm.birds, 0);
  assert.ok(s.farm.scarecrow > 0);

  advanceFarm(s, 71 * HOUR_MS, 72 * HOUR_MS, cfg, () => 0, true);
  assert.equal(s.farm.scarecrow, 0);
  // 倒了以后鸟又能落下来。
  advanceFarm(s, 72 * HOUR_MS, 73 * HOUR_MS, cfg, () => 0, true);
  assert.ok(s.farm.birds > 0);
});

test('旱情: 土壤干透才标记，浇上水就解除', () => {
  const s = newState(0);
  sowField(s, { nowMs: 0 });
  const cfg = quietFarm();
  s.farm.moisture = 3;
  assert.equal(farmSummary(s, cfg).drought, true);
  s.farm.moisture = 40;
  assert.equal(farmSummary(s, cfg).drought, false);
  s.farm.moisture = 0;
  s.farm.progress = 100;
  assert.equal(farmSummary(s, cfg).drought, false, '成熟了就不算旱情');
});

test('收割: 虫和鸟随田一起清空，稻草人留着继续老化', () => {
  const s = newState(0);
  sowField(s, { nowMs: 0 });
  s.farm.progress = 100;
  s.farm.pests = 30;
  s.farm.birds = 40;
  s.farm.scarecrow = 55;
  harvestField(s, { ...quietFarm(), riceCapacityGrams: 5000, random: () => 1 });
  assert.equal(s.farm.pests, 0);
  assert.equal(s.farm.birds, 0);
  assert.equal(s.farm.scarecrow, 55);
  assert.equal(s.farm.planted, false);
});

test('saveState / loadState: 原子落盘并读回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eat-state-'));
  try {
    const file = join(dir, 'eat', 'state.json');
    const s = newState(789);
    s.satiety = 80;
    s.riceGrams = 2000;
    await saveState(file, s);
    const again = await loadState(file);
    assert.deepEqual(again, s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
