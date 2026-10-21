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
  RAW_GRAMS_PER_BOWL,
  addRice,
  advanceState,
  buildScarecrow,
  cook,
  eat,
  farmConfig,
  farmSummary,
  fertilizeField,
  fillPool,
  formatBowls,
  formatKg,
  formatLiters,
  formatSatiety,
  harvestField,
  loadState,
  newState,
  saveState,
  sowField,
  stageLabel,
  stageOf,
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
    description: '查看宠物饱食度、米仓里的生米、电饭煲里的熟饭，以及当前饥饿阶段。不确定有没有米、有没有现成的饭，或者自己有多饿时，先查这个。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'eat_cook',
    tags: ['write'],
    description: '给宠物自己在电饭煲里煮一锅饭，选 0.5–20 碗；1 碗熟饭用 100 g 生米、出 200 g 熟饭。煮饭要时间（worlds.eat.cookMinutes），点下后这一锅的量锁定，煮好之前不能开第二锅。立即返回；饭好了会收到 eat.cooked 事件。米不够、锅放不下、或已经有一锅在煮都会失败。主人从控制台「厨房」面板煮饭，不走这个工具。',
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
    description: '吃电饭煲里已经煮好的饭，选 0.5–20 碗，吃了恢复饱食度。现成饭不够会失败；还在煮的那一锅不算现成的。',
    parameters: {
      type: 'object',
      properties: {
        bowls: {
          type: 'number',
          minimum: 0.5,
          maximum: 20,
          multipleOf: 0.5,
          description: '吃几碗熟饭；0.5 = 半碗。',
        },
      },
      required: ['bowls'],
      additionalProperties: false,
    },
  },
  {
    name: 'farm_status',
    tags: ['read', 'snapshot'],
    description: '查看水稻田和水池：田里有没有种、处在哪个生长阶段、成熟进度、大约多久成熟、土壤水分、这一季有没有施肥、水池还剩多少水、最近一次下雨是什么时候。生长和灾害都不会主动推送，想知道情况就查这个，不要等事件。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'farm_sow',
    tags: ['write'],
    description: '在空田里播种，开始新一季水稻。田里已经有水稻会失败。播种会把进度清零、清掉这一季的施肥标记，土壤水分保留。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'farm_water',
    tags: ['write'],
    description: '给田里浇一次水：从水池取水，补土壤水分，并立刻推进一段成熟进度。推进多少看当前阶段（发芽和抽穗最多，灌浆最少）。没播种、已经成熟、水池没水都会失败。下雨等于免费浇一次，不花水池的水。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'farm_fertilize',
    tags: ['write'],
    description: '给正在长的水稻施肥，提高收割产量。整季只能一次，重新播种才会重置；现在不消耗任何化肥。没播种、已经成熟、或这一季已经施过都会失败。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'farm_harvest',
    tags: ['write'],
    description: '收割成熟的水稻，稻谷作为生米进米仓。没成熟、或米仓放不下都会失败；收完田就空了，可以再播种。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'farm_scarecrow',
    tags: ['write'],
    description: '立一个稻草人：立刻赶走田里的鸟群，一段时间内不会再来鸟；到期自己倒，倒了才能再立。它只挡鸟、不管虫——没有鸟吃虫，虫会一直啃到它们自己退。已经有稻草人立着会失败（报错会说还能撑多久）。',
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
    const lines = [
      `你开始煮 ${formatBowls(result.bowls)} 碗饭，约 ${Math.max(1, Math.ceil(result.cookMs / 60000))} 分钟后好。`,
      '这一锅的量已经锁定，煮好之前不能再煮或改量。',
      `用了 ${result.rawGrams} g 生米；米仓还剩 ${formatKg(result.riceGrams)} kg。`,
    ];
    if (s.cookedBowls > 0) lines.push(`电饭煲里另外还有 ${formatBowls(s.cookedBowls)} 碗现成的饭，可以先吃。`);
    lines.push(`现在饱食度：${s.satietyText}/100（${s.hunger}）。`);
    return { text: lines.join('\n') };
  }

  async #mealTool(args) {
    this.#ensureStarted();
    const bowls = args.bowls;
    const result = await this.#mutate((state) => eat(state, {
      bowls,
      who: 'pet',
      satietyPerBowl: this.#satietyPerBowl(),
    }));
    const s = this.#snapshot();
    const lines = [
      `你吃了 ${formatBowls(result.bowls)} 碗饭（${result.grams} g）。`,
      `饱食度：${formatSatiety(result.beforeSatiety)} → ${formatSatiety(result.afterSatiety)}/100（${stageLabel(stageOf(result.afterSatiety))}）。`,
    ];
    if (result.gained <= 0) lines.push('已经很饱了，饱食度没有继续涨。');
    lines.push(`电饭煲里还剩 ${formatBowls(result.cookedGrams / BOWL_GRAMS)} 碗现成的饭。`);
    if (s.cooking) {
      lines.push(`还在煮 ${formatBowls(s.cooking.bowls)} 碗饭，约 ${Math.max(1, Math.ceil(s.cooking.remainingMs / 60000))} 分钟后好。`);
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
        '你把稻种撒进了田里，这一季从现在开始算。',
        `土壤水分：${f.moistureText}%（长势 ×${f.moistureFactor}）—— 水越足长得越快，土干了会慢很多。`,
        `按现在的水分估，${this.#inText(f.hoursToRipe)}成熟；浇水能立刻催一截。`,
        '整季只能施一次肥（不消耗化肥），只影响收割产量。',
      ].join('\n'),
    };
  }

  async #waterTool() {
    this.#ensureStarted();
    const result = await this.#mutate((state) => waterField(state, this.#farmCfg()));
    const f = this.#snapshot().farm;
    const lines = [
      `你给田里浇了一次水，用了 ${formatLiters(result.cost)} L；水池还剩 ${formatLiters(result.poolLiters)} L。`,
      `土壤水分：${formatSatiety(result.moistureBefore)}% → ${f.moistureText}%（长势 ×${f.moistureFactor}）。`,
      `${result.stageName}浇水效果 ×${result.waterFactor}：进度 ${formatSatiety(result.progressBefore)}% → ${f.progressText}%。`,
    ];
    if (result.moistureWasted > 0) {
      lines.push(`土已经很湿了，有 ${formatSatiety(result.moistureWasted)}% 的水分没吃住；等土干一点再浇更划算。`);
    }
    if (result.stageChanged) lines.push(`水稻进入${result.stageAfterName}。`);
    if (result.ripe) lines.push('水稻成熟了，可以收割了。');
    else lines.push(`按现在的水分估，${this.#inText(f.hoursToRipe)}成熟。`);
    return { text: lines.join('\n') };
  }

  async #fertilizeTool() {
    this.#ensureStarted();
    const result = await this.#mutate((state) => fertilizeField(state, this.#farmCfg()));
    const f = this.#snapshot().farm;
    return {
      text: [
        `你给${result.stageName}的水稻施了肥（现在不消耗化肥）。`,
        `这一季收割产量 ×${result.bonus}：从 ${formatKg(result.baseYieldKg * 1000)} kg 提到 ${formatKg(result.yieldKg * 1000)} kg 稻谷。`,
        '整季只能施一次，下次播种才会重置。',
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
      `你收了这一季水稻：${formatKg(result.grams)} kg 稻谷${result.fertilized ? `（施过肥，×${result.yieldMultiplier}）` : ''}，已经倒进米仓。`,
      `米仓：${formatKg(result.afterGrams)} kg / 上限 ${s.riceBinCapacityKg.toFixed(2)} kg，够煮 ${formatBowls(result.riceBowls)} 碗饭。`,
      '田里空出来了，可以再播种。',
    ];
    return { text: lines.join('\n') };
  }

  async #scarecrowTool() {
    this.#ensureStarted();
    const result = await this.#mutate((state) => buildScarecrow(state, { nowMs: this.#now(), ...this.#farmCfg() }));
    const f = this.#snapshot().farm;
    const lines = [
      result.chased > 0
        ? `你立起了稻草人，田里的鸟群被赶走了（鸟群 ${formatSatiety(result.chased)}）。`
        : '你在田边立起了稻草人。',
      `稻草人耐久 100%，${this.#inText(result.lastsHours)}倒；倒了才能再立。`,
    ];
    if (f.pestActive) {
      lines.push(`注意：稻草人只赶鸟、不管虫。现在虫口还有 ${f.pestsText}%，没有鸟来吃，只能等它们自己退（${this.#inText(f.pestHoursLeft)}）。`);
    } else {
      lines.push('稻草人只赶鸟、不管虫：鸟不会来，虫也就没人帮着吃了，记得常看一眼虫口。');
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
      lines.push(`水稻：${f.stageName}，进度 100% —— 可以收割了（farm_harvest），预计 ${f.expectedYieldKg.toFixed(2)} kg 稻谷。`);
    } else {
      lines.push(`水稻：${f.stageName}，进度 ${f.progressText}%（${this.#inText(f.hoursToRipe)}成熟）。`);
    }
    lines.push(`土壤水分：${f.moistureText}%（长势 ×${f.moistureFactor}；干了会明显变慢，浇一次补 ${cfg.moisturePerWatering}%）`);
    if (f.drought) {
      lines.push('旱情：土壤已经干透，长势只剩 0.3 倍；等雨或者自己浇水。');
    }
    if (f.fertilized) {
      lines.push(`施肥：这一季已施过（收割产量 ×${cfg.fertilizeYieldBonus}，预计 ${f.expectedYieldKg.toFixed(2)} kg）。`);
    } else {
      lines.push('施肥：还没施（整季一次，不消耗化肥，只提高产量）。');
    }
    lines.push(`水池：${f.poolText} L / ${formatLiters(f.poolCapacityLiters)} L（浇一次 ${formatLiters(f.waterPerWatering)} L）`);
    lines.push(f.lastRainAt ? `下雨：最近一次在${this.#agoText(f.lastRainAt)}；下雨会免费给田里浇一次，并往水池补水。` : '下雨：还没下过；下雨会免费给田里浇一次，并往水池补水。');
    lines.push(this.#critterText(f));
    if (f.planted && !f.ripe) lines.push(`浇水效果：当前${f.stageName} ×${f.waterFactor}。`);
    return lines.join('\n');
  }

  /** 虫、鸟、稻草人三件事压成一行；都正常时就说一切太平。 */
  #critterText(f) {
    const bits = [];
    if (f.pestActive) {
      bits.push(`虫口 ${f.pestsText}%（每小时啃掉约 ${formatSatiety((f.pestDamagePerHour * f.pests) / 100)} 点，${this.#inText(f.pestHoursLeft)}自己退）`);
    } else {
      bits.push('没有虫');
    }
    if (f.birdActive) {
      bits.push(`鸟群 ${f.birdsText}（${f.birdPhase === 'pests' ? '在吃虫' : '虫吃光了，在啄稻穗'}，${this.#inText(f.birdHoursLeft)}散去）`);
    } else {
      bits.push('没有鸟');
    }
    if (f.scarecrowActive) {
      bits.push(`稻草人耐久 ${f.scarecrowText}%（${this.#inText(f.scarecrowHoursLeft)}倒）`);
    } else {
      bits.push('没立稻草人');
    }
    return `灾害：${bits.join('；')}。`;
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
    const lines = [
      '吃饭状态',
      `饱食度：${s.satietyText}/100（${s.hunger}）`,
      `米仓：${s.riceKg.toFixed(2)} kg 生米（约 ${formatBowls(s.riceBowls)} 碗饭的米）· 上限 ${s.riceBinCapacityKg.toFixed(2)} kg`,
    ];
    if (s.cooking) {
      const wait = Math.max(1, Math.ceil(s.cooking.remainingMs / 60000));
      const extra = s.cookedBowls > 0 ? `；另有 ${formatBowls(s.cookedBowls)} 碗现成的饭` : '';
      lines.push(`电饭煲：正在煮 ${formatBowls(s.cooking.bowls)} 碗饭，约 ${wait} 分钟后好${extra}。这一锅的量已锁定。`);
    } else {
      lines.push(`电饭煲：${formatBowls(s.cookedBowls)} 碗熟饭（${Math.round(s.cookedGrams)} g）· 上限 ${formatBowls(s.cookerCapacityBowls)} 碗`);
    }
    const rate = this.#hungerPerHour();
    lines.push(rate > 0 ? `消耗：约 ${rate} 点/小时。` : '消耗：关着（不会变饿）。');
    lines.push(`单位：1 碗熟饭 = ${BOWL_GRAMS} g，用 ${RAW_GRAMS_PER_BOWL} g 生米；宠物每碗 +${this.#satietyPerBowl()} 饱食度。`);
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
    const bits = [`吃饭：${stageLabel(stage)}（饱食度 ${s.satietyText}/100）。`];
    if (s.cookedBowls >= 0.5) {
      bits.push(`电饭煲里有 ${formatBowls(s.cookedBowls)} 碗饭，可以先吃。`);
    } else if (s.cooking) {
      const wait = Math.max(1, Math.ceil(s.cooking.remainingMs / 60000));
      bits.push(`电饭煲正在煮 ${formatBowls(s.cooking.bowls)} 碗饭，约 ${wait} 分钟后好，先忍一下。`);
    } else if (s.riceBowls >= 0.5) {
      bits.push(`电饭煲是空的；米仓里有 ${s.riceKg.toFixed(2)} kg 生米，可以煮 ${formatBowls(s.riceBowls)} 碗。`);
    } else {
      bits.push('米仓里没有米了，请主人到控制台「厨房」面板加米。');
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
    const more = s.cooking ? `另外还有 ${formatBowls(s.cooking.bowls)} 碗正在煮。` : '';
    await host.pushEvent({
      type: EVENT_COOKED,
      source: this.id,
      senderKey: 'eat.cooked',
      origin: 'internal',
      ts: new Date(this.#now()).toISOString(),
      text: `吃饭：饭煮好了（${formatBowls(finished.bowls)} 碗，${finished.producedGrams} g）。电饭煲里现在有 ${formatBowls(s.cookedBowls)} 碗现成的饭，可以吃了。${more}`,
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
