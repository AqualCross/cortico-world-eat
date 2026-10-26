/**
 * 吃饭 World。
 *
 * 一个饱食度、一个米仓、一个电饭煲。桌宠用工具给自己做饭、吃饭；
 * 主人在控制台「厨房」面板直接加米、煮饭、吃饭。饱食度随时间下降，
 * 跨过新的饥饿阶段时投递 `eat.hunger` 事件。
 *
 * 状态是纯 JSON，落在 <dataDir>/eat/state.json；每次动作原子保存。
 * 应用关着的时间在下次启动时补算：重启后如果已经饿到新阶段，会补一条提醒。
 */
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS, EVENT_COOKED, EVENT_HUNGER, ID, configGroup, text } from './config.js';
import {
  BOWL_GRAMS,
  PET_MEAL_MAX_BOWLS,
  RAW_GRAMS_PER_BOWL,
  addRice,
  advanceState,
  bellyLabel,
  buildScarecrow,
  cook,
  eat,
  farmConfig,
  farmSummary,
  fertilizeField,
  fillPool,
  formatBowls,
  formatBowlsZh,
  formatKg,
  formatLiters,
  formatSatiety,
  harvestField,
  loadState,
  newState,
  saveState,
  sowField,
  stageLabel,
  stateSummary,
  waterField,
} from './state.js';

const ENV_PROMPT = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

const msg = (err) => (err instanceof Error ? err.message : String(err));

/**
 * 全部工具的声明（不含 handler）；定义里的 describe 与 tools() 都取它。
 *
 * 描述直接用中文：框架的 ToolSchema.description 只是一个字符串，没有按语言分份的机制，
 * 模型（DeepSeek 等）读中文没有问题；和回执、环境提示词保持同一种语言，也省 token。
 * 名字仍然是英文标识符，改名会打断已有调用记录和存档里的 senderKey。
 */
export const EAT_TOOL_DECLS = [
  {
    name: 'eat_status',
    tags: ['read', 'snapshot'],
    description: '看看自己现在有多饱、米仓里还有多少生米、电饭煲里有没有现成的饭。拿不准要不要煮、能不能吃的时候，先看一眼。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'eat_cook',
    tags: ['write'],
    description: '给自己煮一锅饭，选半碗到二十碗；一碗熟饭用 100 g 生米。按下开关就得等（worlds.eat.cookMinutes 分钟），这一锅煮好之前不能下第二锅。立即返回；饭好了会收到 eat.cooked 事件。米不够、锅放不下、或已经有一锅在煮都会失败。主人从控制台「厨房」面板煮饭，不走这个工具。',
    parameters: {
      type: 'object',
      properties: {
        bowls: {
          type: 'number',
          minimum: 0.5,
          maximum: 20,
          multipleOf: 0.5,
          description: '煮几碗熟饭；0.5 = 半碗。',
        },
      },
      required: ['bowls'],
      additionalProperties: false,
    },
  },
  {
    name: 'eat_meal',
    tags: ['write'],
    description: '盛电饭煲里已经煮好的饭吃。一次只吃一碗或半碗——饭要一碗一碗吃，没吃饱就再盛一碗。现成的饭不够、或者饭还在锅里煮，都会失败。',
    parameters: {
      type: 'object',
      properties: {
        bowls: {
          type: 'number',
          minimum: 0.5,
          maximum: 1,
          multipleOf: 0.5,
          description: '这一碗盛多少：0.5 = 半碗，1 = 一碗。',
        },
      },
      required: ['bowls'],
      additionalProperties: false,
    },
  },
  {
    name: 'farm_status',
    tags: ['read', 'snapshot'],
    description: '看看田里的水稻：种没种、长到哪一步、大概多久能割、土有多湿、这一季施没施肥、水池还剩多少水、最近一次下雨是什么时候。生长和灾害都不会主动推送，想知道情况就自己来看，不要等事件。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'farm_sow',
    tags: ['write'],
    description: '在空田里撒下稻种，开始新一季水稻。田里已经种着水稻会失败。播种会把进度清零、抹掉上一季的施肥记录；土里的水分留着。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'farm_water',
    tags: ['write'],
    description: '从水池打水浇田：土喝饱水，稻子当场往前蹿一截。发芽和抽穗的时候最吃水，灌浆期浇了也催不动。没播种、已经成熟、水池没水都会失败。下雨等于免费浇一次，不花池子里的水。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'farm_fertilize',
    tags: ['write'],
    description: '给正在长的水稻施肥，让穗子沉一些，收割时产量更高。一季只能施一次，重新播种才会重置；现在不消耗化肥。没播种、已经成熟、或这一季已经施过都会失败。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'farm_harvest',
    tags: ['write'],
    description: '把熟了的稻子割下来，稻谷直接倒进米仓。没熟、或者米仓放不下都会失败；割完田就空了，能再种一季。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'farm_scarecrow',
    tags: ['write'],
    description: '在田头立个稻草人，把鸟群赶走，之后一段时间鸟不会再来；它站旧了自己会倒，倒了才能再立。它只吓鸟、不管虫——没有鸟来吃，虫会一直啃到它们自己退。已经有稻草人立着会失败（会告诉你还能站多久）。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

export class EatWorld {
  #host = null;
  #state = null;
  #started = false;
  #timer = null;
  #queue = Promise.resolve();
  #now;
  #random;
  #setTimeout;
  #clearTimeout;

  constructor(opts = {}) {
    this.id = ID;
    this.cfg = opts.cfg ?? { ...DEFAULTS };
    this.dataDir = opts.dataDir ?? process.cwd();
    this.botDir = opts.botDir ?? process.cwd();
    this.packageDir = opts.packageDir ?? process.cwd();
    this.language = 'zh';
    this.#now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.#random = typeof opts.random === 'function' ? opts.random : Math.random;
    this.#setTimeout = opts.timers?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeout = opts.timers?.clearTimeout ?? ((timer) => clearTimeout(timer));
  }

  // -------------------------------------------------------------------------
  // 配置：config.json 的段被 WebUI 热改，每次用时现读
  // -------------------------------------------------------------------------

  #raw(key) {
    const value = this.cfg?.[key];
    return value === undefined || value === null ? DEFAULTS[key] : value;
  }

  #num(key, min, max) {
    const fallback = Number(DEFAULTS[key]);
    const n = Number(this.#raw(key));
    if (!Number.isFinite(n)) return Number.isFinite(fallback) ? fallback : min;
    return Math.min(Math.max(n, min), max);
  }

  #tickMs() {
    return Math.round(this.#num('tickIntervalMs', 5000, 3600000));
  }

  #riceCapacityGrams() {
    return Math.round(this.#num('riceBinCapacityKg', 0.1, 100) * 1000);
  }

  #riceCapacityKg() {
    return this.#riceCapacityGrams() / 1000;
  }

  #cookerCapacityBowls() {
    return this.#num('cookerCapacityBowls', 1, 50);
  }

  #cookMinutes() {
    return this.#num('cookMinutes', 1, 180);
  }

  #hungerPerHour() {
    return this.#num('hungerPerHour', 0, 100);
  }

  #satietyPerBowl() {
    return this.#num('satietyPerBowl', 0, 100);
  }

  /** 稻田参数：热改即时生效，缺省值由 state.js 的 FARM_DEFAULTS 兜。 */
  #farmCfg() {
    return farmConfig({
      growHours: this.#raw('growHours'),
      moisturePerWatering: this.#raw('moisturePerWatering'),
      waterPerWatering: this.#raw('waterPerWatering'),
      poolCapacityLiters: this.#raw('poolCapacityLiters'),
      moistureDryPerHour: this.#raw('moistureDryPerHour'),
      rainChancePerHour: this.#raw('rainChancePerHour'),
      rainWaterLiters: this.#raw('rainWaterLiters'),
      harvestYieldKg: this.#raw('harvestYieldKg'),
      fertilizeYieldBonus: this.#raw('fertilizeYieldBonus'),
      pestChancePerHour: this.#raw('pestChancePerHour'),
      birdChancePerHour: this.#raw('birdChancePerHour'),
      pestDamagePerHour: this.#raw('pestDamagePerHour'),
      birdDamagePerHour: this.#raw('birdDamagePerHour'),
      scarecrowHours: this.#raw('scarecrowHours'),
      harvestBonusChance: this.#raw('harvestBonusChance'),
    });
  }

  /** 时间推进要用的参数；`rollEvents=false` 时只结算生长，不掷雨和灾害。 */
  #advanceOpts(rollEvents = true) {
    return { farm: this.#farmCfg(), random: this.#random, rollEvents };
  }

  #text() {
    return text(this.language);
  }

  /** 状态文件：<dataDir>/eat/state.json。 */
  stateFile() {
    return join(this.dataDir, 'eat', 'state.json');
  }

  // -------------------------------------------------------------------------
  // 提示词
  // -------------------------------------------------------------------------

  /** 环境模板是静态说明；当前饱食度用 eat_status 查，避免每分钟打穿前缀缓存。 */
  envPromptVars() {
    return {};
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  tools() {
    return EAT_TOOL_DECLS.map((decl) => ({
      ...decl,
      handler: (args) => this.#runTool(decl.name, args ?? {}),
    }));
  }

  async #runTool(name, args) {
    try {
      return await this.#serial(() => this.#tool(name, args));
    } catch (err) {
      return { text: `[${name} 失败] ${msg(err)}`, failed: true };
    }
  }

  async #tool(name, args) {
    switch (name) {
      case 'eat_status': return this.#statusTool();
      case 'eat_cook': return await this.#cookTool(args);
      case 'eat_meal': return await this.#mealTool(args);
      case 'farm_status': return this.#farmStatusTool();
      case 'farm_sow': return await this.#sowTool();
      case 'farm_water': return await this.#waterTool();
      case 'farm_fertilize': return await this.#fertilizeTool();
      case 'farm_harvest': return await this.#harvestTool();
      case 'farm_scarecrow': return await this.#scarecrowTool();
      default: return { text: `[${name} 失败] 不认识这个工具。`, failed: true };
    }
  }

  #ensureStarted() {
    if (!this.#started || !this.#state) {
      throw new Error('吃饭 World 还没启动；等它启用后再试。');
    }
  }

  #statusTool() {
    this.#ensureStarted();
    // 只在一个副本上结算：真正的饥饿/饭好提醒仍由定时器或动作发现并投递。
    // 预览不掷下雨，免得状态里出现一场其实没落下来的雨。
    const next = structuredClone(this.#state);
    advanceState(next, this.#now(), this.#hungerPerHour(), this.#advanceOpts(false));
    return { text: this.#statusText(next) };
  }

  async #cookTool(args) {
    this.#ensureStarted();
    const bowls = args.bowls;
    const result = await this.#mutate((state) => cook(state, {
      bowls,
      who: 'pet',
      cookerCapacityBowls: this.#cookerCapacityBowls(),
      cookMinutes: this.#cookMinutes(),
    }));
    const s = this.#snapshot();
    const wait = Math.max(1, Math.ceil(result.cookMs / 60000));
    const lines = [
      `你把够煮${formatBowlsZh(result.bowls)}的米淘好下了锅，按下开关；大约 ${wait} 分钟后好。`,
      '这一锅就定下了，煮好之前不能再下第二锅。',
      `用了 ${result.rawGrams} g 生米，米仓里还剩 ${formatKg(result.riceGrams)} kg。`,
    ];
    if (s.cookedBowls > 0) lines.push(`锅里还有${formatBowlsZh(s.cookedBowls)}现成的饭，可以先盛。`);
    lines.push(`你现在${bellyLabel(s.satiety)}。`);
    return { text: lines.join('\n') };
  }

  async #mealTool(args) {
    this.#ensureStarted();
    const bowls = args.bowls;
    const result = await this.#mutate((state) => eat(state, {
      bowls,
      who: 'pet',
      maxBowls: PET_MEAL_MAX_BOWLS,
      satietyPerBowl: this.#satietyPerBowl(),
    }));
    const s = this.#snapshot();
    const lines = [`${formatBowlsZh(result.bowls)}饭下肚，现在${bellyLabel(result.afterSatiety)}。`];
    if (result.gained <= 0) lines.push('其实肚子早就饱了，这一碗也只是慢慢吃完。');
    if (result.cookedGrams >= BOWL_GRAMS / 2) {
      lines.push(`锅里还剩${formatBowlsZh(result.cookedGrams / BOWL_GRAMS)}现成的饭。`);
    } else {
      lines.push('锅里没剩饭了。');
    }
    if (s.cooking) {
      lines.push(`另一锅还在煮${formatBowlsZh(s.cooking.bowls)}，约 ${Math.max(1, Math.ceil(s.cooking.remainingMs / 60000))} 分钟后好。`);
    }
    if (result.cookedGrams >= BOWL_GRAMS / 2 && result.afterSatiety < 100) {
      lines.push('没吃饱就再盛一碗。');
    }
    return { text: lines.join('\n') };
  }

  // -------------------------------------------------------------------------
  // 稻田工具
  // -------------------------------------------------------------------------

  #farmStatusTool() {
    this.#ensureStarted();
    const next = structuredClone(this.#state);
    advanceState(next, this.#now(), this.#hungerPerHour(), this.#advanceOpts(false));
    return { text: this.#farmStatusText(this.#snapshot(next)) };
  }

  async #sowTool() {
    this.#ensureStarted();
    await this.#mutate((state) => sowField(state, { nowMs: this.#now() }));
    const f = this.#snapshot().farm;
    return {
      text: [
        '你把稻种撒进田里，水面浮起一层细碎的谷粒，这一季从今天算起。',
        `土还是潮的：水分 ${f.moistureText}%（长势 ×${f.moistureFactor}）——水足的时候稻子长得快，土干了就发蔫。`,
        `照现在这样，${this.#inText(f.hoursToRipe)}能割；中间浇水还能催一催。`,
        '一季只施一次肥，肥力要到收割才见分晓。',
      ].join('\n'),
    };
  }

  async #waterTool() {
    this.#ensureStarted();
    const result = await this.#mutate((state) => waterField(state, this.#farmCfg()));
    const f = this.#snapshot().farm;
    const lines = [
      `你从池子里打了 ${formatLiters(result.cost)} L 水，顺着田埂放进田里；池子里还剩 ${formatLiters(result.poolLiters)} L。`,
      `土喝了个饱：水分 ${formatSatiety(result.moistureBefore)}% → ${f.moistureText}%。`,
      `${result.stageName}的稻子正吃水（×${result.waterFactor}），这一浇把进度从 ${formatSatiety(result.progressBefore)}% 推到了 ${f.progressText}%。`,
    ];
    if (result.moistureWasted > 0) {
      lines.push(`不过土已经喝不下，有 ${formatSatiety(result.moistureWasted)}% 的水顺着田埂流走了。`);
    }
    if (result.stageChanged) lines.push(`稻子悄悄抽了新叶，进了${result.stageAfterName}。`);
    if (result.ripe) lines.push('稻穗已经垂下来了，可以割了。');
    else lines.push(`${this.#inText(f.hoursToRipe)}能割。`);
    return { text: lines.join('\n') };
  }

  async #fertilizeTool() {
    this.#ensureStarted();
    const result = await this.#mutate((state) => fertilizeField(state, this.#farmCfg()));
    const f = this.#snapshot().farm;
    return {
      text: [
        `你把肥撒进${result.stageName}的田里，水面起了一层细纹。`,
        `这一季的稻子吃得饱，穗子会沉些：收割时产量 ×${result.bonus}，从 ${formatKg(result.baseYieldKg * 1000)} kg 提到 ${formatKg(result.yieldKg * 1000)} kg 稻谷。`,
        '一季只施一次，下一季重新算。',
        `现在进度 ${f.progressText}%，土壤水分 ${f.moistureText}%。`,
      ].join('\n'),
    };
  }

  async #harvestTool() {
    this.#ensureStarted();
    const result = await this.#mutate((state) => harvestField(state, {
      ...this.#farmCfg(),
      riceCapacityGrams: this.#riceCapacityGrams(),
      random: this.#random,
    }));
    const s = this.#snapshot();
    // 只报总数：多收的那一点点不单独提，让它自己对预计产量去。
    const lines = [
      `你割下这一季的稻子，捆好、晒了一会儿，脱粒过秤：${formatKg(result.grams)} kg 稻谷${result.fertilized ? `（施过肥，穗子压手，×${result.yieldMultiplier}）` : ''}。`,
      `一袋袋倒进米仓，米仓现在 ${formatKg(result.afterGrams)} kg，最多装 ${s.riceBinCapacityKg.toFixed(2)} kg；这些米够煮${formatBowlsZh(result.riceBowls)}的饭。`,
      '田里空出来了，歇口气就能再播一季。',
    ];
    return { text: lines.join('\n') };
  }

  async #scarecrowTool() {
    this.#ensureStarted();
    const result = await this.#mutate((state) => buildScarecrow(state, { nowMs: this.#now(), ...this.#farmCfg() }));
    const f = this.#snapshot().farm;
    const lines = [
      result.chased > 0
        ? `你在田头立起稻草人，风一吹袖子哗啦响；田里的鸟群惊起来，扑棱棱地飞走了（鸟群 ${formatSatiety(result.chased)}）。`
        : '你在田头立起稻草人，风一吹袖子哗啦响。',
      `稻草人立得稳，${this.#inText(result.lastsHours)}才会倒；倒了才能再立。`,
    ];
    if (f.pestActive) {
      lines.push(`不过它只吓鸟，不管虫。田里还有 ${f.pestsText}% 的虫，鸟不来吃，只能等它们自己退（${this.#inText(f.pestHoursLeft)}）。`);
    } else {
      lines.push('它只吓鸟，不管虫；鸟不来了，虫也没人帮着吃，记得常去田里看一眼。');
    }
    return { text: lines.join('\n') };
  }

  #farmStatusText(s) {
    this.#ensureStarted();
    const f = s.farm;
    const cfg = this.#farmCfg();
    const lines = ['稻田状态'];
    if (!f.planted) {
      lines.push('水稻：田里空着，可以播种（farm_sow）。');
    } else if (f.ripe) {
      lines.push(`水稻：已经熟了，穗子垂着头——可以割了（farm_harvest），估摸着能收 ${f.expectedYieldKg.toFixed(2)} kg 稻谷。`);
    } else {
      lines.push(`水稻：${f.stageName}，进度 ${f.progressText}%，${this.#inText(f.hoursToRipe)}能割。`);
    }
    lines.push(`土壤：水分 ${f.moistureText}%（长势 ×${f.moistureFactor}；土干了就发蔫，浇一次补 ${cfg.moisturePerWatering}%）`);
    if (f.drought) {
      lines.push('旱情：土已经干透，长势只剩 0.3 倍；等雨，或者自己浇水。');
    }
    if (f.fertilized) {
      lines.push(`施肥：这一季已经施过（收割产量 ×${cfg.fertilizeYieldBonus}，估计能收 ${f.expectedYieldKg.toFixed(2)} kg）。`);
    } else {
      lines.push('施肥：还没施（一季一次，不消耗化肥，只让穗子沉些）。');
    }
    lines.push(`水池：${f.poolText} L / ${formatLiters(f.poolCapacityLiters)} L（浇一次 ${formatLiters(f.waterPerWatering)} L）`);
    lines.push(f.lastRainAt ? `下雨：最近一次在${this.#agoText(f.lastRainAt)}；雨会自己把田浇了，还往池子里添水。` : '下雨：还没下过；雨会自己把田浇了，还往池子里添水。');
    lines.push(this.#critterText(f));
    if (f.planted && !f.ripe) lines.push(`浇水效果：现在是${f.stageName}，×${f.waterFactor}。`);
    return lines.join('\n');
  }

  /** 虫、鸟、稻草人三件事压成一行；都正常时就说田里太平。 */
  #critterText(f) {
    const bits = [];
    if (f.pestActive) {
      bits.push(`虫口 ${f.pestsText}%（一小时啃掉约 ${formatSatiety((f.pestDamagePerHour * f.pests) / 100)} 点，${this.#inText(f.pestHoursLeft)}自己退干净）`);
    } else {
      bits.push('没有虫');
    }
    if (f.birdActive) {
      bits.push(`鸟群 ${f.birdsText}（${f.birdPhase === 'pests' ? '正在吃虫' : '虫吃光了，正在啄稻穗'}，${this.#inText(f.birdHoursLeft)}后散去）`);
    } else {
      bits.push('没有鸟');
    }
    if (f.scarecrowActive) {
      bits.push(`稻草人还立着（耐久 ${f.scarecrowText}%，${this.#inText(f.scarecrowHoursLeft)}后倒）`);
    } else {
      bits.push('没立稻草人');
    }
    return `田里：${bits.join('；')}。`;
  }

  /** 把“还有多少小时”写成一个能直接接在句子里的短语。 */
  #inText(hours) {
    if (hours === null || hours === undefined) return '还要一个多月';
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) return '马上';
    if (h < 1) return `约 ${Math.max(1, Math.round(h * 60))} 分钟后`;
    if (h < 48) return `约 ${formatSatiety(h)} 小时后`;
    return `约 ${formatSatiety(h / 24)} 天后`;
  }

  /** ISO 时间离现在多久。 */
  #agoText(iso) {
    const at = Date.parse(String(iso));
    if (!Number.isFinite(at)) return '不久前';
    const minutes = Math.max(0, Math.round((this.#now() - at) / 60000));
    if (minutes < 1) return '刚才';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = minutes / 60;
    if (hours < 48) return `${formatSatiety(hours)} 小时前`;
    return `${formatSatiety(hours / 24)} 天前`;
  }

  /** 在一个状态副本上结算时间并执行动作，保存成功后才替换当前状态。 */
  async #mutate(action) {
    const now = this.#now();
    const next = structuredClone(this.#state);
    const advanced = advanceState(next, now, this.#hungerPerHour(), this.#advanceOpts(true));
    // 记下动作前的虫鸟数量：动作本身（比如立稻草人）会立刻把它们清零。
    const critters = { pests: next.farm?.pests ?? 0, birds: next.farm?.birds ?? 0 };
    const result = action(next);
    await this.#saveState(next);
    this.#state = next;
    if (advanced.farm?.rain) this.#logRain(advanced.farm.rain);
    this.#logDisasters(advanced.farm, critters);
    if (advanced.cookingFinished) {
      try {
        await this.#pushCooked(advanced.cookingFinished);
      } catch (err) {
        this.#host?.log?.warn?.('吃饭：饭好提醒没送出去', { err: msg(err) });
      }
    }
    return result;
  }

  #logRain(rain) {
    this.#host?.log?.info?.('稻田：下雨了', {
      at: new Date(rain.atMs).toISOString(),
      pool: rain.poolAfter,
      moisture: rain.moistureAfter,
      progress: rain.progress,
      watered: rain.watered,
    });
  }

  /** 虫灾和鸟群只写日志，不投递事件：桌宠靠 farm_status 自己查。 */
  #logDisasters(farm, snapshot = null) {
    if (!farm) return;
    const pests = snapshot?.pests ?? this.#state?.farm?.pests ?? 0;
    const birds = snapshot?.birds ?? this.#state?.farm?.birds ?? 0;
    for (const at of farm.pestOutbreaks ?? []) {
      this.#host?.log?.info?.('稻田：闹虫灾', { at: new Date(at).toISOString(), pests });
    }
    for (const at of farm.birdFlocks ?? []) {
      this.#host?.log?.info?.('稻田：来了一群鸟', { at: new Date(at).toISOString(), birds });
    }
  }

  // -------------------------------------------------------------------------
  // 控制台“厨房”面板：主人的动作只从这里来
  // -------------------------------------------------------------------------

  /** 面板的 data plane。`state` 只读；其余是主人动作，按同一个队列串行执行。 */
  async invoke(panel, method, args = []) {
    if (panel !== 'kitchen' && panel !== 'farm') throw new Error(`未知面板：${panel}`);
    const list = Array.isArray(args) ? args : [args];
    if (method === 'state') {
      return await this.#serial(() => {
        if (!this.#state) return this.#snapshot();
        // 只在一个副本上结算给面板看：真正的阶段提醒仍由定时器发现并投递。
        const next = structuredClone(this.#state);
        advanceState(next, this.#now(), this.#hungerPerHour(), this.#advanceOpts(false));
        return this.#snapshot(next);
      });
    }
    if (!this.#started) throw new Error('吃饭 World 还没启动。');
    if (panel === 'farm') {
      switch (method) {
        case 'sow': return await this.#ownerSow();
        case 'water': return await this.#ownerWater();
        case 'fertilize': return await this.#ownerFertilize();
        case 'harvest': return await this.#ownerHarvest();
        case 'scarecrow': return await this.#ownerScarecrow();
        case 'fillPool': return await this.#ownerFillPool(list[0]);
        default: throw new Error(`未知面板方法：${method}`);
      }
    }
    switch (method) {
      case 'addRice': return await this.#ownerAddRice(list[0]);
      case 'cook': return await this.#ownerCook(list[0]);
      case 'eat': return await this.#ownerEat(list[0]);
      default: throw new Error(`未知面板方法：${method}`);
    }
  }

  async #ownerAddRice(kg) {
    const result = await this.#serial(() => this.#mutate((state) => addRice(state, {
      kg,
      riceCapacityGrams: this.#riceCapacityGrams(),
    })));
    return {
      state: this.#snapshot(),
      message: `主人往米仓加了 ${formatKg(result.grams)} kg 米；米仓现在有 ${formatKg(result.afterGrams)} kg。`,
    };
  }

  async #ownerCook(bowls) {
    const result = await this.#serial(() => this.#mutate((state) => cook(state, {
      bowls,
      who: 'owner',
      cookerCapacityBowls: this.#cookerCapacityBowls(),
      cookMinutes: this.#cookMinutes(),
    })));
    const s = this.#snapshot();
    const lines = [
      `主人开始煮 ${formatBowls(result.bowls)} 碗饭，约 ${Math.max(1, Math.ceil(result.cookMs / 60000))} 分钟后好。`,
      '这一锅的量已经锁定。',
    ];
    if (s.cookedBowls > 0) lines.push(`电饭煲里另外还有 ${formatBowls(s.cookedBowls)} 碗现成的饭。`);
    return { state: s, message: lines.join('') };
  }

  async #ownerEat(bowls) {
    const result = await this.#serial(() => this.#mutate((state) => eat(state, {
      bowls,
      who: 'owner',
      satietyPerBowl: this.#satietyPerBowl(),
    })));
    const s = this.#snapshot();
    const lines = [
      `主人吃了 ${formatBowls(result.bowls)} 碗饭；电饭煲里还剩 ${formatBowls(result.cookedGrams / BOWL_GRAMS)} 碗现成的饭。`,
    ];
    if (s.cooking) {
      lines.push(`还在煮 ${formatBowls(s.cooking.bowls)} 碗饭，约 ${Math.max(1, Math.ceil(s.cooking.remainingMs / 60000))} 分钟后好。`);
    }
    return { state: s, message: lines.join('') };
  }

  async #ownerSow() {
    await this.#serial(() => this.#mutate((state) => sowField(state, { nowMs: this.#now() })));
    const s = this.#snapshot();
    return {
      state: s,
      message: `主人播下了稻种；土壤水分 ${s.farm.moistureText}%，按现在的水分${this.#inText(s.farm.hoursToRipe)}成熟。`,
    };
  }

  async #ownerWater() {
    const result = await this.#serial(() => this.#mutate((state) => waterField(state, this.#farmCfg())));
    const s = this.#snapshot();
    return {
      state: s,
      message: `主人浇了一次水，用了 ${formatLiters(result.cost)} L；进度 ${s.farm.progressText}%，水池还剩 ${s.farm.poolText} L。`,
    };
  }

  async #ownerFertilize() {
    const result = await this.#serial(() => this.#mutate((state) => fertilizeField(state, this.#farmCfg())));
    const s = this.#snapshot();
    return {
      state: s,
      message: `主人给水稻施了肥；这一季收割产量 ×${result.bonus}，预计 ${s.farm.expectedYieldKg.toFixed(2)} kg 稻谷。`,
    };
  }

  async #ownerHarvest() {
    const result = await this.#serial(() => this.#mutate((state) => harvestField(state, {
      ...this.#farmCfg(),
      riceCapacityGrams: this.#riceCapacityGrams(),
      random: this.#random,
    })));
    const s = this.#snapshot();
    return {
      state: s,
      message: `主人收了 ${formatKg(result.grams)} kg 稻谷进米仓；米仓现在有 ${formatKg(result.afterGrams)} kg，田里空出来了。`,
    };
  }

  async #ownerScarecrow() {
    const result = await this.#serial(() => this.#mutate((state) => buildScarecrow(state, this.#farmCfg())));
    const s = this.#snapshot();
    return {
      state: s,
      message: `主人立起了稻草人${result.chased > 0 ? `，赶走了鸟群 ${formatSatiety(result.chased)}` : ''}；${this.#inText(result.lastsHours)}倒。`,
    };
  }

  async #ownerFillPool(liters) {
    const result = await this.#serial(() => this.#mutate((state) => fillPool(state, {
      liters,
      poolCapacityLiters: this.#farmCfg().poolCapacityLiters,
    })));
    const s = this.#snapshot();
    return {
      state: s,
      message: `主人往水池打了 ${formatLiters(result.liters)} L；水池现在 ${s.farm.poolText} L / ${formatLiters(s.farm.poolCapacityLiters)} L。`,
    };
  }

  #statusText(fromState = this.#state) {
    this.#ensureStarted();
    const s = this.#snapshot(fromState);
    const riceBowlText = s.riceBowls >= 0.5 ? `够煮${formatBowlsZh(s.riceBowls)}的饭` : '还不够煮半碗';
    const lines = [
      '你的肚子和厨房',
      `饱食度：${s.satietyText}/100（${s.hunger}）`,
      `米仓：${s.riceKg.toFixed(2)} kg 生米（${riceBowlText}）· 最多 ${s.riceBinCapacityKg.toFixed(2)} kg`,
    ];
    if (s.cooking) {
      const wait = Math.max(1, Math.ceil(s.cooking.remainingMs / 60000));
      const extra = s.cookedBowls > 0 ? `；锅里另外还有${formatBowlsZh(s.cookedBowls)}现成的饭` : '';
      lines.push(`电饭煲：正在煮${formatBowlsZh(s.cooking.bowls)}饭，约 ${wait} 分钟后好${extra}。这一锅的量已经定下。`);
    } else if (s.cookedBowls >= 0.5) {
      lines.push(`电饭煲：${formatBowlsZh(s.cookedBowls)}热饭（${Math.round(s.cookedGrams)} g）· 最多${formatBowlsZh(s.cookerCapacityBowls)}`);
    } else {
      lines.push(`电饭煲：空的（最多${formatBowlsZh(s.cookerCapacityBowls)}）`);
    }
    const rate = this.#hungerPerHour();
    lines.push(rate > 0 ? `消耗：约 ${rate} 点/小时。` : '消耗：关着（不会变饿）。');
    lines.push(`单位：一碗熟饭 = ${BOWL_GRAMS} g，用 ${RAW_GRAMS_PER_BOWL} g 生米；自己吃一碗 +${this.#satietyPerBowl()} 饱食度，一次只盛一碗或半碗。`);
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // 时间推进与饥饿事件
  // -------------------------------------------------------------------------

  #schedule() {
    if (!this.#started) return;
    if (this.#timer) {
      this.#clearTimeout(this.#timer);
      this.#timer = null;
    }
    const timer = this.#setTimeout(() => {
      this.#timer = null;
      void this.#serial(() => this.#tick())
        .catch((err) => this.#host?.log?.warn?.('吃饭：定时结算失败', { err: msg(err) }))
        .finally(() => this.#schedule());
    }, this.#tickMs());
    if (timer && typeof timer.unref === 'function') timer.unref();
    this.#timer = timer;
  }

  async #tick() {
    if (!this.#started || !this.#state) return;
    const now = this.#now();
    const result = advanceState(this.#state, now, this.#hungerPerHour(), this.#advanceOpts(true));
    let dirty = false;
    if (result.cookingFinished) {
      try {
        await this.#pushCooked(result.cookingFinished);
      } catch (err) {
        this.#host?.log?.warn?.('吃饭：饭好提醒没送出去', { err: msg(err) });
      }
      dirty = true;
    }
    if (result.toStage > result.fromStage) {
      try {
        await this.#pushHunger(result.toStage, now);
      } catch (err) {
        this.#host?.log?.warn?.('吃饭：饥饿提醒没送出去', { err: msg(err) });
      }
      dirty = true;
    }
    // 水稻只推进、不投递事件：桌宠有自己的定时器，用 farm_status 自己查。
    if (result.farm?.rain) {
      this.#logRain(result.farm.rain);
      dirty = true;
    }
    if (result.farm?.pestOutbreaks?.length || result.farm?.birdFlocks?.length) {
      this.#logDisasters(result.farm);
      dirty = true;
    }
    if (dirty) await this.#save();
  }

  async #pushHunger(stage, now) {
    const host = this.#host;
    if (!host?.pushEvent) return;
    const s = this.#snapshot();
    const bits = [`吃饭：${stageLabel(stage)}。`];
    if (s.cookedBowls >= 0.5) {
      bits.push(`锅里还有${formatBowlsZh(s.cookedBowls)}热饭，先去盛了吃。`);
    } else if (s.cooking) {
      const wait = Math.max(1, Math.ceil(s.cooking.remainingMs / 60000));
      bits.push(`锅里还在煮${formatBowlsZh(s.cooking.bowls)}，约 ${wait} 分钟后好，先忍一忍。`);
    } else if (s.riceBowls >= 0.5) {
      bits.push(`电饭煲空着；米仓里还有 ${s.riceKg.toFixed(2)} kg 生米，够煮${formatBowlsZh(s.riceBowls)}的饭，可以去淘米。`);
    } else {
      bits.push('米仓空了，得请主人到控制台「厨房」面板添米。');
    }
    await host.pushEvent({
      type: EVENT_HUNGER,
      source: this.id,
      senderKey: 'eat.hunger',
      origin: 'internal',
      ts: new Date(now).toISOString(),
      text: bits.join(''),
      meta: {
        stage,
        satiety: s.satiety,
        riceGrams: s.riceGrams,
        cookedGrams: s.cookedGrams,
        riceKg: s.riceKg,
        cookedBowls: s.cookedBowls,
      },
    }, { deliver: true, trigger: 'debounce' });
    this.#host?.log?.info?.('吃饭：饥饿提醒', {
      stage,
      satiety: s.satietyText,
      riceKg: s.riceKg,
      cookedBowls: s.cookedBowls,
    });
  }

  async #pushCooked(finished) {
    const host = this.#host;
    if (!host?.pushEvent) return;
    const s = this.#snapshot();
    const more = s.cooking ? `另外还有${formatBowlsZh(s.cooking.bowls)}正在煮。` : '';
    await host.pushEvent({
      type: EVENT_COOKED,
      source: this.id,
      senderKey: 'eat.cooked',
      origin: 'internal',
      ts: new Date(this.#now()).toISOString(),
      text: `吃饭：电饭煲嘀了一声，饭好了。新煮好的${formatBowlsZh(finished.bowls)}热饭（${finished.producedGrams} g）盛在锅里，现在一共${formatBowlsZh(s.cookedBowls)}现成的饭，可以吃了。${more}`,
      meta: {
        bowls: finished.bowls,
        producedGrams: finished.producedGrams,
        cookedGrams: s.cookedGrams,
        cookedBowls: s.cookedBowls,
      },
    }, { deliver: true, trigger: 'debounce' });
    this.#host?.log?.info?.('吃饭：饭煮好了', {
      bowls: finished.bowls,
      producedGrams: finished.producedGrams,
      cookedBowls: s.cookedBowls,
    });
  }

  #serial(task) {
    const run = () => task();
    const result = this.#queue.then(run, run);
    this.#queue = result.then(() => {}, () => {});
    return result;
  }

  // -------------------------------------------------------------------------
  // 快照与 WebUI
  // -------------------------------------------------------------------------

  #snapshot(fromState = this.#state) {
    if (!fromState) {
      return {
        started: false,
        satiety: 0,
        satietyText: '0',
        hungerStage: 0,
        hunger: '未启动',
        riceGrams: 0,
        riceKg: 0,
        riceBowls: 0,
        cookedGrams: 0,
        cookedBowls: 0,
        cooking: null,
        farm: farmSummary({ farm: null }, this.#farmCfg()),
        cookerCapacityBowls: this.#cookerCapacityBowls(),
        riceBinCapacityKg: this.#riceCapacityKg(),
        hungerPerHour: this.#hungerPerHour(),
        satietyPerBowl: this.#satietyPerBowl(),
        updatedAt: '',
      };
    }
    return {
      started: this.#started,
      ...stateSummary(fromState, {
        ...this.#farmCfg(),
        cookerCapacityBowls: this.#cookerCapacityBowls(),
        riceBinCapacityKg: this.#riceCapacityKg(),
      }),
      hungerPerHour: this.#hungerPerHour(),
      satietyPerBowl: this.#satietyPerBowl(),
    };
  }

  webUi(language = 'zh') {
    this.language = language === 'en' ? 'en' : 'zh';
    const t = this.#text();
    const s = this.#snapshot();
    const started = s.started;
    return {
      label: t.label,
      lamps: [{
        label: t.lamp,
        state: started ? 'online' : 'offline',
        hint: started ? t.lampHint({ ...s, cookedBowls: formatBowls(s.cookedBowls) }) : t.stopped,
      }],
      badges: [
        {
          label: t.badgeSatiety,
          value: started ? `${s.satietyText}%` : '—',
          tone: started && s.hungerStage === 0 ? 'on' : 'off',
        },
        {
          label: t.badgeRice,
          value: started ? `${s.riceKg.toFixed(2)} kg` : '—',
          tone: started && s.riceGrams > 0 ? 'on' : 'off',
        },
        {
          label: t.badgeCooked,
          value: started ? `${formatBowls(s.cookedBowls)} ${t.bowlUnit}` : '—',
          tone: started && s.cookedGrams > 0 ? 'on' : 'off',
        },
        {
          label: t.badgeFarm,
          value: started ? (s.farm.planted ? `${s.farm.progressText}%` : '—') : '—',
          tone: started && s.farm.ripe ? 'on' : 'off',
        },
      ],
      panels: [
        {
          id: 'kitchen',
          title: t.panelTitle,
          description: t.panelDesc,
          getMethods: ['state'],
        },
        {
          id: 'farm',
          title: t.panelFarmTitle,
          description: t.panelFarmDesc,
          getMethods: ['state'],
        },
      ],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      config: [configGroup(this.language)],
      promptDocs: [{
        key: `worlds.${ID}.env`,
        title: t.label,
        description: t.prompt,
        path: ENV_PROMPT,
        role: 'envPrompt',
      }],
    };
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  async start(host) {
    if (this.#started) return;
    this.#host = host;
    try {
      this.#state = await this.#loadOrInit(host);
      const now = this.#now();
      const result = advanceState(this.#state, now, this.#hungerPerHour(), this.#advanceOpts(true));
      if (result.farm?.rain) this.#logRain(result.farm.rain);
      if (result.cookingFinished) {
        try {
          await this.#pushCooked(result.cookingFinished);
        } catch (err) {
          host?.log?.warn?.('吃饭：启动时的饭好提醒没送出去', { err: msg(err) });
        }
      }
      if (result.toStage > result.fromStage) {
        try {
          await this.#pushHunger(result.toStage, now);
        } catch (err) {
          host?.log?.warn?.('吃饭：启动时的饥饿提醒没送出去', { err: msg(err) });
        }
      }
      await this.#save();
      this.#started = true;
      this.#schedule();
      const s = this.#snapshot();
      host?.log?.info?.('吃饭已就绪', {
        satiety: s.satietyText,
        riceKg: s.riceKg,
        cookedBowls: s.cookedBowls,
        tickIntervalMs: this.#tickMs(),
        stateFile: this.stateFile(),
      });
    } catch (err) {
      this.#started = false;
      this.#state = null;
      this.#host = null;
      throw err;
    }
  }

  async #loadOrInit(host) {
    const file = this.stateFile();
    let loaded = null;
    try {
      loaded = await loadState(file);
    } catch (err) {
      // 权限之类的问题不该被当成“文件坏了”；能读但解析失败才备份重建。
      if (err && typeof err === 'object' && 'code' in err) throw err;
      const stamp = new Date(this.#now()).toISOString().replace(/[:.]/g, '-');
      const backup = `${file}.bad-${stamp}`;
      try {
        await rename(file, backup);
      } catch {
        /* 备份不了也继续用新状态，下面会尝试覆盖写。 */
      }
      host?.log?.warn?.('吃饭：状态文件读不出来，已备份并新建', {
        file,
        backup,
        err: msg(err),
      });
    }
    if (loaded) return loaded;
    return newState(this.#now());
  }

  async #save() {
    if (!this.#state) return false;
    try {
      await saveState(this.stateFile(), this.#state);
      return true;
    } catch (err) {
      this.#host?.log?.warn?.('吃饭：状态没存下来', {
        file: this.stateFile(),
        err: msg(err),
      });
      return false;
    }
  }

  async #saveState(state) {
    try {
      await saveState(this.stateFile(), state);
    } catch (err) {
      throw new Error(`状态没存下来：${msg(err)}`);
    }
  }

  async stop() {
    if (!this.#started && !this.#timer) return;
    this.#started = false;
    if (this.#timer) {
      this.#clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#queue;
    await this.#save();
    this.#state = null;
    this.#host = null;
  }
}
