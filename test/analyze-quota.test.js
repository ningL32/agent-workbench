'use strict';

/**
 * analyze-quota.test.js — dsh 引擎 QUOTA（额度不足）的明确报错（v2.9.97）
 *
 * 事故（2026-11-27 真机）：dsh 子进程 stdout 只回来了半截文本、stderr 报
 * "QUOTA: Insufficient Balance"，exit code 却是 0——结果一路当成"成功"传下去，
 * 访谈层把半截文本按"无法按契约解析"留痕，界面对用户说"模型返回无法解析"——
 * 重试一万次也不会好，正确动作是充值。修复：stderr 含 QUOTA → 明确抛
 * DSH_QUOTA（模型额度不足），上层各失败路径自然带着这句真话。
 *
 * 用真子进程测（spawn 一个假 bin：stderr 打 QUOTA、stdout 吐半截、exit 0），
 * 离线、不碰网络、不碰真模型。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const analyze = require('../lib/analyze');

/** 造一个假 dsh bin：stderr 打指定文本，stdout 输出指定文本，按给定码退出 */
function fakeBin(dir, name, { stderr, stdout, code }) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, [
    'process.stderr.write(' + JSON.stringify(stderr || '') + ');',
    'process.stdout.write(' + JSON.stringify(stdout || '') + ');',
    'process.exit(' + (code || 0) + ');',
  ].join('\n'));
  return file;
}

const cfgWithBin = (bin) => ({ analyze: { dshBin: bin, timeoutSec: 30 } });

test('stderr 含 QUOTA（即使 exit 0、stdout 有半截文本）→ 抛 DSH_QUOTA「模型额度不足」', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-quota-'));
  try {
    const bin = fakeBin(dir, 'dsh-quota.js', {
      stderr: ' dsh: QUOTA: Insufficient Balance (request_id: de98fd07)\n',
      stdout: '①Excel台账由谁维护、何时交给小王？', // 半截文本，JSON 解析必失败——正是真机事故的形态
      code: 0,
    });
    await assert.rejects(
      () => analyze.runHeadless(cfgWithBin(bin), '任意提示词'),
      (e) => {
        assert.strictEqual(e.code, 'DSH_QUOTA');
        assert.match(e.message, /模型额度不足/);
        assert.ok(!/Insufficient Balance/.test(e.message) || /QUOTA/.test(e.message), '保留 QUOTA 字样供检索');
        return true;
      },
      '半截成功必须被拦下：它不是成功，是没钱的失败'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stderr 含 Insufficient Balance（无 QUOTA 字样）同样识别；正常 stderr（无额度字样）不误伤', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-quota-'));
  try {
    const balance = fakeBin(dir, 'dsh-balance.js', {
      stderr: 'provider: Insufficient Balance for this key',
      stdout: '{"advice":"ok"}',
      code: 0,
    });
    await assert.rejects(() => analyze.runHeadless(cfgWithBin(balance), 'x'), (e) => e.code === 'DSH_QUOTA');

    const normal = fakeBin(dir, 'dsh-normal.js', {
      stderr: '[dsh] profile loaded in 120ms', // 日常噪声 stderr，不是额度问题
      stdout: '完整输出',
      code: 0,
    });
    const out = await analyze.runHeadless(cfgWithBin(normal), 'x');
    assert.strictEqual(out, '完整输出', '正常调用不被误判');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('非零退出 + QUOTA stderr：报额度不足而非笼统的执行失败', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-quota-'));
  try {
    const bin = fakeBin(dir, 'dsh-quota-exit1.js', { stderr: 'QUOTA: Insufficient Balance', stdout: '', code: 1 });
    await assert.rejects(() => analyze.runHeadless(cfgWithBin(bin), 'x'), (e) => {
      assert.strictEqual(e.code, 'DSH_QUOTA');
      assert.match(e.message, /模型额度不足/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
