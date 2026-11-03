'use strict';

/**
 * postmortem.test.js — v2.9.28 任务复盘：证据蒸馏（会话派工词/提交/日报）+ 跨度 + 端点
 *
 * 覆盖：
 *  - 证据聚合：session artifacts 回读派工词（claude 文件夹具）；commit/pr 计数；日报计数与摘录
 *  - 跨度口径：证据时间 min..max（完成时刻并入）；零证据 → span 全 null（诚实空态）
 *  - 幂等去重：同 sessionRef 不重复；每类证据截 8 条
 *  - 端点：404 TASK_NOT_FOUND / 200 形状
 * 纪律：全合成夹具零出网零 sqlite；临时目录 EPERM 容忍。
 * 运行：node --test test/postmortem.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sessionRef = require('../lib/sessionRef');
const { buildPostmortem } = require('../lib/postmortem');

const NOW = new Date('2026-10-31T04:00:00.000Z').getTime();
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

let tmpRoot;
let claudeRoot;

function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const REF_A = sessionRef.encodeRef({ s: 'claude', k: 'project', v: { dir: 'proj-pm', file: 'aaaaaaaa-0000-0000-0000-000000000001.jsonl' } });
const REF_B = sessionRef.encodeRef({ s: 'claude', k: 'project', v: { dir: 'proj-pm', file: 'aaaaaaaa-0000-0000-0000-000000000002.jsonl' } });

const cfg = () => ({ dataDir: path.join(tmpRoot, 'data'), agentActivity: { enabled: true, sources: { claude: { root: claudeRoot } } } });
const ctxOf = () => ({ tasksPath: path.join(tmpRoot, 'data', 'tasks.json'), diaryPath: path.join(tmpRoot, 'data', 'diary.json'), config: cfg() });

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-pm-'));
  claudeRoot = mk(path.join(tmpRoot, 'claude', 'projects'));
  // 两条 claude 会话（派工词可回读）+ 坏 ref 一条（应降级不炸）
  write(path.join(claudeRoot, 'proj-pm', 'aaaaaaaa-0000-0000-0000-000000000001.jsonl'),
    JSON.stringify({ type: 'user', timestamp: new Date(NOW - 3 * DAY).toISOString(), message: { role: 'user', content: '把导出改成流式' } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, cwd: 'C:\\proj\\pm' }) + '\n',
    NOW - 3 * DAY);
  write(path.join(claudeRoot, 'proj-pm', 'aaaaaaaa-0000-0000-0000-000000000002.jsonl'),
    JSON.stringify({ type: 'user', timestamp: new Date(NOW - DAY).toISOString(), message: { role: 'user', content: '补齐测试边界' } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, cwd: 'C:\\proj\\pm' }) + '\n',
    NOW - DAY);

  writeTasks([
    {
      id: 't-pm-1',
      title: '复盘夹具任务',
      status: 'done',
      createdAt: new Date(NOW - 10 * DAY).toISOString(),
      completedAt: new Date(NOW - 30 * MIN).toISOString(),
      artifacts: [
        { url: 'https://gitea/c/1', kind: 'commit', repo: 'example-org/x', ref: 'main', at: new Date(NOW - 2 * DAY).toISOString(), title: 'feat: 流式导出', messageBody: '' },
        { url: 'https://gitea/p/1', kind: 'pr', repo: 'example-org/x', ref: null, at: new Date(NOW - DAY).toISOString(), title: 'PR #9 边界补齐', messageBody: '' },
        { url: null, kind: 'session', repo: null, ref: null, sessionRef: REF_A, title: '把导出改成流式', at: new Date(NOW - 3 * DAY).toISOString() },
        { url: null, kind: 'session', repo: null, ref: null, sessionRef: REF_B, title: '补齐测试边界', at: new Date(NOW - DAY).toISOString() },
        { url: null, kind: 'session', repo: null, ref: null, sessionRef: REF_A, title: '重复引用应去重', at: new Date(NOW - HOUR).toISOString() },
      ],
    },
    { id: 't-pm-2', title: '零证据任务', status: 'todo', createdAt: new Date(NOW).toISOString(), artifacts: [] },
  ]);
  writeDiaries([
    { taskId: 't-pm-1', date: '2026-10-30', content: '今天完成流式导出并补齐边界测试', updatedAt: new Date(NOW - 2 * HOUR).toISOString() },
    { taskId: 't-other-task', date: '2026-10-30', content: '真正别任务的日报（不该计入 t-pm-2）', updatedAt: new Date(NOW - 2 * HOUR).toISOString() },
  ]);
});

function mk(p2) { return p2; }
function write(file, content, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (Number.isFinite(mtimeMs)) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}
function writeTasks(tasks) {
  fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'data', 'tasks.json'), JSON.stringify({ columns: [], tasks }, null, 2));
}
function writeDiaries(list) {
  fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'data', 'diary.json'), JSON.stringify(list, null, 2));
}

test.after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) { /* EPERM 容忍 */ }
});

test('证据聚合：派工词回读/提交计数/日报摘录；同 ref 去重', () => {
  const r = buildPostmortem(ctxOf(), 't-pm-1', { now: NOW });
  assert.equal(r.counts.commits, 2);
  assert.equal(r.counts.prs, 1);
  assert.equal(r.counts.sessions, 2, '重复 sessionRef 去重');
  assert.equal(r.counts.diaries, 1);
  const words = r.evidence.dispatchWords;
  assert.equal(words.length, 2);
  assert.ok(words.some((w) => w.dispatchText.includes('把导出改成流式')), '派工词经 ref 回读');
  assert.ok(r.evidence.commits[0].title.includes('流式导出') || r.evidence.commits[0].title.includes('边界'), '提交证据在列');
  assert.equal(r.evidence.diaries[0].date, '2026-10-30');
  assert.ok(r.evidence.diaries[0].excerpt.includes('流式导出'));
});

test('跨度：证据 min..max（完成时刻并入）→ 天数；零证据 → span 全 null', () => {
  const r = buildPostmortem(ctxOf(), 't-pm-1', { now: NOW });
  assert.equal(r.span.days, 3, '3 天前会话 → 完成时刻（30min 前）≈ 3 天');
  assert.ok(r.span.firstAt && r.span.lastAt);

  const empty = buildPostmortem(ctxOf(), 't-pm-2', { now: NOW });
  assert.equal(empty.counts.commits, 0);
  assert.equal(empty.span.days, null, '零证据不虚增跨度');
  assert.equal(empty.span.firstAt, null);
});

test('端点：404 TASK_NOT_FOUND / 200 形状契约', async () => {
  const cfgPath = path.join(tmpRoot, 'ep', 'config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: 7850,
    host: '127.0.0.1',
    dataDir: path.join(tmpRoot, 'data'),
    webDir: path.join(tmpRoot, 'ep', 'web'),
    gitea: { pollIntervalSec: 0 },
    agentActivity: { enabled: true, sources: { claude: { root: claudeRoot } } },
  }));
  const { buildApp } = require('./helpers/appAssembler');
  const app = buildApp({ poller: 'manual', warmProbe: false, configPath: cfgPath });
  try {
    const miss = await app.fetch('GET', '/api/tasks/t-nope/postmortem', {});
    assert.equal(miss.status, 404);
    assert.equal(miss.body.error.code, 'TASK_NOT_FOUND');
    const hit = await app.fetch('GET', '/api/tasks/t-pm-1/postmortem', {});
    assert.equal(hit.status, 200);
    assert.equal(hit.body.task.id, 't-pm-1');
    assert.equal(hit.body.counts.sessions, 2);
    assert.ok(hit.body.evidence.dispatchWords.length >= 1);
  } finally {
    app.close();
  }
});
