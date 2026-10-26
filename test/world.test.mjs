import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULTS } from '../src/config.js';
import { EatWorld } from '../src/world.js';

const root = mkdtempSync(join(tmpdir(), 'eat-world-'));
after(() => rmSync(root, { recursive: true, force: true }));

const START = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function makeClock(start = START) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (ms) => { t = ms; },
  };
}

/** 只够测试的 setTimeout / clearTimeout：手动把下一个回调跑掉。 */
function makeTimers() {
  let nextId = 1;
  const handles = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      handles.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      handles.delete(id);
    },
    runNext() {
      const entry = [...handles.entries()][0];
      if (!entry) return null;
      handles.delete(entry[0]);
      entry[1].fn();
      return entry[1].ms;
    },
    get size() {
      return handles.size;
    },
  };
}

function makeHost() {
  const events = [];
  return {
    events,
    host: {
      pushEvent: async (event, opts) => {
        events.push({ event, opts });
        return { ...event, cursor: events.length };
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    },
  };
}

async function until(predicate, message, tries = 2000) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    // 每 50 次让出一次宏任务：结算里要落盘，纯 setImmediate 空转在整包跑测试时可能抢不到 I/O。
    if (i > 0 && i % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    else await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

/** 跑一次定时结算，等它落盘并排好下一轮；返回这次新增的事件数。 */
async function runTick(rig) {
  const before = rig.events.length;
  const ms = rig.timers.runNext();
  assert.notEqual(ms, null, '没有排队的定时器');
  await until(() => rig.timers.size > 0, '下一轮定时器没有排上');
  return rig.events.length - before;
}

/** 让这一锅饭到点，并跑一次定时结算。 */
async function finishCook(rig, minutes = 1) {
  rig.clock.advance(minutes * 60_000);
  return runTick(rig);
}

let seq = 0;
function makeWorld(opts = {}) {
  seq += 1;
  const dataDir = opts.dataDir ?? join(root, `rig-${seq}`);
  const clock = makeClock(opts.start ?? START);
  const timers = makeTimers();
  const { host, events } = makeHost();
  const cfg = {
    ...DEFAULTS,
    enabled: true,
    // 默认把随机事件关掉，让绝大多数用例可复现；要测天气/灾害的用例自己开。
    rainChancePerHour: 0,
    pestChancePerHour: 0,
    birdChancePerHour: 0,
    ...opts.cfg,
  };
  // 默认给一个“永不中奖”的随机源，让用例可复现；要测随机事件的用例自己传 random。
  const world = new EatWorld({ cfg, dataDir, now: clock.now, timers, random: opts.random ?? (() => 1) });
  const call = async (name, args = {}) => {
    const tool = world.tools().find((item) => item.name === name);
    assert.ok(tool, `找不到工具 ${name}`);
    return tool.handler(args, {});
  };
  const invoke = (method, args = []) => world.invoke('kitchen', method, args);
  const farm = (method, args = []) => world.invoke('farm', method, args);
  return { world, host, events, clock, timers, dataDir, call, invoke, farm };
}

test('工具面: 桌宠有吃饭和种田工具，但没有加米/打水或 who', () => {
  const rig = makeWorld();
  const tools = rig.world.tools();
  assert.deepEqual(tools.map((tool) => tool.name), [
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
  assert.equal(tools.some((tool) => tool.name === 'eat_add_rice'), false);
  assert.equal(tools.some((tool) => tool.name === 'farm_fill_pool'), false);
  assert.equal(Object.hasOwn(tools[1].parameters.properties, 'who'), false);
  assert.equal(Object.hasOwn(tools[2].parameters.properties, 'who'), false);
  for (const tool of tools.filter((item) => item.name.startsWith('farm_'))) {
    assert.deepEqual(Object.keys(tool.parameters.properties ?? {}), [], `${tool.name} 不该要参数`);
  }
});

test('eat_status: 初始状态有饱食度、米仓和电饭煲', async () => {
  const rig = makeWorld();
  await rig.world.start(rig.host);

  const res = await rig.call('eat_status');
  assert.equal(res.failed, undefined);
  assert.match(res.text, /饱食度：100\/100（不饿）/);
  assert.match(res.text, /米仓：0\.00 kg 生米/);
  assert.match(res.text, /电饭煲：空的/);
  assert.match(res.text, /一碗熟饭 = 200 g/);
  assert.match(res.text, /一次只盛一碗或半碗/);

  assert.equal(rig.timers.size, 1);
  await rig.world.stop();
  assert.equal(rig.timers.size, 0);
});

test('eat_cook / eat_meal: 煮饭要等，饭好才能吃', async () => {
  const rig = makeWorld({ cfg: { cookMinutes: 1 } });
  await rig.world.start(rig.host);
  await rig.invoke('addRice', [1]);
  rig.clock.advance(6 * HOUR); // 100 -> 70
  assert.equal(await runTick(rig), 0);
  rig.world.cfg.hungerPerHour = 0;

  const cooked = await rig.call('eat_cook', { bowls: 2 });
  assert.equal(cooked.failed, undefined);
  assert.match(cooked.text, /够煮两碗的米淘好下了锅/);
  assert.match(cooked.text, /煮好之前不能再下第二锅/);
  assert.match(cooked.text, /用了 200 g 生米/);
  assert.match(cooked.text, /米仓里还剩 0\.80 kg/);

  const cooking = await rig.call('eat_status');
  assert.match(cooking.text, /电饭煲：正在煮两碗饭，约 1 分钟后好。这一锅的量已经定下。/);

  assert.equal(await finishCook(rig, 1), 1);
  const done = rig.events.at(-1).event;
  assert.equal(done.type, 'eat.cooked');
  assert.equal(done.meta.bowls, 2);

  const ready = await rig.call('eat_status');
  assert.match(ready.text, /电饭煲：两碗热饭/);

  const petMeal = await rig.call('eat_meal', { bowls: 1 });
  assert.match(petMeal.text, /一碗饭下肚，现在撑得有点坐不住。/);
  assert.match(petMeal.text, /锅里还剩一碗现成的饭/);

  // 一次只盛一碗：想多吃要再盛一次。
  const tooMuch = await rig.call('eat_meal', { bowls: 2 });
  assert.equal(tooMuch.failed, true);
  assert.match(tooMuch.text, /一碗或半碗|一碗一碗/);

  await rig.world.stop();
});

test('失败回执: 饭不够或米不够时不会凭空变出食物', async () => {
  const rig = makeWorld();
  await rig.world.start(rig.host);

  const noRice = await rig.call('eat_cook', { bowls: 20 });
  assert.equal(noRice.failed, true);
  assert.match(noRice.text, /米仓只有 0\.00 kg/);

  const noMeal = await rig.call('eat_meal', { bowls: 1 });
  assert.equal(noMeal.failed, true);
  assert.match(noMeal.text, /电饭煲里没有现成的饭/);

  const still = await rig.call('eat_status');
  assert.match(still.text, /米仓：0\.00 kg/);
  assert.match(still.text, /电饭煲：空的/);
  await rig.world.stop();
});

test('厨房面板: 主人加米、煮饭、吃饭；煮饭中锁定这一锅', async () => {
  const rig = makeWorld({ cfg: { cookMinutes: 1, hungerPerHour: 0 } });
  const beforeStart = await rig.invoke('state');
  assert.equal(beforeStart.started, false);

  await rig.world.start(rig.host);
  const decl = rig.world.webUi('zh');
  assert.ok(decl.panels?.some((panel) => panel.id === 'kitchen'), '缺 kitchen 面板');
  assert.equal(typeof decl.invoke, 'function');

  const state = await rig.invoke('state');
  assert.equal(state.started, true);
  assert.equal(state.riceKg, 0);
  assert.equal(state.cookedBowls, 0);
  assert.equal(state.satiety, 100);

  const added = await rig.invoke('addRice', [0.5]);
  assert.match(added.message, /主人往米仓加了 0\.50 kg 米/);
  assert.equal(added.state.riceKg, 0.5);

  const cooked = await rig.invoke('cook', [2]);
  assert.match(cooked.message, /主人开始煮 2 碗饭，约 1 分钟后好/);
  assert.match(cooked.message, /量已经锁定/);
  assert.equal(cooked.state.cooking.bowls, 2);
  assert.equal(cooked.state.cookedBowls, 0);
  assert.equal(cooked.state.riceKg, 0.3);
  assert.equal(cooked.state.satiety, 100);

  // 煮饭中：再点煮饭 / 桌宠再煮都会被拒绝；也没有现成饭可吃。
  await assert.rejects(() => rig.invoke('cook', [1]), /正在煮两碗/);
  const petCook = await rig.call('eat_cook', { bowls: 1 });
  assert.equal(petCook.failed, true);
  assert.match(petCook.text, /正在煮两碗/);
  const noMeal = await rig.call('eat_meal', { bowls: 1 });
  assert.equal(noMeal.failed, true);
  assert.match(noMeal.text, /正在煮两碗/);

  const mid = await rig.invoke('state');
  assert.equal(mid.cooking.bowls, 2);
  assert.equal(mid.cookedBowls, 0);

  assert.equal(await finishCook(rig, 1), 1);
  assert.equal(rig.events.at(-1).event.type, 'eat.cooked');
  const ready = await rig.invoke('state');
  assert.equal(ready.cooking, null);
  assert.equal(ready.cookedBowls, 2);

  const eaten = await rig.invoke('eat', [1]);
  assert.match(eaten.message, /主人吃了 1 碗饭/);
  assert.equal(eaten.state.cookedBowls, 1);
  assert.equal(eaten.state.satiety, 100);

  await rig.world.stop();
});

test('厨房面板: 加米受米仓容量限制', async () => {
  const rig = makeWorld();
  await rig.world.start(rig.host);

  const filled = await rig.invoke('addRice', [4.9]);
  assert.equal(filled.state.riceKg, 4.9);
  const added = await rig.invoke('addRice', [0.1]);
  assert.equal(added.state.riceKg, 5);

  await assert.rejects(() => rig.invoke('addRice', [0.1]), /米仓已经满了/);
  await rig.world.stop();
});

test('饥饿事件: 阶段只提醒一次，长时间离线只报最严重的阶段', async () => {
  const rig = makeWorld();
  await rig.world.start(rig.host);

  rig.clock.advance(8 * HOUR); // 100 -> 60, 阶段 1
  assert.equal(await runTick(rig), 1);
  assert.equal(rig.events[0].event.type, 'eat.hunger');
  assert.match(rig.events[0].event.text, /有点饿了/);
  assert.equal(rig.events[0].event.meta.stage, 1);
  assert.equal(rig.events[0].opts.trigger, 'debounce');

  // 同一阶段内再跑一次，不应重复提醒。
  assert.equal(await runTick(rig), 0);
  assert.equal(rig.events.length, 1);

  rig.clock.advance(5 * HOUR); // 60 -> 35, 阶段 2
  assert.equal(await runTick(rig), 1);
  assert.equal(rig.events.length, 2);
  assert.match(rig.events[1].event.text, /饿了/);
  assert.equal(rig.events[1].event.meta.stage, 2);

  rig.clock.advance(10 * HOUR); // 35 -> 0, 阶段 4（中间跨过阶段 3，但只报一次）
  assert.equal(await runTick(rig), 1);
  assert.equal(rig.events.length, 3);
  assert.match(rig.events[2].event.text, /饿得不行了/);
  assert.equal(rig.events[2].event.meta.stage, 4);

  await rig.world.stop();
});

test('吃回去之后，下一次掉到同一阶段会重新提醒', async () => {
  const rig = makeWorld({ cfg: { cookMinutes: 1 } });
  await rig.world.start(rig.host);

  rig.clock.advance(8 * HOUR); // 100 -> 60, 阶段 1
  assert.equal(await runTick(rig), 1);

  await rig.invoke('addRice', [1]);
  await rig.call('eat_cook', { bowls: 2 });
  assert.equal(await finishCook(rig, 1), 1); // 饭好事件
  await rig.call('eat_meal', { bowls: 1 }); // 60 -> 85
  await rig.call('eat_meal', { bowls: 1 }); // 85 -> 100
  const status = await rig.call('eat_status');
  assert.match(status.text, /饱食度：100\/100（不饿）/);

  rig.clock.advance(8 * HOUR); // 100 -> 60, 阶段 1
  assert.equal(await runTick(rig), 1);
  assert.equal(rig.events.length, 3);
  assert.match(rig.events.at(-1).event.text, /有点饿了/);

  await rig.world.stop();
});

test('跨重启保留: 米仓、电饭煲和饱食度都接着上次算', async () => {
  const dataDir = join(root, 'persist');
  const rig1 = makeWorld({ dataDir, cfg: { cookMinutes: 1, hungerPerHour: 0 } });
  await rig1.world.start(rig1.host);
  await rig1.invoke('addRice', [1]);
  await rig1.call('eat_cook', { bowls: 2 });
  assert.equal(await finishCook(rig1, 1), 1);
  await rig1.call('eat_meal', { bowls: 1 });
  await rig1.world.stop();

  const rig2 = makeWorld({ dataDir, start: rig1.clock.now() });
  await rig2.world.start(rig2.host);
  const status = await rig2.call('eat_status');
  assert.match(status.text, /饱食度：100\/100/);
  assert.match(status.text, /米仓：0\.80 kg/);
  assert.match(status.text, /电饭煲：一碗热饭/);
  await rig2.world.stop();
});

test('离线补算: 重新启动时已经跨阶段会补一条提醒', async () => {
  const dataDir = join(root, 'offline');
  const rig1 = makeWorld({ dataDir });
  await rig1.world.start(rig1.host);
  await rig1.world.stop();

  const rig2 = makeWorld({ dataDir, start: rig1.clock.now() + 8 * HOUR });
  await rig2.world.start(rig2.host);
  assert.equal(rig2.events.length, 1);
  assert.match(rig2.events[0].event.text, /有点饿了/);
  assert.equal(rig2.events[0].event.meta.stage, 1);
  await rig2.world.stop();
});

test('配置热改: 每碗恢复量在下一次吃饭时生效', async () => {
  const rig = makeWorld({ cfg: { cookMinutes: 1 } });
  await rig.world.start(rig.host);
  await rig.invoke('addRice', [1]);
  rig.clock.advance(6 * HOUR); // 100 -> 70
  assert.equal(await runTick(rig), 0);
  rig.world.cfg.hungerPerHour = 0;
  await rig.call('eat_cook', { bowls: 1 });
  assert.equal(await finishCook(rig, 1), 1);

  rig.world.cfg.satietyPerBowl = 40;
  const meal = await rig.call('eat_meal', { bowls: 0.5 });
  assert.match(meal.text, /半碗饭下肚，现在肚子饱饱的。/);
  const status = await rig.call('eat_status');
  assert.match(status.text, /饱食度：90\/100/);
  await rig.world.stop();
});

// ---------------------------------------------------------------------------
// 种田
// ---------------------------------------------------------------------------

test('farm_status: 空田也能查，说明怎么开始', async () => {
  const rig = makeWorld({ cfg: { rainChancePerHour: 0 } });
  await rig.world.start(rig.host);

  const res = await rig.call('farm_status');
  assert.equal(res.failed, undefined);
  assert.match(res.text, /稻田状态/);
  assert.match(res.text, /田里空着，可以播种/);
  assert.match(res.text, /土壤：水分 45%/);
  assert.match(res.text, /水池：80 L \/ 200 L/);
  assert.match(res.text, /还没下过/);
  assert.match(res.text, /田里：没有虫；没有鸟；没立稻草人/);
  await rig.world.stop();
});

test('种田全流程: 播种 → 浇水 → 施肥 → 成熟 → 收割进米仓', async () => {
  const rig = makeWorld({ cfg: { growHours: 1, moistureDryPerHour: 0, rainChancePerHour: 0, hungerPerHour: 0 } });
  await rig.world.start(rig.host);

  const sown = await rig.call('farm_sow');
  assert.equal(sown.failed, undefined);
  assert.match(sown.text, /撒进田里/);

  const again = await rig.call('farm_sow');
  assert.equal(again.failed, true);
  assert.match(again.text, /已经种着水稻/);

  const watered = await rig.call('farm_water');
  assert.match(watered.text, /打了 8 L/);
  assert.match(watered.text, /发芽期的稻子正吃水（×1\.6）/);
  assert.match(watered.text, /进度从 0% 推到了 4\.8%/);

  const fertilized = await rig.call('farm_fertilize');
  assert.match(fertilized.text, /一季只施一次/);
  assert.match(fertilized.text, /×1\.5/);
  assert.match(fertilized.text, /从 1\.50 kg 提到 2\.25 kg/);

  const twice = await rig.call('farm_fertilize');
  assert.equal(twice.failed, true);
  assert.match(twice.text, /已经施过肥/);

  const early = await rig.call('farm_harvest');
  assert.equal(early.failed, true);
  assert.match(early.text, /没成熟不能收割/);

  rig.clock.advance(2 * HOUR);
  assert.equal(await runTick(rig), 0); // 水稻成熟不投递事件

  const ripe = await rig.call('farm_status');
  assert.match(ripe.text, /已经熟了/);
  assert.match(ripe.text, /可以割了/);
  assert.match(ripe.text, /2\.25 kg/);

  const harvested = await rig.call('farm_harvest');
  assert.match(harvested.text, /2\.25 kg 稻谷/);
  assert.match(harvested.text, /施过肥.*×1\.5/);

  const status = await rig.call('eat_status');
  assert.match(status.text, /米仓：2\.25 kg/);
  const after = await rig.call('farm_status');
  assert.match(after.text, /田里空着/);

  // 收下来的稻谷能直接煮。
  await rig.call('eat_cook', { bowls: 2 });
  rig.clock.advance(31 * 60_000);
  assert.equal(await runTick(rig), 1);
  assert.equal(rig.events.at(-1).event.type, 'eat.cooked');

  await rig.world.stop();
});

test('浇水效果: 不同阶段不一样，成熟后不能浇', async () => {
  const rig = makeWorld({ cfg: { growHours: 1000, moistureDryPerHour: 0, rainChancePerHour: 0, hungerPerHour: 0 } });
  await rig.world.start(rig.host);
  await rig.farm('sow');

  const first = await rig.call('farm_water');
  assert.match(first.text, /发芽期的稻子正吃水（×1\.6）/);

  // 直接把进度推到抽穗期：下一次浇水的效果应该换成 ×1.4。
  const state = await rig.farm('state');
  assert.equal(state.farm.stageName, '发芽期');
  const cfg = rig.world.cfg;
  cfg.growHours = 0.5;
  rig.clock.advance(0.4 * HOUR);
  await runTick(rig);
  cfg.growHours = 1000;

  const mid = await rig.call('farm_status');
  assert.match(mid.text, /浇水效果：现在是(抽穗期|灌浆期|分蘖期|幼苗期)，×/);

  // 成熟以后浇水会被拒绝。
  const ripe = makeWorld({ cfg: { growHours: 0.5, moistureDryPerHour: 0, rainChancePerHour: 0, hungerPerHour: 0 } });
  await ripe.world.start(ripe.host);
  await ripe.farm('sow');
  ripe.clock.advance(1 * HOUR);
  await runTick(ripe);
  const blocked = await ripe.call('farm_water');
  assert.equal(blocked.failed, true);
  assert.match(blocked.text, /已经成熟/);

  await rig.world.stop();
  await ripe.world.stop();
});

test('水池: 浇完就没水，下雨会补；主人也能打水', async () => {
  const rig = makeWorld({ cfg: { growHours: 1000, moistureDryPerHour: 0, rainChancePerHour: 0, hungerPerHour: 0, poolCapacityLiters: 20 } });
  await rig.world.start(rig.host);
  await rig.farm('sow');

  // 20 L 只够浇两次（每次 8 L）。
  await rig.call('farm_water');
  await rig.call('farm_water');
  const dry = await rig.call('farm_water');
  assert.equal(dry.failed, true);
  assert.match(dry.text, /水池里只有 4 L/);

  const filled = await rig.farm('fillPool', [10]);
  assert.match(filled.message, /打了 10 L/);
  assert.equal(filled.state.farm.poolLiters, 14);
  await rig.call('farm_water');
  const empty = await rig.call('farm_water');
  assert.equal(empty.failed, true);

  await rig.world.stop();
});

test('下雨: 随机事件，免费浇田并补水，不投递事件', async () => {
  const rig = makeWorld({
    random: () => 0,
    cfg: { growHours: 1000, moistureDryPerHour: 0, rainChancePerHour: 0.5, hungerPerHour: 0 },
  });
  await rig.world.start(rig.host);
  await rig.farm('sow');
  const before = await rig.farm('state');
  const poolBefore = before.farm.poolLiters;
  const progressBefore = before.farm.progress;

  rig.clock.advance(2 * HOUR);
  assert.equal(await runTick(rig), 0, '下雨不该给桌宠推事件');

  const after = await rig.farm('state');
  assert.ok(after.farm.poolLiters > poolBefore, '下雨应补水');
  assert.ok(after.farm.progress > progressBefore, '下雨应推进进度');
  assert.ok(after.farm.lastRainAt, '应记下下雨时间');

  const status = await rig.call('farm_status');
  assert.match(status.text, /最近一次在/);
  await rig.world.stop();
});

test('稻田面板: 主人播种、浇水、施肥、收割、打水', async () => {
  const rig = makeWorld({ cfg: { growHours: 0.5, moistureDryPerHour: 0, rainChancePerHour: 0, hungerPerHour: 0 } });
  const beforeStart = await rig.farm('state');
  assert.equal(beforeStart.started, false);

  await rig.world.start(rig.host);
  const decl = rig.world.webUi('zh');
  assert.ok(decl.panels?.some((panel) => panel.id === 'farm'), '缺 farm 面板');

  const empty = await rig.farm('state');
  assert.equal(empty.farm.planted, false);
  assert.equal(empty.farm.poolLiters, 80);

  const sown = await rig.farm('sow');
  assert.match(sown.message, /主人播下了稻种/);
  assert.equal(sown.state.farm.planted, true);

  const watered = await rig.farm('water');
  assert.match(watered.message, /主人浇了一次水/);
  assert.ok(watered.state.farm.poolLiters < 80);

  const fertilized = await rig.farm('fertilize');
  assert.match(fertilized.message, /主人给水稻施了肥/);
  await assert.rejects(() => rig.farm('fertilize'), /已经施过肥/);

  await assert.rejects(() => rig.farm('harvest'), /没成熟/);
  rig.clock.advance(1 * HOUR);
  await runTick(rig);
  const harvested = await rig.farm('harvest');
  assert.match(harvested.message, /主人收了 2\.25 kg 稻谷进米仓/);
  assert.equal(harvested.state.farm.planted, false);
  assert.equal(harvested.state.riceKg, 2.25);

  const pool = await rig.farm('fillPool', [50]);
  assert.equal(pool.state.farm.poolLiters, 80 - 8 + 50);
  await assert.rejects(() => rig.farm('fillPool', [0]), /大于 0/);

  await rig.world.stop();
});

test('跨重启保留: 田里的进度、施肥、水池都接着上次算', async () => {
  const dataDir = join(root, 'farm-persist');
  const rig1 = makeWorld({ dataDir, cfg: { growHours: 1000, moistureDryPerHour: 0, rainChancePerHour: 0, hungerPerHour: 0 } });
  await rig1.world.start(rig1.host);
  await rig1.farm('sow');
  await rig1.call('farm_water');
  await rig1.call('farm_fertilize');
  await rig1.farm('fillPool', [20]);
  const before = await rig1.farm('state');
  await rig1.world.stop();

  const rig2 = makeWorld({ dataDir, start: rig1.clock.now(), cfg: { growHours: 1000, moistureDryPerHour: 0, rainChancePerHour: 0, hungerPerHour: 0 } });
  await rig2.world.start(rig2.host);
  const status = await rig2.call('farm_status');
  assert.match(status.text, /进度 4\.8%/);
  assert.match(status.text, /已经施过/);
  assert.match(status.text, /水池：92 L/);
  const after = await rig2.farm('state');
  assert.equal(after.farm.planted, true);
  assert.equal(after.farm.progress, before.farm.progress);
  await rig2.world.stop();
});

test('旧存档: v1 状态文件读进来会补一块空田', async () => {
  const dataDir = join(root, 'legacy');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(dataDir, 'eat'), { recursive: true });
  writeFileSync(join(dataDir, 'eat', 'state.json'), JSON.stringify({
    version: 1,
    satiety: 42,
    riceGrams: 300,
    cookedGrams: 0,
    cooking: null,
    updatedAtMs: START,
  }), 'utf8');

  const rig = makeWorld({ dataDir, cfg: { hungerPerHour: 0, rainChancePerHour: 0 } });
  await rig.world.start(rig.host);
  const status = await rig.call('farm_status');
  assert.match(status.text, /田里空着/);
  const eat = await rig.call('eat_status');
  assert.match(eat.text, /饱食度：42\/100/);
  assert.match(eat.text, /米仓：0\.30 kg/);
  await rig.world.stop();
});

// ---------------------------------------------------------------------------
// 灾害
// ---------------------------------------------------------------------------

test('虫灾与鸟灾: 随机落下，只写状态不推事件', async () => {
  const rig = makeWorld({
    random: () => 0,
    cfg: {
      growHours: 1000,
      moistureDryPerHour: 0,
      hungerPerHour: 0,
      pestChancePerHour: 2,
      birdChancePerHour: 2,
    },
  });
  await rig.world.start(rig.host);
  await rig.farm('sow');

  rig.clock.advance(1 * HOUR);
  assert.equal(await runTick(rig), 0, '虫灾和鸟群不该给桌宠推事件');

  const status = await rig.call('farm_status');
  assert.match(status.text, /虫口 \d/);
  assert.match(status.text, /鸟群 \d/);

  const state = await rig.farm('state');
  assert.ok(state.farm.pestActive);
  assert.ok(state.farm.birdActive);
  await rig.world.stop();
});

test('鸟吃虫: 先清虫，再啄稻穗', async () => {
  const rig = makeWorld({
    random: () => 0,
    cfg: {
      growHours: 1000,
      moistureDryPerHour: 0,
      hungerPerHour: 0,
      pestChancePerHour: 2,
      birdChancePerHour: 0,
    },
  });
  await rig.world.start(rig.host);
  await rig.farm('sow');
  rig.clock.advance(30 * 60_000);
  await runTick(rig);
  const infested = await rig.farm('state');
  assert.ok(infested.farm.pestActive);
  const pestsBefore = infested.farm.pests;

  // 关掉虫灾刷新、手动放一群鸟进来（鸟灾默认关着，这里直接借 cfg 打开）。
  rig.world.cfg.pestChancePerHour = 0;
  rig.world.cfg.birdChancePerHour = 2;
  rig.clock.advance(30 * 60_000);
  await runTick(rig);
  const withBirds = await rig.farm('state');
  assert.ok(withBirds.farm.birdActive);
  assert.ok(withBirds.farm.pests < pestsBefore, '鸟应该吃掉一部分虫');
  assert.equal(withBirds.farm.birdPhase, 'pests');
  await rig.world.stop();
});

test('稻草人: 立起来赶鸟、挡住新鸟群、倒了才能再立', async () => {
  const rig = makeWorld({
    random: () => 0,
    cfg: {
      growHours: 1000,
      moistureDryPerHour: 0,
      hungerPerHour: 0,
      pestChancePerHour: 0,
      birdChancePerHour: 0,
      scarecrowHours: 2,
    },
  });
  await rig.world.start(rig.host);
  await rig.farm('sow');

  const built = await rig.call('farm_scarecrow');
  assert.equal(built.failed, undefined);
  assert.match(built.text, /立起稻草人/);
  assert.match(built.text, /只吓鸟，不管虫/);

  const again = await rig.call('farm_scarecrow');
  assert.equal(again.failed, true);
  assert.match(again.text, /还立着/);

  // 立着的时候把鸟灾频率拉满也不会来鸟。
  rig.world.cfg.birdChancePerHour = 5;
  rig.clock.advance(1 * HOUR);
  await runTick(rig);
  const guarded = await rig.farm('state');
  assert.equal(guarded.farm.birds, 0);

  // 寿命到了（默认 2 小时）就倒，之后鸟又能来。
  rig.clock.advance(2 * HOUR);
  await runTick(rig);
  const fallen = await rig.farm('state');
  assert.equal(fallen.farm.scarecrow, 0);
  assert.ok(fallen.farm.birds > 0);

  const rebuilt = await rig.farm('scarecrow');
  assert.match(rebuilt.message, /主人立起了稻草人/);
  assert.equal(rebuilt.state.farm.scarecrow, 100);
  await rig.world.stop();
});

test('收割彩蛋: 回执只报总数，半个字都不提多收', async () => {
  const rig = makeWorld({
    random: () => 0,
    cfg: { growHours: 0.5, moistureDryPerHour: 0, hungerPerHour: 0 },
  });
  await rig.world.start(rig.host);
  await rig.farm('sow');
  rig.clock.advance(1 * HOUR);
  await runTick(rig);

  const before = await rig.call('farm_status');
  assert.match(before.text, /估摸着能收 1\.50 kg/);

  const harvested = await rig.call('farm_harvest');
  assert.equal(harvested.failed, undefined);
  assert.match(harvested.text, /1\.5[678] kg 稻谷/);
  assert.doesNotMatch(harvested.text, /多收|惊喜|额外|运气|彩蛋/);

  const after = await rig.farm('state');
  assert.ok(after.riceGrams > 1500, `应该多收了一点：${after.riceGrams}`);
  await rig.world.stop();
});

test('旱情: 土壤干透时状态里会点名', async () => {
  const rig = makeWorld({ cfg: { growHours: 1000, moistureDryPerHour: 100, hungerPerHour: 0 } });
  await rig.world.start(rig.host);
  await rig.farm('sow');
  rig.clock.advance(1 * HOUR);
  await runTick(rig);
  const status = await rig.call('farm_status');
  assert.match(status.text, /旱情：土已经干透/);
  assert.match(status.text, /长势 ×0\.3/);
  await rig.world.stop();
});
