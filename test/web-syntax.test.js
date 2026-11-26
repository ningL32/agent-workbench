'use strict';

/**
 * web-syntax.test.js — 前端语法守卫（v2.9.84 事故固化）
 *
 * 事故：onboarding.js 一次编辑留下孤儿 `try {`，模块图装载即抛 SyntaxError，
 * app 引导死在静态初始态（「连接中…」/ 数据全是 —）——后端测试 532 绿照样溜进 main，
 * 因为前端视图没有 Node 侧测试覆盖。
 *
 * 守卫：对 web/js 下全部 .js 模块逐个做「仅解析」装载（子进程 ESM import），
 * 断言错误类型 ≠ SyntaxError。视图模块顶层访问 document/location 在 Node 下抛
 * ReferenceError 属预期（浏览器环境才有的全局），不算失败——本守卫只抓语法。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WEB_JS = path.join(__dirname, '..', 'web', 'js');

function listJsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsFiles(abs));
    else if (e.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

test('web/js 全部模块可解析（无孤儿 try / 断括号类语法错误）', () => {
  const files = listJsFiles(WEB_JS);
  assert.ok(files.length >= 15, `web/js 模块数应 ≥15（实际 ${files.length}，目录结构变了就同步本守卫）`);
  const syntaxBroken = [];
  for (const f of files) {
    const probe = path.join(os.tmpdir(), `fde-web-syntax-${Date.now()}.mjs`);
    const rel = path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/');
    fs.writeFileSync(probe, `await import(${JSON.stringify('file:///' + f.replace(/\\/g, '/'))});`);
    try {
      execFileSync(process.execPath, ['--input-type=module', probe], { timeout: 15000, stdio: 'pipe' });
      // 无输出无错 = 装载成功（顶层 DOM ReferenceError 也会走这里？不会——execFileSync 非零抛错）
    } catch (e) {
      const out = `${e.stdout || ''}\n${e.stderr || ''}`;
      // ReferenceError（document/location 未定义）= 语法过关、仅是浏览器全局，放行；
      // SyntaxError = 真·解析失败（含其依赖图里的语法错误,一并列出帮定位）
      if (/SyntaxError:/.test(out)) syntaxBroken.push(`${rel}: ${out.match(/SyntaxError:[^\n]*/)[0]}`);
    } finally {
      try { fs.unlinkSync(probe); } catch { /* 清理互不阻塞 */ }
    }
  }
  assert.deepEqual(
    syntaxBroken, [],
    `[docs-sync 同宗] web/js 存在语法错误模块（模块图装载即全灭,SPA 冻结在静态初始态）:\n  ${syntaxBroken.join('\n  ')}`
  );
});
