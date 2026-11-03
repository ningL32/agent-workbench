'use strict';

/**
 * diary.test.js — v2.7 任务日报
 * 覆盖：日报 CRUD（GET 倒序 / PUT upsert 201+200 / DELETE 204+404）、唯一键 taskId+date
 *       （同日覆盖不重复发事件；跨任务同日互不干扰）、日期校验（格式/日历回读/prefill 缺省今天）、
 *       prefill 两数据源（Gitea commit 按 branch 精确 + repo 兜底 + 日期过滤 + 伪协议剔除；
 *       memo 事件拆 quote/note + 跨日排除 + 畸形 detail 兜底）、draft 拼装（两块皆空为空串）、
 *       成员 diaryToday 联动（进行中+当天有日报 true / 无日报 false / done false）、
 *       删任务顺带清理日报、原子写（无 .tmp 残留）。
 * 运行：node --test test/diary.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7797; // 仅作 fixture 配置留痕（进程内装配不再监听端口）

const { buildApp } = require('./helpers/appAssembler');
const diary = require('../lib/diary');

let app;
let tmpDir;
let dataDir;

const pad2 = (x) => String(x).padStart(2, '0');
function ymdLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** 本地某日某时刻的 ISO8601（UTC 表示）——与服务器「本地日」口径对齐，跨时区可复现 */
function isoAtLocal(ymd, h, min) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, h, min, 0).toISOString();
}

const TODAY = ymdLocal(new Date());
const OTHER_DAY = '2026-01-02'; // 固定历史日期（跨日排除用例）

async function api(method, p, body, headers = {}) {
  return app.fetch(method, p, {
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function seedData(file, obj) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, file), JSON.stringify(obj, null, 2));
}

function readDiaryFile() {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'diary.json'), 'utf8'));
}

function eventsFile() {
  const d = JSON.parse(fs.readFileSync(path.join(dataDir, 'task_events.json'), 'utf8'));
  return Array.isArray(d) ? d : d.events;
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-diary-'));
  dataDir = path.join(tmpDir, 'data');
  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({
      port: PORT,
      host: '127.0.0.1',
      dataDir,
      webDir: path.join(tmpDir, 'web'),
      gitea: { pollIntervalSec: 0 },
    })
  );
  app = buildApp({ configPath: path.join(tmpDir, 'config.json') });

  // ---- 预填数据源种子（临时 dataDir，只动测试自己的副本）----
  seedData('activities.json', [
    {
      id: 'a-1',
      type: 'commit_pushed',
      actor: 'agent-kilo',
      repo: 'example-org/fde-api',
      branch: 'feat/sso',
      title: 'feat: SSO 登录',
      sha: 'abc123def456',
      messageBody: '',
      url: 'https://gitea.example/example-org/fde-api/commit/abc123def456',
      occurredAt: isoAtLocal(TODAY, 10, 30), // 今天
      fetchedAt: new Date().toISOString(),
    },
    {
      id: 'a-2',
      type: 'commit_pushed',
      actor: 'agent-kilo',
      repo: 'example-org/fde-api',
      branch: 'feat/sso',
      title: 'feat: 昨天的提交',
      sha: 'ffff0000',
      messageBody: '',
      url: 'https://gitea.example/example-org/fde-api/commit/ffff0000',
      occurredAt: isoAtLocal(OTHER_DAY, 9, 0), // 非今天
      fetchedAt: new Date().toISOString(),
    },
    {
      id: 'a-3',
      type: 'commit_pushed',
      actor: 'agent-mcode',
      repo: 'example-org/demo-hub',
      branch: null, // 存量动态无分支 → 只能靠 repo 兜底命中
      title: '[demo-team] Update session stats',
      sha: null,
      messageBody: '',
      url: 'https://gitea.example/example-org/demo-hub/commit/deadbeef',
      occurredAt: isoAtLocal(TODAY, 11, 0),
      fetchedAt: new Date().toISOString(),
    },
    {
      id: 'a-4',
      type: 'commit_pushed',
      actor: 'agent-kilo',
      repo: 'example-org/fde-api',
      branch: 'feat/sso',
      title: 'javascript: 提交（伪协议应剔除）',
      sha: 'bad0bad0',
      messageBody: '',
      url: 'javascript:alert(1)',
      occurredAt: isoAtLocal(TODAY, 12, 0),
      fetchedAt: new Date().toISOString(),
    },
  ]);
  seedData('task_events.json', [
    { id: 'e-1', taskId: 'TBD', type: 'created', from: null, to: 'todo', detail: '手工创建', at: isoAtLocal(TODAY, 8, 0) },
    {
      id: 'e-2',
      taskId: 'TBD',
      type: 'memo',
      from: null,
      to: null,
      detail: '纪要《日报方案评审》：每日过程需要留痕，先做最小切片',
      at: isoAtLocal(TODAY, 9, 15), // 今天
    },
    {
      id: 'e-3',
      taskId: 'TBD',
      type: 'memo',
      from: null,
      to: null,
      detail: '纪要《上次的会》：那天讨论过旧方案',
      at: isoAtLocal(OTHER_DAY, 15, 0), // 非今天
    },
    {
      id: 'e-4',
      taskId: 'TBD',
      type: 'memo',
      from: null,
      to: null,
      detail: '不合形态的旧数据', // 无《》包裹 → 兜底 quote=detail、note=''
      at: isoAtLocal(TODAY, 9, 50),
    },
  ]);
  seedData('gitea-members.json', [
    { login: 'alice', full_name: 'Alice', name: 'Alice' },
    { login: 'bob', full_name: 'Bob', name: 'Bob' },
    { login: 'carol', full_name: 'Carol', name: 'Carol' },
  ]);
});

test.after(() => {
  if (app) app.close();
});

// ---------- CRUD 与唯一键 ----------

test('PUT 首存 201 + 事件流 type:diary（detail=日报 <date>，to=date）', async () => {
  const t = await api('POST', '/api/tasks', { title: '多日任务A' });
  const r = await api('PUT', `/api/tasks/${t.body.id}/diary`, { date: TODAY, content: '今天完成 SSO 联调' });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(
    { taskId: r.body.taskId, date: r.body.date, content: r.body.content },
    { taskId: t.body.id, date: TODAY, content: '今天完成 SSO 联调' }
  );
  assert.match(r.body.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  const detail = await api('GET', `/api/tasks/${t.body.id}`);
  const diaryEvents = detail.body.events.filter((e) => e.type === 'diary');
  assert.strictEqual(diaryEvents.length, 1);
  assert.strictEqual(diaryEvents[0].detail, `日报 ${TODAY}`);
  assert.strictEqual(diaryEvents[0].to, TODAY);
});

test('PUT 同日重写 200：内容覆盖、updatedAt 刷新、事件不重复发', async () => {
  const t = await api('POST', '/api/tasks', { title: '多日任务B' });
  const id = t.body.id;
  const r1 = await api('PUT', `/api/tasks/${id}/diary`, { date: TODAY, content: '初稿' });
  assert.strictEqual(r1.status, 201);
  const before = r1.body.updatedAt;
  const r2 = await api('PUT', `/api/tasks/${id}/diary`, { date: TODAY, content: '定稿版' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.content, '定稿版');
  assert.ok(r2.body.updatedAt >= before);
  const detail = await api('GET', `/api/tasks/${id}`);
  assert.strictEqual(detail.body.events.filter((e) => e.type === 'diary').length, 1, '同日重写不重复发事件');
  const list = await api('GET', `/api/tasks/${id}/diary`);
  assert.strictEqual(list.body.length, 1, '唯一键 taskId+date：同日只有一条');
});

test('PUT 不同日期 201：同任务多日并存；跨任务同日互不干扰（唯一键二元组）', async () => {
  const a = await api('POST', '/api/tasks', { title: '多日任务C' });
  const b = await api('POST', '/api/tasks', { title: '多日任务D' });
  await api('PUT', `/api/tasks/${a.body.id}/diary`, { date: OTHER_DAY, content: 'A 的旧日报' });
  await api('PUT', `/api/tasks/${b.body.id}/diary`, { date: OTHER_DAY, content: 'B 的旧日报' });
  const la = await api('GET', `/api/tasks/${a.body.id}/diary`);
  assert.strictEqual(la.body.length, 1);
  assert.strictEqual(la.body[0].content, 'A 的旧日报');
  const lb = await api('GET', `/api/tasks/${b.body.id}/diary`);
  assert.strictEqual(lb.body.length, 1);
  assert.strictEqual(lb.body[0].content, 'B 的旧日报');
});

test('GET 日报按日期倒序；只含本任务条目', async () => {
  const t = await api('POST', '/api/tasks', { title: '多日任务E' });
  const id = t.body.id;
  await api('PUT', `/api/tasks/${id}/diary`, { date: '2026-01-01', content: '旧' });
  await api('PUT', `/api/tasks/${id}/diary`, { date: TODAY, content: '新' });
  await api('PUT', `/api/tasks/${id}/diary`, { date: '2026-06-01', content: '中' });
  const r = await api('GET', `/api/tasks/${id}/diary`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.map((x) => x.date), [TODAY, '2026-06-01', '2026-01-01']);
  assert.ok(r.body.every((x) => x.taskId === id));
});

test('DELETE 204 → 列表移除；重复删 404 DIARY_NOT_FOUND；路径日期非法 400', async () => {
  const t = await api('POST', '/api/tasks', { title: '多日任务F' });
  const id = t.body.id;
  await api('PUT', `/api/tasks/${id}/diary`, { date: OTHER_DAY, content: '待删' });
  const del = await api('DELETE', `/api/tasks/${id}/diary/${OTHER_DAY}`);
  assert.strictEqual(del.status, 204);
  assert.strictEqual(del.text, '');
  const list = await api('GET', `/api/tasks/${id}/diary`);
  assert.deepStrictEqual(list.body, []);
  const again = await api('DELETE', `/api/tasks/${id}/diary/${OTHER_DAY}`);
  assert.strictEqual(again.status, 404);
  assert.strictEqual(again.body.error.code, 'DIARY_NOT_FOUND');
  const bad = await api('DELETE', `/api/tasks/${id}/diary/2026-02-30`);
  assert.strictEqual(bad.status, 400);
});

test('PUT 校验：date 缺失/格式/日历溢出 400；content 缺失/空白/超长 400', async () => {
  const t = await api('POST', '/api/tasks', { title: '多日任务G' });
  const p = `/api/tasks/${t.body.id}/diary`;
  const cases = [
    [{ content: '无日期' }, 'date 缺失'],
    [{ date: '20260101', content: 'x' }, 'date 格式'],
    [{ date: '2026-13-99', content: 'x' }, 'date 溢出'],
    [{ date: TODAY }, 'content 缺失'],
    [{ date: TODAY, content: '' }, 'content 空'],
    [{ date: TODAY, content: '   \n  ' }, 'content 纯空白'],
    [{ date: TODAY, content: 'x'.repeat(2001) }, 'content 超长'],
    [{ date: TODAY, content: 123 }, 'content 非字符串'],
  ];
  for (const [body, label] of cases) {
    const r = await api('PUT', p, body);
    assert.strictEqual(r.status, 400, `用例 ${label} 应 400`);
    assert.strictEqual(r.body.error.code, 'FIELD_INVALID', `用例 ${label} 错误码`);
    assert.match(r.body.error.message, /date|content/);
  }
});

test('任务不存在：GET/PUT/DELETE/prefill 一律 404 TASK_NOT_FOUND', async () => {
  assert.strictEqual((await api('GET', '/api/tasks/t-nope/diary')).status, 404);
  assert.strictEqual((await api('PUT', '/api/tasks/t-nope/diary', { date: TODAY, content: 'x' })).status, 404);
  assert.strictEqual((await api('DELETE', `/api/tasks/t-nope/diary/${TODAY}`)).status, 404);
  const pf = await api('GET', '/api/tasks/t-nope/diary/prefill');
  assert.strictEqual(pf.status, 404);
  assert.strictEqual(pf.body.error.code, 'TASK_NOT_FOUND');
});

test('删任务顺带清理其全部日报；纯读（GET diary/prefill/members）不创建 diary.json', async () => {
  const t = await api('POST', '/api/tasks', { title: '多日任务H' });
  await api('PUT', `/api/tasks/${t.body.id}/diary`, { date: OTHER_DAY, content: 'x' });
  await api('PUT', `/api/tasks/${t.body.id}/diary`, { date: TODAY, content: 'y' });
  assert.strictEqual(readDiaryFile().filter((x) => x.taskId === t.body.id).length, 2);
  const del = await api('DELETE', `/api/tasks/${t.body.id}`);
  assert.strictEqual(del.status, 204);
  assert.strictEqual(readDiaryFile().filter((x) => x.taskId === t.body.id).length, 0, '删任务后日报应清理');
});

// ---------- prefill ----------

test('prefill：branch 精确命中 + 当天过滤 + 伪协议剔除；date 缺省=今天（服务器本地时区）', async () => {
  const t = await api('POST', '/api/tasks', { title: '接入SSO', branch: 'feat/sso', repo: 'example-org/fde-api' });
  const r = await api('GET', `/api/tasks/${t.body.id}/diary/prefill`); // 不带 date
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.date, TODAY, 'date 缺省应为服务器本地今天');
  assert.deepStrictEqual(
    r.body.giteaCommits.map((c) => c.sha),
    ['abc123def456'],
    '只命中今天的 feat/sso 提交（跨日排除 + 伪协议剔除）'
  );
  const c = r.body.giteaCommits[0];
  assert.strictEqual(c.title, 'feat: SSO 登录');
  assert.strictEqual(c.url, 'https://gitea.example/example-org/fde-api/commit/abc123def456');
});

test('prefill：repo 兜底命中（存量动态 branch=null）；branch 不匹配的任务不命中', async () => {
  const repoTask = await api('POST', '/api/tasks', { title: '经验库任务', repo: 'example-org/demo-hub' });
  const r = await api('GET', `/api/tasks/${repoTask.body.id}/diary/prefill?date=${TODAY}`);
  assert.deepStrictEqual(
    r.body.giteaCommits.map((c) => c.url),
    ['https://gitea.example/example-org/demo-hub/commit/deadbeef'],
    'branch=null 的当天提交按任务 repo 相等兜底命中'
  );

  const noRepoTask = await api('POST', '/api/tasks', { title: '无分支无仓库任务' });
  const r2 = await api('GET', `/api/tasks/${noRepoTask.body.id}/diary/prefill?date=${TODAY}`);
  assert.deepStrictEqual(r2.body.giteaCommits, []);

  const branchMiss = await api('POST', '/api/tasks', { title: '别的分支', branch: 'feat/other', repo: 'example-org/other' });
  const r3 = await api('GET', `/api/tasks/${branchMiss.body.id}/diary/prefill?date=${TODAY}`);
  assert.deepStrictEqual(r3.body.giteaCommits, [], 'branch/repo 都不匹配不命中');
});

test('prefill：显式 date 取其他日期 → 命中那天的提交', async () => {
  const t = await api('POST', '/api/tasks', { title: '接入SSO2', branch: 'feat/sso', repo: 'example-org/fde-api' });
  const r = await api('GET', `/api/tasks/${t.body.id}/diary/prefill?date=${OTHER_DAY}`);
  assert.strictEqual(r.body.date, OTHER_DAY);
  assert.deepStrictEqual(r.body.giteaCommits.map((c) => c.sha), ['ffff0000']);
});

test('prefill：memo 事件拆 {quote,note} + 跨日排除 + 畸形 detail 兜底', async () => {
  const t = await api('POST', '/api/tasks', { title: '带纪要的任务' });
  const id = t.body.id;
  // 把种子 memo 事件挂到本任务名下（改 taskId 落盘）
  const evs = eventsFile().map((e) => (e.type === 'memo' ? { ...e, taskId: id } : e));
  seedData('task_events.json', evs);

  const r = await api('GET', `/api/tasks/${id}/diary/prefill?date=${TODAY}`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.memoUpdates, [
    { quote: '不合形态的旧数据', note: '' },
    { quote: '每日过程需要留痕，先做最小切片', note: '日报方案评审' },
  ], '当天 memo 按 at 倒序；畸形 detail 兜底 quote=detail/note=空');

  const r2 = await api('GET', `/api/tasks/${id}/diary/prefill?date=${OTHER_DAY}`);
  assert.deepStrictEqual(r2.body.memoUpdates, [
    { quote: '那天讨论过旧方案', note: '上次的会' },
  ], '跨日 memo 只命中对应日期');
});

test('prefill：draft 拼两块；两块皆空为空串；date 非法 400', async () => {
  const withAll = await api('POST', '/api/tasks', { title: '全量任务', branch: 'feat/sso', repo: 'example-org/fde-api' });
  const id = withAll.body.id;
  const evs = eventsFile().map((e) => (e.type === 'memo' ? { ...e, taskId: id } : e));
  seedData('task_events.json', evs);
  const r = await api('GET', `/api/tasks/${id}/diary/prefill?date=${TODAY}`);
  assert.match(r.body.draft, /■ Gitea 提交（1）/);
  assert.match(r.body.draft, /- feat: SSO 登录/);
  assert.match(r.body.draft, /https:\/\/gitea\.example\/example-org\/fde-api\/commit\/abc123def456/);
  assert.match(r.body.draft, /■ 纪要摘录（2）/);
  assert.match(r.body.draft, /《日报方案评审》：每日过程需要留痕，先做最小切片/);

  const empty = await api('POST', '/api/tasks', { title: '空草稿任务' });
  const r2 = await api('GET', `/api/tasks/${empty.body.id}/diary/prefill?date=${TODAY}`);
  assert.strictEqual(r2.body.draft, '', '两块皆空 draft 应为空串');
  assert.deepStrictEqual(r2.body.giteaCommits, []);
  assert.deepStrictEqual(r2.body.memoUpdates, []);

  for (const d of ['2026-13-99', '20260101', 'not-a-date']) {
    const bad = await api('GET', `/api/tasks/${empty.body.id}/diary/prefill?date=${d}`);
    assert.strictEqual(bad.status, 400, `prefill date=${d} 应 400`);
    assert.strictEqual(bad.body.error.code, 'FIELD_INVALID');
  }
});

// ---------- 成员 diaryToday 联动 ----------

test('/api/members 增 diaryToday：进行中+当天有日报 true；无日报 false；done 任务 false；口径不变仅增字段', async () => {
  const mk = async (title, memberId) => {
    const t = await api('POST', '/api/tasks', { title, memberId });
    await api('PATCH', `/api/tasks/${t.body.id}`, { status: 'doing' });
    return t.body.id;
  };
  const tAlice = await mk('Alice 的任务', 'alice');
  await mk('Bob 的任务', 'bob'); // 无日报
  const tCarol = await mk('Carol 的任务', 'carol');
  await api('PATCH', `/api/tasks/${tCarol}`, { status: 'done' }); // done 不算进行中
  await api('PUT', `/api/tasks/${tAlice}/diary`, { date: TODAY, content: 'Alice 今天有日报' });
  await api('PUT', `/api/tasks/${tCarol}/diary`, { date: TODAY, content: 'Carol 今天有日报但任务已完成' });

  const r = await api('GET', '/api/members');
  assert.strictEqual(r.status, 200);
  const by = Object.fromEntries(r.body.map((m) => [m.id, m]));
  assert.strictEqual(by.alice.diaryToday, true, '进行中任务当天有日报 → true');
  assert.strictEqual(by.bob.diaryToday, false, '进行中任务无日报 → false（今日未填）');
  assert.strictEqual(by.carol.diaryToday, false, 'done 任务有日报也不算（非进行中）');
  // 口径不变：既有字段原样在（仅增不改）
  for (const id of ['alice', 'bob', 'carol']) {
    assert.ok(['kind', 'status', 'currentTask', 'todayCommits', 'weekDone'].every((k) => k in by[id]));
  }
  // 隔日口径：删掉今日日报、只留昨日 → 今天无日报
  await api('DELETE', `/api/tasks/${tAlice}/diary/${TODAY}`);
  await api('PUT', `/api/tasks/${tAlice}/diary`, { date: OTHER_DAY, content: '昨天的日报' });
  const r2 = await api('GET', '/api/members');
  assert.strictEqual(r2.body.find((m) => m.id === 'alice').diaryToday, false, '日报不在今天 → false');
});

// ---------- 存储纪律 ----------

test('原子写：diary.json 无 .tmp 残留，落盘为裸数组且字段四元组', async () => {
  const t = await api('POST', '/api/tasks', { title: '原子写任务' });
  await api('PUT', `/api/tasks/${t.body.id}/diary`, { date: TODAY, content: '落盘' });
  const raw = readDiaryFile();
  assert.ok(Array.isArray(raw), 'diary.json 应为裸数组');
  assert.ok(raw.every((x) => ['taskId', 'date', 'content', 'updatedAt'].every((k) => k in x)));
  const residue = fs.readdirSync(dataDir).filter((f) => f.includes('.tmp-'));
  assert.deepStrictEqual(residue, [], '不应有 .tmp 残留');
});

test('本地日历工具：localYmd/localDateOf/validateYmd（含溢出拒绝）', () => {
  const ts = new Date(2026, 9, 19, 8, 30).getTime(); // 本地 2026-10-19 08:30
  assert.strictEqual(diary.localYmd(ts), '2026-10-19');
  assert.match(diary.localYmd(), /^\d{4}-\d{2}-\d{2}$/);
  // 带时区偏移的 ISO：按 Date.parse 换算到服务器本地日，而非字符串截断
  const offsetIso = '2026-10-19T23:30:00-05:00';
  assert.strictEqual(diary.localDateOf(offsetIso), ymdLocal(new Date(Date.parse(offsetIso))));
  assert.strictEqual(diary.localDateOf('garbage'), null);
  assert.strictEqual(diary.validateYmd('2028-02-29', 'd'), '2028-02-29', '闰年合法');
  assert.throws(() => diary.validateYmd('2026-02-29', 'd'), /有效日期/, '非闰年 2-29 拒绝');
  assert.throws(() => diary.validateYmd('2026-02-30', 'd'), /有效日期/);
  assert.throws(() => diary.validateYmd('2026-1-1', 'd'), /YYYY-MM-DD/);
});

// ---------- feeds 词表回归：当天 type 'commit' 也计入 giteaCommitsFor ----------

test('prefill：feeds 新词表 type commit 当天提交同样计入 giteaCommitsFor（与存量 commit_pushed 并存）', async () => {
  // Arrange：重播种子（放文件末尾，不影响前序用例的 activities 快照）——
  // 存量 commit_pushed（a-1，今天 feat/sso）+ feeds 词表 commit（同分支当天）
  const feedsAct = {
    id: 'a-feeds-1',
    type: 'commit', // feeds 词表（giteaClient activities/feeds 数据源）
    actor: 'zhangsan',
    repo: 'example-org/fde-api',
    branch: 'feat/sso',
    title: 'feat: feeds 词表提交',
    sha: 'feedface0001',
    messageBody: '',
    url: 'https://gitea.example/example-org/fde-api/commit/feedface0001',
    occurredAt: isoAtLocal(TODAY, 14, 0), // 今天
    fetchedAt: new Date().toISOString(),
  };
  const existing = JSON.parse(fs.readFileSync(path.join(dataDir, 'activities.json'), 'utf8'));
  seedData('activities.json', [...existing, feedsAct]);

  // Act
  const t = await api('POST', '/api/tasks', { title: 'feeds词表任务', branch: 'feat/sso', repo: 'example-org/fde-api' });
  const r = await api('GET', `/api/tasks/${t.body.id}/diary/prefill?date=${TODAY}`);

  // Assert：feeds 词表 commit 与存量 commit_pushed 同日并存皆命中
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(
    r.body.giteaCommits.map((c) => c.sha).sort(),
    ['abc123def456', 'feedface0001'].sort(),
    'type commit 与 commit_pushed 同日均计入 prefill'
  );
  const feedsHit = r.body.giteaCommits.find((c) => c.sha === 'feedface0001');
  assert.strictEqual(feedsHit.title, 'feat: feeds 词表提交');
  assert.strictEqual(feedsHit.url, 'https://gitea.example/example-org/fde-api/commit/feedface0001');
});
