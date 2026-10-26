/**
 * WorldDefinition：默认配置、预检、实例工厂和自描述。
 * create() 必须保持纯：不读状态文件、不建目录、不启动定时器。
 */
import { DEFAULTS, EVENT_COOKED, EVENT_HUNGER, ID, LABEL } from './config.js';
import { EAT_TOOL_DECLS, EatWorld } from './world.js';

/** 自描述里每个工具配一句给人看的话，按工具名。 */
const TOOL_SUMMARIES = {
  eat_status: {
    zh: '查看饱食度、米仓里的生米和电饭煲里的熟饭。',
    en: 'Show satiety, raw rice in the bin and cooked rice in the cooker.',
  },
  eat_cook: {
    zh: '桌宠自己从米仓取米煮饭，按碗选择量。',
    en: 'The pet cooks rice from the bin in bowls.',
  },
  eat_meal: {
    zh: '桌宠自己吃电饭煲里的熟饭，一次一碗或半碗。',
    en: 'The pet eats one bowl or half a bowl of cooked rice at a time.',
  },
  farm_status: {
    zh: '查看水稻的进度、阶段、土壤水分、施肥情况、水池水量和最近一次下雨。',
    en: 'Show crop progress and stage, soil moisture, fertilizer, the water pool and the last rain.',
  },
  farm_sow: {
    zh: '在空田里播种，开始新一季水稻。',
    en: 'Sow rice in the empty paddy to start a new cycle.',
  },
  farm_water: {
    zh: '从水池打水浇田：补土壤水分，并按阶段立刻推进一段生长进度。',
    en: 'Water the paddy from the pool: adds soil moisture and pushes growth forward by a stage-dependent amount.',
  },
  farm_fertilize: {
    zh: '给这一季施肥一次，提高收割产量（暂不消耗化肥）。',
    en: 'Fertilize this cycle once to raise the harvest yield (no fertilizer stock consumed yet).',
  },
  farm_harvest: {
    zh: '收割成熟的水稻，把稻谷放进米仓。',
    en: 'Harvest the ripe crop and put the paddy rice into the rice bin.',
  },
  farm_scarecrow: {
    zh: '立一个稻草人驱赶鸟群；只赶鸟，不管虫，立着期间鸟灾不会落下。',
    en: 'Put up a scarecrow to chase birds away; it stops birds only, not pests, and keeps new flocks away while it stands.',
  },
};

/** 与框架 `describeTools()` 相同的拼法：取发给模型的字段，再加一句 summary。 */
function describeTools(decls) {
  return decls.map(({ name, description, parameters, tags }) => ({
    name,
    description,
    parameters,
    tags,
    summary: TOOL_SUMMARIES[name],
  }));
}

export const eatDefinition = {
  id: ID,
  label: LABEL,
  /** `worlds.eat` 段的默认值；启用与否由部署决定，定义里恒为 false。 */
  defaults: () => structuredClone(DEFAULTS),
  preflight: () => {
    if (typeof structuredClone !== 'function') {
      throw new Error('吃饭需要 Node 22+ 的 structuredClone。');
    }
  },
  create: (ctx) => new EatWorld({
    cfg: ctx.cfg,
    dataDir: ctx.dataDir,
    botDir: ctx.botDir,
    packageDir: ctx.packageDir,
  }),
  /** 自描述：可能出现的全部工具与事件，不进提示词。`describe` 把它导出成 describe.json。 */
  describe: {
    tools: describeTools(EAT_TOOL_DECLS),
    events: [
      {
        type: EVENT_HUNGER,
        description: {
          zh: '宠物饱食度掉到新的饥饿阶段（有点饿了、饿了、很饿了、饿得不行了），正文会带上米仓和电饭煲的现状。',
          en: 'The pet reached a new hunger stage (a little hungry, hungry, very hungry, starving); the text also reports the rice bin and cooker.',
        },
        trigger: 'debounce',
      },
      {
        type: EVENT_COOKED,
        description: {
          zh: '电饭煲这一锅饭煮好了；正文说明煮了几碗、电饭煲里现在有多少现成的饭。',
          en: 'The rice cooker finished a batch; the text reports the batch size and how much ready rice is now in the cooker.',
        },
        trigger: 'debounce',
      },
    ],
  },
};

export default eatDefinition;
