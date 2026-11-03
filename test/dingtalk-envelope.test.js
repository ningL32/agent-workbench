'use strict';

/**
 * dingtalk-envelope.test.js — dws CLI 回执解包（v1.0.64 起的 {ok,outcome,data,meta} 外壳）
 *
 * 背景：v1.0.59 时代 dws 直出业务对象（{minutes:[...]} / {paragraphList:[...]}），
 * 插件据此直接取 data.minutes；v1.0.64 起所有子命令套了统一回执外壳，
 * 不解包会让 syncMessages 拿到 undefined → 同步「成功但 0 条」的静默空转。
 */

const test = require('node:test');
const assert = require('node:assert');

const { unwrapDwsPayload, dwsErrorDetail } = require('../lib/dingtalk');

test('unwrapDwsPayload：v1.x 外壳解包为 data（list-all 形态）', () => {
  // Arrange
  const payload = {
    ok: true,
    outcome: 'success',
    data: { complete: false, count: 1, minutes: [{ taskUuid: 'abc12345' }] },
    meta: { cli_version: 'v1.0.64' },
  };

  // Act
  const out = unwrapDwsPayload(payload);

  // Assert
  assert.deepStrictEqual(out, { complete: false, count: 1, minutes: [{ taskUuid: 'abc12345' }] });
});

test('unwrapDwsPayload：老版本直出业务对象原样返回（向后兼容）', () => {
  // Arrange
  const legacy = { minutes: [{ taskUuid: 'abc12345' }] };

  // Act / Assert
  assert.strictEqual(unwrapDwsPayload(legacy), legacy);
});

test('unwrapDwsPayload：ok:false 即使退出码为 0 也必须抛 DWS_ERROR', () => {
  // Arrange
  const payload = {
    ok: false,
    outcome: 'failure',
    error: { type: 'api', message: '逐字稿读取不完整：已读取 0 页、0 个段落' },
  };

  // Act
  let caught;
  try { unwrapDwsPayload(payload); } catch (e) { caught = e; }

  // Assert
  assert.ok(caught, 'ok:false 必须抛错');
  assert.strictEqual(caught.code, 'DWS_ERROR');
  assert.match(caught.message, /逐字稿读取不完整/);
});

test('unwrapDwsPayload：非对象输入原样返回（防 CLI 直出字符串/数组）', () => {
  // Arrange / Act / Assert
  assert.deepStrictEqual(unwrapDwsPayload([1, 2]), [1, 2]);
  assert.strictEqual(unwrapDwsPayload('plain'), 'plain');
  assert.strictEqual(unwrapDwsPayload(null), null);
});

test('dwsErrorDetail：从失败回执 stdout 中取 error.message', () => {
  // Arrange
  const stdout = JSON.stringify({ ok: false, error: { message: 'P_ParamsError: 参数错误' } });

  // Act / Assert
  assert.strictEqual(dwsErrorDetail(stdout), 'P_ParamsError: 参数错误');
});

test('dwsErrorDetail：非 JSON / 空输出返回空串，不抛错', () => {
  // Arrange / Act / Assert
  assert.strictEqual(dwsErrorDetail('boom'), '');
  assert.strictEqual(dwsErrorDetail(''), '');
  assert.strictEqual(dwsErrorDetail(undefined), '');
});
