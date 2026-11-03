'use strict';

/**
 * instance-lock.test.js — v2.9.43 单实例登记（检测 + 告警，不硬拦）
 *
 * 覆盖：登记写入自己、检出其它存活实例、清理已死 pid、退出摘除自己、运行期 status。
 * 全临时目录，不触碰真实 ~/.dsh/fde-console（AGENTS 红线 3）。
 * 活体/死体 pid 都真实构造（父进程 = 活；spawn 后立即退出的 node = 死），不 mock process.kill。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const lock = require('../lib/instanceLock');

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fde-lock-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* Windows EPERM 容错 */
  }
}

test('acquire：登记自己（pid/版本/端口）并落盘', () => {
  const base = tmpBase();
  const r = lock.acquire(base, { version: '9.9.9', port: 38082 });

  assert.equal(r.self.pid, process.pid);
  assert.equal(r.others.length, 0, '干净目录里不应有别家');

  const raw = JSON.parse(fs.readFileSync(lock.lockPath(base), 'utf8'));
  assert.equal(raw.instances.length, 1);
  assert.equal(raw.instances[0].pid, process.pid);
  assert.equal(raw.instances[0].version, '9.9.9');
  assert.equal(raw.instances[0].port, 38082);
  cleanup(base);
});

test('acquire：目录里已有别的存活实例时如实报出来（不阻止、不吞掉）', () => {
  const base = tmpBase();
  fs.writeFileSync(lock.lockPath(base), JSON.stringify({
    updatedAt: new Date().toISOString(),
    instances: [{ pid: process.ppid, startedAt: new Date().toISOString(), version: '1.0.0', port: 7788 }],
  }));

  const r = lock.acquire(base, { version: '2.0.0' });
  assert.equal(r.others.length, 1, '父进程是活体，必须被识别为其它实例');
  assert.equal(r.others[0].pid, process.ppid);

  const raw = JSON.parse(fs.readFileSync(lock.lockPath(base), 'utf8'));
  assert.equal(raw.instances.length, 2, '两家都要在登记表里（谁活着谁自己决定退不退）');
  cleanup(base);
});

test('acquire：已死 pid 被清理，不制造假告警', () => {
  const base = tmpBase();
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(lock.isAlive(dead.pid), false, '刚退出的子进程必须是死体');

  fs.writeFileSync(lock.lockPath(base), JSON.stringify({
    updatedAt: new Date().toISOString(),
    instances: [{ pid: dead.pid, startedAt: new Date().toISOString() }],
  }));

  const r = lock.acquire(base, { version: '3.0.0' });
  assert.equal(r.others.length, 0, '死 pid 不算其它实例');
  const raw = JSON.parse(fs.readFileSync(lock.lockPath(base), 'utf8'));
  assert.deepEqual(raw.instances.map((x) => x.pid), [process.pid], '登记表只留活着的自己');
  cleanup(base);
});

test('release：摘掉自己；没有别人时连锁文件一起删掉', () => {
  const base = tmpBase();
  lock.acquire(base, { version: '4.0.0' });
  const r = lock.release(base);

  assert.equal(r.released, true);
  assert.equal(r.remaining, 0);
  assert.equal(fs.existsSync(lock.lockPath(base)), false, '最后一个实例退出应删除锁文件');
  cleanup(base);
});

test('status：有其它存活实例时 multiInstance=true，否则 false', () => {
  const base = tmpBase();
  lock.acquire(base, { version: '5.0.0' });

  const solo = lock.status(base);
  assert.equal(solo.multiInstance, false);
  assert.ok(solo.self && solo.self.pid === process.pid);

  fs.writeFileSync(lock.lockPath(base), JSON.stringify({
    updatedAt: new Date().toISOString(),
    instances: [
      { pid: process.pid, startedAt: new Date().toISOString(), version: '5.0.0' },
      { pid: process.ppid, startedAt: new Date().toISOString(), version: '5.0.0', port: 7788 },
    ],
  }));
  const multi = lock.status(base);
  assert.equal(multi.multiInstance, true);
  assert.equal(multi.others.length, 1);
  cleanup(base);
});
