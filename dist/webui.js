/**
 * 吃饭的 WebUI 厨房面板（浏览器侧 bundle）。
 *
 * 宿主按 `/assets/extensions/<包>/<版本>/dist/webui.js` 取这个文件，
 * 直接 `import()` 它的 default 导出；所以它是纯浏览器 ES 模块：
 * 不 import 任何东西，只用 ctx.ui。主人动作（加米、煮饭、吃饭）都从这里发出。
 */

const STYLE = `
.eat-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.eat-row input { max-width: 120px; }
.eat-sub { opacity: .68; font-size: 12px; }
.eat-note { min-height: 1.2em; }
.eat-stats { margin: 4px 0 10px; }
.eat-actions { display: flex; gap: 8px; flex-wrap: wrap; }
`;

const ZH = {
  title: '厨房',
  en: 'kitchen',
  desc: '主人直接在这里加米、煮饭、吃饭；桌宠自己用工具吃饭。',
  satiety: '宠物饱食度',
  rice: '米仓',
  cooker: '电饭煲',
  hunger: '状态',
  capacity: '上限',
  rate: '消耗',
  perBowl: '每碗恢复',
  addTitle: '往米仓加米',
  addDesc: '加的是生米；1 碗熟饭用 100 g 生米。',
  addButton: '加米',
  cookTitle: '做饭',
  cookDesc: '按碗煮；1 碗熟饭 = 200 g。煮饭需要时间，开始后这一锅的量锁定。',
  cookButton: '煮饭',
  cookingButton: '煮饭中',
  cookerState: '电饭煲状态',
  idle: '空闲',
  cookingNote: (c) => `这一锅已锁定：${formatBowls(c.bowls)} 碗，约 ${cookingMinutes(c)} 分钟后好。`,
  cookingDetail: (c) => `正在煮 ${formatBowls(c.bowls)} 碗 · 约 ${cookingMinutes(c)} 分钟`,
  eatTitle: '主人吃饭',
  eatDesc: '从电饭煲盛给你自己；主人的饱食度不记录。',
  eatButton: '吃饭',
  refresh: '刷新',
  kgUnit: 'kg',
  bowlUnit: '碗',
  hourUnit: '点/小时',
  ready: '可以直接操作。',
  inactive: 'World 未启动；先在配置里打开。',
  badAmount: '先填一个大于 0 的量。',
  busier: '处理中…',
  loadBad: '读不到厨房状态',
  unknown: '未知',
  unitLine: '1 碗熟饭 = 200 g，用 100 g 生米',
  farmTitle: '稻田',
  farmEn: 'paddy',
  farmDesc: '一块水稻田和一个水池。下雨会免费浇一次田并补水；水稻不会主动报进度，自己去「状态」里看。',
  crop: '水稻',
  stageLabel: '阶段',
  progressLabel: '进度',
  moistureLabel: '土壤水分',
  poolLabel: '水池',
  factorLabel: '长势',
  yieldLabel: '预计产量',
  ripeInLabel: '预计成熟',
  rainLabel: '最近下雨',
  neverRain: '还没下过',
  emptyField: '空着',
  ripeField: '成熟了',
  sowTitle: '播种',
  sowDesc: '田空着才能播；播种会重置进度和这一季的施肥。',
  sowButton: '播种',
  waterTitle: '浇水',
  waterDesc: '从水池取水：补土壤水分，并立刻推进一段进度；不同生长阶段效果不同。',
  waterButton: '浇水',
  fertilizeTitle: '施肥',
  fertilizeDesc: '整季只能一次，收割产量会提高；现在不消耗化肥。',
  fertilizeButton: '施肥',
  fertilized: '这一季已施肥',
  harvestTitle: '收割',
  harvestDesc: '成熟后才能收；稻谷直接进米仓。',
  harvestButton: '收割',
  fillTitle: '往水池打水',
  fillDesc: '下雨会自动补水；也可以自己打。',
  fillButton: '打水',
  scarecrowTitle: '稻草人',
  scarecrowDesc: '立刻赶走鸟群，立着期间鸟灾不会落下来；只赶鸟，不管虫。倒了才能再立。',
  scarecrowButton: '立稻草人',
  scarecrowUp: (f) => `还立着：耐久 ${f.scarecrowText}%，约 ${shortDuration(f.scarecrowHoursLeft)}后倒`,
  pestsLabel: '虫口',
  birdsLabel: '鸟群',
  scarecrowLabel: '稻草人',
  noPests: '没有虫',
  noBirds: '没有鸟',
  noScarecrow: '没立',
  birdEatingPests: '在吃虫',
  birdEatingCrop: '在啄稻穗',
  droughtLabel: '旱情',
  droughtText: '土壤干透，长势只剩 0.3 倍',
  literUnit: 'L',
  farmInactive: 'World 未启动；先在配置里打开。',
  farmBusier: '处理中…',
  farmLoadBad: '读不到稻田状态',
};

const EN = {
  title: 'Kitchen',
  en: '',
  desc: 'The owner adds rice, cooks and eats here; the pet uses its own tools.',
  satiety: 'Pet satiety',
  rice: 'Rice bin',
  cooker: 'Rice cooker',
  hunger: 'State',
  capacity: 'capacity',
  rate: 'Drain',
  perBowl: 'Per bowl',
  addTitle: 'Add rice to the bin',
  addDesc: 'Raw rice; one bowl of cooked rice uses 100 g.',
  addButton: 'Add rice',
  cookTitle: 'Cook',
  cookDesc: 'By the bowl; one bowl of cooked rice is 200 g. Cooking takes time and locks the batch amount.',
  cookButton: 'Cook',
  cookingButton: 'Cooking',
  cookerState: 'Cooker state',
  idle: 'idle',
  cookingNote: (c) => `Batch locked: ${formatBowls(c.bowls)} ${c.bowls === 1 ? 'bowl' : 'bowls'}, ready in about ${cookingMinutes(c)} min.`,
  cookingDetail: (c) => `cooking ${formatBowls(c.bowls)} ${c.bowls === 1 ? 'bowl' : 'bowls'} · about ${cookingMinutes(c)} min`,
  eatTitle: 'Owner eats',
  eatDesc: 'Eat from the cooker; the owner\'s satiety is not tracked.',
  eatButton: 'Eat',
  refresh: 'Refresh',
  kgUnit: 'kg',
  bowlUnit: 'bowls',
  hourUnit: 'pts/hour',
  ready: 'Ready.',
  inactive: 'The World is not running; enable it in the config first.',
  badAmount: 'Enter an amount greater than zero.',
  busier: 'Working…',
  loadBad: 'Could not read the kitchen state',
  unknown: 'unknown',
  unitLine: '1 bowl = 200 g, made from 100 g raw rice',
  farmTitle: 'Paddy',
  farmEn: '',
  farmDesc: 'One rice paddy and one water pool. Rain waters the field for free and refills the pool; the crop never announces itself, check the state here.',
  crop: 'Crop',
  stageLabel: 'Stage',
  progressLabel: 'Progress',
  moistureLabel: 'Soil moisture',
  poolLabel: 'Pool',
  factorLabel: 'Growth',
  yieldLabel: 'Expected yield',
  ripeInLabel: 'Ripe in',
  rainLabel: 'Last rain',
  neverRain: 'never',
  emptyField: 'empty',
  ripeField: 'ripe',
  sowTitle: 'Sow',
  sowDesc: 'Only on an empty field; sowing resets progress and this cycle\'s fertilizer.',
  sowButton: 'Sow',
  waterTitle: 'Water',
  waterDesc: 'Takes water from the pool: raises soil moisture and pushes progress forward at once; the amount depends on the stage.',
  waterButton: 'Water',
  fertilizeTitle: 'Fertilize',
  fertilizeDesc: 'Once per cycle, raises the harvest yield; no fertilizer stock is consumed yet.',
  fertilizeButton: 'Fertilize',
  fertilized: 'Fertilized this cycle',
  harvestTitle: 'Harvest',
  harvestDesc: 'Only when ripe; the paddy rice goes straight into the rice bin.',
  harvestButton: 'Harvest',
  fillTitle: 'Fill the pool',
  fillDesc: 'Rain refills it automatically; you can also fill it by hand.',
  fillButton: 'Fill',
  scarecrowTitle: 'Scarecrow',
  scarecrowDesc: 'Chases the birds away at once and keeps new flocks off while it stands; birds only, not pests. Put a new one up only after it falls.',
  scarecrowButton: 'Put up scarecrow',
  scarecrowUp: (f) => `standing: ${f.scarecrowText}% left, about ${shortDuration(f.scarecrowHoursLeft)}`,
  pestsLabel: 'Pests',
  birdsLabel: 'Birds',
  scarecrowLabel: 'Scarecrow',
  noPests: 'none',
  noBirds: 'none',
  noScarecrow: 'none',
  birdEatingPests: 'eating pests',
  birdEatingCrop: 'pecking the crop',
  droughtLabel: 'Drought',
  droughtText: 'soil bone dry, growth 0.3x',
  literUnit: 'L',
  farmInactive: 'The World is not running; enable it in the config first.',
  farmBusier: 'Working…',
  farmLoadBad: 'Could not read the paddy state',
};

const text = (language) => (language === 'en' ? EN : ZH);

function message(err) {
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}

function formatBowls(value) {
  const n = Math.round((Number(value) || 0) * 10) / 10;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function cookingMinutes(cooking) {
  return Math.max(1, Math.ceil((Number(cooking?.remainingMs) || 0) / 60000));
}

/** 把“还要多少小时”压成 45m / 3.3h / 2.1d 这种短标记。 */
function shortDuration(hours) {
  if (hours === null || hours === undefined) return '—';
  const h = Number(hours);
  if (!Number.isFinite(h)) return '—';
  if (h <= 0) return '0';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h * 10) / 10}h`;
  return `${Math.round((h / 24) * 10) / 10}d`;
}

/** ISO 时间离现在多久，同样压成短标记。 */
function shortAgo(iso) {
  const at = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

function injectStyle(ctx) {
  const el = ctx.ui.h('style');
  el.textContent = STYLE;
  ctx.root.appendChild(el);
}

function kitchenPanel(ctx) {
  const tx = text(ctx.language);
  injectStyle(ctx);

  const sheet = ctx.ui.sheet({ title: tx.title, en: tx.en || undefined, desc: tx.desc });
  ctx.root.appendChild(sheet.el);
  const body = sheet.body;

  const stats = ctx.ui.statgrid();
  stats.classList.add('eat-stats');
  body.appendChild(stats);

  const details = ctx.ui.h('div');
  body.appendChild(details);

  let started = false;

  // 加米
  const addCard = ctx.ui.section(tx.addTitle, tx.addDesc);
  const addRow = ctx.ui.h('div', 'eat-row');
  const addInput = ctx.ui.input({
    type: 'number',
    value: '0.5',
    cls: 'mono',
    onCommit: () => { void run('addRice', addInput, tx.addButton); },
  });
  addInput.min = '0.1';
  addInput.max = '25';
  addInput.step = '0.1';
  const addButton = ctx.ui.button(tx.addButton, {
    variant: 'primary',
    size: 'sm',
    onClick: () => { void run('addRice', addInput, tx.addButton); },
  });
  addRow.append(addInput, ctx.ui.h('span', 'eat-sub', tx.kgUnit), addButton);
  addCard.appendChild(addRow);
  body.appendChild(addCard);

  // 煮饭
  const cookCard = ctx.ui.section(tx.cookTitle, tx.cookDesc);
  const cookRow = ctx.ui.h('div', 'eat-row');
  const cookInput = ctx.ui.input({
    type: 'number',
    value: '1',
    cls: 'mono',
    onCommit: () => { void run('cook', cookInput, tx.cookButton); },
  });
  cookInput.min = '0.5';
  cookInput.max = '20';
  cookInput.step = '0.5';
  const cookButton = ctx.ui.button(tx.cookButton, {
    variant: 'primary',
    size: 'sm',
    onClick: () => { void run('cook', cookInput, tx.cookButton); },
  });
  cookRow.append(cookInput, ctx.ui.h('span', 'eat-sub', tx.bowlUnit), cookButton);
  cookCard.appendChild(cookRow);
  const cookNote = ctx.ui.msgline('');
  cookNote.classList.add('eat-note');
  cookCard.appendChild(cookNote);
  body.appendChild(cookCard);

  // 主人吃饭
  const eatCard = ctx.ui.section(tx.eatTitle, tx.eatDesc);
  const eatRow = ctx.ui.h('div', 'eat-row');
  const eatInput = ctx.ui.input({
    type: 'number',
    value: '1',
    cls: 'mono',
    onCommit: () => { void run('eat', eatInput, tx.eatButton); },
  });
  eatInput.min = '0.5';
  eatInput.max = '20';
  eatInput.step = '0.5';
  const eatButton = ctx.ui.button(tx.eatButton, {
    variant: 'primary',
    size: 'sm',
    onClick: () => { void run('eat', eatInput, tx.eatButton); },
  });
  eatRow.append(eatInput, ctx.ui.h('span', 'eat-sub', tx.bowlUnit), eatButton);
  eatCard.appendChild(eatRow);
  body.appendChild(eatCard);

  const actions = ctx.ui.actions();
  actions.append(ctx.ui.button(tx.refresh, { size: 'sm', onClick: () => { void load(true); } }));
  body.appendChild(actions);

  const note = ctx.ui.msgline('');
  note.classList.add('eat-note');
  body.appendChild(note);

  const render = (s) => {
    void ctx.refresh().catch(() => { /* Header refresh must not block panel controls. */ });
    started = s?.started === true;
    const cooking = s?.cooking;
    stats.replaceChildren(
      ctx.ui.stat({
        k: tx.satiety,
        v: String(s?.satietyText ?? '0'),
        unit: '/100',
        accent: started && s?.hungerStage === 0,
      }),
      ctx.ui.stat({ k: tx.rice, v: Number(s?.riceKg ?? 0).toFixed(2), unit: tx.kgUnit }),
      ctx.ui.stat({ k: tx.cooker, v: formatBowls(s?.cookedBowls), unit: tx.bowlUnit }),
    );
    details.replaceChildren(
      ctx.ui.kv([
        { k: tx.hunger, v: String(s?.hunger ?? tx.unknown) },
        { k: `${tx.rice} ${tx.capacity}`, v: `${Number(s?.riceBinCapacityKg ?? 0).toFixed(2)} ${tx.kgUnit}` },
        { k: `${tx.cooker} ${tx.capacity}`, v: `${formatBowls(s?.cookerCapacityBowls)} ${tx.bowlUnit}` },
        { k: tx.cookerState, v: cooking ? tx.cookingDetail(cooking) : tx.idle },
        { k: tx.rate, v: `${s?.hungerPerHour ?? 0} ${tx.hourUnit}` },
        { k: tx.perBowl, v: `+${s?.satietyPerBowl ?? 0}` },
      ]),
      ctx.ui.h('div', 'eat-sub', tx.unitLine),
    );
    if (cooking) {
      cookInput.value = formatBowls(cooking.bowls);
      cookNote.textContent = tx.cookingNote(cooking);
    } else {
      cookNote.textContent = '';
    }
    addButton.disabled = !started;
    cookButton.textContent = cooking ? tx.cookingButton : tx.cookButton;
    cookButton.disabled = !started || !!cooking;
    eatButton.disabled = !started;
    addInput.disabled = !started;
    cookInput.disabled = !started || !!cooking;
    eatInput.disabled = !started;
    note.textContent = started ? tx.ready : tx.inactive;
  };

  const load = async (busy) => {
    const release = busy ? ctx.ui.busy(tx.busier, tx.title) : null;
    try {
      const s = await ctx.invoke('state', []);
      if (ctx.signal.aborted) return;
      render(s);
    } catch (err) {
      if (ctx.signal.aborted) return;
      note.textContent = `${tx.loadBad}：${message(err)}`;
      ctx.ui.toast(note.textContent, 'bad');
    } finally {
      if (release) release.dispose();
    }
  };

  const run = async (method, input, label) => {
    if (!started) {
      note.textContent = tx.inactive;
      return;
    }
    const value = Number(input.value);
    if (!Number.isFinite(value) || value <= 0) {
      note.textContent = tx.badAmount;
      ctx.ui.toast(tx.badAmount, 'bad');
      return;
    }
    const release = ctx.ui.busy(tx.busier, label);
    try {
      const res = await ctx.invoke(method, [value]);
      if (ctx.signal.aborted) return;
      if (res?.state) render(res.state);
      note.textContent = res?.message || tx.ready;
      ctx.ui.toast(note.textContent, 'ok');
    } catch (err) {
      if (ctx.signal.aborted) return;
      note.textContent = message(err);
      ctx.ui.toast(note.textContent, 'bad');
    } finally {
      release.dispose();
    }
  };

  // 饱食度会随时间走；面板开着时定期追一下。
  ctx.interval(() => { void load(false); }, 15000);
  void load(true);
}

function farmPanel(ctx) {
  const tx = text(ctx.language);
  injectStyle(ctx);

  const sheet = ctx.ui.sheet({ title: tx.farmTitle, en: tx.farmEn || undefined, desc: tx.farmDesc });
  ctx.root.appendChild(sheet.el);
  const body = sheet.body;

  const stats = ctx.ui.statgrid();
  stats.classList.add('eat-stats');
  body.appendChild(stats);

  const details = ctx.ui.h('div');
  body.appendChild(details);

  let started = false;

  const actionCard = (title, desc, label, method, args = []) => {
    const card = ctx.ui.section(title, desc);
    const row = ctx.ui.h('div', 'eat-actions');
    const button = ctx.ui.button(label, {
      variant: 'primary',
      size: 'sm',
      onClick: () => { void run(method, args, label); },
    });
    row.append(button);
    card.appendChild(row);
    body.appendChild(card);
    return { card, row, button };
  };

  const sow = actionCard(tx.sowTitle, tx.sowDesc, tx.sowButton, 'sow');
  const water = actionCard(tx.waterTitle, tx.waterDesc, tx.waterButton, 'water');
  const fertilize = actionCard(tx.fertilizeTitle, tx.fertilizeDesc, tx.fertilizeButton, 'fertilize');
  const harvest = actionCard(tx.harvestTitle, tx.harvestDesc, tx.harvestButton, 'harvest');
  const scarecrow = actionCard(tx.scarecrowTitle, tx.scarecrowDesc, tx.scarecrowButton, 'scarecrow');

  // 打水要填升数
  const fillCard = ctx.ui.section(tx.fillTitle, tx.fillDesc);
  const fillRow = ctx.ui.h('div', 'eat-row');
  const fillInput = ctx.ui.input({
    type: 'number',
    value: '20',
    cls: 'mono',
    onCommit: () => { void run('fillPool', [Number(fillInput.value)], tx.fillButton); },
  });
  fillInput.min = '1';
  fillInput.max = '500';
  fillInput.step = '1';
  const fillButton = ctx.ui.button(tx.fillButton, {
    variant: 'primary',
    size: 'sm',
    onClick: () => { void run('fillPool', [Number(fillInput.value)], tx.fillButton); },
  });
  fillRow.append(fillInput, ctx.ui.h('span', 'eat-sub', tx.literUnit), fillButton);
  fillCard.appendChild(fillRow);
  body.appendChild(fillCard);

  const actions = ctx.ui.actions();
  actions.append(ctx.ui.button(tx.refresh, { size: 'sm', onClick: () => { void load(true); } }));
  body.appendChild(actions);

  const note = ctx.ui.msgline('');
  note.classList.add('eat-note');
  body.appendChild(note);

  const render = (s) => {
    void ctx.refresh().catch(() => { /* Header refresh must not block panel controls. */ });
    started = s?.started === true;
    const f = s?.farm ?? {};
    const planted = f.planted === true;
    const ripe = f.ripe === true;
    stats.replaceChildren(
      ctx.ui.stat({
        k: tx.stageLabel,
        v: planted ? String(f.stageName ?? '') : tx.emptyField,
        accent: ripe,
      }),
      ctx.ui.stat({
        k: tx.progressLabel,
        v: planted ? String(f.progressText ?? '0') : '—',
        unit: planted ? '%' : '',
      }),
      ctx.ui.stat({ k: tx.moistureLabel, v: String(f.moistureText ?? '0'), unit: '%' }),
      ctx.ui.stat({ k: tx.poolLabel, v: String(f.poolText ?? '0'), unit: tx.literUnit }),
    );
    details.replaceChildren(ctx.ui.kv([
      { k: tx.ripeInLabel, v: planted ? (ripe ? tx.ripeField : shortDuration(f.hoursToRipe)) : tx.emptyField },
      { k: tx.factorLabel, v: `×${Number(f.moistureFactor ?? 0).toFixed(2)}` },
      { k: tx.yieldLabel, v: `${Number(f.expectedYieldKg ?? 0).toFixed(2)} kg` },
      { k: `${tx.poolLabel} ${tx.capacity}`, v: `${Number(f.poolCapacityLiters ?? 0)} ${tx.literUnit}` },
      { k: tx.rainLabel, v: f.lastRainAt ? shortAgo(f.lastRainAt) : tx.neverRain },
      {
        k: tx.pestsLabel,
        v: f.pestActive ? `${f.pestsText}%` : tx.noPests,
      },
      {
        k: tx.birdsLabel,
        v: f.birdActive
          ? `${f.birdsText} · ${f.birdPhase === 'pests' ? tx.birdEatingPests : tx.birdEatingCrop}`
          : tx.noBirds,
      },
      {
        k: tx.scarecrowLabel,
        v: f.scarecrowActive ? tx.scarecrowUp(f) : tx.noScarecrow,
      },
      ...(f.drought ? [{ k: tx.droughtLabel, v: tx.droughtText }] : []),
    ]));
    sow.button.disabled = !started || planted;
    water.button.disabled = !started || !planted || ripe
      || Number(f.poolLiters ?? 0) < Number(f.waterPerWatering ?? 0);
    fertilize.button.disabled = !started || !planted || ripe || f.fertilized === true;
    fertilize.button.textContent = f.fertilized ? tx.fertilized : tx.fertilizeButton;
    harvest.button.disabled = !started || !ripe;
    scarecrow.button.disabled = !started || f.scarecrowActive === true;
    scarecrow.button.textContent = f.scarecrowActive ? tx.scarecrowUp(f) : tx.scarecrowButton;
    fillButton.disabled = !started;
    fillInput.disabled = !started;
    note.textContent = started ? tx.ready : tx.farmInactive;
  };

  const load = async (busy) => {
    const release = busy ? ctx.ui.busy(tx.farmBusier, tx.farmTitle) : null;
    try {
      const s = await ctx.invoke('state', []);
      if (ctx.signal.aborted) return;
      render(s);
    } catch (err) {
      if (ctx.signal.aborted) return;
      note.textContent = `${tx.farmLoadBad}：${message(err)}`;
      ctx.ui.toast(note.textContent, 'bad');
    } finally {
      if (release) release.dispose();
    }
  };

  const run = async (method, args, label) => {
    if (!started) {
      note.textContent = tx.farmInactive;
      return;
    }
    const release = ctx.ui.busy(tx.farmBusier, label);
    try {
      const res = await ctx.invoke(method, Array.isArray(args) ? args : [args]);
      if (ctx.signal.aborted) return;
      if (res?.state) render(res.state);
      note.textContent = res?.message || tx.ready;
      ctx.ui.toast(note.textContent, 'ok');
    } catch (err) {
      if (ctx.signal.aborted) return;
      note.textContent = message(err);
      ctx.ui.toast(note.textContent, 'bad');
    } finally {
      release.dispose();
    }
  };

  // 水稻在后台一直长；面板开着时定期追一下。
  ctx.interval(() => { void load(false); }, 15000);
  void load(true);
}

export default {
  panels: {
    kitchen: { mount: kitchenPanel },
    farm: { mount: farmPanel },
  },
};
