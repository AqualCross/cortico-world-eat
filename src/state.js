/**
 * 吃饭的纯状态模型：饱食度、米仓和电饭煲。
 *
 * 所有动作都在传入的 state 上就地修改，调用方负责决定何时持久化。
 * 单位固定为克，展示时再换成 kg / 碗：
 *   - 1 碗熟饭 = 200 g；
 *   - 煮 1 碗熟饭用 100 g 生米。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const STATE_VERSION = 3;
export const BOWL_GRAMS = 200;
export const RAW_GRAMS_PER_BOWL = 100;
export const HOUR_MS = 60 * 60 * 1000;
export const MIN_BOWLS = 0.5;
export const MAX_BOWLS = 20;
/** 宠物一次最多吃一碗：饭要一碗一碗吃。主人面板不受这个限制。 */
export const PET_MEAL_MAX_BOWLS = 1;

// ---------------------------------------------------------------------------
// 稻田：一块水田、一个水池，外加虫、鸟和稻草人
// ---------------------------------------------------------------------------

/** 成熟进度到 100 就算成熟，可以收割。 */
export const FARM_PROGRESS_MAX = 100;
/** 一次浇水立刻推进的进度点数；再按当前阶段的 waterFactor 缩放。 */
export const WATER_BOOST_POINTS = 3;
/** 新存档的土壤水分（%）和水池水量（L）。 */
export const INITIAL_MOISTURE = 45;
export const INITIAL_POOL_LITERS = 80;
/** 土壤水分掉到这个值以下就算旱情（只影响文案，伤害由长势倍率体现）。 */
export const DROUGHT_MOISTURE = 5;

/** 水分对长势的影响：干透也有 0.3 倍速度，浇透是 1 倍。 */
const DRY_FLOOR = 0.3;

/**
 * 虫与鸟的固定参数（频次和伤害在配置里，这里只放不好调的生物学常数）。
 *
 * 虫口 0–100：一次虫灾落下 40，之后每小时繁殖 2、自然死亡 5，净减 3，
 * 也就是没人管大约 13 小时自己退干净；虫口按比例啃稻子。
 * 鸟群 0–100：一次鸟灾落下 60，每小时散去 15；鸟先吃虫，虫吃光了才啄稻穗。
 * 稻草人只赶鸟，不碰虫。
 */
export const PEST_INITIAL = 40;
export const PEST_GROW_PER_HOUR = 2;
export const PEST_DECAY_PER_HOUR = 5;
export const BIRD_INITIAL = 60;
export const BIRD_LEAVE_PER_HOUR = 15;
export const BIRD_EAT_PEST_PER_HOUR = 60;
export const SCARECROW_SCARE_PER_HOUR = 60;
/** 离线补算时最多切多少步：每步不超过半小时，最多 48 小时。 */
const MAX_STEP_HOURS = 0.5;
const MAX_STEPS = 96;

/**
 * 收割彩蛋的额度：多收基础产量的 5%–15%，按 5 g 取整。
 * 概率由 `harvestBonusChance` 控制，米仓越空越容易触发；这套东西不进任何提示词。
 */
export const HARVEST_BONUS_MIN_RATIO = 0.05;
export const HARVEST_BONUS_MAX_RATIO = 0.15;
export const HARVEST_BONUS_STEP = 5;

/**
 * 生长阶段。`waterFactor` 是这次浇水推进量的系数：
 * 发芽和抽穗最吃水，灌浆期浇再多也催不动，成熟后浇水没有意义。
 */
export const FARM_STAGES = Object.freeze([
  Object.freeze({ key: 'sprout', name: '发芽期', until: 10, waterFactor: 1.6 }),
  Object.freeze({ key: 'seedling', name: '幼苗期', until: 30, waterFactor: 1.2 }),
  Object.freeze({ key: 'tiller', name: '分蘖期', until: 55, waterFactor: 0.9 }),
  Object.freeze({ key: 'heading', name: '抽穗期', until: 80, waterFactor: 1.4 }),
  Object.freeze({ key: 'filling', name: '灌浆期', until: 100, waterFactor: 0.6 }),
]);

export const RIPE_STAGE = Object.freeze({ key: 'ripe', name: '成熟期', until: 100, waterFactor: 0 });

/** 稻田的默认参数；`worlds.eat` 段覆盖，config.js 的 DEFAULTS 直接用这一份。 */
export const FARM_DEFAULTS = Object.freeze({
  /** 从播种到成熟要多少小时（水分足、不施肥的情况下）。 */
  growHours: 24,
  /** 一次浇水（或一场雨）补多少土壤水分。 */
  moisturePerWatering: 35,
  /** 一次浇水从水池里取多少升。 */
  waterPerWatering: 8,
  /** 水池容量（L）。 */
  poolCapacityLiters: 200,
  /** 每小时蒸发多少点土壤水分。 */
  moistureDryPerHour: 12,
  /** 每小时下雨的期望次数（0.2 ≈ 平均 5 小时一场）。 */
  rainChancePerHour: 0.2,
  /** 一场雨往水池里补多少升。 */
  rainWaterLiters: 35,
  /** 一季稻谷的基础产量（kg）。 */
  harvestYieldKg: 1.5,
  /** 施过肥的产量倍率。 */
  fertilizeYieldBonus: 1.5,
  /** 每小时闹一次虫灾的期望次数（0.03 ≈ 平均 33 小时一次）。 */
  pestChancePerHour: 0.03,
  /** 每小时来一群鸟的期望次数（0.03 ≈ 平均 33 小时一次）；有稻草人就不会来。 */
  birdChancePerHour: 0.03,
  /** 虫口 100% 时每小时啃掉多少点进度。 */
  pestDamagePerHour: 3,
  /** 鸟群 100% 且虫已被吃光时，每小时啄掉多少点进度。 */
  birdDamagePerHour: 4,
  /** 一个稻草人能立多少小时。 */
  scarecrowHours: 72,
  /** 收割时米仓全空的情况下，多收一点点的概率；米仓越满越低，0 = 关掉这个彩蛋。 */
  harvestBonusChance: 0.06,
});

/** 饱食度掉到这些值时进入新的饥饿阶段（从下往上）。 */
export const HUNGER_THRESHOLDS = Object.freeze([0, 15, 35, 60]);

const STAGE_LABELS = Object.freeze(['不饿', '有点饿了', '饿了', '很饿了', '饿得不行了']);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round1 = (value) => Math.round(value * 10) / 10;
const round3 = (value) => Math.round(value * 1000) / 1000;

/** 当前饱食度属于哪个阶段：0 不饿，1 有点饿，2 饿，3 很饿，4 饿得不行。 */
export function stageOf(satiety) {
  const n = clamp(Number(satiety) || 0, 0, 100);
  if (n <= 0) return 4;
  if (n <= 15) return 3;
  if (n <= 35) return 2;
  if (n <= 60) return 1;
  return 0;
}

export function stageLabel(stage) {
  return STAGE_LABELS[stage] ?? STAGE_LABELS[0];
}

export function normalizeWho(value) {
  if (value === undefined || value === null || value === '') return 'pet';
  const who = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (who === 'pet' || who === 'owner') return who;
  throw new Error('who 只能是 pet（宠物自己）或 owner（主人）。');
}

/** 碗数只接受 0.5–max、按半碗递增；宠物吃饭时 max 是 1。 */
function validBowls(value, maxBowls = MAX_BOWLS) {
  const n = Number(value);
  const max = clamp(Number(maxBowls) || MAX_BOWLS, MIN_BOWLS, MAX_BOWLS);
  if (!Number.isFinite(n) || n < MIN_BOWLS || n > max) {
    if (Number.isFinite(n) && n > max && max <= PET_MEAL_MAX_BOWLS) {
      throw new Error('一次只盛一碗或半碗，饭要一碗一碗吃；没吃饱就再盛一碗。');
    }
    throw new Error(`量要在半碗到${formatBowlsZh(max)}之间。`);
  }
  if (Math.abs(n * 2 - Math.round(n * 2)) > 1e-9) {
    throw new Error('量要按半碗递增，例如半碗、一碗、一碗半。');
  }
  return Math.round(n * 2) / 2;
}

export function formatBowls(value) {
  const n = round1(Number(value) || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

const CN_DIGITS = Object.freeze(['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']);

function cnNumber(n) {
  if (n >= 100) return String(n);
  if (n < 10) return CN_DIGITS[n];
  if (n === 10) return '十';
  if (n < 20) return `十${CN_DIGITS[n - 10]}`;
  const ones = n % 10;
  return `${CN_DIGITS[Math.floor(n / 10)]}十${ones ? CN_DIGITS[ones] : ''}`;
}

/** 给模型读的碗数：半碗、一碗、一碗半、两碗；0 就是“0 碗”。 */
export function formatBowlsZh(value) {
  const halves = Math.round((Number(value) || 0) * 2);
  if (halves <= 0) return '0 碗';
  const whole = Math.floor(halves / 2);
  const half = halves % 2 === 1;
  if (whole === 0) return '半碗';
  const head = whole === 2 ? '两' : cnNumber(whole);
  return `${head}碗${half ? '半' : ''}`;
}

/** 饱食度换成一句肚子里的感觉；分界跟 HUNGER_THRESHOLDS 对齐。 */
export function bellyLabel(satiety) {
  const n = clamp(Number(satiety) || 0, 0, 100);
  if (n >= 95) return '撑得有点坐不住';
  if (n >= 80) return '肚子饱饱的';
  if (n > 60) return '有点饱了';
  if (n > 35) return '还有点饿';
  if (n > 15) return '肚子空落落的';
  if (n > 0) return '饿得慌';
  return '饿得前胸贴后背';
}

export function formatKg(grams) {
  return (Math.max(0, Number(grams) || 0) / 1000).toFixed(2);
}

export function formatSatiety(value) {
  const n = round1(Number(value) || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** 新存档：饱食度满，米仓和电饭煲都空，电饭煲空闲，田里空着、水池半满。 */
export function newState(nowMs) {
  const at = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  return {
    version: STATE_VERSION,
    satiety: 100,
    riceGrams: 0,
    cookedGrams: 0,
    cooking: null,
    farm: newFarm(),
    updatedAtMs: at,
  };
}

/** 一块空田：没种、没施肥，土壤有点湿，水池有存水，没有虫鸟和稻草人。 */
export function newFarm() {
  return {
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
  };
}

/** 到点就把正在煮的那一锅倒进熟饭；返回这一锅的信息，没到点返回 null。 */
export function settleCooking(state, nowMs) {
  const cooking = state.cooking;
  if (!cooking) return null;
  const at = Number(nowMs);
  if (!Number.isFinite(at) || at < cooking.finishesAtMs) return null;
  state.cookedGrams += cooking.producedGrams;
  state.cooking = null;
  return {
    bowls: cooking.bowls,
    producedGrams: cooking.producedGrams,
    cookedGrams: state.cookedGrams,
    startedAtMs: cooking.startedAtMs,
    finishesAtMs: cooking.finishesAtMs,
  };
}

/**
 * 把稻田里的数值夹回合法区间。改小水池容量之后，旧存档里多出来的水
 * 会在下一次结算时被削到新容量，不会出现“80 L / 上限 20 L”。
 */
export function normalizeFarm(farm, cfg = farmConfig()) {
  if (!farm) return farm;
  farm.progress = round3(clamp(farm.progress, 0, FARM_PROGRESS_MAX));
  farm.moisture = round3(clamp(farm.moisture, 0, 100));
  farm.poolLiters = round3(clamp(farm.poolLiters, 0, cfg.poolCapacityLiters));
  farm.pests = round3(clamp(farm.pests, 0, 100));
  farm.birds = round3(clamp(farm.birds, 0, 100));
  farm.scarecrow = round3(clamp(farm.scarecrow, 0, 100));
  return farm;
}

/**
 * 把时间推进到 nowMs，按 hungerPerHour 扣饱食度、推进水稻，并结算到点的饭。
 * opts.farm 是稻田参数（缺省用 FARM_DEFAULTS），opts.random 可注入随机源，
 * opts.rollEvents=false 时只结算生长，不掷下雨/虫/鸟（给只读预览用）。
 * 返回阶段变化、这一轮刚煮好的饭和这一轮发生的天气与灾害；调用方负责投递提醒。
 */
export function advanceState(state, nowMs, hungerPerHour, opts = {}) {
  const at = Number(nowMs);
  if (!Number.isFinite(at)) throw new Error('时间不对。');
  const cookingFinished = settleCooking(state, at);
  const fromStage = stageOf(state.satiety);
  const farmCfg = farmConfig(opts.farm);
  const random = typeof opts.random === 'function' ? opts.random : Math.random;
  const rollEvents = opts.rollEvents !== false && opts.rollRain !== false;
  normalizeFarm(state.farm, farmCfg);
  if (at <= state.updatedAtMs) {
    return { fromStage, toStage: fromStage, hours: 0, changed: false, cookingFinished, farm: null };
  }
  const hours = (at - state.updatedAtMs) / HOUR_MS;
  const rate = Math.max(0, Number(hungerPerHour) || 0);
  state.satiety = round3(clamp(state.satiety - rate * hours, 0, 100));
  const farm = advanceFarm(state, state.updatedAtMs, at, farmCfg, random, rollEvents);
  state.updatedAtMs = at;
  const toStage = stageOf(state.satiety);
  return { fromStage, toStage, hours, changed: toStage !== fromStage, cookingFinished, farm };
}

const remainingMinutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));

/** 从米仓取生米，开始煮一锅；到点后由 settleCooking 变成熟饭。 */
export function cook(state, opts = {}) {
  const bowls = validBowls(opts.bowls);
  const who = normalizeWho(opts.who);
  const now = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : state.updatedAtMs;
  settleCooking(state, now);
  if (state.cooking) {
    const wait = remainingMinutes(state.cooking.finishesAtMs - now);
    throw new Error(`电饭煲正在煮${formatBowlsZh(state.cooking.bowls)}饭，约 ${wait} 分钟后好；这一锅的量已锁定，不能再煮或改量。`);
  }
  const rawGrams = Math.round(bowls * RAW_GRAMS_PER_BOWL);
  const producedGrams = Math.round(bowls * BOWL_GRAMS);
  if (state.riceGrams < rawGrams) {
    throw new Error(`米仓只有 ${formatKg(state.riceGrams)} kg 生米，不够煮${formatBowlsZh(bowls)}饭（需要 ${rawGrams} g）。让主人加米，或少煮一点。`);
  }
  const capacity = (opts.cookerCapacityBowls === undefined
    ? 6
    : Math.max(0, Number(opts.cookerCapacityBowls) || 0)) * BOWL_GRAMS;
  if (state.cookedGrams + producedGrams > capacity + 1e-6) {
    const room = Math.max(0, capacity - state.cookedGrams);
    const have = state.cookedGrams >= BOWL_GRAMS / 2
      ? `锅里已经有${formatBowlsZh(state.cookedGrams / BOWL_GRAMS)}，`
      : '';
    const roomText = room >= BOWL_GRAMS / 2 ? formatBowlsZh(room / BOWL_GRAMS) : '一碗也放不下';
    throw new Error(`电饭煲最多${formatBowlsZh(capacity / BOWL_GRAMS)}，${have}只放得下${roomText}。先吃掉一些，或少煮一点。`);
  }
  const minutes = Number.isFinite(Number(opts.cookMinutes)) ? Math.max(0, Number(opts.cookMinutes)) : 30;
  const cookMs = Math.round(minutes * 60_000);
  state.riceGrams -= rawGrams;
  state.cooking = {
    startedAtMs: now,
    finishesAtMs: now + cookMs,
    bowls,
    rawGrams,
    producedGrams,
  };
  return {
    who,
    bowls,
    rawGrams,
    producedGrams,
    riceGrams: state.riceGrams,
    cookedGrams: state.cookedGrams,
    cookMinutes: minutes,
    cookMs,
    startedAtMs: now,
    finishesAtMs: now + cookMs,
  };
}

/** 从电饭煲里吃饭；宠物吃会恢复饱食度，主人吃只消耗饭。 */
export function eat(state, opts = {}) {
  const bowls = validBowls(opts.bowls, opts.maxBowls);
  const who = normalizeWho(opts.who);
  settleCooking(state, state.updatedAtMs);
  const grams = Math.round(bowls * BOWL_GRAMS);
  if (state.cookedGrams < grams) {
    const wait = state.cooking
      ? `（电饭煲正在煮${formatBowlsZh(state.cooking.bowls)}，约 ${remainingMinutes(state.cooking.finishesAtMs - state.updatedAtMs)} 分钟后好）`
      : '';
    const left = state.cookedGrams >= BOWL_GRAMS / 2
      ? `只有${formatBowlsZh(state.cookedGrams / BOWL_GRAMS)}现成的饭`
      : '没有现成的饭';
    throw new Error(`电饭煲里${left}，不够吃${formatBowlsZh(bowls)}${wait}。先等饭好，或少盛一点。`);
  }
  const beforeSatiety = state.satiety;
  state.cookedGrams -= grams;
  let gained = 0;
  if (who === 'pet') {
    const perBowl = Math.max(0, Number(opts.satietyPerBowl) || 0);
    const after = clamp(beforeSatiety + bowls * perBowl, 0, 100);
    gained = round3(after - beforeSatiety);
    state.satiety = round3(after);
  }
  return {
    who,
    bowls,
    grams,
    beforeSatiety,
    afterSatiety: state.satiety,
    gained,
    cookedGrams: state.cookedGrams,
    cooking: state.cooking,
  };
}

/** 主人往米仓加生米。 */
export function addRice(state, opts = {}) {
  settleCooking(state, state.updatedAtMs);
  const kg = Number(opts.kg);
  if (!Number.isFinite(kg) || kg < 0.1) {
    throw new Error('加米量至少 0.1 kg。');
  }
  if (kg > 25) {
    throw new Error('一次最多加 25 kg；米仓装不下就分几次加。');
  }
  const grams = Math.round(kg * 1000);
  const capacity = opts.riceCapacityGrams === undefined
    ? 5000
    : Math.max(0, Number(opts.riceCapacityGrams) || 0);
  const room = capacity - state.riceGrams;
  if (room <= 0) {
    throw new Error(`米仓已经满了（${formatKg(state.riceGrams)} kg / 上限 ${formatKg(capacity)} kg）。先煮掉一些，再让主人加米。`);
  }
  if (grams > room + 1e-6) {
    throw new Error(`米仓最多 ${formatKg(capacity)} kg，现在有 ${formatKg(state.riceGrams)} kg，只加得下 ${formatKg(room)} kg。让主人少加一点。`);
  }
  const beforeGrams = state.riceGrams;
  state.riceGrams += grams;
  return {
    kg: round3(grams / 1000),
    grams,
    beforeGrams,
    afterGrams: state.riceGrams,
  };
}

// ---------------------------------------------------------------------------
// 稻田：生长、浇水、施肥、收割、水池与下雨
// ---------------------------------------------------------------------------

/** 成熟进度属于哪个阶段；进度到 100 就是成熟期。 */
export function farmStage(progress) {
  const p = clamp(Number(progress) || 0, 0, FARM_PROGRESS_MAX);
  if (p >= FARM_PROGRESS_MAX) return RIPE_STAGE;
  return FARM_STAGES.find((stage) => p < stage.until) ?? RIPE_STAGE;
}

/** 土壤水分换成长势倍率：0% → 0.3 倍，100% → 1 倍。 */
export function moistureFactor(moisture) {
  const m = clamp(Number(moisture) || 0, 0, 100);
  return round3(DRY_FLOOR + (1 - DRY_FLOOR) * (m / 100));
}

/** 把 `worlds.eat` 段里的稻田参数补全并夹到合理区间。 */
export function farmConfig(opts = {}) {
  const n = (key, min, max) => {
    const raw = Number(opts?.[key]);
    const base = Number.isFinite(raw) ? raw : Number(FARM_DEFAULTS[key]);
    return Math.min(Math.max(base, min), max);
  };
  return {
    growHours: n('growHours', 0.5, 720),
    moisturePerWatering: n('moisturePerWatering', 1, 100),
    waterPerWatering: n('waterPerWatering', 0, 1000),
    poolCapacityLiters: n('poolCapacityLiters', 1, 100000),
    moistureDryPerHour: n('moistureDryPerHour', 0, 100),
    rainChancePerHour: n('rainChancePerHour', 0, 24),
    rainWaterLiters: n('rainWaterLiters', 0, 10000),
    harvestYieldKg: n('harvestYieldKg', 0.1, 100),
    fertilizeYieldBonus: n('fertilizeYieldBonus', 1, 10),
    pestChancePerHour: n('pestChancePerHour', 0, 24),
    birdChancePerHour: n('birdChancePerHour', 0, 24),
    pestDamagePerHour: n('pestDamagePerHour', 0, 50),
    birdDamagePerHour: n('birdDamagePerHour', 0, 50),
    scarecrowHours: n('scarecrowHours', 1, 2000),
    harvestBonusChance: n('harvestBonusChance', 0, 1),
  };
}

/**
 * 把田地从 fromMs 推进到 toMs：水分蒸发、水稻长一截，按概率下雨、闹虫、来鸟。
 *
 * 离线补算可能一次跨好几个小时，所以整段会被切成不超过半小时的小步，
 * 每步单独掷骰——这样“每小时 0.2 场雨”在长区间里才是真的按小时算，
 * 虫和鸟也不会在离线回来后一次性叠在一起。
 */
export function advanceFarm(state, fromMs, toMs, cfg = farmConfig(), random = Math.random, rollEvents = true) {
  const farm = state.farm;
  if (!farm) return null;
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const hours = (to - from) / HOUR_MS;
  const moistureBefore = farm.moisture;
  const progressBefore = farm.progress;
  const steps = Math.min(MAX_STEPS, Math.max(1, Math.ceil(hours / MAX_STEP_HOURS)));
  const stepHours = hours / steps;
  const rainAt = [];
  const pestOutbreaks = [];
  const birdFlocks = [];
  let lastRain = null;
  for (let i = 0; i < steps; i += 1) {
    const at = from + ((to - from) * (i + 1)) / steps;
    const rain = stepFarm(state, stepHours, cfg, random, rollEvents, at);
    if (rain) {
      lastRain = rain;
      rainAt.push(at);
    }
    if (rollEvents) {
      const critters = rollCritters(state, stepHours, cfg, random, at);
      if (critters.pests) pestOutbreaks.push(at);
      if (critters.birds) birdFlocks.push(at);
    }
    simulateCritters(farm, stepHours, cfg);
  }
  farm.moisture = round3(farm.moisture);
  farm.progress = round3(farm.progress);
  farm.pests = round3(farm.pests);
  farm.birds = round3(farm.birds);
  farm.scarecrow = round3(farm.scarecrow);
  return {
    hours: round3(hours),
    moistureBefore,
    moistureAfter: farm.moisture,
    progressBefore,
    progressAfter: farm.progress,
    rain: lastRain,
    rains: rainAt.length,
    pestOutbreaks,
    birdFlocks,
  };
}

/** 走一小步：蒸发、生长、稻草人变旧、下雨。返回这一小步里的那场雨（没有就是 null）。 */
function stepFarm(state, dtHours, cfg, random, rollEvents, atMs) {
  const farm = state.farm;
  const moistureBefore = farm.moisture;
  farm.moisture = clamp(farm.moisture - cfg.moistureDryPerHour * dtHours, 0, 100);
  if (farm.scarecrow > 0) {
    farm.scarecrow = clamp(farm.scarecrow - (100 / cfg.scarecrowHours) * dtHours, 0, 100);
  }
  if (farm.planted && farm.progress < FARM_PROGRESS_MAX) {
    const mid = clamp((moistureBefore + farm.moisture) / 2, 0, 100);
    const perHour = (FARM_PROGRESS_MAX / cfg.growHours) * moistureFactor(mid);
    farm.progress = clamp(farm.progress + perHour * dtHours, 0, FARM_PROGRESS_MAX);
  }
  if (!rollEvents || cfg.rainChancePerHour <= 0) return null;
  if (random() >= 1 - Math.exp(-cfg.rainChancePerHour * dtHours)) return null;
  return applyRain(state, atMs, cfg);
}

/** 这一小步里闹不闹虫、来不来鸟。有稻草人时鸟不会落下来。 */
function rollCritters(state, dtHours, cfg, random, atMs) {
  const farm = state.farm;
  const out = { pests: false, birds: false };
  if (!farm.planted || farm.progress >= FARM_PROGRESS_MAX) return out;
  if (cfg.pestChancePerHour > 0 && random() < 1 - Math.exp(-cfg.pestChancePerHour * dtHours)) {
    out.pests = farm.pests <= 0;
    farm.pests = Math.max(farm.pests, PEST_INITIAL);
    farm.lastPestAtMs = Number(atMs);
  }
  if (cfg.birdChancePerHour > 0 && farm.scarecrow <= 0
    && random() < 1 - Math.exp(-cfg.birdChancePerHour * dtHours)) {
    out.birds = farm.birds <= 0;
    farm.birds = Math.max(farm.birds, BIRD_INITIAL);
    farm.lastBirdAtMs = Number(atMs);
  }
  return out;
}

/**
 * 虫和鸟的动向：虫按比例啃稻子；鸟先吃虫，虫吃光了才啄稻穗；
 * 稻草人会把已经落下来的鸟赶走。田里没稻子或已经成熟时，虫鸟自己散掉。
 */
function simulateCritters(farm, dtHours, cfg) {
  if (!farm.planted || farm.progress >= FARM_PROGRESS_MAX) {
    farm.pests = 0;
    farm.birds = 0;
    return;
  }
  if (farm.pests > 0) {
    farm.pests = clamp(farm.pests + (PEST_GROW_PER_HOUR - PEST_DECAY_PER_HOUR) * dtHours, 0, 100);
  }
  if (farm.birds > 0) {
    if (farm.scarecrow > 0) {
      farm.birds = Math.max(0, farm.birds - SCARECROW_SCARE_PER_HOUR * dtHours);
    }
    if (farm.birds > 0 && farm.pests > 0) {
      const eaten = Math.min(farm.pests, BIRD_EAT_PEST_PER_HOUR * (farm.birds / 100) * dtHours);
      farm.pests = Math.max(0, farm.pests - eaten);
    } else if (farm.birds > 0) {
      farm.progress = clamp(farm.progress - cfg.birdDamagePerHour * (farm.birds / 100) * dtHours, 0, FARM_PROGRESS_MAX);
    }
    farm.birds = Math.max(0, farm.birds - BIRD_LEAVE_PER_HOUR * dtHours);
  }
  if (farm.pests > 0) {
    farm.progress = clamp(farm.progress - cfg.pestDamagePerHour * (farm.pests / 100) * dtHours, 0, FARM_PROGRESS_MAX);
  }
}

/** 一场雨：给田里浇一次水（不花水池的水），同时把水池补上。 */
export function applyRain(state, atMs, cfg = farmConfig()) {
  const farm = state.farm;
  const moistureBefore = farm.moisture;
  const poolBefore = farm.poolLiters;
  const stageBefore = farmStage(farm.progress);
  farm.moisture = round3(clamp(farm.moisture + cfg.moisturePerWatering, 0, 100));
  farm.poolLiters = round3(clamp(farm.poolLiters + cfg.rainWaterLiters, 0, cfg.poolCapacityLiters));
  let boost = 0;
  if (farm.planted && farm.progress < FARM_PROGRESS_MAX) {
    boost = round3(WATER_BOOST_POINTS * stageBefore.waterFactor);
    farm.progress = round3(clamp(farm.progress + boost, 0, FARM_PROGRESS_MAX));
  }
  farm.lastRainAtMs = Number(atMs);
  return {
    atMs: Number(atMs),
    moistureBefore,
    moistureAfter: farm.moisture,
    poolBefore,
    poolAfter: farm.poolLiters,
    stageBefore: stageBefore.key,
    stageAfter: farmStage(farm.progress).key,
    boost,
    progress: farm.progress,
    watered: boost > 0,
  };
}

/** 播种：只往空田里撒。水分照旧，进度清零，施肥次数重置。 */
export function sowField(state, opts = {}) {
  const farm = state.farm;
  if (!farm) throw new Error('这块地还没有稻田状态，先重启一下吃饭 World。');
  if (farm.planted) {
    const stage = farmStage(farm.progress);
    throw new Error(`田里已经种着水稻（${stage.name}，进度 ${formatSatiety(farm.progress)}%），不能重复播种。`);
  }
  farm.planted = true;
  farm.plantedAtMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : state.updatedAtMs;
  farm.progress = 0;
  farm.fertilized = false;
  return {
    plantedAtMs: farm.plantedAtMs,
    moisture: farm.moisture,
    growHours: Number(opts.growHours) || FARM_DEFAULTS.growHours,
  };
}

/** 浇水：从水池取水，补土壤水分，并立刻推进一段进度（多少按阶段算）。 */
export function waterField(state, opts = {}) {
  const farm = state.farm;
  if (!farm) throw new Error('这块地还没有稻田状态，先重启一下吃饭 World。');
  if (!farm.planted) throw new Error('田里还空着，先播种再浇水。');
  if (farm.progress >= FARM_PROGRESS_MAX) {
    throw new Error('水稻已经成熟了，浇水也催不动，去收割吧。');
  }
  const cfg = farmConfig(opts);
  const cost = Math.min(cfg.waterPerWatering, cfg.poolCapacityLiters);
  if (farm.poolLiters + 1e-6 < cost) {
    throw new Error(`水池里只有 ${formatLiters(farm.poolLiters)} L，浇一次要 ${formatLiters(cost)} L。等下雨，或者请主人在「稻田」面板打水。`);
  }
  const stage = farmStage(farm.progress);
  const moistureBefore = farm.moisture;
  const progressBefore = farm.progress;
  farm.poolLiters = round3(clamp(farm.poolLiters - cost, 0, cfg.poolCapacityLiters));
  farm.moisture = round3(clamp(farm.moisture + cfg.moisturePerWatering, 0, 100));
  const boost = round3(WATER_BOOST_POINTS * stage.waterFactor);
  farm.progress = round3(clamp(farm.progress + boost, 0, FARM_PROGRESS_MAX));
  if (farm.progress >= FARM_PROGRESS_MAX) {
    // 熟了就没东西可啃了，虫鸟当场散掉。
    farm.pests = 0;
    farm.birds = 0;
  }
  const stageAfter = farmStage(farm.progress);
  return {
    cost,
    poolLiters: farm.poolLiters,
    boost,
    stage: stage.key,
    stageName: stage.name,
    waterFactor: stage.waterFactor,
    stageAfter: stageAfter.key,
    stageAfterName: stageAfter.name,
    stageChanged: stageAfter.key !== stage.key,
    moistureBefore,
    moistureAfter: farm.moisture,
    moistureWasted: round3(Math.max(0, moistureBefore + cfg.moisturePerWatering - 100)),
    progressBefore,
    progress: farm.progress,
    ripe: farm.progress >= FARM_PROGRESS_MAX,
  };
}

/** 施肥：整季只能一次，提高收割产量；现在不消耗任何化肥。 */
export function fertilizeField(state, opts = {}) {
  const farm = state.farm;
  if (!farm) throw new Error('这块地还没有稻田状态，先重启一下吃饭 World。');
  if (!farm.planted) throw new Error('田里还没种东西，播种之后再施肥。');
  if (farm.progress >= FARM_PROGRESS_MAX) {
    throw new Error('水稻已经成熟了，这时候施肥不影响产量；直接收割吧。');
  }
  if (farm.fertilized) throw new Error('这一季已经施过肥了；整季只能施一次，下次播种才会重置。');
  const cfg = farmConfig(opts);
  farm.fertilized = true;
  return {
    bonus: cfg.fertilizeYieldBonus,
    yieldKg: round3(cfg.harvestYieldKg * cfg.fertilizeYieldBonus),
    baseYieldKg: round3(cfg.harvestYieldKg),
    stageName: farmStage(farm.progress).name,
  };
}

/**
 * 立稻草人：立刻把已经落下来的鸟赶走，之后 `scarecrowHours` 小时内鸟灾不会落下来。
 * 只管鸟，不管虫——没有鸟来吃，虫会一直啃到它们自己退。
 */
export function buildScarecrow(state, opts = {}) {
  const farm = state.farm;
  if (!farm) throw new Error('这块地还没有稻田状态，先重启一下吃饭 World。');
  const cfg = farmConfig(opts);
  if (farm.scarecrow > 0) {
    const hoursLeft = (farm.scarecrow / 100) * cfg.scarecrowHours;
    throw new Error(`稻草人还立着（耐久 ${formatSatiety(farm.scarecrow)}%，大约还能撑 ${formatSatiety(hoursLeft)} 小时），倒了才能再立。`);
  }
  const chased = farm.birds;
  farm.scarecrow = 100;
  farm.birds = 0;
  return {
    chased: round3(chased),
    lastsHours: cfg.scarecrowHours,
    pests: farm.pests,
  };
}

/**
 * 收割：成熟的水稻变成生米进米仓，田重新空出来。
 *
 * 还有一个不写在任何提示词里的彩蛋：米仓越空，越有可能多收一点点（`harvestBonusChance`
 * 是米仓全空时的概率，按当前存粮线性递减）。多出来的部分直接算进总产量，
 * 回执只报总数——桌宠要自己跟 `farm_status` 里的预计产量对一下才会发现。
 */
export function harvestField(state, opts = {}) {
  const farm = state.farm;
  if (!farm) throw new Error('这块地还没有稻田状态，先重启一下吃饭 World。');
  if (!farm.planted) throw new Error('田里没有水稻，先播种。');
  if (farm.progress < FARM_PROGRESS_MAX) {
    const stage = farmStage(farm.progress);
    throw new Error(`水稻还在${stage.name}（进度 ${formatSatiety(farm.progress)}%），没成熟不能收割。`);
  }
  const cfg = farmConfig(opts);
  const yieldMultiplier = farm.fertilized ? cfg.fertilizeYieldBonus : 1;
  const baseGrams = Math.round(cfg.harvestYieldKg * 1000 * yieldMultiplier);
  const capacity = opts.riceCapacityGrams === undefined
    ? 5000
    : Math.max(0, Number(opts.riceCapacityGrams) || 0);
  const room = capacity - state.riceGrams;
  if (baseGrams > room + 1e-6) {
    throw new Error(`这一季能收 ${formatKg(baseGrams)} kg 稻谷，但米仓只放得下 ${formatKg(Math.max(0, room))} kg（现在 ${formatKg(state.riceGrams)} kg / 上限 ${formatKg(capacity)} kg）。先煮掉一些再收割。`);
  }
  const random = typeof opts.random === 'function' ? opts.random : Math.random;
  const luckyGrams = rollHarvestBonus({
    chance: cfg.harvestBonusChance,
    storedGrams: state.riceGrams,
    capacityGrams: capacity,
    baseGrams,
    roomGrams: room,
    random,
  });
  const grams = baseGrams + luckyGrams;
  const beforeGrams = state.riceGrams;
  state.riceGrams += grams;
  const fertilized = farm.fertilized;
  farm.planted = false;
  farm.plantedAtMs = 0;
  farm.progress = 0;
  farm.fertilized = false;
  farm.pests = 0;
  farm.birds = 0;
  return {
    grams,
    baseGrams,
    luckyGrams,
    kg: round3(grams / 1000),
    fertilized,
    yieldMultiplier,
    beforeGrams,
    afterGrams: state.riceGrams,
    riceBowls: round3(grams / RAW_GRAMS_PER_BOWL),
  };
}

/** 收割彩蛋：米仓越空概率越高，多出来的量按基础产量的一小段取，放不下就不要。 */
function rollHarvestBonus({ chance, storedGrams, capacityGrams, baseGrams, roomGrams, random }) {
  if (!(chance > 0) || baseGrams <= 0) return 0;
  const spare = Math.floor(roomGrams - baseGrams);
  if (spare < HARVEST_BONUS_STEP) return 0;
  const fill = capacityGrams > 0 ? clamp(storedGrams / capacityGrams, 0, 1) : 0;
  if (random() >= chance * (1 - fill)) return 0;
  const ratio = HARVEST_BONUS_MIN_RATIO + random() * (HARVEST_BONUS_MAX_RATIO - HARVEST_BONUS_MIN_RATIO);
  const want = Math.max(HARVEST_BONUS_STEP, Math.round((baseGrams * ratio) / HARVEST_BONUS_STEP) * HARVEST_BONUS_STEP);
  return Math.min(want, spare);
}

/** 主人往水池打水。 */
export function fillPool(state, opts = {}) {
  const farm = state.farm;
  if (!farm) throw new Error('这块地还没有稻田状态，先重启一下吃饭 World。');
  const liters = Number(opts.liters);
  if (!Number.isFinite(liters) || liters <= 0) throw new Error('打水量要大于 0 L。');
  if (liters > 500) throw new Error('一次最多打 500 L；水池装不下就分几次。');
  const capacity = farmConfig(opts).poolCapacityLiters;
  const room = capacity - farm.poolLiters;
  if (room <= 0) {
    throw new Error(`水池已经满了（${formatLiters(farm.poolLiters)} L / 上限 ${formatLiters(capacity)} L）。`);
  }
  if (liters > room + 1e-6) {
    throw new Error(`水池最多 ${formatLiters(capacity)} L，现在有 ${formatLiters(farm.poolLiters)} L，只打得进 ${formatLiters(room)} L。`);
  }
  const before = farm.poolLiters;
  farm.poolLiters = round3(farm.poolLiters + liters);
  return { liters: round3(liters), beforeLiters: before, afterLiters: farm.poolLiters, capacity };
}

/** 按现在的土壤水分一直放下去，还要多少小时成熟；已经成熟返回 0。 */
export function estimateRipeHours(farm, opts = {}) {
  if (!farm || !farm.planted) return null;
  const cfg = farmConfig(opts);
  if (farm.progress >= FARM_PROGRESS_MAX) return 0;
  const step = 0.05;
  let progress = farm.progress;
  let moisture = farm.moisture;
  let hours = 0;
  while (progress < FARM_PROGRESS_MAX && hours < 720) {
    const mid = clamp(moisture - (cfg.moistureDryPerHour * step) / 2, 0, 100);
    progress += (FARM_PROGRESS_MAX / cfg.growHours) * moistureFactor(mid) * step;
    moisture = clamp(moisture - cfg.moistureDryPerHour * step, 0, 100);
    hours += step;
  }
  return hours >= 720 ? null : round1(hours);
}

/** 这一季收割能拿到多少 kg（施肥会翻倍率）。 */
export function expectedYieldKg(farm, opts = {}) {
  const cfg = farmConfig(opts);
  return round3(cfg.harvestYieldKg * (farm?.fertilized ? cfg.fertilizeYieldBonus : 1));
}

export function formatLiters(value) {
  const n = round1(Number(value) || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** 稻田的可读快照；`opts` 里带稻田参数与米仓容量。 */
export function farmSummary(state, opts = {}) {
  const farm = state.farm ?? newFarm();
  const cfg = farmConfig(opts);
  const stage = farmStage(farm.progress);
  const ripe = farm.planted && farm.progress >= FARM_PROGRESS_MAX;
  const hoursToRipe = estimateRipeHours(farm, opts);
  const pests = round1(farm.pests);
  const birds = round1(farm.birds);
  const scarecrow = round1(farm.scarecrow);
  return {
    planted: farm.planted,
    stage: stage.key,
    stageName: stage.name,
    waterFactor: stage.waterFactor,
    progress: round1(farm.progress),
    progressText: formatSatiety(farm.progress),
    ripe,
    moisture: round1(farm.moisture),
    moistureText: formatSatiety(farm.moisture),
    moistureFactor: moistureFactor(farm.moisture),
    drought: farm.planted && farm.moisture <= DROUGHT_MOISTURE && !ripe,
    fertilized: farm.fertilized === true,
    plantedAt: farm.plantedAtMs ? new Date(farm.plantedAtMs).toISOString() : null,
    poolLiters: round1(farm.poolLiters),
    poolText: formatLiters(farm.poolLiters),
    poolCapacityLiters: cfg.poolCapacityLiters,
    waterPerWatering: cfg.waterPerWatering,
    lastRainAt: farm.lastRainAtMs ? new Date(farm.lastRainAtMs).toISOString() : null,
    // 虫与鸟：虫口自己会退，鸟会先吃虫再吃稻子。
    pests,
    pestsText: formatSatiety(pests),
    pestActive: pests > 0,
    pestHoursLeft: pests > 0 ? round1(pests / (PEST_DECAY_PER_HOUR - PEST_GROW_PER_HOUR)) : 0,
    birds,
    birdsText: formatSatiety(birds),
    birdActive: birds > 0,
    birdPhase: birds <= 0 ? 'none' : (pests > 0 ? 'pests' : 'crop'),
    birdHoursLeft: birds > 0 ? round1(birds / BIRD_LEAVE_PER_HOUR) : 0,
    scarecrow,
    scarecrowText: formatSatiety(scarecrow),
    scarecrowActive: scarecrow > 0,
    scarecrowHoursLeft: scarecrow > 0 ? round1((scarecrow / 100) * cfg.scarecrowHours) : 0,
    lastPestAt: farm.lastPestAtMs ? new Date(farm.lastPestAtMs).toISOString() : null,
    lastBirdAt: farm.lastBirdAtMs ? new Date(farm.lastBirdAtMs).toISOString() : null,
    pestDamagePerHour: cfg.pestDamagePerHour,
    birdDamagePerHour: cfg.birdDamagePerHour,
    hoursToRipe,
    expectedYieldKg: expectedYieldKg(farm, opts),
    growHours: cfg.growHours,
  };
}

export function stateSummary(state, opts = {}) {
  const stage = stageOf(state.satiety);
  const cooking = state.cooking
    ? {
        bowls: state.cooking.bowls,
        producedGrams: state.cooking.producedGrams,
        startedAt: new Date(state.cooking.startedAtMs).toISOString(),
        finishesAt: new Date(state.cooking.finishesAtMs).toISOString(),
        remainingMs: Math.max(0, state.cooking.finishesAtMs - state.updatedAtMs),
      }
    : null;
  return {
    satiety: round1(state.satiety),
    satietyText: formatSatiety(state.satiety),
    hungerStage: stage,
    hunger: stageLabel(stage),
    riceGrams: state.riceGrams,
    riceKg: round3(state.riceGrams / 1000),
    riceBowls: round3(state.riceGrams / RAW_GRAMS_PER_BOWL),
    cookedGrams: state.cookedGrams,
    cookedBowls: round3(state.cookedGrams / BOWL_GRAMS),
    cooking,
    farm: farmSummary(state, opts),
    cookerCapacityBowls: Number(opts.cookerCapacityBowls) || 0,
    riceBinCapacityKg: Number(opts.riceBinCapacityKg) || 0,
    updatedAt: new Date(state.updatedAtMs).toISOString(),
  };
}

function validCooking(value) {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const key of ['startedAtMs', 'finishesAtMs', 'bowls', 'rawGrams', 'producedGrams']) {
    if (!Number.isFinite(value[key])) return false;
  }
  if (value.startedAtMs < 0 || value.finishesAtMs < value.startedAtMs) return false;
  if (value.finishesAtMs > 8.64e15) return false;
  if (value.bowls < MIN_BOWLS || value.bowls > MAX_BOWLS) return false;
  if (value.rawGrams <= 0 || value.producedGrams <= 0) return false;
  return true;
}

function validFarm(farm) {
  if (!farm || typeof farm !== 'object' || Array.isArray(farm)) return false;
  if (typeof farm.planted !== 'boolean' || typeof farm.fertilized !== 'boolean') return false;
  for (const key of ['plantedAtMs', 'progress', 'moisture', 'poolLiters', 'lastRainAtMs',
    'pests', 'birds', 'scarecrow', 'lastPestAtMs', 'lastBirdAtMs']) {
    if (!Number.isFinite(farm[key])) return false;
  }
  if (farm.progress < 0 || farm.progress > FARM_PROGRESS_MAX) return false;
  if (farm.moisture < 0 || farm.moisture > 100) return false;
  if (farm.poolLiters < 0) return false;
  if (farm.pests < 0 || farm.pests > 100) return false;
  if (farm.birds < 0 || farm.birds > 100) return false;
  if (farm.scarecrow < 0 || farm.scarecrow > 100) return false;
  if (farm.plantedAtMs < 0 || farm.plantedAtMs > 8.64e15) return false;
  if (farm.lastRainAtMs < 0 || farm.lastRainAtMs > 8.64e15) return false;
  if (farm.lastPestAtMs < 0 || farm.lastPestAtMs > 8.64e15) return false;
  if (farm.lastBirdAtMs < 0 || farm.lastBirdAtMs > 8.64e15) return false;
  if (!farm.planted && farm.progress > 0) return false;
  return true;
}

export function validState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  // v1 是没有稻田、v2 是没有虫鸟稻草人的旧存档，读进来后由 migrateState 补齐。
  if (![1, 2, STATE_VERSION].includes(value.version)) return false;
  for (const key of ['satiety', 'riceGrams', 'cookedGrams', 'updatedAtMs']) {
    if (!Number.isFinite(value[key])) return false;
  }
  if (value.satiety < 0 || value.satiety > 100) return false;
  if (value.riceGrams < 0 || value.cookedGrams < 0) return false;
  if (value.updatedAtMs < 0 || value.updatedAtMs > 8.64e15) return false;
  if (!validCooking(value.cooking)) return false;
  if (value.version === STATE_VERSION && !validFarm(value.farm)) return false;
  return true;
}

/** 旧存档里的田可能是 v2 的（没有虫鸟稻草人），缺的键补 0。 */
function migrateFarm(farm) {
  const base = newFarm();
  if (!farm || typeof farm !== 'object') return base;
  return {
    planted: farm.planted === true,
    plantedAtMs: Number.isFinite(farm.plantedAtMs) ? farm.plantedAtMs : 0,
    progress: round3(clamp(Number(farm.progress) || 0, 0, FARM_PROGRESS_MAX)),
    moisture: round3(clamp(Number(farm.moisture) || 0, 0, 100)),
    fertilized: farm.fertilized === true,
    poolLiters: round3(Math.max(0, Number(farm.poolLiters) || 0)),
    lastRainAtMs: Number.isFinite(farm.lastRainAtMs) ? farm.lastRainAtMs : 0,
    pests: round3(clamp(Number(farm.pests) || 0, 0, 100)),
    birds: round3(clamp(Number(farm.birds) || 0, 0, 100)),
    scarecrow: round3(clamp(Number(farm.scarecrow) || 0, 0, 100)),
    lastPestAtMs: Number.isFinite(farm.lastPestAtMs) ? farm.lastPestAtMs : 0,
    lastBirdAtMs: Number.isFinite(farm.lastBirdAtMs) ? farm.lastBirdAtMs : 0,
  };
}

export function migrateState(value) {
  if (!validState(value)) throw new Error('状态文件格式不对。');
  return {
    version: STATE_VERSION,
    satiety: round3(value.satiety),
    riceGrams: Math.round(value.riceGrams),
    cookedGrams: Math.round(value.cookedGrams),
    cooking: value.cooking ? {
      startedAtMs: value.cooking.startedAtMs,
      finishesAtMs: value.cooking.finishesAtMs,
      bowls: value.cooking.bowls,
      rawGrams: value.cooking.rawGrams,
      producedGrams: value.cooking.producedGrams,
    } : null,
    farm: migrateFarm(value.farm),
    updatedAtMs: value.updatedAtMs,
  };
}

/** 读状态文件；不存在时返回 null，格式不对时抛错（由 World 备份后新建）。 */
export async function loadState(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return migrateState(JSON.parse(raw));
}

/** 原子写：先写临时文件，再换名。 */
export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await rename(temporary, file);
}
