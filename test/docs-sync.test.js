'use strict';

/**
 * docs-sync.test.js — 文档即断言（docs-as-tests）
 *
 * 把 AGENTS.md 第五章「文档同步纪律」中可机器判定的条目固化为测试：漏同步 → 测试红。
 * 设计：docs/proposals/PROPOSAL-docs-as-tests.md。思路源自 DeepSeek dsh-superagent-prototype
 * 的 tests/docs.spec.ts（精读见 docs/reviews/REVIEW-superagent-architecture.md §7），按本仓裁剪。
 *
 * 性质：纯读仓库文件——零出网、零写入、零依赖（红线 1）；路径锚定本文件位置，不依赖 CWD。
 *
 * 断言组：
 *   A 版本口径（package.json ↔ README.zh-CN / DISTRIBUTION / SPEC 变更记录 / engines.node）
 *   B files 白名单 ↔ 磁盘双向
 *   C locale 双语词典（meta 完整 + 顶层键集一致）
 *   D API 契约 ↔ 路由注册双向（注册面 ↔ SPEC §3）
 *   E 文档互链可达（README* + AGENTS.md + docs/**）
 *   F 反精确测试计数（用户面文档禁写死计数，SPEC 历史条目豁免）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const pkg = JSON.parse(read('package.json'));
const VERSION = pkg.version;

// ---------- A 版本口径 ----------

test('A1: README.zh-CN.md「当前版本」行与 package.json 一致', () => {
  // arrange/act
  const md = read('README.zh-CN.md');
  const m = md.match(/当前版本\s+v?(\d+\.\d+\.\d+)/);
  // assert
  assert.ok(m, '[docs-sync] README.zh-CN.md 缺「当前版本 vX.Y.Z」行 —— 补版本行（AGENTS.md 五）');
  assert.equal(
    m[1], VERSION,
    `[docs-sync] README.zh-CN.md 当前版本 v${m[1]} ≠ package.json ${VERSION} —— 同步版本行（AGENTS.md 五）`
  );
});

test('A2: DISTRIBUTION.md 兼容矩阵插件版本行与 package.json 一致', () => {
  const md = read('docs/DISTRIBUTION.md');
  const line = md.split('\n').find((l) => l.includes('与 package.json 同步'));
  assert.ok(line, '[docs-sync] docs/DISTRIBUTION.md 缺「与 package.json 同步」版本行 —— 兼容矩阵补插件版本行');
  const m = line.match(/(\d+\.\d+\.\d+)/);
  assert.ok(m, '[docs-sync] docs/DISTRIBUTION.md 兼容矩阵版本行无版本号');
  assert.equal(
    m[1], VERSION,
    `[docs-sync] DISTRIBUTION.md 兼容矩阵插件版本 ${m[1]} ≠ package.json ${VERSION} —— 同步（该行自称"与 package.json 同步"）`
  );
});

test('A3: SPEC.md 头部变更记录含当前版本条目', () => {
  const md = read('docs/SPEC.md');
  assert.ok(
    md.includes(`> v${VERSION} 变更`),
    `[docs-sync] docs/SPEC.md 头部变更记录缺「> v${VERSION} 变更」条目 —— 版本 bump 必须带变更记录（AGENTS.md 五）`
  );
});

test('A4: Node 门槛口径两处一致（package.json engines ↔ DISTRIBUTION）', () => {
  assert.ok(
    /22\.13/.test((pkg.engines && pkg.engines.node) || ''),
    '[docs-sync] package.json engines.node 未声明 node:sqlite 门槛 22.13（AGENTS.md 红线 1）'
  );
  const md = read('docs/DISTRIBUTION.md');
  assert.ok(
    md.includes('≥22.13'),
    '[docs-sync] docs/DISTRIBUTION.md 缺「≥22.13」口径 —— node:sqlite 门槛（AGENTS.md 红线 1）'
  );
  assert.ok(
    md.includes('18/20 不可用'),
    '[docs-sync] docs/DISTRIBUTION.md 缺「Node 18/20 不可用」口径 —— 防旧「Node ≥18」口径回潮（AGENTS.md 红线 1）'
  );
});

// ---------- B files 白名单 ↔ 磁盘双向 ----------

// 已知运行时面：每一项为何必须进 files 白名单（缺一项 = 发布包缺文件）。
const KNOWN_RUNTIME = [
  'plugin/',                      // ESM 入口 plugin/index.mjs（宿主加载唯一入口）
  'lib/',                         // 后端业务层（CJS，createRequire 桥接进 ESM 入口）
  'web/',                         // 前端 SPA（webDir 指向，资产随代码走）
  'locale/',                      // meta.title/description 词典（缺=插件行回落技术名 fde-console）
  'assets/',                      // icon.svg（插件页展示）
  'cordis.patch.yml',             // dsh.bundle.patch 指向的宿主补丁
  'scripts/migrate-data.js',      // 老独立版→插件数据迁移 CLI（SPEC-PLUGIN）
  'test/helpers/appAssembler.js', // 装配器被运行时引用、尚未迁出 test/（SPEC-PLUGIN 7.4）
];

test('B1: package.json files 白名单每一项在仓库根存在', () => {
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, '[docs-sync] package.json 缺 files 白名单');
  for (const entry of pkg.files) {
    assert.ok(
      exists(entry),
      `[docs-sync] files 白名单项 "${entry}" 在仓库根不存在 —— 打包会缺文件，修正白名单`
    );
  }
});

test('B2: 已知运行时面全部在 files 白名单内', () => {
  for (const entry of KNOWN_RUNTIME) {
    assert.ok(
      pkg.files.includes(entry),
      `[docs-sync] 运行时面 "${entry}" 不在 package.json files 白名单 —— 发布包将缺该文件（SPEC-PLUGIN 第七章）`
    );
  }
});

// ---------- C locale 双语词典 ----------

test('C: locale 双语词典 meta 完整且顶层键集一致', () => {
  const en = JSON.parse(read('locale/en.json'));
  const zh = JSON.parse(read('locale/zh.json'));
  for (const [lang, dict] of [['en', en], ['zh', zh]]) {
    assert.ok(
      dict.meta && String(dict.meta.title || '').trim(),
      `[docs-sync] locale/${lang}.json meta.title 缺失或为空 —— 插件行会回落技术名 fde-console（AGENTS.md 五）`
    );
    assert.ok(
      dict.meta && String(dict.meta.description || '').trim(),
      `[docs-sync] locale/${lang}.json meta.description 缺失或为空`
    );
  }
  assert.deepEqual(
    Object.keys(en).sort(), Object.keys(zh).sort(),
    '[docs-sync] locale/en.json 与 zh.json 顶层键集不一致 —— 词典只增不改、两边同步（AGENTS.md 五）'
  );
});

// ---------- D API 契约 ↔ 路由注册双向 ----------

// 注册面：lib/*.js、plugin/index.mjs、test/helpers/appAssembler.js
// （装配器是路由注册点之一且尚未迁出 test/，见 SPEC-PLUGIN 7.4）。
// 契约面：docs/SPEC.md §3「REST API 契约」。
// 有意不入契约文档的路由登记在 UNDOCUMENTED_OK——每条必须带理由注释，无理由即测试红。

const ROUTE_SURFACES = ['lib', 'plugin/index.mjs', 'test/helpers/appAssembler.js'];

function extractRegisteredRoutes() {
  const routes = []; // { method, path, file }
  const re = /\.add\(\s*['"]([A-Z]+)['"]\s*,\s*['"](\/api\/[^'"]+)['"]/g;
  const files = [];
  for (const surface of ROUTE_SURFACES) {
    const abs = path.join(ROOT, surface);
    if (fs.statSync(abs).isDirectory()) {
      for (const f of fs.readdirSync(abs).sort()) {
        if (f.endsWith('.js')) files.push(path.join(abs, f));
      }
    } else {
      files.push(abs);
    }
  }
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      routes.push({ method: m[1], path: m[2], file: path.relative(ROOT, file) });
    }
  }
  return routes;
}

function extractSpecRoutes() {
  const md = read('docs/SPEC.md');
  const head = md.split(/^## 4\./m)[0]; // 截到 §3（含），避免拿 §4 之后的正文
  const start = head.indexOf('## 3. REST API 契约');
  const scope = start >= 0 ? head.slice(start) : '';
  const out = [];
  const re = /`([A-Z]+) (\/api\/[^`\s]+)`/g;
  for (const m of scope.matchAll(re)) out.push(`${m[1]} ${m[2]}`);
  return out;
}

// 归一化：去 query 串、去尾斜杠、:param 段名折算为 :p（两侧同规则，参数命名差异不误报）
const normPath = (p) => p.split('?')[0].replace(/\/+$/, '').replace(/:[^/]+/g, ':p');
const routeKey = (method, p) => `${method} ${normPath(p)}`;

// 有意暂不进 SPEC §3 契约文档的路由（键 = 'METHOD /api/path'，归一化后比对）。
// 棘轮纪律（2026-11-03 措辞修订，评审 P2「首日自破」）：存量挂账**只减不增**（补写 §3 即摘除）；
// **新路由**允许带理由登记入组（机制即为此设——新端点上线先行挂账、契约补写随后摘除），
// 但同批必须更新组注释说明；严禁无理由追加。
// 存量背景：§3 写于 v1/v2.0 核心 CRUD 时代（现覆盖 16/65 条），v2.9 系端点仅记录于
// SPEC 头部变更记录。补写 §3 完整契约是登记债务（docs/BACKLOG.md），此处逐组挂账防新债。
const UNDOCUMENTED_OK = new Set([
  // —— 智能体动态 / 会话阅读器（v2.9.14+，契约描述见 SPEC 头部变更记录 v2.9.14/31/61/66）——
  'GET /api/agent-activity',
  'GET /api/agent-sessions',
  'GET /api/agent-session',
  'GET /api/agent-dispatch',
  // —— 任务雷达（v2.9.13+；粘贴转写 v2.9.28；删除即忽略+过滤 v2.9.63；飞书妙记通道 2026-11-03）——
  'POST /api/radar/analyze',
  'GET /api/radar/analyze/:p',
  'POST /api/radar/text',
  'POST /api/radar/sync',
  'POST /api/radar/sync/feishu',
  'GET /api/radar/messages',
  'GET /api/radar/messages/:p',
  'DELETE /api/radar/messages/:p',
  'GET /api/radar/engine',
  'POST /api/radar/engine/test',
  'GET /api/radar/jobs/:p',
  'GET /api/radar/ignore',
  'POST /api/radar/ignore',
  'DELETE /api/radar/ignore/messages/:p',
  // —— 收件箱 / 成员册别名 / 会话归因建议 / 工作搜索 / 热力图 / 复盘 / Scorecard ——
  'GET /api/inbox',
  'POST /api/inbox/confirm-merged',
  'POST /api/members/:p/aliases',
  'GET /api/members/source-health', // 桌面源健康探针（2026-11-03 评审尾巴：单源故障静默缺席的可见性）
  'GET /api/tasks/:p/session-suggestions',
  'GET /api/work-search',
  'GET /api/agent-heatmap',
  'GET /api/tasks/:p/postmortem',
  'GET /api/scorecard/:p',
  // —— 知识库学习（v2.9.44+，功能契约见 docs/SPEC-LEARN.md）——
  'GET /api/learn/status',
  'POST /api/learn/probe',
  'GET /api/learn/source',
  'POST /api/learn/import/preview',
  'POST /api/learn/import',
  'POST /api/learn/init',
  'GET /api/learn/today',
  'POST /api/learn/scan',
  'GET /api/learn/items',
  'POST /api/learn/items/:p/exclude',
  'POST /api/learn/session',
  'POST /api/learn/session/:p/turn',
  'POST /api/learn/session/:p/finish',
  // —— 备份（v2.9.41）/ IM 通道测试（v2.9.39）/ 环境体检 / 仓库清单 / 数据源连接测试 ——
  'GET /api/backup/list',
  'POST /api/backup/now',
  'POST /api/backup/restore',
  'POST /api/im/test',
  'GET /api/setup/check',
  'GET /api/repos',
  'POST /api/sources/test',
  // —— 任务成果挂接（v1.x，语义见 §3 归因小节）/ 插件自省（plugin/index.mjs）——
  'POST /api/tasks/:p/artifacts',
  'DELETE /api/tasks/:p/artifacts/:p',
  'GET /api/ping',
  'GET /api/instance',
]);

test('D1: 每个注册路由都有 SPEC §3 契约条目（或白名单登记）', () => {
  const spec = new Set(extractSpecRoutes().map((k) => routeKey(...k.split(' '))));
  const missing = [];
  for (const r of extractRegisteredRoutes()) {
    const key = routeKey(r.method, r.path);
    if (!spec.has(key) && !UNDOCUMENTED_OK.has(key)) missing.push(`${r.method} ${r.path}（注册于 ${r.file}）`);
  }
  assert.deepEqual(
    missing, [],
    `[docs-sync] 以下路由未入 docs/SPEC.md §3 契约、也未在 UNDOCUMENTED_OK 登记理由：\n  ${missing.join('\n  ')}`
  );
});

test('D2: SPEC §3 每条契约都能找到路由注册', () => {
  const code = new Set(extractRegisteredRoutes().map((r) => routeKey(r.method, r.path)));
  const stale = [];
  for (const raw of extractSpecRoutes()) {
    const key = routeKey(...raw.split(' '));
    if (!code.has(key)) stale.push(raw);
  }
  assert.deepEqual(
    stale, [],
    `[docs-sync] SPEC §3 以下契约已无对应路由注册（实现删除但文档未同步）：\n  ${stale.join('\n  ')}`
  );
});

// ---------- E 文档互链可达 ----------

function listMarkdownFiles() {
  const files = ['README.md', 'README.zh-CN.md', 'AGENTS.md'];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, f.name);
      if (f.isDirectory()) walk(abs);
      else if (f.name.endsWith('.md')) files.push(path.relative(ROOT, abs));
    }
  };
  walk(path.join(ROOT, 'docs'));
  return files;
}

test('E: README/AGENTS/docs 所有相对 markdown 链接指向存在的文件', () => {
  const broken = [];
  for (const doc of listMarkdownFiles()) {
    // 剥掉围栏代码块与行内代码再扫（代码/正则示例里的 [x](y) 形态不是真链接）
    const md = read(doc).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    for (const m of md.matchAll(re)) {
      const raw = m[1];
      if (/^(https?:|mailto:|#)/i.test(raw)) continue;
      const noAnchor = raw.split('#')[0];
      if (!noAnchor) continue;
      let target;
      try { target = decodeURIComponent(noAnchor); } catch { target = noAnchor; } // 中文路径 URL 编码
      const abs = path.resolve(path.dirname(path.join(ROOT, doc)), target);
      if (!fs.existsSync(abs)) broken.push(`${doc} → ${raw}`);
    }
  }
  assert.deepEqual(
    broken, [],
    `[docs-sync] 以下相对链接指向不存在的文件：\n  ${broken.join('\n  ')}`
  );
});

// ---------- F 反精确测试计数 ----------

// AGENTS.md 三：「测试计数不写死在文档（写「300+」），防漂移」。
// 用户面文档禁精确计数；SPEC 历史变更条目豁免（当时的数字是历史事实）。
const COUNT_DOCS = ['README.md', 'README.zh-CN.md', 'docs/DISTRIBUTION.md'];
const COUNT_PATTERNS = [
  [/全量\s*\d+\s*绿/, '「全量 N 绿」'],
  [/\d+\s*(?:例|个)\s*(?:测试|用例)/, '「N 例/个 测试/用例」'],
  [/\d+\s+tests?\b/, '「N test(s)」（英文精确计数；「300+ tests」不命中）'],
];

test('F: 用户面文档不写死精确测试计数', () => {
  const hits = [];
  for (const doc of COUNT_DOCS) {
    const md = read(doc);
    for (const [re, label] of COUNT_PATTERNS) {
      if (re.test(md)) hits.push(`${doc} 命中 ${label}`);
    }
  }
  assert.deepEqual(
    hits, [],
    `[docs-sync] 用户面文档禁写死精确测试计数（写「300+」防漂移，AGENTS.md 三）：\n  ${hits.join('\n  ')}`
  );
});
