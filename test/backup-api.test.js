'use strict';

/**
 * backup-api.test.js — v2.9.41 数据备份与恢复（lib/backup.js）
 *
 * 覆盖：备份产物与清单、keep 滚动、恢复三道闸（confirm/名字白名单/存在性）、
 *       恢复往返（含「先快照」与「只覆盖不删除」）、每日自动备份到点/当日去重、状态视图。
 * 全合成夹具（临时目录），绝不触碰真实 ~/.dsh/fde-console/data（AGENTS 红线 3）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  backupNow,
  listBackups,
  restoreBackup,
  maybeDailyBackup,
  backupStatus,
} = require('../lib/backup');

function fixture(opts) {
  const o = opts || {};
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-bkapi-'));
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({ tasks: [{ id: 't1', title: '原始标题' }] }));
  fs.writeFileSync(path.join(dataDir, 'diary.json'), '[]');
  return {
    base,
    dataDir,
    ctx: {
      dataDir,
      config: { backup: Object.assign({ enabled: true, keep: 3, at: '09:05' }, o.backup || {}) },
    },
  };
}

function cleanup(base) {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch (e) {
    /* Windows 临时目录 EPERM 容错 */
  }
}

test('backupNow：产出时间戳目录 + manifest，listBackups 能反查时间与体积', () => {
  const { base, ctx } = fixture();
  const r = backupNow(ctx, { now: Date.parse('2026-10-31T09:05:00') });

  assert.ok(fs.existsSync(path.join(r.dir, 'manifest.json')), 'manifest 必须落盘');
  assert.equal(r.files.length, 2, '只备 data/ 下的 JSON 文件');

  const list = listBackups(ctx);
  assert.equal(list.length, 1);
  assert.ok(list[0].backedUpAt, '清单带备份时间');
  assert.ok(list[0].bytes > 0, '清单带体积');
  assert.equal(list[0].unreadable, false);
  cleanup(base);
});

test('keep 生效：保留 2 份时第三次备份触发滚动清理（最旧出局）', () => {
  const { base, ctx } = fixture({ backup: { keep: 2 } });
  const t0 = Date.parse('2026-10-31T09:05:00');
  backupNow(ctx, { now: t0 });
  backupNow(ctx, { now: t0 + 60000 });
  backupNow(ctx, { now: t0 + 120000 });

  assert.equal(listBackups(ctx).length, 2, '超过 keep 的旧备份必须被清理');
  cleanup(base);
});

test('restoreBackup 三道闸：无 confirm / 名字非法 / 备份不存在，分别拒绝且错误码明确', () => {
  const { base, ctx } = fixture();
  const r = backupNow(ctx, { now: Date.parse('2026-10-31T09:05:00') });
  const name = path.basename(r.dir);

  assert.throws(() => restoreBackup(ctx, name, {}), (e) => e.code === 'CONFIRM_REQUIRED');
  assert.throws(() => restoreBackup(ctx, '../data', { confirm: 'RESTORE' }), (e) => e.code === 'BACKUP_INVALID');
  assert.throws(() => restoreBackup(ctx, 'backup-19700101-000000', { confirm: 'RESTORE' }), (e) => e.code === 'BACKUP_NOT_FOUND');
  cleanup(base);
});

test('restoreBackup 往返：数据回滚 + 先给当前状态拍快照 + 备份里没有的文件不被删除', () => {
  const { base, ctx, dataDir } = fixture();
  const r = backupNow(ctx, { now: Date.parse('2026-10-31T09:05:00') });
  const name = path.basename(r.dir);

  // 备份之后改了数据，并新增一个备份里没有的文件
  fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({ tasks: [{ id: 't1', title: '改坏了' }] }));
  fs.writeFileSync(path.join(dataDir, 'later.json'), '[]');

  const out = restoreBackup(ctx, name, { confirm: 'RESTORE', now: Date.parse('2026-10-31T10:00:00') });
  const restored = JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'));

  assert.equal(restored.tasks[0].title, '原始标题', '内容必须回到备份时刻');
  assert.ok(fs.existsSync(path.join(dataDir, 'later.json')), '只覆盖不删除：备份里没有的文件保留');
  assert.ok(fs.existsSync(out.snapshot), '恢复前必须给当前状态留快照（可再回滚）');
  assert.ok(out.files.includes('tasks.json'));
  cleanup(base);
});

test('maybeDailyBackup：未到点不跑；到点跑一次；同日再调不重复', () => {
  const { base, ctx } = fixture();
  const early = maybeDailyBackup(ctx, { now: new Date(2026, 9, 31, 8, 0, 0) });
  assert.equal(early.ran, false);
  assert.equal(early.reason, '未到点');

  const first = maybeDailyBackup(ctx, { now: new Date(2026, 9, 31, 9, 30, 0) });
  assert.equal(first.ran, true);

  const second = maybeDailyBackup(ctx, { now: new Date(2026, 9, 31, 10, 0, 0) });
  assert.equal(second.ran, false);
  assert.equal(second.reason, '今日已备份');
  assert.equal(listBackups(ctx).length, 1, '一天只备一份，绝不刷盘');
  cleanup(base);
});

test('backupStatus：份数/最近备份/开关如实带出（从未备份时 lastBackupAt 为 null）', () => {
  const { base, ctx } = fixture();
  const before = backupStatus(ctx);
  assert.equal(before.count, 0);
  assert.equal(before.lastBackupAt, null);

  backupNow(ctx, { now: Date.parse('2026-10-31T09:05:00') });
  const after = backupStatus(ctx);
  assert.equal(after.count, 1);
  assert.ok(after.lastBackupAt);
  assert.equal(after.enabled, true);
  cleanup(base);
});
