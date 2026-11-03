'use strict';
// B3 凭据红线测试：redact 双重过滤（按 redactKeys + 按凭据原值）+ 全项目落盘扫描。
// AAA 三段式；一个用例一个断言主题。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const { redact, registerSecret, clearSecrets } = require('../lib/redact.js');
const { loadConfig, readCredential } = require('../lib/giteaClient.js');

test('redact 按 key 过滤：Authorization 头形态', () => {
  clearSecrets();
  // Arrange
  const raw = 'GET /api/v1/xx Authorization: Basic dXNlcjpwYXNz123 done';
  // Act
  const out = redact(raw);
  // Assert
  assert.ok(!out.includes('dXNlcjpwYXNz123'), `原值泄漏: ${out}`);
  assert.ok(out.includes('Authorization'), 'key 名应保留');
  assert.ok(out.includes('[REDACTED]'));
});

test('redact 按 key 过滤：JSON 序列化形态（大小写不敏感）', () => {
  clearSecrets();
  const raw = '{"authorization":"Bearer tok-abcdef","x":1}';
  const out = redact(raw);
  assert.ok(!out.includes('tok-abcdef'), `原值泄漏: ${out}`);
  assert.ok(out.includes('"authorization"'));
  assert.ok(out.includes('[REDACTED]'));
});

test('redact 按 key 过滤：git-config extraheader= 形态', () => {
  clearSecrets();
  const raw = 'git config --global http.https://gitea.example.com/.extraheader=Basic s3cr3tVA9 done';
  const out = redact(raw);
  assert.ok(!out.includes('s3cr3tVA9'), `原值泄漏: ${out}`);
  assert.ok(out.includes('extraheader'));
});

test('redact 按已注册凭据原值过滤（值过滤先于 key 过滤）', () => {
  clearSecrets();
  // Arrange
  registerSecret('Basic TopSecret123');
  const raw = 'connect Basic TopSecret123 ok; extraheader=Authorization: Basic TopSecret123';
  // Act
  const out = redact(raw);
  // Assert
  assert.equal(out.includes('TopSecret123'), false, `原值泄漏: ${out}`);
  clearSecrets();
});

test('redact extraSecrets 参数同样生效', () => {
  clearSecrets();
  const out = redact('payload ExtraVal456 tail', ['ExtraVal456']);
  assert.ok(!out.includes('ExtraVal456'), `原值泄漏: ${out}`);
});

test('凭据落盘扫描：全项目文件不含真实凭据原值与哨兵值', () => {
  clearSecrets();
  // Arrange：读真实 git config 凭据（可能为 null）；哨兵值拼接构造，避免字面量出现在本文件
  const cfg = loadConfig();
  const cred = readCredential(cfg);
  const SENTRY = ['Basic SENTRY-CRED-', '7f', '3a9'].join('');
  registerSecret(SENTRY);
  const skipDirs = new Set(['.git', 'node_modules', '.mimosa']);
  const offenders = [];
  // Act：递归遍历项目全部文件
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (skipDirs.has(name)) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else {
        let txt;
        try { txt = fs.readFileSync(full, 'utf8'); } catch { continue; } // 二进制跳过
        if (cred && txt.includes(cred)) offenders.push(`${full}（真实凭据）`);
        if (txt.includes(SENTRY)) offenders.push(`${full}（哨兵）`);
      }
    }
  })(PROJECT_ROOT);
  // Assert
  assert.deepEqual(offenders, [], `凭据落盘: \n${offenders.join('\n')}`);
});
