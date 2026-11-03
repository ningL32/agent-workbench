'use strict';

/**
 * session-suggest.test.js — v2.9.24 会话归因建议：候选池/打分/闸门/幂等/端点/闭环
 *
 * 覆盖：
 *  - 未绑定项目 → items:[] 零扫描（不触源）
 *  - 项目过滤圈候选：同项目入池、他项目出局；已挂 sessionRef 幂等出局
 *  - 打分规则（逐信号）：时间窗 +2 / 近期 +1 / commit 桥 ±24h +2 / 派工词存在 +1；
 *    完成后活跃 -3 且低于阈值被闸门滤除；远早于创建 -2 同样滤除
 *  - 理由数组 reasons 逐条可读（前端展示用）
 *  - 端点：404 TASK_NOT_FOUND / 200 形状 / 建议 ref 走既有 POST artifacts 201 闭环
 * 纪律：全合成夹具 + 临时目录零出网；新文件不用 node:sqlite（AGENTS.md 坑 5）——会话走
 * claude 文件源；建议调用带 freshIndex 求确定性（模块级索引缓存不跨用例泄漏）；
 * before 一次性建齐全部夹具再跑用例（端点层无 freshIndex 走 TTL 缓存也不串数据）。
 * 运行：node --test test/session-suggest.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sessionRef = require('../lib/sessionRef');
const { suggestSessionsForTask, scoreCandidate, SCORE_THRESHOLD } = require('../lib/sessionSuggest');
const { textScore } = require('../lib/sessionSuggest');

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

let tmpRoot;
let dataDir;
let claudeRoot;
const REF = {}; // 夹具会话 ref 表

function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function write(file, content, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (Number.isFinite(mtimeMs)) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

/** claude 会话夹具：首条 user 文本=派工词；assistant 行带 cwd（readTail 抓 projectId）；mtime=lastActiveAt */
function claudeSession(key, dirName, file, firstText, mtimeMs, cwd) {
  const p = mk(path.join(claudeRoot, dirName));
  write(
    path.join(p, file),
    JSON.stringify({ type: 'user', timestamp: new Date(mtimeMs).toISOString(), message: { role: 'user', content: firstText } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, cwd }) + '\n',
    mtimeMs
  );
  REF[key] = sessionRef.encodeRef({ s: 'claude', k: 'project', v: { dir: dirName, file } });
}

const cfg = () => ({ dataDir, agentActivity: { enabled: true, sources: { claude: { root: claudeRoot } } } });
const ctxOf = () => ({ tasksPath: path.join(dataDir, 'tasks.json'), config: cfg() });

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-sugsess-'));
  dataDir = mk(path.join(tmpRoot, 'data'));
  claudeRoot = mk(path.join(tmpRoot, 'claude', 'projects'));

  // 会话夹具：同项目 C:\proj\sg 四条 + 他项目一条
  claudeSession('already', 'proj-sg', 'aaaaaaaa-0000-0000-0000-000000000001.jsonl', '已挂过的会话不要重推', NOW - 2 * HOUR, 'C:\\proj\\sg');
  claudeSession('window', 'proj-sg', 'aaaaaaaa-0000-0000-0000-000000000002.jsonl', '修一下搜索的高亮逻辑', NOW - 2 * HOUR, 'C:\\proj\\sg');
  claudeSession('afterDone', 'proj-sg', 'aaaaaaaa-0000-0000-0000-000000000003.jsonl', '完成后才跑的下一个活', NOW - 30 * MIN, 'C:\\proj\\sg');
  claudeSession('tooOld', 'proj-sg', 'aaaaaaaa-0000-0000-0000-000000000004.jsonl', '任务创建之前的旧会话', NOW - 30 * DAY, 'C:\\proj\\sg');
  claudeSession('other', 'proj-other', 'aaaaaaaa-0000-0000-0000-000000000005.jsonl', '别的项目的会话', NOW - 60 * MIN, 'C:\\proj\\other');

  // 任务夹具
  writeJSON(path.join(dataDir, 'tasks.json'), {
    columns: [
      { id: 'todo', name: '待办' },
      { id: 'doing', name: '进行中' },
      { id: 'done', name: '已完成' },
    ],
    tasks: [
      {
        id: 't-sug-1',
        title: '搜索高亮优化',
        desc: '结果行关键词高亮',
        status: 'doing',
        projectDir: 'C:\\proj\\sg',
        createdAt: new Date(NOW - 10 * DAY).toISOString(),
        updatedAt: new Date(NOW - MIN).toISOString(),
        artifacts: [
          // commit 桥：与 window 会话同时刻（|diff|=0 ≤24h）
          { url: 'https://gitea/commit/b1', kind: 'commit', repo: 'example-org/x', ref: 'main', at: new Date(NOW - 2 * HOUR).toISOString(), title: 'fix: 高亮', messageBody: '' },
          // 幂等：already 会话已挂
          { url: null, kind: 'session', repo: null, ref: null, sessionRef: REF.already, title: '已挂过的会话不要重推', at: new Date(NOW - HOUR).toISOString() },
        ],
      },
      { id: 't-sug-2', title: '未绑定项目任务', status: 'todo', createdAt: new Date(NOW - DAY).toISOString(), artifacts: [] },
      {
        id: 't-sug-3',
        title: '已完成任务',
        status: 'done',
        projectDir: 'C:\\proj\\sg',
        createdAt: new Date(NOW - 10 * DAY).toISOString(),
        completedAt: new Date(NOW - DAY).toISOString(),
        completedFlag: true,
        updatedAt: new Date(NOW - DAY).toISOString(),
        artifacts: [],
      },
    ],
  });
});

test.after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) { /* Windows 句柄延迟容忍 */ }
});

// ---------- 纯打分函数 ----------

test('textScore：有派工词 +1，标题命中再 +2；空派工词 0 分', () => {
  assert.deepEqual(textScore('', { title: '搜索高亮', desc: '' }), { score: 0, textHit: false });
  assert.deepEqual(textScore('帮忙改别的', { title: '搜索高亮', desc: '' }), { score: 1, textHit: false });
  const hit = textScore('请优化搜索高亮的显示', { title: '搜索高亮', desc: '' });
  assert.equal(hit.score, 3);
  assert.equal(hit.textHit, true);
});

test('scoreCandidate：完成后活跃 -3、远早于创建 -2、时间窗 +2、commit 桥 +2', () => {
  const base = { artifacts: [], createdAt: new Date(NOW - 10 * DAY).toISOString() };
  const now = NOW;
  // 完成后活跃
  const rDone = scoreCandidate(
    { lastActiveAt: new Date(NOW - 30 * MIN).toISOString(), dispatchText: '' },
    { ...base, completedAt: new Date(NOW - DAY).toISOString() },
    now
  );
  assert.ok(rDone.score < 0, `完成后活跃应净负分（-3 +1 近期），实际 ${rDone.score}`);
  assert.ok(rDone.reasons.includes('任务完成之后才活跃'));
  // 远早于创建
  const rOld = scoreCandidate(
    { lastActiveAt: new Date(NOW - 30 * DAY).toISOString(), dispatchText: '' },
    base,
    now
  );
  assert.ok(rOld.reasons.includes('远早于任务创建'));
  // 时间窗 + 桥
  const rWin = scoreCandidate(
    { lastActiveAt: new Date(NOW - 2 * HOUR).toISOString(), dispatchText: '' },
    { ...base, artifacts: [{ kind: 'commit', at: new Date(NOW - 3 * HOUR).toISOString() }] },
    now
  );
  assert.ok(rWin.reasons.includes('活跃于任务时间窗内'));
  assert.ok(rWin.reasons.includes('同期有本任务归因提交'));
  assert.ok(rWin.score >= 4, `窗+桥至少 4 分，实际 ${rWin.score}`);
});

// ---------- suggestSessionsForTask 集成 ----------

test('未绑定项目 → items 空且零扫描（无源配置也不报错）', () => {
  const r = suggestSessionsForTask(
    { tasksPath: path.join(dataDir, 'tasks.json'), config: { agentActivity: { sources: {} } } },
    't-sug-2',
    { now: NOW, freshIndex: true }
  );
  assert.deepEqual(r.items, []);
  assert.equal(r.task.projectDir, '');
});

test('候选池：同项目入池/他项目出局/已挂 ref 幂等出局；打分排序与理由齐备', () => {
  const r = suggestSessionsForTask(ctxOf(), 't-sug-1', { now: NOW, freshIndex: true });
  const refs = r.items.map((i) => i.ref);
  assert.ok(!refs.includes(REF.already), '已挂会话不重推（幂等）');
  assert.ok(!refs.includes(REF.other), '他项目会话不入候选池');
  assert.ok(refs.includes(REF.window), '时间窗内会话入建议');
  const w = r.items.find((i) => i.ref === REF.window);
  assert.equal(w.agent, 'claude');
  assert.ok(w.score >= SCORE_THRESHOLD);
  assert.ok(w.reasons.includes('同期有本任务归因提交'), 'commit 桥理由');
  assert.ok(w.reasons.includes('活跃于任务时间窗内'));
  assert.ok(w.dispatchText.includes('修一下搜索的高亮逻辑'), '派工词随建议返回');
  assert.ok(typeof w.score === 'number' && w.score >= 2);
  // afterDone/tooOld 低于阈值被滤除（t-sug-1 未完成，afterDone 是近期活跃 → 分数= -0+1+1+1=3？）
  // 精确算：afterDone 对 t-sug-1（无 completedAt）：窗内 +2、近期 +1、派工词 +1 = 4 ≥2 → 会在列表。
  // 真正被滤除的是 tooOld：-2 + 无近期 + 派工词 +1 = -1 < 2
  assert.ok(!refs.includes(REF.tooOld), '远早于创建的会话被闸门滤除');
});

test('已完成任务：完成时刻之后的活跃被降级滤除（闸门宁缺）', () => {
  const r = suggestSessionsForTask(ctxOf(), 't-sug-3', { now: NOW, freshIndex: true });
  const refs = r.items.map((i) => i.ref);
  assert.ok(!refs.includes(REF.afterDone), '完成后才活跃的会话不推荐');
  assert.ok(!refs.includes(REF.window), '窗内会话在完成任务上也因完成后活跃被滤（mtime>completedAt）');
});

// ---------- 端点层（appAssembler 装配真相 + 闭环） ----------

test('端点：404 / 200 形状 / 建议 ref 经既有 POST artifacts 201 闭环', async () => {
  const cfgPath = path.join(tmpRoot, 'sg-endpoint', 'config.json');
  writeJSON(cfgPath, {
    port: 7846,
    host: '127.0.0.1',
    dataDir,
    webDir: path.join(tmpRoot, 'sg-endpoint', 'web'),
    gitea: { pollIntervalSec: 0 },
    agentActivity: { enabled: true, sources: { claude: { root: claudeRoot } } },
  });
  const { buildApp } = require('./helpers/appAssembler');
  const app = buildApp({ poller: 'manual', warmProbe: false, configPath: cfgPath });
  try {
    const miss = await app.fetch('GET', '/api/tasks/t-nope/session-suggestions', {});
    assert.equal(miss.status, 404);
    assert.equal(miss.body.error.code, 'TASK_NOT_FOUND');

    const hit = await app.fetch('GET', '/api/tasks/t-sug-1/session-suggestions', {});
    assert.equal(hit.status, 200);
    assert.equal(hit.body.task.id, 't-sug-1');
    assert.ok(Array.isArray(hit.body.items));
    assert.ok(hit.body.items.length >= 1, '端点路径出建议');
    const w = hit.body.items.find((i) => i.ref === REF.window);
    assert.ok(w, '端点含 window 建议');
    assert.ok(Array.isArray(w.reasons) && w.reasons.length > 0);

    // 闭环：拿建议的 ref 走既有挂接端点（session 形态）必须 201（body 按 app.fetch 契约序列化）
    const post = await app.fetch('POST', '/api/tasks/t-sug-1/artifacts', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'session',
        sessionRef: w.ref,
        title: (w.dispatchText || w.title || '建议挂接会话').slice(0, 200),
      }),
    });
    assert.equal(post.status, 201);
    assert.equal(post.body.kind, 'session');
    assert.equal(post.body.url, null);
    // 幂等回归：再查建议，该 ref 出局
    const again = await app.fetch('GET', '/api/tasks/t-sug-1/session-suggestions', {});
    assert.ok(!again.body.items.some((i) => i.ref === w.ref), '挂接后建议出局（幂等闭环）');
  } finally {
    app.close();
  }
});
