'use strict';

/**
 * backup.test.js — v2.9.7 数据备份脚本：
 *   备份目录结构（时间戳目录 + manifest）、保留策略滚动清理、幂等不覆盖、源缺失报错。
 * 全合成夹具（tmp 目录），不触碰真实数据目录。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { backupOnce, KEEP_DEFAULT } = require('../scripts/backup-data.js');

function mkFixture() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-bk-src-'));
  fs.writeFileSync(path.join(src, 'tasks.json'), JSON.stringify({ columns: [], tasks: [{ id: 't1' }] }));
  fs.writeFileSync(path.join(src, 'diary.json'), '[]');
  fs.mkdirSync(path.join(src, 'session-logs')); // 子目录不备（只备 JSON 文件）
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-bk-out-'));
  return { src, out };
}

test('backupOnce：时间戳目录 + 全部 JSON 备齐 + manifest 清单；子目录不备', () => {
  const { src, out } = mkFixture();
  const now = Date.parse('2026-10-22T10:00:00Z');
  const r = backupOnce({ source: src, out, now, keep: 5 });
  assert.ok(fs.existsSync(r.dir), '备份目录存在');
  assert.ok(path.basename(r.dir).startsWith('backup-'), '目录名带 backup- 前缀时间戳');
  for (const f of ['tasks.json', 'diary.json', 'manifest.json']) {
    assert.ok(fs.existsSync(path.join(r.dir, f)), `${f} 已备`);
  }
  assert.ok(!fs.existsSync(path.join(r.dir, 'session-logs')), '子目录不备份');
  const manifest = JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.files.length, 2, 'manifest 只记 JSON 文件');
  assert.ok(manifest.files.some((f) => f.name === 'tasks.json' && f.bytes > 0), 'tasks.json 在清单且带字节数');
  assert.strictEqual(manifest.source, src);
  assert.strictEqual(manifest.backedUpAt, new Date(now).toISOString());
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test('保留策略：keep=2 时第三份备份触发滚动清理（最旧的出局）', () => {
  const { src, out } = mkFixture();
  try {
    const base = Date.parse('2026-10-22T10:00:00Z');
    backupOnce({ source: src, out, now: base, keep: 2 });
    backupOnce({ source: src, out, now: base + 60000, keep: 2 });
    backupOnce({ source: src, out, now: base + 120000, keep: 2 });
    const dirs = fs.readdirSync(out).filter((n) => n.startsWith('backup-')).sort();
    assert.strictEqual(dirs.length, 2, `滚动后应保留 2 份，实际 ${dirs.length}`);
    assert.ok(dirs[0] > 'backup-20261022-100100', '最旧的一份（10:00:00）已被清理');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('幂等：同一时间戳重复备份生成 -后缀目录，绝不覆盖既有备份', () => {
  const { src, out } = mkFixture();
  try {
    const now = Date.parse('2026-10-22T10:00:00Z');
    const r1 = backupOnce({ source: src, out, now, keep: 5 });
    const r2 = backupOnce({ source: src, out, now, keep: 5 });
    assert.notStrictEqual(r1.dir, r2.dir, '同时间戳两次备份目录不同');
    assert.ok(fs.existsSync(r1.dir) && fs.existsSync(r2.dir), '两份备份都完好');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('源目录不存在 → 报错且信息含路径', () => {
  assert.throws(
    () => backupOnce({ source: path.join(os.tmpdir(), 'fde-no-such-dir-xyz'), out: os.tmpdir() }),
    (e) => e.message.includes('数据目录不存在')
  );
});

test('KEEP_DEFAULT 缺省为 14（v2.9.41 起按「每日一份、留两周」定档；旧默认 12 已上调）', () => {
  assert.strictEqual(KEEP_DEFAULT, 14);
});

// ---------- v2.9.33 存储迁移配套：db 进档案（checkpoint）+ 旧代档案自动重导入（SPEC-STORAGE §5） ----------
// 测试文件自身零 node:sqlite——建库走 lib/migration.runMigration，断言走备份/恢复公开 API。

test('备份含 fde.db：checkpoint 后入库清单；*.migrated 归档不进备份', () => {
  const { runMigration } = require('../lib/migration');
  const { src, out } = mkFixture();
  fs.writeFileSync(path.join(src, 'messages.json'), JSON.stringify([
    { id: 'm-1', title: '会话一', occurredAt: '2026-10-30T00:00:00Z' },
  ]));
  runMigration({ dataDir: src, units: ['messages'], now: 0 });
  const now = Date.parse('2026-10-31T10:00:00Z');
  const r = backupOnce({ source: src, out, now, keep: 5 });
  const names = r.files.map((f) => f.name);
  assert.ok(names.includes('fde.db'), 'fde.db 进备份清单（checkpoint 后拷贝）');
  assert.ok(!names.some((n) => n.includes('.migrated-')), '*.migrated 归档不进备份');
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test('恢复旧代纯 JSON 档案：已迁移单元自动重导入（恢复后系统可用承诺）', () => {
  const store = require('../lib/store');
  const storeDb = require('../lib/storeDb');
  const { restoreBackup } = require('../lib/backup.js');
  const { runMigration } = require('../lib/migration');
  // 独立根目录：src 与 backups 同根隔离（共享 Temp\backups 会被其它运行的 keep:5 滚动清理剪掉旧档案）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-rs-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  const msgs = [{ id: 'm-old', title: '迁移前旧消息', occurredAt: '2026-10-01T00:00:00Z' }];
  fs.writeFileSync(path.join(src, 'messages.json'), JSON.stringify(msgs));

  // ① 迁移前的旧代备份（纯 JSON，无 fde.db）——落 ctx 的 backups 目录（restoreBackup 按 ctx 找）
  const ctxBackups = path.join(path.dirname(src), 'backups');
  const oldArchive = backupOnce({ source: src, out: ctxBackups, now: Date.parse('2026-10-01T00:00:00Z'), keep: 5 });
  const oldName = path.basename(oldArchive.dir);
  assert.ok(!oldArchive.files.some((f) => f.name === 'fde.db'));

  // ② 迁移（messages 进 db，原 JSON 改名归档）
  runMigration({ dataDir: src, units: ['messages'], now: 0 });
  assert.equal(storeDb.unitBackend(src, 'messages').backend, 'sqlite');

  // ③ 恢复旧代档案：JSON 回来 + 自动重导入 db + 台账保持
  const r = restoreBackup({ dataDir: src, config: { backup: { keep: 5 } } }, oldName, { confirm: 'RESTORE', now: Date.parse('2026-10-31T10:00:00Z') });
  assert.ok(r.files.includes('messages.json'), '旧 JSON 已恢复');
  assert.equal(storeDb.unitBackend(src, 'messages').backend, 'sqlite', '台账保持迁移态');
  const loaded = store.loadMessages({ messagesPath: path.join(src, 'messages.json') });
  assert.deepEqual(loaded.map((m) => m.id), ['m-old'], '恢复出的旧消息经重导入回到 db');

  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (e) { /* Windows 句柄延迟 EPERM 容忍（AGENTS.md 测试纪律） */ }
});
