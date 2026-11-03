'use strict';

/**
 * learn.test.js — 知识库学习模式（v2.9.51：学习单元 = 原子知识点，不是页面）
 *
 * 覆盖验收门：功能门、只读门、先测门、调度门、引擎门、幂等门、**知识点粒度门**
 * （题面必须针对一个术语/概念，而不是整页综述）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const learn = require('../lib/learn');

// ---------- 夹具 ----------

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-vault-'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Vault AGENTS\n\n这是 LLM Wiki 架构的实例。\n');
  const write = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  write('wiki/思维方法论/矛盾分析法.md', '# 矛盾分析法\n\n先找主要矛盾，再看矛盾的主要方面。\n');
  write('wiki/思维方法论/尺度效应.md', '# 尺度效应\n\n放大十倍，很多规则会失效。\n');
  write('wiki/学习卡片/2026-10-01-复利思维.md', '---\ntitle: 学习卡片·复利思维\nstatus: draft\ntags: [学习卡片]\n---\n\n# 复利思维\n\n收益可再投入，且衰减项不被吃掉。\n');
  write('wiki/学习卡片/_题库.md', '# 题库规范\n\n元页面，不该学习。\n');
  write('wiki/项目档案/不该学.md', '# 项目档案\n\n项目文档，应被 exclude。\n');
  write('raw/素材.md', '# 素材\n\n事实来源，不扫。\n');
  return root;
}

function makeCtx(root, overrides) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-learndata-'));
  return {
    dataDir,
    config: {
      learn: Object.assign({
        enabled: true,
        root,
        scope: ['wiki'],
        exclude: ['wiki/项目档案'],
        dailyNew: 1,
        dailyReview: 3,
        minutes: 15,
        seeds: [],
        engine: { mode: 'auto', timeoutSec: 180, reasoningEffort: 'off', maxTokens: 1200 },
      }, overrides || {}),
    },
  };
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else out[path.relative(dir, abs)] = fs.statSync(abs).mtimeMs;
    }
  };
  walk(dir);
  return out;
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (e) {
      /* Windows EPERM 容错 */
    }
  }
}

/** 造几个知识点条目（跳过抽取，直接喂 items.json） */
function seedConcepts(ctx, pageRel, terms) {
  const now = new Date().toISOString();
  return terms.map((t) => ({
    id: `C-${Buffer.from(t.term).toString('hex').slice(0, 10)}-${Math.random().toString(16).slice(2, 8)}`,
    kind: 'concept',
    term: t.term,
    definition: t.definition,
    why: t.why || '',
    sourcePath: pageRel,
    pageTitle: '测试页面',
    digest: t.definition,
    createdAt: now,
    excluded: false,
    needsRewrite: false,
  }));
}

/** 引擎 stub：按提示词类型返回不同 JSON（零真实调用） */
function stubEngine(level) {
  const calls = [];
  const fn = async (prompt) => {
    calls.push(prompt);
    if (prompt.includes('原子知识点')) {
      return JSON.stringify({ concepts: [
        { term: '复利的损耗项', definition: '收益再投入时被手续费或衰减吃掉的部分', why: '决定复利是否真成立' },
        { term: '再投入门槛', definition: '收益足够大到值得再投入的最小规模', why: '低于门槛则谈不上复利' },
      ] });
    }
    if (prompt.includes('5-why')) {
      return JSON.stringify({ chain: ['为什么会损耗？', '损耗从哪来？'], root: '交易成本与摩擦' });
    }
    return JSON.stringify({ good: ['讲了再投入'], missing: ['没讲损耗项'], jargon: [], misconception: [], probe: '损耗率怎么算？', level });
  };
  fn.calls = calls;
  return fn;
}

// ---------- 功能门 / 根路径 ----------

test('validateRoot：绝对路径 + 目录 + AGENTS.md 含 LLM Wiki 标记', () => {
  const root = makeVault();
  try {
    assert.equal(learn.validateRoot(root).ok, true);
    assert.equal(learn.validateRoot('relative/path').ok, false);
    assert.equal(learn.validateRoot(path.join(root, 'nope')).ok, false);
  } finally {
    cleanup(root);
  }
});

test('validateRoot：普通 Markdown 目录也合法（不再强求 LLM Wiki 标记）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-plain-'));
  try {
    fs.writeFileSync(path.join(root, 'a.md'), '# 随便一页\n\n内容。\n');
    const r = learn.validateRoot(root);
    assert.equal(r.ok, true, '没有 AGENTS.md 的普通目录必须能用');
    assert.equal(r.flavor, 'generic');
    assert.equal(r.warnings.length, 1, '要提示「按普通 Markdown 库处理」，但不拦');

    const wiki = makeVault();
    try {
      assert.equal(learn.validateRoot(wiki).flavor, 'llm-wiki');
    } finally {
      cleanup(wiki);
    }
  } finally {
    cleanup(root);
  }
});

test('probeRoot：只读探测出 md 数、顶层分布、会被过滤的比例', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-probe-'));
  try {
    const write = (rel, body) => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    };
    write('笔记/甲.md', '# 甲\n\n正文\n');
    write('笔记/乙.md', '# 乙\n\n正文\n');
    write('资料/丙.md', '# 丙\n\n正文\n');
    write('_index.md', '# 索引\n');
    write('课/README.md', '# 索引\n');
    write('课/outputs/产出.md', '# 产出\n');
    write('课/docs/en.md', '# english\n');
    write('课/docs/zh.md', '# 中文课\n');

    const p = learn.probeRoot(root);
    assert.equal(p.ok, true);
    assert.equal(p.counts.md, 4, '甲/乙/丙/zh.md 才是可学内容');
    assert.equal(p.counts.filtered.underscore, 1, '_index.md 被过滤');
    assert.equal(p.counts.filtered.readme, 1);
    assert.equal(p.counts.filtered.outputs, 1);
    assert.equal(p.counts.filtered.en, 1);
    assert.deepEqual(p.topDirs.map((d) => d.rel).sort(), ['资料', '笔记', '课'].sort());
    assert.equal(p.suggestedScope.length, 3, '推荐范围 = 有内容的顶层目录');
    assert.equal(learn.probeRoot(path.join(root, 'nope')).ok, false);
  } finally {
    cleanup(root);
  }
});

test('initLearn：陌生库一步配置（落盘 + 建索引 + 试抽预览，预览不落库）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-init-'));
  const ctx = {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fde-initdata-')),
    config: { learn: {} },
    configPath: null,
  };
  ctx.configPath = path.join(ctx.dataDir, 'config.json');
  const engine = stubEngine(2);
  try {
    const write = (rel, body) => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    };
    write('知识/复利.md', '# 复利\n\n收益可再投入。\n');
    write('知识/尺度.md', '# 尺度\n\n放大后规则失效。\n');

    const r = await learn.initLearn(ctx, { root, seeds: [], dailyNew: 2 }, { engine });
    assert.equal(r.ok, true);
    assert.equal(r.pages, 2, '两篇 md 都要进索引');
    assert.ok(r.sample && r.sample.concepts.length > 0, '要给出试抽预览');
    assert.ok(r.sample.concepts[0].term, '预览里是知识点而不是页面标题');

    const disk = JSON.parse(fs.readFileSync(ctx.configPath, 'utf8'));
    assert.equal(disk.learn.root, path.resolve(root));
    assert.equal(disk.learn.enabled, true);
    assert.deepEqual(disk.learn.scope.sort(), ['知识'].sort());
    assert.equal(ctx.config.learn.dailyNew, 2);

    assert.equal(learn.loadItems(ctx).length, 0, '预览只展示、不写入');

    assert.equal(learn.status(ctx).configured, true);
  } finally {
    cleanup(root, ctx.dataDir);
  }
});

test('status：未启用 → enabled/configured 双 false（功能不存在）', () => {
  const root = makeVault();
  const ctx = makeCtx(root, { enabled: false });
  try {
    const st = learn.status(ctx);
    assert.equal(st.enabled, false);
    assert.equal(st.configured, false);
  } finally {
    cleanup(root, ctx.dataDir);
  }
});

// ---------- 只读门 + 元页面过滤 ----------

test('scanVault：只扫 scope 内、exclude 生效、跳过 _ 前缀元页面、vault 字节不变', () => {
  const root = makeVault();
  const ctx = makeCtx(root);
  try {
    const before = snapshot(root);
    const scanned = learn.scanVault(ctx);
    const rels = scanned.entries.map((e) => e.rel).sort();
    assert.deepEqual(rels, ['wiki/学习卡片/2026-10-01-复利思维.md', 'wiki/思维方法论/尺度效应.md', 'wiki/思维方法论/矛盾分析法.md']);
    assert.ok(!rels.some((r) => r.includes('_题库')), '_ 前缀元页面不得进入扫描结果');

    const pages = learn.syncPages(ctx, scanned);
    assert.equal(pages.length, 3);
    assert.ok(pages.every((p) => p.conceptsAt === null), '新页面应标记为待抽取');
    assert.deepEqual(snapshot(root), before, '扫描/落库不得改动 vault（只读门）');
  } finally {
    cleanup(root, ctx.dataDir);
  }
});

// ---------- 知识点粒度门（本次改造的核心） ----------

test('ensureFreshConcepts：按页抽原子知识点，term 独立成条；重复调用不重复抽', async () => {
  const root = makeVault();
  const ctx = makeCtx(root);
  const engine = stubEngine(2);
  try {
    learn.syncPages(ctx, learn.scanVault(ctx));
    const r1 = await learn.ensureFreshConcepts(ctx, { engine });
    assert.equal(r1.added, 2, '一页抽出 2 个知识点');

    const items = learn.loadItems(ctx);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((i) => i.term).sort(), ['复利的损耗项', '再投入门槛'].sort());
    assert.ok(items.every((i) => i.kind === 'concept' && i.sourcePath), '条目必须是知识点，且能回溯来源页');

    const pages = learn.loadPages(ctx);
    assert.ok(pages.some((p) => p.conceptsAt), '抽过的页面要打标记，避免重复计费');
  } finally {
    cleanup(root, ctx.dataDir);
  }
});

test('createSession：题面针对具体术语（不是页面标题），且建会话不给材料', () => {
  const root = makeVault();
  const ctx = makeCtx(root);
  try {
    learn.syncPages(ctx, learn.scanVault(ctx));
    learn.saveItems(ctx, seedConcepts(ctx, 'wiki/思维方法论/矛盾分析法.md', [
      { term: '主要矛盾', definition: '决定全局的那个矛盾', why: '抓错就白忙' },
    ]));
    const item = learn.loadItems(ctx)[0];
    const s = learn.createSession(ctx, item.id);
    assert.equal(s.stage, 'study', '没学过的知识点要给材料，不能让人凭空作答');
    assert.equal(s.isReview, false, '新学必须标 isReview=false（前端据此决定进度条）');
    assert.ok(s.material && s.material.includes('主要矛盾'), '新学阶段必须直接给材料');
    assert.match(s.question, /概括/, '新学先读再讲');
    assert.equal(s.item.term, '主要矛盾');
    assert.equal(s.item.title, '主要矛盾');
    // 复习场景才守

    const s2 = learn.createSession(ctx, item.id);
    assert.equal(s2.id, s.id, '同日同条目复用未完成会话（幂等门）');
  } finally {
    cleanup(root, ctx.dataDir);
  }
});

// ---------- 查看原文（只读） ----------

test('readSource：只读查看原文，拒绝越界/非 md，支持导入资料', () => {
  const root = makeVault();
  const ctx = makeCtx(root);
  try {
    const r = learn.readSource(ctx, 'wiki/思维方法论/矛盾分析法.md');
    assert.equal(r.ok, true);
    assert.match(r.content, /先找主要矛盾/, '要读到原文内容');
    assert.equal(r.kind, 'vault');

    assert.throws(() => learn.readSource(ctx, '../secrets.md'), (e) => e.status === 400, '不允许 .. 越界');
    assert.throws(() => learn.readSource(ctx, 'notes.txt'), (e) => e.status === 400, '只允许 md 原文');
    assert.throws(() => learn.readSource(ctx, 'wiki/不存在.md'), (e) => e.status === 404, '不存在的文件报 404');
    assert.throws(() => learn.readSource(ctx, ''), (e) => e.status === 400, '缺参数要报错');

    const dir = path.join(ctx.dataDir, 'learn', 'imports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pdf-abc123.md'), '---\ntitle: 一本书\n---\n\n# 一本书\n\n正文内容。\n');
    const impRes = learn.readSource(ctx, 'import:pdf-abc123');
    assert.equal(impRes.kind, 'import');
    assert.match(impRes.content, /正文内容/);
    assert.throws(() => learn.readSource(ctx, 'import:..-etc'), (e) => e.status === 400, '导入标识里的非法字符也要拦');
  } finally {
    cleanup(root, ctx.dataDir);
  }
});

// ---------- 调度门 ----------

test('applyReview：0/1 明日重来、2 逐级、3 跳级、35 封顶', () => {
  const now = new Date('2026-10-31T10:00:00');
  const low = learn.applyReview({ itemId: 'C-1', level: 2, intervalDays: 7, lapses: 0 }, 1, now);
  assert.equal(low.intervalDays, 1);
  assert.equal(low.dueAt, '2026-11-01');

  let st = learn.applyReview({ itemId: 'C-1', level: 0, intervalDays: 0, lapses: 0 }, 2, now);
  assert.equal(st.intervalDays, 1);
  st = learn.applyReview(st, 2, now);
  assert.equal(st.intervalDays, 3);
  st = learn.applyReview(st, 2, now);
  assert.equal(st.intervalDays, 7);

  assert.equal(learn.applyReview({ itemId: 'C-2', intervalDays: 3 }, 3, now).intervalDays, 16);
  assert.equal(learn.applyReview({ itemId: 'C-3', intervalDays: 35 }, 2, now).intervalDays, 35);
});

test('applyReview：连续 3 次失败熔断；90 天荒废后低分重学', () => {
  const now = new Date('2026-10-31T10:00:00');
  let st = { itemId: 'C-1', level: 0, intervalDays: 0, lapses: 0 };
  for (let i = 0; i < 3; i++) st = learn.applyReview(st, 1, now);
  assert.equal(st.needsRewrite, true);

  const stale = learn.applyReview({ itemId: 'C-9', level: 1, intervalDays: 16, lastReviewedAt: '2026-06-01' }, 2, now);
  assert.equal(stale.intervalDays, 1);
});

test('pickDaily：到期优先占满 dailyReview；到期为空才补新', () => {
  const now = new Date('2026-10-31T10:00:00');
  const cfg = { dailyNew: 1, dailyReview: 2 };
  const items = [
    { id: 'A', kind: 'concept', term: '甲', sourcePath: 'wiki/a.md' },
    { id: 'B', kind: 'concept', term: '乙', sourcePath: 'wiki/b.md' },
    { id: 'C', kind: 'concept', term: '丙', sourcePath: 'wiki/c.md' },
  ];
  const due = learn.pickDaily(items, { A: { dueAt: '2026-10-30' }, B: { dueAt: '2026-10-31' } }, cfg, now);
  assert.equal(due.length, 3, 'dailyReview=2 条到期 + dailyNew=1 条新题（v2.9.61 起并行）');
  assert.deepEqual(due.map((p) => p.reason), ['due', 'due', 'new']);

  const fresh = learn.pickDaily(items, {}, cfg, now);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].reason, 'new');

  // v2.9.61：到期与新题并行——有到期时也要补新题（否则「每日 3 新题」形同虚设）
  const both = learn.pickDaily(items, { A: { dueAt: '2026-10-30' } }, cfg, now);
  assert.equal(both.length, 2, '1 条到期 + 1 条新题');
  assert.deepEqual(both.map((x) => x.reason), ['due', 'new']);
});

// ---------- 会话 + 引擎 ----------

test('完整会话：recall → 费曼 → 五问 ×3 → 迁移 → 落调度（批改针对知识点）', async () => {
  const root = makeVault();
  const ctx = makeCtx(root);
  const engine = stubEngine(2);
  try {
    learn.syncPages(ctx, learn.scanVault(ctx));
    learn.saveItems(ctx, seedConcepts(ctx, 'wiki/学习卡片/2026-10-01-复利思维.md', [
      { term: '损耗项', definition: '复利中被吃掉的收益', why: '决定复利是否成立' },
    ]));
    const item = learn.loadItems(ctx)[0];
    const s = learn.createSession(ctx, item.id);

    const t1 = await learn.turn(ctx, s.id, 'study', '这段讲的是损耗项会吃掉复利收益', { engine });
    assert.equal(t1.stage, 'feynman');
    assert.match(t1.material, /损耗项/, '材料必须是知识点卡片，不是整页');
    assert.match(t1.prompt, /损耗项/, '费曼题面要点名术语');

    const t2 = await learn.turn(ctx, s.id, 'feynman', '损耗项像水管的漏水，漏多少决定你最后剩多少', { engine });
    assert.equal(t2.stage, 'why5');
    assert.equal(t2.feedback.level, 2);
    assert.equal(t2.chainFallback, false);

    // 引擎给的链是 2 问：答完第 2 问即进入迁移
    await learn.turn(ctx, s.id, 'why5', '因为交易有摩擦', { engine });
    const t4 = await learn.turn(ctx, s.id, 'why5', '因为摩擦来自撮合成本', { engine });
    assert.equal(t4.stage, 'transfer');

    const done = await learn.turn(ctx, s.id, 'transfer', '比如健身效果被熬夜抵消', { engine });
    assert.equal(done.stage, 'done');
    assert.equal(done.intervalDays, 1);
    assert.equal(learn.loadSchedule(ctx)[item.id].level, 2);
  } finally {
    cleanup(root, ctx.dataDir);
  }
});

// ---------- 内置主题（工程侧知识） ----------

test('内置主题：物化幂等、带 seed: 来源，且与知识库按单双日交替出题', () => {
  const root = makeVault();
  const ctx = makeCtx(root, { seeds: ['Java'] });
  try {
    learn.syncPages(ctx, learn.scanVault(ctx));
    const items = learn.loadItems(ctx);
    const java = items.filter((i) => String(i.sourcePath).startsWith('seed:'));
    assert.ok(java.length >= 10, 'Java 主题应物化出多条知识点');
    assert.ok(java.every((i) => i.pageTitle.startsWith('内置主题')), '来源标注为内置主题');
    assert.ok(!java.some((i) => i.term === 'GIL'), 'GIL 属于 Python 主题，不该混进来');
    assert.ok(java.some((i) => i.term === 'volatile 语义' || i.term === '垃圾回收分代'), 'Java 术语应在列');

    assert.equal(learn.materializeSeeds(ctx), 0, '重复调用不得重复插（幂等）');

    const seedItem = { id: 'S-1', kind: 'concept', term: 'GIL', sourcePath: 'seed:Python' };
    const vaultItem = { id: 'C-1', kind: 'concept', term: '损耗项', sourcePath: 'wiki/x.md' };
    const cfg = { dailyNew: 1, dailyReview: 0 };
    const even = learn.pickDaily([seedItem, vaultItem], {}, cfg, new Date('2026-10-30T10:00:00'));
    assert.equal(even[0].item.id, 'S-1', '双日先出内置主题');
    const odd = learn.pickDaily([seedItem, vaultItem], {}, cfg, new Date('2026-10-31T10:00:00'));
    assert.equal(odd[0].item.id, 'C-1', '单日先出知识库');
  } finally {
    cleanup(root, ctx.dataDir);
  }
});

test('内置主题不会饿死知识库：主题很多时仍会抽页面知识点', async () => {
  const root = makeVault();
  const ctx = makeCtx(root, { seeds: ['Java', 'Python'] });
  const engine = stubEngine(2);
  try {
    learn.syncPages(ctx, learn.scanVault(ctx));
    assert.ok(learn.loadItems(ctx).length >= 20, '主题先物化出一批');
    const r = await learn.ensureFreshConcepts(ctx, { engine });
    assert.ok(r.added > 0, 'vault 池为空时仍必须抽页面（否则知识库永远学不到）');
    const vaultItems = learn.loadItems(ctx).filter((i) => !String(i.sourcePath).startsWith('seed:'));
    assert.ok(vaultItems.length > 0);
  } finally {
    cleanup(root, ctx.dataDir);
  }
});

test('内置主题可通过配置关闭：seeds=[] 时只用知识库', () => {
  const root = makeVault();
  const ctx = makeCtx(root, { seeds: [] });
  try {
    learn.syncPages(ctx, learn.scanVault(ctx));
    assert.equal(learn.loadItems(ctx).filter((i) => String(i.sourcePath).startsWith('seed:')).length, 0);
  } finally {
    cleanup(root, ctx.dataDir);
  }
});

test('内置主题包含「AI 工程」（aieng 术语表精选），条目合法', () => {
  const seeds = require('../lib/learnSeeds');
  assert.ok(seeds.DOMAINS.includes('AI 工程'), 'AI 工程 主题应存在');
  const list = seeds.seedConcepts('AI 工程');
  assert.ok(list.length >= 40, 'AI 工程 至少 40 条');
  const terms = list.map((c) => c.term);
  assert.equal(terms.length, new Set(terms).size, '主题内术语不得重复');
  assert.ok(list.every((c) => c.term && c.definition && c.why), '每条都要有 term/definition/why');
});

test('todayQueue：返回队列对象（不是 Promise），且队列里是知识点', async () => {
  const root = makeVault();
  const ctx = makeCtx(root, { seeds: ['Java'] });
  try {
    learn.syncPages(ctx, learn.scanVault(ctx));
    const r = await learn.todayQueue(ctx);
    assert.ok(r && typeof r === 'object', 'todayQueue 必须 resolve 出对象');
    assert.ok(Array.isArray(r.queue), 'queue 必须是数组');
    assert.equal(r.queue.length, 1, 'dailyNew=1 时应出 1 条');
    assert.ok(r.queue[0].item.term, '队列条目必须带 term');
    assert.ok(r.status && r.status.counts, '顺带回状态，省一次请求');
  } finally {
    cleanup(root, ctx.dataDir);
  }
});

test('宿主 llm 优先：进程内调用宿主当前默认模型，并压低推理强度', async () => {
  const root = makeVault();
  const ctx = makeCtx(root, { engine: { mode: 'auto', timeoutSec: 180, reasoningEffort: 'off', maxTokens: 1200 } });
  const calls = [];
  ctx.llm = {
    async *stream(options) {
      calls.push(options);
      yield { type: 'text-delta', text: '{"good":[],"missing":[],"jargon":[],"misconception":[],"probe":"p","level":2}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  ctx.agentDefaultModel = { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) };
  try {
    learn.saveItems(ctx, seedConcepts(ctx, 'wiki/x.md', [{ term: '基础率', definition: '先验概率' }]));
    const item = learn.loadItems(ctx)[0];
    const s = learn.createSession(ctx, item.id);
    await learn.turn(ctx, s.id, 'study', '先验概率就是基础率', {});
    const r = await learn.turn(ctx, s.id, 'feynman', '像背景水位', {});
    assert.equal(r.degraded, false);
    assert.equal(r.feedback.level, 2);
    assert.equal(calls[0].provider, 'deepseek-account');
    assert.equal(calls[0].model, 'deepseek-flash');
    assert.equal(calls[0].reasoningEffort, 'off');
  } finally {
    cleanup(root, ctx.dataDir);
  }
});

test('引擎失败：degraded 继续跑完（降级门），不卡死', async () => {
  const root = makeVault();
  const ctx = makeCtx(root);
  const boom = async () => {
    throw new Error('宿主模型超时（>180s）');
  };
  try {
    learn.saveItems(ctx, seedConcepts(ctx, 'wiki/y.md', [{ term: '纳什均衡', definition: '谁都不愿单方改变' }]));
    const item = learn.loadItems(ctx)[0];
    const s = learn.createSession(ctx, item.id);
    await learn.turn(ctx, s.id, 'study', '一个谁都不愿单方改变的状态', { engine: boom });
    const g = await learn.turn(ctx, s.id, 'feynman', '像两个人都不先松手', { engine: boom });
    assert.equal(g.degraded, true);
    assert.equal(g.chainFallback, true);
    assert.ok(g.question, '降级后仍给通用追问');

    const done = await learn.finishSession(ctx, s.id, 1);
    assert.equal(done.stage, 'done');
  } finally {
    cleanup(root, ctx.dataDir);
  }
});
