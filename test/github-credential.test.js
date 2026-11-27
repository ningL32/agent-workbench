'use strict';

/**
 * github-credential.test.js — GitHub 凭据脱敏状态(v2.9.93)
 *
 * describeCredential 是设置页「凭据外显」的唯一出口。它的全部安全性在于:
 * **无论 git config 里的值是什么形态,输出里都不含可还原令牌的信息**。
 * 所以本文件的主线不是"功能对不对",而是"会不会泄露"——对一组正常与畸形/恶意的凭据值,
 * 逐一断言输出里只有 configured / tail(≤4 位) / scheme。
 *
 * 测的是纯函数 describeCredential(credentialValue),不碰 git config、不依赖本机环境。
 * (最初把它和「读 git config」耦在一起,导致桩无法注入、用例全部走"未配置"分支而假通过——
 *  那次教训促成了这次拆分:凭据相关的逻辑必须能在脱离本机环境的前提下被穷举。)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const githubClient = require('../lib/githubClient.js');

const describe = githubClient.describeCredential;
// 合成令牌:够长(让「不含 ≥5 字符连续片段」的泄露检查有意义)、尾 4 位可辨认。两点约束:
// ① 刻意不用 ghp_ 前缀 + 30 位以上的真实形态——那会命中 public-hygiene 的 H4(凭据形态零豁免);
//    被测逻辑(scheme 解析/尾位/缓存)不依赖前缀。
// ② 不含输出固定词表里的任何 ≥5 字符片段(configured/scheme/bearer/basic/token/other/true/false)——
//    输出里的 "scheme":"token" 是词表,不是令牌信息;夹具里混进 "TOKEN" 一词会让泄露检查假阳性(踩过)。
const SECRET = 'Zq7Xk2M9vB4n8WlC1jR6yTh5pD3fS0Ga';

test('未配置:null / undefined / 空 / 纯空白 → configured=false,其余字段为空串', () => {
  for (const v of [null, undefined, '', '   ', '\t\n']) {
    assert.deepEqual(describe(v), { configured: false, tail: '', scheme: '' }, `输入 ${JSON.stringify(v)}`);
  }
});

test('非字符串输入(数字/对象)按未配置处理,不抛错', () => {
  for (const v of [0, 123, {}, [], true]) {
    assert.deepEqual(describe(v), { configured: false, tail: '', scheme: '' }, `输入 ${String(v)}`);
  }
});

test('标准 Bearer 形态:只暴露尾 4 位与 scheme,输出形状封闭', () => {
  const r = describe(`Authorization: Bearer ${SECRET}`);
  assert.equal(r.configured, true);
  assert.equal(r.scheme, 'bearer');
  assert.equal(r.tail, SECRET.slice(-4));
  assert.equal(r.tail.length, 4, 'tail 恒为 4 位');
  assert.deepEqual(Object.keys(r).sort(), ['configured', 'scheme', 'tail'], '不携带其它字段(无长度/前缀/原值)');
});

test('裸令牌与 Basic / token scheme:尾位取自令牌本身而非 scheme 词', () => {
  assert.equal(describe(SECRET).tail, SECRET.slice(-4), '裸令牌');
  assert.equal(describe(SECRET).scheme, 'other', '裸令牌无 scheme');
  const basic = describe('Authorization: Basic dXNlcjpwYXNzMTIzNA==');
  assert.equal(basic.scheme, 'basic');
  assert.equal(basic.tail, 'zNA=='.slice(-4), 'Basic 值的尾 4 位');
  const tok = describe('Authorization: token ' + SECRET);
  assert.equal(tok.scheme, 'token');
  assert.equal(tok.tail, SECRET.slice(-4));
});

test('scheme 大小写不敏感、容忍多余空白;冒号可出现在令牌内部而不被误当分隔符', () => {
  assert.equal(describe(`AUTHORIZATION: BEARER ${SECRET}`).scheme, 'bearer');
  assert.equal(describe(`Authorization:   bearer   ${SECRET}   `).tail, SECRET.slice(-4));
  // 令牌里含冒号:以**第一个**冒号作为「头名:值」分隔,其后整体当值
  const odd = describe('Authorization: Bearer ab:cd:ef:gh:ij');
  assert.equal(odd.scheme, 'bearer');
  assert.equal(odd.tail, 'h:ij', '尾 4 位来自值的末尾(冒号是值的一部分)');
});

test('泄露检查:输出不含令牌本体、前缀、或任何 ≥5 字符的连续片段(大小写皆无)', () => {
  const cases = [
    `Authorization: Bearer ${SECRET}`,
    `authorization: bearer ${SECRET.toLowerCase()}`,   // 大小写变体
    SECRET,                                             // 裸令牌
    `Authorization: Bearer   ${SECRET}  `,              // 多余空白
    `Authorization: token ${SECRET}`,                   // 另一种 scheme
    `X-Custom: ${SECRET}`,                              // 非标准头名
    `${SECRET}`,                                        // 首尾无空白的裸值
  ];
  // SECRET 的所有长度 ≥5 的连续片段;出现任何一个都意味着泄露
  const fragments = [];
  for (let len = 5; len <= SECRET.length; len++) {
    for (let i = 0; i + len <= SECRET.length; i++) fragments.push(SECRET.slice(i, i + len));
  }
  for (const cred of cases) {
    const out = JSON.stringify(describe(cred)).toLowerCase();
    const leaked = fragments.find((f) => out.includes(f.toLowerCase()));
    assert.equal(leaked, undefined, `输出泄露了令牌片段「${leaked}」(凭据形态: ${cred.slice(0, 20)}…)`);
  }
});

test('短令牌(不足 4 位):tail 为空,不把整个短令牌当"尾部"暴露', () => {
  for (const cred of ['Authorization: Bearer abc', 'Authorization: Bearer a', 'ab']) {
    const r = describe(cred);
    assert.equal(r.configured, true, `${cred}: 有值即视为已配置`);
    assert.equal(r.tail, '', `${cred}: 不足 4 位不显示`);
  }
  assert.ok(!JSON.stringify(describe('Authorization: Bearer abc')).includes('abc'));
});

test('只有 scheme 没有令牌:configured=true 但 tail 为空(不把 scheme 词当令牌显示尾位)', () => {
  // 回归锚:实现曾把 "Bearer" 当成令牌值,显示尾位 "arer"——配置不完整时误导用户以为配了 Token
  assert.deepEqual(describe('Authorization: Bearer '), { configured: true, tail: '', scheme: 'bearer' });
  assert.deepEqual(describe('Authorization: Bearer'), { configured: true, tail: '', scheme: 'bearer' }, 'scheme 后无空白、直接到结尾');
  assert.deepEqual(describe('Authorization:   token   '), { configured: true, tail: '', scheme: 'token' });
});

test('恰好 4 位的令牌:尾位等于令牌本身——这是唯一会完整暴露原值的情形,且仅限 ≤4 位', () => {
  // 如实记录边界:4 位及以下的"令牌"没有保密意义(registerSecret 也忽略 <4 的值)。
  // 对真实 PAT(几十位)不构成问题。
  assert.equal(describe('Authorization: Bearer abcd').tail, 'abcd');
  assert.equal(describe('Authorization: Bearer abcde').tail, 'bcde', '5 位起只显示后 4 位');
});

test('credentialStatus(读 git config 的包装):本机未配置时返回未配置,不抛错', () => {
  // 不 mock git——只断言包装层不会抛、且形状正确。本机若恰好配置了凭据,configured 可能为 true。
  const r = githubClient.credentialStatus({ github: { baseUrl: 'https://api.github.com' } });
  assert.deepEqual(Object.keys(r).sort(), ['configured', 'scheme', 'tail']);
  assert.equal(typeof r.configured, 'boolean');
  assert.ok(r.tail.length <= 4, '尾位永不超过 4 位');
});

// ------------------------------------------------------------------ 生命周期(缓存口径)

/**
 * 凭据读取带进程内缓存。「未配置」曾经也缓存到进程结束——用户照设置页提示配好令牌后,
 * 状态行仍显示未配置、请求仍按匿名发出,直到重启:页面上「配置后点测试连接确认」成了假承诺(真机实测坐实)。
 * 口径:轮询路径沿用缓存(空值也缓存,否则未配令牌时每 tick 起一个阻塞事件循环的 git 子进程);
 *      用户主动确认的动作(设置页读取 / 测试连接)在缓存为空时重新读。
 *
 * 隔离:GIT_CONFIG_GLOBAL 指向临时文件,绝不读写本机真实的全局 git config;网络用桩 fetch 截获请求头。
 */
const GIT_OPTS = { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };

/**
 * 隔离的全局 git 配置(GIT_CONFIG_GLOBAL → 临时文件),本用例内所有 git config --global 都落在临时文件里,
 * 绝不读写本机真实的全局配置。自检:git 不可用、或版本过旧不认 GIT_CONFIG_GLOBAL(需 ≥2.32)时返回 null → 用例跳过
 * (否则写操作会落到真实配置上)。
 * @returns {{git: (...args: string[]) => string}|null}
 */
function isolatedGlobalGit(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-cred-'));
  const globalFile = path.join(dir, 'gitconfig');
  fs.writeFileSync(globalFile, '[probe]\n\tisolated = yes\n');
  const prevEnv = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalFile;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevEnv;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 临时目录清理 EPERM 可容忍 */ }
  });
  let isolated = '';
  try {
    isolated = execFileSync('git', ['config', '--global', '--get', 'probe.isolated'], GIT_OPTS).trim();
  } catch { isolated = ''; }
  if (isolated !== 'yes') return null;
  // 读不到/写失败都返回空串(与「未配置」同处理);测试从不打印读回的原值
  return { git: (...a) => { try { return execFileSync('git', ['config', '--global', ...a], GIT_OPTS).trim(); } catch { return ''; } } };
}

/** 桩 fetch:离线,按 `reply` 回包并记录 Authorization 头(testConnection 出站前的白名单校验照常走) */
function stubFetch(t) {
  const realFetch = globalThis.fetch;
  const stub = { reply: { status: 200, body: '[]' }, auth: [] };
  globalThis.fetch = async (url, init) => {
    stub.auth.push(init && init.headers && init.headers.Authorization);
    return new Response(stub.reply.body, { status: stub.reply.status, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return stub;
}

test('未配置 → 配好令牌:设置页/测试连接无需重启即可见,轮询路径不每 tick 起子进程', async (t) => {
  const iso = isolatedGlobalGit(t);
  if (!iso) return t.skip('本机 git 不可用或不支持 GIT_CONFIG_GLOBAL,跳过(避免触碰真实全局配置)');
  const git = iso.git;

  // ---- Arrange
  const baseUrl = `https://cred-lifecycle-${process.pid}.example.test`; // 唯一 baseUrl = 唯一缓存键,不与同进程其它用例串扰
  const cfg = { github: { baseUrl, org: 'some-org', accountType: 'org', hostWhitelist: [new URL(baseUrl).hostname] }, security: { allowedProtocols: ['https'] } };
  const gitKey = `http.${baseUrl}/.extraheader`;
  const UNSET = { configured: false, tail: '', scheme: '' };
  const net = stubFetch(t);
  const authHeadersSeen = net.auth;

  // ---- Act 1:未配置
  const s0 = githubClient.credentialStatus(cfg);
  const t0 = await githubClient.testConnection(cfg);
  // Assert 1
  assert.deepEqual(s0, UNSET);
  assert.equal(t0.hasToken, false);
  assert.equal(authHeadersSeen.at(-1), undefined, '匿名请求不带 Authorization');

  git(gitKey, `Authorization: Bearer ${SECRET}`);

  // ---- Act/Assert 2:轮询路径仍拿到缓存的空值(空值被缓存 = 未配令牌时不会每 tick 起 git 子进程)
  assert.equal(githubClient.readCredential(cfg), null, '轮询路径沿用缓存,不重新读');

  // ---- Act 3:用户主动确认——测试连接 / 设置页,在缓存为空时重新读
  const t1 = await githubClient.testConnection(cfg);
  const s1 = githubClient.credentialStatus(cfg);
  // Assert 3
  assert.equal(t1.ok, true);
  assert.equal(t1.hasToken, true, '配好令牌后测试连接无需重启即按令牌发出');
  assert.equal(authHeadersSeen.at(-1), `Bearer ${SECRET}`, 'Authorization 头取自刚配置的值');
  assert.deepEqual(s1, { configured: true, tail: SECRET.slice(-4), scheme: 'bearer' });

  // ---- Act/Assert 4:读到的新值进缓存 → 轮询路径随即可用(同样无需重启)
  assert.equal(typeof githubClient.readCredential(cfg), 'string', '新值已进缓存');

  // ---- 边界如实记录:已配置的值缓存到进程结束——清除/更换仍需重启(不在本版解决)
  git('--unset', gitKey);
  assert.equal(githubClient.credentialStatus(cfg).configured, true, '正值缓存到进程结束:清除令牌后需重启才回到匿名(页面提示已写明)');
});

test('失败提示可执行:401 仅在确实带了令牌时说「令牌无效」;403 限流按匿名/已配令牌给两种说法', async (t) => {
  const iso = isolatedGlobalGit(t);
  if (!iso) return t.skip('本机 git 不可用或不支持 GIT_CONFIG_GLOBAL,跳过(避免触碰真实全局配置)');
  // Arrange:两个互不相干的缓存键——正值缓存到进程结束,同一个键没法从「已配置」回到「匿名」
  const host = `cred-hints-${process.pid}.example.test`;
  const mkCfg = (h) => ({ github: { baseUrl: `https://${h}`, org: 'some-org', accountType: 'org', hostWhitelist: [h] }, security: { allowedProtocols: ['https'] } });
  const cfgTok = mkCfg(host);
  const cfgAnon = mkCfg(host.replace('cred-hints-', 'cred-hints-anon-'));
  const net = stubFetch(t);
  net.reply = { status: 401, body: JSON.stringify({ message: 'Bad credentials' }) };

  // Act/Assert 1:匿名请求遇到 401(如 GHE 强制认证)——根本没带令牌,不能说「令牌无效」
  const anon401 = await githubClient.testConnection(cfgAnon);
  assert.equal(anon401.hasToken, false);
  assert.doesNotMatch(anon401.error, /令牌无效/, '没带令牌时不该把 401 归因于令牌');

  // Act/Assert 2:带了令牌的 401 → 令牌无效/过期,并给出下一步
  // (git 键 = http.<完整 baseUrl>/.extraheader,含协议头——少写 https:// 会写到另一个键上,读不回来)
  iso.git(`http.https://${host}/.extraheader`, `Authorization: Bearer ${SECRET}`);
  const tok401 = await githubClient.testConnection(cfgTok);
  assert.equal(tok401.ok, false);
  assert.equal(tok401.hasToken, true);
  assert.match(tok401.error, /令牌无效或已过期/);
  assert.match(tok401.error, /重启 DSH/, '已配置的值缓存到进程结束:换令牌必须提示重启');
  assert.ok(!tok401.error.includes(SECRET.slice(4)), '报错文本不含令牌主体');

  // Act/Assert 3:403 限流——已带令牌 / 匿名 两种说法
  net.reply = { status: 403, body: JSON.stringify({ message: 'API rate limit exceeded for 203.0.113.9.' }) };
  const tok403 = await githubClient.testConnection(cfgTok);
  assert.match(tok403.error, /已触发 API 限流/);
  assert.doesNotMatch(tok403.error, /匿名访问限流/, '带了令牌就不该叫用户去配令牌');
  const anon403 = await githubClient.testConnection(cfgAnon);
  assert.equal(anon403.hasToken, false);
  assert.match(anon403.error, /匿名访问限流/);
  assert.match(anon403.error, /配置令牌/, '匿名限流要指向解法');
});
