/**
 * 扩展入口：默认导出必须是 WorldDefinition。
 * package.json 里 cortico.kind = world、cortico.api = 6。
 */
import definition, { eatDefinition } from './definition.js';

export default definition;
export { eatDefinition };
export { EatWorld, EAT_TOOL_DECLS } from './world.js';
export {
  ID as EAT_WORLD_ID,
  DEFAULTS as EAT_DEFAULTS,
  EVENT_COOKED as EAT_COOKED_EVENT,
  EVENT_HUNGER as EAT_HUNGER_EVENT,
} from './config.js';
export {
  BOWL_GRAMS,
  FARM_DEFAULTS,
  FARM_PROGRESS_MAX,
  FARM_STAGES,
  RAW_GRAMS_PER_BOWL,
  RIPE_STAGE,
  STATE_VERSION,
  WATER_BOOST_POINTS,
  addRice,
  advanceFarm,
  advanceState,
  applyRain,
  cook,
  eat,
  estimateRipeHours,
  expectedYieldKg,
  farmConfig,
  farmStage,
  farmSummary,
  fertilizeField,
  fillPool,
  formatBowls,
  formatKg,
  formatLiters,
  formatSatiety,
  harvestField,
  loadState,
  migrateState,
  moistureFactor,
  newFarm,
  newState,
  normalizeWho,
  saveState,
  settleCooking,
  sowField,
  stageLabel,
  stageOf,
  stateSummary,
  validState,
  waterField,
} from './state.js';
