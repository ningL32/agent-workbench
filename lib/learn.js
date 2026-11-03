'use strict';

/**
 * learn.js — v2.9.44 知识库学习模式（只读 vault + 交互式学习 + 遗忘曲线调度）
 *
 * 契约见 docs/SPEC-LEARN.md。三条不可违背：
 *  ① **vault 只读**：本模块对 `learn.root` 只有 readdir/stat/readFile，**没有任何写/删调用**；
 *     全部产出落 `data/learn/`（items/schedule/sessions/scan）。
 *  ② **先测后学**：建会话的响应里不含材料正文；必须先提交 recall 才拿得到 digest。
 *  ③ **引擎失败可降级**：dsh 不可用/超时 → 会话标 `degraded:true`，按"自评"继续，绝不卡死。
 *
 * 调度是纯函数（输入 item+评分+now → 新状态），可表驱动测试、不依赖系统时钟。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const store = require('./store');
const storeDb = require('./storeDb');
const { HttpError, sendJSON } = require('./router');
const analyze = require('./analyze');
const seedsLib = require('./learnSeeds');

const LADDER = [1, 3, 7, 16, 35]; // 间隔阶梯（天），与 vault 题库的 1/2/4/8/16 同构但更缓
const DECAY_DAYS = 90; // 长期不复习且掌握度≤1 → 当新条目重学
const MAX_SCAN_FILES = 2000;
const MAX_SESSIONS = 500;

// ---------- 小工具 ----------

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地日期 YYYY-MM-DD（用本地时区，跨日判断跟用户感知一致） */
function ymd(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(ymdStr, days) {
  const [y, m, d] = ymdStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0); // 中午锚点，避开夏令时/边界
  dt.setDate(dt.getDate() + days);
  return ymd(dt);
}

function itemId(sourcePath) {
  return `L-${crypto.createHash('sha1').update(String(sourcePath)).digest('hex').slice(0, 10)}`;
}

function learnDir(ctx) {
  return path.join(ctx.dataDir, 'learn');
}

function fileOf(ctx, name) {
  return path.join(learnDir(ctx), name);
}

function learnCfg(ctx) {
  return (ctx && ctx.config && ctx.config.learn) || {};
}

// ---------- 配置与根路径校验（只读） ----------

/**
 * 根路径校验（v2.9.55 放宽）：只要求 **绝对路径 + 存在 + 目录**。
 * 是否 LLM Wiki 只作为 `flavor` 提示，不再硬拦——别人的库可能是 Obsidian 目录、
 * 文档导出、普通 Markdown 仓库；拿"缺少 AGENTS.md"当拒绝理由是产品缺陷。
 */
function validateRoot(raw) {
  const root = typeof raw === 'string' ? raw.trim() : '';
  if (!root) return { ok: false, reason: '未配置知识库根路径' };
  if (!path.isAbsolute(root)) return { ok: false, reason: '根路径必须是绝对路径' };
  let st;
  try {
    st = fs.statSync(root);
  } catch (e) {
    return { ok: false, reason: `根路径不存在或不可读：${root}` };
  }
  if (!st.isDirectory()) return { ok: false, reason: '根路径不是目录' };
  const resolved = path.resolve(root);
  let flavor = 'generic';
  try {
    const agents = fs.readFileSync(path.join(resolved, 'AGENTS.md'), 'utf8');
    if (/LLM[\s-]*Wiki/i.test(agents)) flavor = 'llm-wiki';
  } catch (e) {
    /* 没有 AGENTS.md 也合法：按普通 Markdown 库处理 */
  }
  const warnings = flavor === 'generic'
    ? ['未检测到 LLM Wiki 标记（AGENTS.md）：按普通 Markdown 库处理，只读取 .md']
    : [];
  return { ok: true, root: resolved, flavor, warnings };
}

const MAX_PROBE_FILES = 5000;

/**
 * 只读探测（初始化向导用）：看清一个陌生目录里"有什么、会被怎么处理"，**不写任何东西**。
 * 返回 md 数、顶层目录分布、会被过滤掉的比例（_前缀/README/outputs/en.md）、样本路径。
 */
function probeRoot(raw) {
  const check = validateRoot(raw);
  if (!check.ok) return { ok: false, reason: check.reason, root: typeof raw === 'string' ? raw : '' };
  const root = check.root;
  const filtered = { underscore: 0, readme: 0, outputs: 0, en: 0 };
  const dirs = new Map();
  const samples = [];
  let md = 0;

  const walk = (relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      if (md >= MAX_PROBE_FILES) return;
      if (!ent || ent.name.startsWith('.')) continue;
      if (ent.name.startsWith('_')) {
        if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) filtered.underscore += 1;
        continue;
      }
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === 'outputs') {
          filtered.outputs += 1;
          continue;
        }
        walk(rel);
        continue;
      }
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue;
      const lower = ent.name.toLowerCase();
      if (lower === 'readme.md') {
        filtered.readme += 1;
        continue;
      }
      if (lower === 'en.md') {
        filtered.en += 1;
        continue;
      }
      md += 1;
      const top = rel.includes('/') ? rel.split('/')[0] : '(根目录)';
      dirs.set(top, (dirs.get(top) || 0) + 1);
      if (samples.length < 12) samples.push(rel);
    }
  };
  walk('');

  const topDirs = Array.from(dirs.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([rel, count]) => ({ rel, count }));
  return {
    ok: true,
    root,
    flavor: check.flavor,
    warnings: check.warnings,
    counts: { md, filtered, filteredTotal: filtered.underscore + filtered.readme + filtered.outputs + filtered.en },
    topDirs,
    samples,
    // 推荐范围：有顶层目录就全选它们（. = 整库），根目录为主时才用 '.'
    suggestedScope: topDirs.filter((d) => d.rel !== '(根目录)').map((d) => d.rel),
  };
}

/** scope 归一：默认 ['wiki']；每个元素必须是 root 内的相对子路径（不许 .. 逃逸） */
function scopeDirs(cfg) {
  // v2.9.55：默认不再是 ['wiki']（那是本仓业主的目录约定，别人的库没有 wiki/）；
  // 留空 = 整库扫描（'.'），只在扫描器里按过滤器剔掉索引/产出物。
  const list = Array.isArray(cfg.scope) && cfg.scope.length ? cfg.scope : ['.'];
  const out = [];
  for (const raw of list) {
    const rel = String(raw || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (rel === '.' || rel === '') {
      out.push('.');
      continue;
    }
    if (rel.split('/').includes('..')) continue;
    out.push(rel);
  }
  return out.length ? out : ['.'];
}

function excludeList(cfg) {
  return (Array.isArray(cfg.exclude) ? cfg.exclude : [])
    .map((s) => String(s || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
}

function isExcluded(rel, excludes) {
  return excludes.some((ex) => rel === ex || rel.startsWith(`${ex}/`));
}

// ---------- 扫描（只读）+ 条目 ----------

function stripFrontmatter(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: String(text || '') };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: String(text || '').slice(m[0].length) };
}

/** 摘要：去 frontmatter、去 markdown 记号，取前 400 字；卡片天然短，等于全文 */
function makeDigest(body, max) {
  const text = String(body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  const limit = max || 400;
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function walkMd(root, relDir, excludes, out) {
  const abs = path.join(root, relDir);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    return; // 目录不存在/无权限：跳过，不炸整次扫描
  }
  for (const ent of entries) {
    if (out.length >= MAX_SCAN_FILES) return;
    // `_` 前缀在本库是元页面约定（_index/_方法论/_audit-notes/_题库…）：不是知识，别拿来出题
    if (!ent || ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      // 课程快照/工程仓里的 outputs 是产出物，不是课文
      if (ent.name === 'outputs') continue;
      if (isExcluded(rel, excludes)) continue;
      walkMd(root, rel, excludes, out);
      continue;
    }
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue;
    // v2.9.54 课程快照适配：README 是阶段/课级索引，en.md 是同一课的英文副本（zh.md 已单独成条）
    const lowerName = ent.name.toLowerCase();
    if (lowerName === 'readme.md' || lowerName === 'en.md') continue;
    if (isExcluded(rel, excludes)) continue;
    const absFile = path.join(root, rel);
    let st;
    try {
      st = fs.statSync(absFile);
    } catch (e) {
      continue;
    }
    let text = '';
    try {
      text = fs.readFileSync(absFile, 'utf8');
    } catch (e) {
      continue;
    }
    const { meta, body } = stripFrontmatter(text);
    const h1 = body.match(/^#\s+(.+)$/m);
    // v2.9.54 小节标题：课程/长文里 h2/h3 是最省 token 的结构信号，抽取知识点时一并喂给模型
    const headings = Array.from(body.matchAll(/^#{2,3}\s+(.+)$/gm))
      .map((m) => m[1].trim().replace(/[*_`]/g, ''))
      .filter(Boolean)
      .slice(0, 12);
    out.push({
      rel,
      kind: rel.startsWith('wiki/学习卡片/') ? 'card' : 'page',
      title: (meta.title || (h1 ? h1[1].trim() : path.basename(rel, '.md'))).slice(0, 120),
      tags: String(meta.tags || '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8),
      status: typeof meta.status === 'string' ? meta.status : null,
      headings,
      mtime: Math.round(st.mtimeMs),
      size: st.size,
      digest: makeDigest(body),
    });
  }
}

/** 只读扫描 vault：返回条目数组（不写盘） */
function scanVault(ctx) {
  const cfg = learnCfg(ctx);
  const check = validateRoot(cfg.root);
  if (!check.ok) throw new HttpError(400, 'LEARN_ROOT_INVALID', check.reason);
  const excludes = excludeList(cfg);
  const out = [];
  for (const rel of scopeDirs(cfg)) walkMd(check.root, rel === '.' ? '' : rel, excludes, out);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { root: check.root, entries: out, scannedAt: new Date().toISOString() };
}

/** 单元名 → 台账单元 id（learn 五单元迁 SQLite 后经 storeDb 路由，SPEC-STORAGE §2.4） */
function unitIdOf(name) {
  return `learn:${String(name || '').replace('.json', '')}`;
}

function loadJSON(ctx, name, fallback) {
  // v2.9.33 批次 2：learn 五单元迁 learn_docs 单文档行（db 在 dataDir 根——**不是** learnDir 子目录）
  if (storeDb.unitBackend(ctx.dataDir, unitIdOf(name)).backend === 'sqlite') {
    const doc = storeDb.loadLearnDoc(storeDb.dbPathFor(ctx.dataDir), unitIdOf(name));
    return doc && typeof doc === 'object' ? doc : fallback;
  }
  const d = store.readJSON(fileOf(ctx, name), null);
  return d && typeof d === 'object' ? d : fallback;
}

/** 写漏斗统一出口（与 store.writeJSON 同纪律：db 路径=单文档 upsert；JSON 路径=tmp+rename） */
function saveJSON(ctx, name, obj) {
  if (storeDb.unitBackend(ctx.dataDir, unitIdOf(name)).backend === 'sqlite') {
    return storeDb.saveLearnDoc(storeDb.dbPathFor(ctx.dataDir), unitIdOf(name), obj);
  }
  store.writeJSON(fileOf(ctx, name), obj);
}

const ITEMS_VERSION = 2; // v2.9.51：学习条目从「一个 wiki 页」改为「一个原子知识点」

/**
 * 学习条目 = **原子知识点**（术语/概念/机制），不是页面。页面只作为素材来源。
 * 旧结构（一页一条）与"逐条学懂"的语义不符，读到旧版本就地重建（孤儿调度无害）。
 */
function loadItems(ctx) {
  const d = loadJSON(ctx, 'items.json', { version: ITEMS_VERSION, items: [] });
  if (d.version !== ITEMS_VERSION) return [];
  return Array.isArray(d.items) ? d.items : [];
}

function saveItems(ctx, items) {
  saveJSON(ctx, 'items.json', { version: ITEMS_VERSION, items, updatedAt: new Date().toISOString() });
}

function loadPages(ctx) {
  const d = loadJSON(ctx, 'pages.json', { pages: [] });
  return Array.isArray(d.pages) ? d.pages : [];
}

function savePages(ctx, pages) {
  saveJSON(ctx, 'pages.json', { pages, updatedAt: new Date().toISOString() });
}

function loadSchedule(ctx) {
  const d = loadJSON(ctx, 'schedule.json', { items: {} });
  return store.isPlainObject(d.items) ? d.items : {};
}

function loadSessions(ctx) {
  const d = loadJSON(ctx, 'sessions.json', { sessions: [] });
  return Array.isArray(d.sessions) ? d.sessions : [];
}

function saveSessions(ctx, list) {
  saveJSON(ctx, 'sessions.json', { sessions: list.slice(-MAX_SESSIONS) });
}

/** 知识点 id：页面 + 术语 稳定可复算（换页面/同页同词都不重复学） */
function conceptId(pageRel, term) {
  return `C-${crypto.createHash('sha1').update(`${pageRel}#${term}`).digest('hex').slice(0, 10)}`;
}

/** 内置主题知识点物化：只补缺、不动已有调度（幂等；老部署不重扫也会在出题前补上） */
function materializeSeeds(ctx) {
  const cfg = learnCfg(ctx);
  const domains = Array.isArray(cfg.seeds) ? cfg.seeds : seedsLib.DOMAINS;
  const items = loadItems(ctx);
  const have = new Set(items.map((it) => it.id));
  const now = new Date().toISOString();
  const added = [];
  for (const domain of domains) {
    for (const c of seedsLib.seedConcepts(domain)) {
      const id = `S-${crypto.createHash('sha1').update(`${domain}#${c.term}`).digest('hex').slice(0, 10)}`;
      if (have.has(id)) continue;
      have.add(id);
      added.push({
        id,
        kind: 'concept',
        term: c.term,
        definition: c.definition,
        why: c.why,
        sourcePath: `seed:${domain}`,
        pageTitle: `内置主题 · ${domain}`,
        digest: c.definition,
        createdAt: now,
        excluded: false,
        needsRewrite: false,
      });
    }
  }
  if (added.length) saveItems(ctx, items.concat(added));
  return added.length;
}

/** 扫描结果 → pages 索引（只读元数据）。页面内容变了就清掉 conceptsAt，下次重新抽知识点 */
function syncPages(ctx, scanned) {
  const old = new Map(loadPages(ctx).map((p) => [p.rel, p]));
  const now = new Date().toISOString();
  const pages = scanned.entries.map((e) => {
    const prev = old.get(e.rel);
    const changed = !prev || prev.mtime !== e.mtime;
    return {
      rel: e.rel,
      title: e.title,
      kind: e.kind,
      tags: e.tags,
      headings: e.headings || [],
      mtime: e.mtime,
      digest: e.digest,
      conceptsAt: changed ? null : (prev.conceptsAt || null),
      createdAt: (prev && prev.createdAt) || now,
    };
  });
  // v2.9.56 导入的资料不在知识库里（落在 data/learn/imports/），重扫必须保留
  for (const p of old.values()) {
    if (String(p.rel).startsWith('import:')) pages.push(p);
  }
  savePages(ctx, pages);
  saveJSON(ctx, 'scan.json', { root: scanned.root, scannedAt: scanned.scannedAt, pages: pages.length });
  materializeSeeds(ctx);
  return pages;
}

// ---------- 导入器：pdf/docx/html/md/txt → 本地学习库（绝不写用户知识库） ----------

function importsDir(ctx) {
  const dir = path.join(learnDir(ctx), 'imports');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    /* 已存在；权限问题交给写文件时报错 */
  }
  return dir;
}

/** 原子写文本（tmp + rename），与 store.writeJSON 同纪律 */
function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** 导入预览：只列文件与类型，不抽取（只读、快） */
function previewImport(inputPath) {
  const imp = require('./learnImport');
  const collected = imp.collectFiles(inputPath);
  if (!collected.ok) return { ok: false, reason: collected.reason };
  const files = collected.files.map((abs) => {
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch (e) {
      size = 0;
    }
    return { path: abs, name: path.basename(abs), kind: imp.kindOf(abs), size };
  });
  return { ok: true, files, total: files.length };
}

/** 执行导入：抽文本 → 落 data/learn/imports/*.md → 进页面索引（conceptsAt=null，待抽） */
function importMaterials(ctx, inputPath) {
  const imp = require('./learnImport');
  const collected = imp.collectFiles(inputPath);
  if (!collected.ok) throw new HttpError(400, 'LEARN_IMPORT_INVALID', collected.reason);

  const dir = importsDir(ctx);
  const byRel = new Map(loadPages(ctx).map((p) => [p.rel, p]));
  const imported = [];
  const skipped = [];
  const now = new Date().toISOString();

  for (const abs of collected.files) {
    const r = imp.extractText(abs);
    if (!r.ok) {
      skipped.push({ name: path.basename(abs), kind: r.kind, reason: r.reason });
      continue;
    }
    const slug = imp.slugify(abs);
    const rel = `import:${slug}`;
    const title = path.basename(abs).replace(/\.[^.]+$/, '').slice(0, 120);
    const md = `---\ntitle: ${title}\nsource: ${abs}\nimportedAt: ${now}\nkind: ${r.kind}\n---\n\n# ${title}\n\n${r.text}\n`;
    try {
      writeTextAtomic(path.join(dir, `${slug}.md`), md);
    } catch (e) {
      /* 副本没落盘不影响学习：内容仍在索引里 */
    }
    const headings = Array.from(String(r.text).matchAll(/^#{1,3}\s+(.+)$/gm))
      .map((m) => m[1].trim())
      .filter(Boolean)
      .slice(0, 12);
    byRel.set(rel, {
      rel,
      title,
      kind: 'import',
      tags: [],
      headings,
      mtime: Date.now(),
      digest: makeDigest(r.text, 400),
      conceptsAt: null,
      createdAt: (byRel.get(rel) && byRel.get(rel).createdAt) || now,
      sourceFile: abs,
      chars: r.chars,
    });
    imported.push({ name: path.basename(abs), kind: r.kind, chars: r.chars, page: rel, warning: r.warning || null });
  }

  savePages(ctx, Array.from(byRel.values()));
  return { ok: true, imported, skipped, total: collected.files.length };
}

// ---------- 原子知识点抽取（每页 1 次引擎调用，按需触发） ----------

function buildConceptPrompt(page) {
  const heads = Array.isArray(page.headings) && page.headings.length
    ? `\n小节（按顺序，可作为选题线索）：${page.headings.join(' / ')}`
    : '';
  return [
    '你是知识工程师。从下面这页笔记里抽取**原子知识点**，用于逐条学习。',
    '要求：',
    '- 每条只讲一个概念/术语/机制，能独立成题；**不要**"某方案总体介绍"这种宽泛条目。',
    '- 优先抽**专业术语、模型/机制名、关键判据**（例："基础率""纳什均衡""幂等奖赏""损耗项"）。',
    '- term ≤20 字；definition ≤60 字（说人话）；why ≤40 字（为什么重要、用在哪）。',
    '- 3-8 条；材料里没有的不编，宁可少。',
    `页面标题：${page.title}${heads}`,
    `<material>\n${page.digest}\n</material>`,
    '只输出 JSON（不要 markdown 代码块）：{"concepts":[{"term":"…","definition":"…","why":"…"}]}',
  ].join('\n');
}

async function extractConcepts(ctx, page, opts) {
  const engine = engineOf(ctx, opts);
  if (!engine) throw new HttpError(400, 'LEARN_NO_ENGINE', '没有可用引擎，无法从页面抽取知识点（learn.engine.mode=off？）');
  const parsed = parseEngineJSON(await engine(buildConceptPrompt(page)));
  const list = parsed && Array.isArray(parsed.concepts) ? parsed.concepts : [];
  const out = [];
  const seen = new Set();
  for (const c of list) {
    const term = String((c && c.term) || '').trim().slice(0, 40);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push({
      id: conceptId(page.rel, term),
      kind: 'concept',
      term,
      definition: String((c && c.definition) || '').trim().slice(0, 200),
      why: String((c && c.why) || '').trim().slice(0, 120),
      sourcePath: page.rel,
      pageTitle: page.title,
      digest: String((c && c.definition) || '').trim().slice(0, 200),
      createdAt: new Date().toISOString(),
      excluded: false,
      needsRewrite: false,
    });
  }
  return out;
}

/**
 * 按需补货：没学过的知识点少于 3 条时，挑一个"还没抽过"的页面抽一批。
 * 单次最多抽 1 页（1 次引擎调用，约 3-5s），避免扫描时炸出一堆调用。
 */
async function ensureFreshConcepts(ctx, opts) {
  materializeSeeds(ctx);
  const items = loadItems(ctx);
  const schedule = loadSchedule(ctx);
  const isSeed = (it) => String(it.sourcePath || '').startsWith('seed:');
  const unlearned = items.filter((it) => !it.excluded && !it.needsRewrite && !schedule[it.id]);
  // 两个池各自保底：内置主题很多，不能因此让知识库永远不再抽页（否则 vault 池会被饿死）
  const freshVault = unlearned.filter((it) => !isSeed(it));
  const freshSeed = unlearned.filter(isSeed);
  if (freshVault.length >= 2 && freshSeed.length >= 2) {
    return { added: 0, reason: '两池都够用' };
  }

  const pages = loadPages(ctx);
  const pending = pages
    .filter((p) => !p.conceptsAt)
    .sort((a, b) => (a.kind === b.kind ? a.rel.localeCompare(b.rel) : a.kind === 'card' ? -1 : 1));
  const page = pending[0];
  if (!page) return { added: 0, reason: '没有待抽取页面' };

  const concepts = await extractConcepts(ctx, page, opts);
  const have = new Set(items.map((it) => it.id));
  const added = concepts.filter((c) => !have.has(c.id));
  if (added.length) saveItems(ctx, items.concat(added));
  page.conceptsAt = new Date().toISOString();
  savePages(ctx, pages);
  return { added: added.length, page: page.rel };
}

/** 知识点素材（题面只用它，避免又回到"整页综述"） */
function conceptMaterial(item) {
  return `${item.term}：${item.definition || '（材料未给定义）'}${item.why ? `\n为什么重要：${item.why}` : ''}`;
}

/**
 * 学习材料（v2.9.58）：知识点卡片 + 来源页摘录。
 * 只给一句定义太薄，读不出上下文；摘录用页面 digest（≤400 字），是原文而非模型转述。
 */
function materialFor(ctx, item) {
  const base = conceptMaterial(item);
  const rel = String(item.sourcePath || '');
  if (!rel) return base;
  const page = loadPages(ctx).find((x) => x.rel === rel);
  if (!page || !page.digest) return base;
  const label = rel.startsWith('import:') ? '导入资料摘录' : `原文摘录（《${page.title || ''}》）`;
  return `${base}\n\n—— ${label}\n${page.digest}`;
}

// ---------- 调度（纯函数） ----------

function defaultState(id) {
  return { itemId: id, level: 0, intervalDays: 0, lapses: 0, dueAt: null, lastReviewedAt: null, needsRewrite: false };
}

/** 下一档间隔：从当前间隔在阶梯上的位置推进；level 3 跳一级 */
function nextInterval(current, level) {
  const idx = LADDER.indexOf(Number(current));
  const base = idx === -1 ? -1 : idx;
  const step = level >= 3 ? 2 : 1;
  const next = Math.min(base + step, LADDER.length - 1);
  return LADDER[Math.max(0, next)];
}

/**
 * 应用一次复习评分（0-3）：返回新状态。纯函数，不读时钟以外的东西。
 *  - 0/1：明天重来，lapses+1；连续 3 次 → needsRewrite（材料讲不清/选题太大）
 *  - 2：阶梯升一级；3：跳一级；35 天封顶
 *  - 长期（>90 天）未复习且 level≤1 → 当新条目重学（interval 归零）
 */
function applyReview(state, level, now) {
  const today = ymd(now || new Date());
  const base = Object.assign(defaultState(state && state.itemId), state || {});
  const lv = Math.max(0, Math.min(3, Number(level) || 0));
  const stale = base.lastReviewedAt && (Date.parse(today) - Date.parse(base.lastReviewedAt)) / 86400000 > DECAY_DAYS;
  const restart = stale && (base.level || 0) <= 1;

  const next = Object.assign({}, base, { level: lv, lastReviewedAt: today });

  if (lv <= 1) {
    next.intervalDays = 1;
    next.lapses = (Number(base.lapses) || 0) + 1;
    next.dueAt = addDays(today, 1);
    if (next.lapses >= 3) next.needsRewrite = true;
    return next;
  }
  const current = restart || !base.intervalDays ? 0 : base.intervalDays;
  next.intervalDays = nextInterval(current, lv);
  next.dueAt = addDays(today, next.intervalDays);
  next.lapses = 0;
  return next;
}

function isDue(state, today) {
  return !!(state && state.dueAt && state.dueAt <= today);
}

/** 今日队列：到期优先（最多 dailyReview 个，按 kind 交错）；到期不足时才补 dailyNew 个新条目 */
function pickDaily(items, schedule, cfg, now) {
  const today = ymd(now || new Date());
  const eligible = items.filter((it) => it && !it.excluded && !it.needsRewrite && !(schedule[it.id] && schedule[it.id].needsRewrite));
  const due = eligible
    .filter((it) => isDue(schedule[it.id], today))
    .sort((a, b) => String(schedule[a.id].dueAt).localeCompare(String(schedule[b.id].dueAt)));

  const reviewLimit = Math.max(0, Number(cfg.dailyReview) || 0);
  const picked = [];
  const rest = due.slice();
  while (picked.length < reviewLimit && rest.length) {
    let i = 0;
    const last = picked[picked.length - 1];
    // 交错：能挑到与上一条不同 kind 的就先挑它，避免连续同主题
    if (last) {
      const alt = rest.findIndex((it) => it.kind !== last.kind);
      if (alt > 0) i = alt;
    }
    picked.push(rest.splice(i, 1)[0]);
  }

  const out = picked.map((it) => ({ item: it, reason: 'due' }));
  const newLimit = Math.max(0, Number(cfg.dailyNew) || 0);
  // v2.9.61：到期与新题**并行**。之前写成"到期为空才补新"，与设置里的「每日 3 新题」冲突：
  // 只要有一条到期，当天就只剩 1 条。现在 = 到期（≤dailyReview）+ 新题（≤dailyNew）。
  if (newLimit > 0) {
    const isSeed = (it) => String(it.sourcePath || '').startsWith('seed:');
    const byPath = (a, b) => (a.kind === b.kind ? a.sourcePath.localeCompare(b.sourcePath) : a.kind === 'card' ? -1 : 1);
    const freshAll = eligible.filter((it) => !schedule[it.id]);
    const seedPool = freshAll.filter(isSeed).sort(byPath);
    const vaultPool = freshAll.filter((it) => !isSeed(it)).sort(byPath);
    // 双池交替：单日先 vault、双日先内置主题，保证"业务知识"和"工程基础"都轮得到
    const dayNum = new Date(now || Date.now()).getDate();
    const pools = dayNum % 2 === 0 ? [seedPool, vaultPool] : [vaultPool, seedPool];
    const fresh = [].concat(...pools);
    for (const it of fresh.slice(0, newLimit)) out.push({ item: it, reason: 'new' });
  }
  return out;
}

// ---------- 引擎（可注入；失败降级） ----------

/**
 * 宿主 LLM 直连（v2.9.47 首选）：用「当前 profile 的默认模型」在进程内流式调用——
 * 桌面端就是 DeepSeek-V4.1-Flash 那条账号通道（子进程拿不到，实测 ACCOUNT_SIGN_IN_REQUIRED），
 * 也不需要 GLM_API_KEY。拿不到 llm 服务时返回 null，调用方回落 spawn 引擎。
 */
function hostEngine(ctx, timeoutSec, engineCfg) {
  const llm = ctx && ctx.llm;
  if (!llm || typeof llm.stream !== 'function') return null;
  const ec = engineCfg || {};
  const reasoningEffort = typeof ec.reasoningEffort === 'string' && ec.reasoningEffort ? ec.reasoningEffort : 'off';
  const maxTokens = Number(ec.maxTokens) > 0 ? Number(ec.maxTokens) : 1200;
  const pick = () => {
    try {
      const svc = ctx.agentDefaultModel;
      const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null;
      if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') return sel;
    } catch (e) {
      /* 拿不到选择就不指定 provider/model，交给宿主默认 */
    }
    return null;
  };
  return async (prompt) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
    const sel = pick();
    if (!sel) throw new Error('宿主未提供默认模型（agentDefaultModel.currentSelection 为空）');
    let text = '';
    try {
      // reasoningEffort 默认压到 low：批改/造题是短输出任务，high 会白等两三分钟（实测 187s）
      const options = {
        provider: sel.provider,
        model: sel.model,
        reasoningEffort,
        maxTokens,
        messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt) }] }],
        signal: ctrl.signal,
      };
      for await (const chunk of llm.stream(options)) {
        if (!chunk) continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind && chunk.reason.kind !== 'stop') {
          throw new Error(`宿主模型结束异常：${chunk.reason.kind}${chunk.reason.message ? ` ${chunk.reason.message}` : ''}`);
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (!text.trim()) throw new Error('宿主模型没有返回文本');
    return text;
  };
}

function engineOf(ctx, opts) {
  if (opts && typeof opts.engine === 'function') return opts.engine;
  const cfg = learnCfg(ctx);
  const engineCfg = cfg.engine || {};
  const mode = engineCfg.mode || 'auto';
  const timeoutSec = Number(engineCfg.timeoutSec) || 180;
  if (mode === 'off') return null;
  if (mode !== 'dsh') {
    const host = hostEngine(ctx, timeoutSec, engineCfg);
    if (host) return host;
    if (mode === 'host') return null; // 显式要求宿主模型却拿不到服务 → 按"无引擎"降级，不偷偷换 profile
  }
  return (prompt) => analyze.runHeadless(ctx.config, prompt, { timeoutSec });
}

function parseEngineJSON(text) {
  const parsed = analyze.extractJSON(String(text || ''));
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function recallQuestion(item) {
  return `先别看资料：${item.term} 是什么？它解决什么问题？用你自己的话说两句。`;
}

function feynmanPrompt(item) {
  return `合上材料，给完全外行解释「${item.term}」：不许用这个术语本身或同义黑话，必须有一个类比。`;
}

function transferPrompt(item) {
  return `举一个知识库之外的例子：哪里用得上「${item.term}」？在什么条件下它不成立？`;
}

function buildGradePrompt(item, material, answer) {
  return [
    '你是严格但克制的学习教练。只依据下面材料判定，不得补充材料之外的知识。',
    '这次要检验的是**一个具体知识点**（术语/概念/机制），不是整篇文章的综述。',
    `<material>\n${material}\n</material>`,
    `知识点：${item.term || item.title}`,
    `学员的解释：\n${answer}`,
    '只输出 JSON（不要 markdown 代码块）：',
    '{"good":[讲对的点，最多3条],"missing":[材料里关键但没讲到的点，最多3条],"jargon":[哪句是用术语代替理解，最多2条],"misconception":[与材料相反的表述，没有则空数组],"probe":"一个能暴露是否真懂的追问","level":0|1|2|3}',
    '判定：0=跑题/空白；1=复述术语；2=用自己的话讲清且类比成立；3=还能指出边界或反例。材料不足以判定时 level 返回 null。',
    '若学员讲的是别的话题（哪怕讲得对），level 给 0 并直接指出跑题，不要迁就。',
  ].join('\n');
}

function buildWhyPrompt(item, material) {
  return [
    '基于材料就这个**具体知识点**生成一条 5-why 追问链，用于检验是否懂机理而不是背结论。',
    `<material>\n${material}\n</material>`,
    `知识点：${item.term || item.title}`,
    '要求：每问都能由上一答继续深挖，不跳步，第 5 问落到"约束/激励/成本"这类根因；',
    '每问都要围绕这个知识点本身（它为什么成立、不成立会怎样、边界在哪），不要扩成整篇文章的宏观讨论。',
    '只输出 JSON（不要 markdown 代码块）：{"chain":["问1","问2","问3","问4","问5"],"root":"根因一句话","materialBoundary":"材料支持到第几层"}',
  ].join('\n');
}

// ---------- 会话状态机 ----------

function findSession(ctx, id) {
  return loadSessions(ctx).find((s) => s && s.id === id) || null;
}

function saveSession(ctx, session) {
  const list = loadSessions(ctx);
  const idx = list.findIndex((s) => s && s.id === session.id);
  if (idx >= 0) list[idx] = session;
  else list.push(session);
  saveSessions(ctx, list);
}

function publicItem(item, extra) {
  return Object.assign({
    id: item.id,
    term: item.term,
    title: item.term || item.title,
    kind: item.kind,
    sourcePath: item.sourcePath,
    pageTitle: item.pageTitle,
    tags: item.tags,
  }, extra || {});
}

/**
 * 建会话。两种入口（v2.9.57 修正设计错误）：
 *  - **复习**（该知识点有调度记录）：先测——不给材料，靠自己回忆（检索练习的价值在这）
 *  - **新学**（从没学过）：先给材料（study）——对完全没接触过的内容"先测"只会卡住人，
 *    教学法上应先读后讲；讲（费曼）仍然是主动回忆，不违背"必须自己输出"的原则。
 */
function createSession(ctx, itemIdArg, opts) {
  const items = loadItems(ctx);
  const item = items.find((it) => it.id === itemIdArg) || items.find((it) => it.sourcePath === itemIdArg);
  if (!item) throw new HttpError(404, 'LEARN_ITEM_NOT_FOUND', `学习条目不存在：${itemIdArg}`);
  if (item.excluded) throw new HttpError(400, 'LEARN_ITEM_EXCLUDED', '该条目已被手动剔除');

  const today = ymd(new Date());
  const schedule = loadSchedule(ctx);
  const isReview = !!schedule[item.id];
  const firstStage = isReview ? 'recall' : 'study';

  const existing = loadSessions(ctx).find((s) => s && s.itemId === item.id && s.date === today && !s.finishedAt);
  if (existing) {
    let stage = existing.stage || firstStage;
    // 旧会话迁移（v2.9.57 之前建的 recall 会话其实是"新学"）：补上材料，别让人继续对着空白发呆
    if (stage === 'recall' && existing.isReview !== true) stage = 'study';
    const out = {
      id: existing.id,
      stage,
      item: publicItem(item),
      question: caseQuestion(item, stage),
      isReview: stage !== 'study',
      resumed: true,
    };
    if (stage === 'study') {
      out.material = materialFor(ctx, item);
      out.source = item.sourcePath;
    }
    return out;
  }

  const session = {
    id: `S-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    date: today,
    itemId: item.id,
    stage: firstStage,
    isReview,
    chain: [],
    chainIndex: 0,
    turns: [],
    grade: null,
    degraded: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    level: null,
  };
  saveSession(ctx, session);
  const out = {
    id: session.id,
    stage: firstStage,
    item: publicItem(item),
    question: caseQuestion(item, firstStage),
    isReview,
    resumed: false,
    _item: item, // 仅供内部/测试使用，路由层会剥掉
  };
  if (firstStage === 'study') {
    out.material = materialFor(ctx, item);
    out.source = item.sourcePath;
  }
  return out;
}

/** 分阶段题面（先测 / 读材料 / 费曼 / 迁移） */
function caseQuestion(item, stage) {
  if (stage === 'study') {
    return '先读下面这段（约 1 分钟），读完用一句话概括它在讲什么。';
  }
  if (stage === 'transition') return '继续。';
  return recallQuestion(item);
}

function stripInternal(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Object.assign({}, obj);
  delete out._item;
  return out;
}

/**
 * 推进一步。stage ∈ recall|feynman|why5|transfer。
 * 引擎失败 → degraded，仍继续（不卡死会话）。
 */
async function turn(ctx, id, stage, text, opts) {
  const session = findSession(ctx, id);
  if (!session) throw new HttpError(404, 'LEARN_SESSION_NOT_FOUND', '会话不存在');
  if (session.finishedAt) throw new HttpError(409, 'LEARN_SESSION_CLOSED', '会话已结束');
  if (session.stage !== stage) throw new HttpError(409, 'LEARN_STAGE_MISMATCH', `当前阶段是 ${session.stage}，不接受 ${stage}`);

  const answer = String(text || '').trim();
  if (answer.length < 2) throw new HttpError(400, 'LEARN_ANSWER_EMPTY', '请先写下你的回答（至少 2 个字）');

  const items = loadItems(ctx);
  const item = items.find((it) => it.id === session.itemId);
  if (!item) throw new HttpError(404, 'LEARN_ITEM_NOT_FOUND', '条目已不在学习库（可能被重建索引）');

  session.turns.push({ stage, text: answer.slice(0, 4000), at: new Date().toISOString() });

  if (stage === 'study' || stage === 'recall') {
    // 新学（study）：材料随建会话已给出，这里收下"一句概括"→ 进入费曼讲解
    // 复习（recall）：先测答案收下 → 才给材料 → 进入费曼讲解
    session.stage = 'feynman';
    saveSession(ctx, session);
    return {
      stage: 'feynman',
      material: materialFor(ctx, item),
      source: item.sourcePath,
      prompt: feynmanPrompt(item),
    };
  }

  if (stage === 'feynman') {
    const engine = engineOf(ctx, opts);
    let grade = null;
    let chain = [];
    let gradeErr = null;
    let chainErr = null;

    if (engine) {
      // 两件事互不依赖（批改 + 造五问链），并行跑——串行会把等待时间翻倍（实测 187s → 见 docs）
      const run = async (prompt) => {
        try {
          return { ok: true, value: parseEngineJSON(await engine(prompt)) };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
        }
      };
      const [g, w] = await Promise.all([
        run(buildGradePrompt(item, item.digest, answer)),
        run(buildWhyPrompt(item, item.digest)),
      ]);
      if (g.ok) grade = g.value;
      else gradeErr = g.error;
      if (w.ok) {
        const why = w.value;
        chain = Array.isArray(why && why.chain) ? why.chain.filter((q) => typeof q === 'string' && q.trim()).slice(0, 5) : [];
        if (why && typeof why.root === 'string') session.root = why.root.slice(0, 300);
        if (!chain.length) chainErr = '模型未给出可用追问链';
      } else {
        chainErr = w.error;
      }
    } else {
      gradeErr = '无可用引擎（learn.engine.mode=off 或宿主 llm 与 dsh 均不可用）';
      chainErr = gradeErr;
    }

    session.grade = grade;
    // 语义纠偏：**批改成功就不算 degraded**（之前把"五问链失败"也算降级，界面会误报"本次无 AI 批改"）
    session.degraded = !grade;
    if (gradeErr) session.engineError = gradeErr;
    if (chainErr) {
      session.chainError = chainErr;
      session.chainFallback = true;
    }
    if (!chain.length) chain = ['为什么会这样？', '再往下问一层：是什么约束导致的？'];
    session.chain = chain;
    session.chainIndex = 0;
    session.stage = 'why5';
    saveSession(ctx, session);
    return {
      stage: 'why5',
      question: chain[0],
      index: 0,
      total: chain.length,
      feedback: grade || null,
      degraded: session.degraded === true,
      chainFallback: session.chainFallback === true,
    };
  }

  if (stage === 'why5') {
    session.chainIndex = (Number(session.chainIndex) || 0) + 1;
    const idx = session.chainIndex;
    if (idx < session.chain.length) {
      saveSession(ctx, session);
      return { stage: 'why5', question: session.chain[idx], index: idx, total: session.chain.length };
    }
    session.stage = 'transfer';
    saveSession(ctx, session);
    return {
      stage: 'transfer',
      prompt: transferPrompt(item),
      root: session.root || null,
    };
  }

  // transfer：收尾
  const level = suggestLevel(session);
  session.finishedAt = new Date().toISOString();
  session.level = level;
  saveSession(ctx, session);
  const applied = applyReviewResult(ctx, session, level);
  return {
    stage: 'done',
    level,
    suggestedLevel: level,
    nextReviewAt: applied.dueAt,
    intervalDays: applied.intervalDays,
    needsRewrite: applied.needsRewrite === true,
    degraded: session.degraded === true,
  };
}

/** 建议掌握度：AI 给的 level 优先；没有则按"答完 5why 且写了迁移题"给 2，否则 1 */
function suggestLevel(session) {
  const g = session.grade;
  if (g && Number.isInteger(g.level)) return Math.max(0, Math.min(3, g.level));
  const whyAnswers = (session.turns || []).filter((t) => t.stage === 'why5').length;
  const transfer = (session.turns || []).some((t) => t.stage === 'transfer');
  if (transfer && whyAnswers >= 2) return 2;
  if (transfer) return 1;
  return 0;
}

/** 落调度（幂等：同一会话只应用一次） */
function applyReviewResult(ctx, session, level) {
  const schedule = loadSchedule(ctx);
  const prev = schedule[session.itemId] || defaultState(session.itemId);
  if (prev.lastSessionId === session.id) return prev; // 已应用过
  const next = applyReview(prev, level, new Date());
  next.lastSessionId = session.id;
  schedule[session.itemId] = next;
  saveJSON(ctx, 'schedule.json', { items: schedule, updatedAt: new Date().toISOString() });
  return next;
}

function finishSession(ctx, id, level, opts) {
  const session = findSession(ctx, id);
  if (!session) throw new HttpError(404, 'LEARN_SESSION_NOT_FOUND', '会话不存在');
  if (session.finishedAt) {
    const applied = (loadSchedule(ctx)[session.itemId]) || defaultState(session.itemId);
    return { stage: 'done', level: session.level, nextReviewAt: applied.dueAt, intervalDays: applied.intervalDays, alreadyFinished: true };
  }
  const lv = Number.isInteger(level) ? Math.max(0, Math.min(3, level)) : suggestLevel(session);
  session.finishedAt = new Date().toISOString();
  session.level = lv;
  saveSession(ctx, session);
  const applied = applyReviewResult(ctx, session, lv);
  return { stage: 'done', level: lv, nextReviewAt: applied.dueAt, intervalDays: applied.intervalDays, needsRewrite: applied.needsRewrite === true };
}

// ---------- 状态 ----------

function status(ctx) {
  const cfg = learnCfg(ctx);
  const check = validateRoot(cfg.root);
  const items = loadItems(ctx);
  const schedule = loadSchedule(ctx);
  const today = ymd(new Date());
  const eligible = items.filter((it) => !it.excluded);
  const due = eligible.filter((it) => isDue(schedule[it.id], today));
  const fresh = eligible.filter((it) => !schedule[it.id]);
  const doneToday = loadSessions(ctx).filter((s) => s && s.date === today && s.finishedAt).length;
  const pages = loadPages(ctx);
  return {
    enabled: cfg.enabled === true,
    configured: cfg.enabled === true && check.ok,
    root: typeof cfg.root === 'string' ? cfg.root : '',
    rootOk: check.ok,
    rootError: check.ok ? null : check.reason,
    scope: scopeDirs(cfg),
    exclude: excludeList(cfg),
    dailyNew: Number(cfg.dailyNew) || 1,
    dailyReview: Number(cfg.dailyReview) || 3,
    minutes: Number(cfg.minutes) || 15,
    counts: {
      items: items.length,
      seeds: items.filter((it) => String(it.sourcePath || '').startsWith('seed:')).length,
      imports: items.filter((it) => String(it.sourcePath || '').startsWith('import:')).length,
      pages: pages.length,
      pagesPending: pages.filter((p) => !p.conceptsAt).length,
      learned: eligible.length - fresh.length,
      due: due.length,
      fresh: fresh.length,
      needsRewrite: eligible.filter((it) => it.needsRewrite || (schedule[it.id] && schedule[it.id].needsRewrite)).length,
    },
    todayDone: doneToday,
    // v2.9.62：实例版本 vs 仓库 package.json ——web 改动刷新即生效、lib 改动必须重启，
    // 两者错位时前端会点到不存在的接口（"接口不存在"），这里把它显式暴露出来
    version: versionInfo(ctx),
    // 引擎是否可用：宿主 llm 服务优先（桌面端=账号模型），否则看 dsh 子进程是否可解析
    engineOk: !!(ctx.llm && typeof ctx.llm.stream === 'function') || !!analyze.resolveDshBin(ctx.config),
    engine: (ctx.llm && typeof ctx.llm.stream === 'function') ? 'host' : 'dsh',
  };
}

/** 今日队列（不含材料正文）；没货时按需抽一页知识点（1 次引擎调用） */
async function todayQueue(ctx) {
  try {
    await ensureFreshConcepts(ctx);
  } catch (e) {
    // 抽取失败不该让整页崩：队列可能还有已抽好的条目
    if (!loadItems(ctx).length) throw e;
  }
  const cfg = learnCfg(ctx);
  const check = validateRoot(cfg.root);
  if (!check.ok) throw new HttpError(400, 'LEARN_ROOT_INVALID', check.reason);
  const items = loadItems(ctx);
  const schedule = loadSchedule(ctx);
  const picks = pickDaily(items, schedule, cfg, new Date());
  return {
    date: ymd(new Date()),
    queue: picks.map((p) => ({
      item: publicItem(p.item),
      reason: p.reason,
      level: (schedule[p.item.id] && schedule[p.item.id].level) || 0,
      dueAt: (schedule[p.item.id] && schedule[p.item.id].dueAt) || null,
    })),
    status: status(ctx),
  };
}

const MAX_SOURCE_BYTES = 400 * 1024;

/**
 * 读原文（v2.9.59）：材料里点「查看原文」时用，**只读**。
 * 白名单：只允许 .md；必须以 root 为根（防目录穿越）；导入资料走 data/learn/imports/。
 */
function readSource(ctx, pageRel) {
  const rel = String(pageRel || '').trim();
  if (!rel) throw new HttpError(400, 'LEARN_SOURCE_INVALID', '缺少 page 参数');

  if (rel.startsWith('import:')) {
    const slug = rel.slice('import:'.length);
    if (!/^[\w\u4e00-\u9fa5-]+$/.test(slug)) throw new HttpError(400, 'LEARN_SOURCE_INVALID', '导入页标识非法');
    const file = path.join(learnDir(ctx), 'imports', `${slug}.md`);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw new HttpError(404, 'LEARN_SOURCE_MISSING', '这份导入资料的本地副本不在了');
    }
    const clipped = text.length > MAX_SOURCE_BYTES;
    return { ok: true, rel, kind: 'import', title: slug, content: clipped ? text.slice(0, MAX_SOURCE_BYTES) : text, truncated: clipped };
  }

  const cfg = learnCfg(ctx);
  const check = validateRoot(cfg.root);
  if (!check.ok) throw new HttpError(400, 'LEARN_ROOT_INVALID', check.reason);
  const root = check.root;
  if (!rel.toLowerCase().endsWith('.md')) throw new HttpError(400, 'LEARN_SOURCE_INVALID', '只能查看 Markdown 原文');
  if (rel.split('/').includes('..')) throw new HttpError(400, 'LEARN_SOURCE_INVALID', '路径不允许包含 ..');

  const abs = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (abs !== root && !abs.startsWith(rootWithSep)) throw new HttpError(400, 'LEARN_SOURCE_INVALID', '路径越界');

  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    throw new HttpError(404, 'LEARN_SOURCE_MISSING', '原文文件不在了（可能被移动或删除）');
  }
  if (!st.isFile()) throw new HttpError(400, 'LEARN_SOURCE_INVALID', '不是文件');
  const clipped = st.size > MAX_SOURCE_BYTES;
  const buf = fs.readFileSync(abs);
  const text = buf.slice(0, MAX_SOURCE_BYTES).toString('utf8');
  const title = path.basename(rel, '.md');
  return { ok: true, rel, kind: 'vault', title, content: text, truncated: clipped, size: st.size };
}

/**
 * 初始化（v2.9.55）：给"别人的库"用的一步到位入口。
 * 探测 → 定范围 → 落盘 → 建索引 → 试抽一页做预览（预览不落库，避免白学没确认的东西）。
 */
async function initLearn(ctx, body, opts) {
  const input = body || {};
  const probe = probeRoot(String(input.root || ''));
  if (!probe.ok) throw new HttpError(400, 'LEARN_ROOT_INVALID', `${probe.reason}（当前：${probe.root || '空'}）`);

  const scope = Array.isArray(input.scope) && input.scope.length
    ? input.scope.map(String)
    : (probe.suggestedScope.length ? probe.suggestedScope : ['.']);

  const patchLearn = {
    enabled: true,
    root: probe.root,
    scope,
    exclude: Array.isArray(input.exclude) ? input.exclude.map(String) : [],
    dailyNew: Number.isInteger(input.dailyNew) ? input.dailyNew : 2,
    dailyReview: Number.isInteger(input.dailyReview) ? input.dailyReview : 3,
  };
  if (Array.isArray(input.seeds)) patchLearn.seeds = input.seeds.map(String);

  // 落盘路径与 settings PATCH 完全一致：磁盘现值 → deepMerge → 原子写 → 换运行期 config
  const settingsMod = require('./settings');
  const disk = store.readJSON(ctx.configPath, null);
  const base = store.isPlainObject(disk) ? disk : store.clone(ctx.config);
  const next = settingsMod.deepMerge(base, { learn: patchLearn });
  store.writeJSON(ctx.configPath, next);
  ctx.config = store.mergeConfigDefaults(next);

  const scanned = scanVault(ctx);
  const pages = syncPages(ctx, scanned);

  // 试抽一页：让用户在"确认"之前先看到知识点长什么样（预览不落库）
  let sample = null;
  let sampleError = null;
  if (input.sample !== false) {
    const page = pages.find((p) => !p.conceptsAt) || pages[0];
    if (page) {
      try {
        const cs = await extractConcepts(ctx, page, opts);
        sample = {
          page: page.rel,
          title: page.title,
          concepts: cs.slice(0, 6).map((x) => ({ term: x.term, definition: x.definition })),
        };
      } catch (e) {
        sampleError = String((e && e.message) || e).slice(0, 300);
      }
    }
  }

  return { ok: true, root: probe.root, flavor: probe.flavor, warnings: probe.warnings, probe, scope, pages: pages.length, sample, sampleError };
}

// ---------- 路由 ----------

function registerLearnRoutes(router, ctx) {
  router.add('GET', '/api/learn/status', (c) => {
    sendJSON(c.res, 200, status(ctx));
  });

  // 初始化向导：探测陌生目录（只读，不写配置）
  router.add('POST', '/api/learn/probe', (c) => {
    const body = c.body || {};
    sendJSON(c.res, 200, probeRoot(String(body.root || '')));
  });

  // v2.9.59 查看原文（只读）：材料里点「查看原文」时拉本地 md
  router.add('GET', '/api/learn/source', (c) => {
    const page = (c.query && typeof c.query.get === 'function' && c.query.get('page')) || '';
    sendJSON(c.res, 200, readSource(ctx, page));
  });

  // v2.9.56 导入器：pdf/docx/html/md/txt → 本地学习库（不写用户知识库）
  router.add('POST', '/api/learn/import/preview', (c) => {
    sendJSON(c.res, 200, previewImport((c.body && c.body.path) || ''));
  });

  router.add('POST', '/api/learn/import', (c) => {
    sendJSON(c.res, 200, importMaterials(ctx, (c.body && c.body.path) || ''));
  });

  // 初始化向导：确认后一步落盘 + 建索引 + 试抽预览
  router.add('POST', '/api/learn/init', async (c) => {
    sendJSON(c.res, 200, await initLearn(ctx, c.body || {}));
  });

  // 注意：todayQueue 是 async（出题前可能按需抽一页知识点），必须 await，否则会返回 Promise 序列化成的 {}
  router.add('GET', '/api/learn/today', async (c) => {
    sendJSON(c.res, 200, await todayQueue(ctx));
  });

  router.add('POST', '/api/learn/scan', (c) => {
    const scanned = scanVault(ctx);
    const pages = syncPages(ctx, scanned);
    sendJSON(c.res, 200, { ok: true, root: scanned.root, pages: pages.length, at: scanned.scannedAt });
  });

  router.add('GET', '/api/learn/items', (c) => {
    const items = loadItems(ctx);
    const schedule = loadSchedule(ctx);
    sendJSON(c.res, 200, items.map((it) => Object.assign(publicItem(it), {
      level: (schedule[it.id] && schedule[it.id].level) || 0,
      dueAt: (schedule[it.id] && schedule[it.id].dueAt) || null,
      needsRewrite: it.needsRewrite === true || (schedule[it.id] && schedule[it.id].needsRewrite === true),
      excluded: it.excluded === true,
    })));
  });

  router.add('POST', '/api/learn/items/:id/exclude', (c) => {
    const items = loadItems(ctx);
    const it = items.find((x) => x.id === c.params.id);
    if (!it) throw new HttpError(404, 'LEARN_ITEM_NOT_FOUND', '条目不存在');
    it.excluded = !it.excluded;
    saveJSON(ctx, 'items.json', { items, updatedAt: new Date().toISOString() });
    sendJSON(c.res, 200, { ok: true, id: it.id, excluded: it.excluded });
  });

  router.add('POST', '/api/learn/session', (c) => {
    const body = c.body || {};
    sendJSON(c.res, 200, stripInternal(createSession(ctx, body.itemId)));
  });

  router.add('POST', '/api/learn/session/:id/turn', async (c) => {
    const body = c.body || {};
    const out = await turn(ctx, c.params.id, String(body.stage || ''), body.text);
    sendJSON(c.res, 200, out);
  });

  router.add('POST', '/api/learn/session/:id/finish', (c) => {
    const body = c.body || {};
    sendJSON(c.res, 200, finishSession(ctx, c.params.id, body.level, undefined));
  });
}

module.exports = {
  LADDER,
  DECAY_DAYS,
  validateRoot,
  probeRoot,
  initLearn,
  previewImport,
  importMaterials,
  readSource,
  scopeDirs,
  stripFrontmatter,
  makeDigest,
  scanVault,
  syncPages,
  loadPages,
  loadItems,
  saveItems,
  extractConcepts,
  ensureFreshConcepts,
  materializeSeeds,
  conceptMaterial,
  loadSchedule,
  loadSessions,
  applyReview,
  nextInterval,
  pickDaily,
  createSession,
  turn,
  finishSession,
  status,
  todayQueue,
  registerLearnRoutes,
  itemId,
};

/** 当前实例加载的版本 vs 仓库磁盘上的版本（不一致 = 需要重启） */
function versionInfo(ctx) {
  const loaded = String((ctx && ctx.version) || '');
  let disk = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ctx.rootDir || process.cwd(), 'package.json'), 'utf8'));
    disk = String(pkg.version || '');
  } catch (e) {
    disk = '';
  }
  return { loaded, disk, stale: !!(loaded && disk && loaded !== disk) };
}
