'use strict';

/**
 * settings.test.js — B5 设置脱敏读写 + deep merge + host 白名单
 * 覆盖：GET 脱敏视图形状（credential 仅来源枚举；WP6：port 退出视图）、PATCH 深合并写回
 *       config.json、host 仅接受 127.0.0.1/0.0.0.0（SPEC-PLUGIN 2.1：业主拍板 LAN 绑定，
 *       其余值 400 HOST_FORBIDDEN 且磁盘不变）、port 静默忽略/白名单/baseUrl 校验。
 * 运行：node --test test/settings.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7794; // 仅作 fixture 配置留痕（进程内装配不再监听端口）

const { buildApp } = require('./helpers/appAssembler');

let app;
let tmpDir;
let configPath;

// WP3：真端口 spawn → 装配器进程内分发（同一 app.handle 管线，断言零改动）
async function api(method, p, body) {
  return app.fetch(method, p, {
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function diskConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-settings-'));
  configPath = path.join(tmpDir, 'config.json');
  // 写入与 §5 一致的完整默认配置，验证 deep merge 不丢节
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      port: PORT,
      host: '127.0.0.1',
      dataDir: 'data',
      webDir: 'web',
      gitea: {
        baseUrl: 'https://gitea.example.com',
        apiPrefix: '/api/v1',
      org: 'example-org',
      pollIntervalSec: 0,
        staleWarnSec: 14400,
        staleDangerSec: 86400,
        hostWhitelist: ['gitea.example.com'],
        activityTypes: ['pr_opened', 'pr_merged', 'commit_pushed', 'branch_created', 'branch_deleted'],
        maxActivities: 500,
      },
      security: {
        allowedProtocols: ['https'],
        credentialSource: 'git-config-extraheader',
        redactKeys: ['Authorization', 'extraheader'],
      },
    })
  );
  app = buildApp({ configPath });
});

test.after(() => {
  if (app) app.close();
});

test('GET /api/settings：脱敏视图，credential 只有来源枚举，无任何凭据值', async () => {
  const r = await api('GET', '/api/settings');
  assert.strictEqual(r.status, 200);
  // WP6 焊死：port 退出设置视图（监听参数归宿主 webServer，不进 config.json/设置面）
  assert.ok(!('port' in r.body), '视图不得再含 port 键');
  assert.strictEqual(r.body.host, '127.0.0.1');
  assert.strictEqual(r.body.credential, 'GIT_CONFIG_EXTRAHEADER');
  assert.deepStrictEqual(r.body.gitea.hostWhitelist, ['gitea.example.com']);
  assert.strictEqual(r.body.gitea.pollIntervalSec, 0);
  assert.strictEqual(r.body.gitea.staleWarnSec, 14400);
  assert.strictEqual(r.body.gitea.staleDangerSec, 86400);
  // 脱敏红线：视图里不允许出现 basic/token 形态的值
  const raw = JSON.stringify(r.body);
  assert.ok(!/basic\s/i.test(raw), '不应包含 basic 凭据');
  assert.ok(!('extraheader' in r.body), '不应出现 extraheader 字段');
});

test('PATCH 深合并：只改 pollIntervalSec，其余 gitea 字段与磁盘文件保持完整', async () => {
  const r = await api('PATCH', '/api/settings', { gitea: { pollIntervalSec: 120 } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.gitea.pollIntervalSec, 120);
  assert.strictEqual(r.body.gitea.baseUrl, 'https://gitea.example.com', '响应中其余字段不变');

  const disk = diskConfig();
  assert.strictEqual(disk.gitea.pollIntervalSec, 120, '磁盘已写回');
  assert.strictEqual(disk.gitea.baseUrl, 'https://gitea.example.com', '深合并不丢 baseUrl');
  assert.strictEqual(disk.gitea.org, 'example-org');
  assert.strictEqual(disk.gitea.staleWarnSec, 14400);
  assert.deepStrictEqual(disk.gitea.activityTypes.length, 5);
  assert.strictEqual(disk.security.credentialSource, 'git-config-extraheader', 'security 节不丢');
});

test('PATCH host：非回环/LAN 白名单值 → 400 HOST_FORBIDDEN 磁盘不变；0.0.0.0 经业主拍板放行（LAN 绑定）', async () => {
  // SPEC-PLUGIN 2.1/2.5：host 校验与宿主 webServer schema 同源（127.0.0.1|0.0.0.0），其余一律拒绝
  const r = await api('PATCH', '/api/settings', { host: '10.0.0.5' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error.code, 'HOST_FORBIDDEN');
  assert.strictEqual(diskConfig().host, '127.0.0.1');

  const lan = await api('PATCH', '/api/settings', { host: '0.0.0.0' });
  assert.strictEqual(lan.status, 200, '0.0.0.0 为显式配置的合法 LAN 绑定值');
  assert.strictEqual(lan.body.host, '0.0.0.0');
  assert.strictEqual(diskConfig().host, '0.0.0.0');
  await api('PATCH', '/api/settings', { host: '127.0.0.1' }); // 还原默认
});

test('WP6：PATCH port 静默忽略（出白名单，不再 400）；白名单/baseUrl 各非法分支 400 且磁盘不变', async () => {
  // port 已退出 config.json 与设置面：PATCH 携带 port 不报错、不生效、不落盘
  const ignorePort = await api('PATCH', '/api/settings', { port: 'abc' });
  assert.strictEqual(ignorePort.status, 200, 'port 出白名单后传入即静默忽略');
  assert.ok(!('port' in ignorePort.body), '响应视图不含 port');
  assert.strictEqual(diskConfig().port, PORT, '磁盘 fixture 留痕的 port 原值不变（未写回新值）');

  const badWl = await api('PATCH', '/api/settings', { gitea: { hostWhitelist: ['localhost'] } });
  assert.strictEqual(badWl.status, 400);
  assert.strictEqual(badWl.body.error.code, 'WHITELIST_INVALID');

  const badWl2 = await api('PATCH', '/api/settings', { gitea: { hostWhitelist: ['10.0.0.1'] } });
  assert.strictEqual(badWl2.status, 400);
  assert.strictEqual(badWl2.body.error.code, 'WHITELIST_INVALID');

  const badUrl = await api('PATCH', '/api/settings', { gitea: { baseUrl: 'http://evil.com' } });
  assert.strictEqual(badUrl.status, 400);
  assert.strictEqual(badUrl.body.error.code, 'HOST_NOT_ALLOWED');

  const badNum = await api('PATCH', '/api/settings', { gitea: { pollIntervalSec: -5 } });
  assert.strictEqual(badNum.status, 400);

  const disk = diskConfig();
  assert.strictEqual(disk.gitea.pollIntervalSec, 120, '失败 PATCH 不落盘');
  assert.deepStrictEqual(disk.gitea.hostWhitelist, ['gitea.example.com']);
});

test('未知 /api/* 与静态缺失路径优雅降级', async () => {
  const nf = await api('GET', '/api/none');
  assert.strictEqual(nf.status, 404);
  // WP3：静态断言指向 plugin/static.js（server.js 与插件 adapter 共用该实现，经同一 handle 管线触达）
  const staticMiss = await app.fetch('GET', '/');
  assert.strictEqual(staticMiss.status, 404, 'web/ 不存在时 / 返回 404 不崩');
  assert.strictEqual(staticMiss.headers.get('x-content-type-options'), 'nosniff', '#18 静态错误响应带安全头');
});

test('#8 PATCH 写回保留未知顶层键与未知嵌套键', async () => {
  // 直接在磁盘配置里塞入 API 不认识的键（模拟人手改 config.json）
  const before = diskConfig();
  before.xCustom = { note: '手改保留', n: 1 };
  before.gitea.yCustom = 'keep-me';
  fs.writeFileSync(configPath, JSON.stringify(before, null, 2));

  const r = await api('PATCH', '/api/settings', { gitea: { pollIntervalSec: 90 } });
  assert.strictEqual(r.status, 200);
  const after = diskConfig();
  assert.deepStrictEqual(after.xCustom, { note: '手改保留', n: 1 }, '未知顶层键不得丢失');
  assert.strictEqual(after.gitea.yCustom, 'keep-me', '未知嵌套键不得丢失');
  assert.strictEqual(after.gitea.pollIntervalSec, 90);
});

test('#10 security 节不可经 API 修改', async () => {
  const r = await api('PATCH', '/api/settings', { security: { redactKeys: [] } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error.code, 'SETTINGS_INVALID');
  assert.deepStrictEqual(diskConfig().security.redactKeys, ['Authorization', 'extraheader'], 'security 未被改动');
});

test('PATCH 合法 host=127.0.0.1 幂等通过；恢复 pollIntervalSec', async () => {
  const r = await api('PATCH', '/api/settings', { host: '127.0.0.1', gitea: { pollIntervalSec: 0 } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.host, '127.0.0.1');
  assert.strictEqual(r.body.gitea.pollIntervalSec, 0);
  assert.strictEqual(diskConfig().gitea.pollIntervalSec, 0);
});

test('v1.5：PATCH dataDir/webDir 只读——忽略不改写，GET/响应回显磁盘原值', async () => {
  // goose 实测回归：一次设置页 PATCH 曾把 config.json 的相对路径持久化为绝对路径
  const r = await api('PATCH', '/api/settings', {
    dataDir: 'X:\\somewhere\\absolute',
    webDir: 'C:\\elsewhere\\web',
    gitea: { pollIntervalSec: 60 },
  });
  assert.strictEqual(r.status, 200, '目录键被静默忽略，不报错');
  assert.strictEqual(r.body.dataDir, 'data', 'PATCH 响应回显磁盘原值');
  const disk = diskConfig();
  assert.strictEqual(disk.dataDir, 'data', 'dataDir 未被改写');
  assert.strictEqual(disk.webDir, 'web', 'webDir 未被改写');
  assert.strictEqual(disk.gitea.pollIntervalSec, 60, '同一请求中其他键照常生效');
  const g = await api('GET', '/api/settings');
  assert.strictEqual(g.body.dataDir, 'data', 'GET 返回原 config 值而非运行期绝对路径');
  await api('PATCH', '/api/settings', { gitea: { pollIntervalSec: 0 } }); // 还原
});

// ---------- 环境体检配套：设置页配置读写白名单补全（dwsBin/dshBin/trustedHosts） ----------

test('PATCH dingtalk.dwsBin / analyze.dshBin：合法值生效、空串重置自动解析默认、非字符串 400', async () => {
  const ok1 = await api('PATCH', '/api/settings', { dingtalk: { dwsBin: 'C:\\tools\\dws.exe' } });
  assert.strictEqual(ok1.status, 200);
  assert.strictEqual(ok1.body.dingtalk.dwsBin, 'C:\\tools\\dws.exe');
  assert.strictEqual(diskConfig().dingtalk.dwsBin, 'C:\\tools\\dws.exe');

  const reset1 = await api('PATCH', '/api/settings', { dingtalk: { dwsBin: '' } });
  assert.strictEqual(reset1.status, 200);
  assert.strictEqual(reset1.body.dingtalk.dwsBin, '', '空串 = 重置为运行时自动解析默认');

  const bad1 = await api('PATCH', '/api/settings', { dingtalk: { dwsBin: 123 } });
  assert.strictEqual(bad1.status, 400);
  assert.strictEqual(bad1.body.error.code, 'SETTINGS_INVALID');

  const ok2 = await api('PATCH', '/api/settings', { analyze: { dshBin: 'D:\\engines\\dsh\\bin.js' } });
  assert.strictEqual(ok2.status, 200);
  assert.strictEqual(ok2.body.analyze.dshBin, 'D:\\engines\\dsh\\bin.js');
  assert.strictEqual(diskConfig().analyze.dshBin, 'D:\\engines\\dsh\\bin.js');

  const bad2 = await api('PATCH', '/api/settings', { analyze: { dshBin: {} } });
  assert.strictEqual(bad2.status, 400);

  const reset2 = await api('PATCH', '/api/settings', { analyze: { dshBin: '' } });
  assert.strictEqual(reset2.status, 200);
  assert.strictEqual(diskConfig().analyze.dshBin, '');
});

test('PATCH security.trustedHosts：域名/IPv4 生效；协议/路径/空格/端口等非法项 400；同节其余键不丢', async () => {
  const ok = await api('PATCH', '/api/settings', {
    security: { trustedHosts: ['fde.corp.example', '192.168.52.206'] },
  });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.body.security.trustedHosts, ['fde.corp.example', '192.168.52.206']);
  assert.deepStrictEqual(diskConfig().security.trustedHosts, ['fde.corp.example', '192.168.52.206']);
  assert.strictEqual(diskConfig().security.credentialSource, 'git-config-extraheader', '同节其余键不受影响');
  assert.deepStrictEqual(diskConfig().security.redactKeys, ['Authorization', 'extraheader']);

  // 反例：协议/路径/空白/端口/userinfo/非字符串/混合合法+非法（一票否决不落盘）
  const bads = [
    ['https://fde.corp'],
    ['fde.corp/path'],
    ['fde corp'],
    ['host.example:8443'],
    ['user@host.example'],
    [''],
    ['ok.example', ''],
    'not-an-array',
  ];
  for (const bad of bads) {
    const r = await api('PATCH', '/api/settings', { security: { trustedHosts: bad } });
    assert.strictEqual(r.status, 400, `非法项 ${JSON.stringify(bad)} 应 400`);
    assert.strictEqual(r.body.error.code, 'WHITELIST_INVALID');
  }
  assert.deepStrictEqual(
    diskConfig().security.trustedHosts,
    ['fde.corp.example', '192.168.52.206'],
    '失败 PATCH 不落盘'
  );

  // 回环字面量恒允许（防线内置）：配置冗余但无害，接受之（防 GET→原样存回被 400）
  const loopback = await api('PATCH', '/api/settings', { security: { trustedHosts: ['localhost', '127.0.0.1'] } });
  assert.strictEqual(loopback.status, 200);
  // 空数组 = 仅回环兜底，允许（重置语义）
  const empty = await api('PATCH', '/api/settings', { security: { trustedHosts: [] } });
  assert.strictEqual(empty.status, 200);
  assert.deepStrictEqual(empty.body.security.trustedHosts, []);
});

test('#10 回归：security 节除 trustedHosts 外仍不可经 API 修改', async () => {
  for (const body of [
    { security: { redactKeys: [] } },
    { security: { allowedProtocols: ['http'] } },
    { security: { credentialSource: 'x' } },
    { security: { trustedHosts: ['ok.example'], redactKeys: [] } },
  ]) {
    const r = await api('PATCH', '/api/settings', body);
    assert.strictEqual(r.status, 400, `${JSON.stringify(body)} 应 400`);
    assert.strictEqual(r.body.error.code, 'SETTINGS_INVALID');
  }
  assert.deepStrictEqual(diskConfig().security.redactKeys, ['Authorization', 'extraheader'], '未落盘');
});

test('GET /api/settings 带出全部可编辑键（dwsBin/dshBin/trustedHosts），回环兜底还原', async () => {
  const patch = await api('PATCH', '/api/settings', {
    dingtalk: { dwsBin: 'C:\\tools\\dws.exe' },
    analyze: { dshBin: 'D:\\e\\bin.js' },
    security: { trustedHosts: ['lan.example'] },
  });
  assert.strictEqual(patch.status, 200);
  const g = await api('GET', '/api/settings');
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.body.dingtalk.dwsBin, 'C:\\tools\\dws.exe');
  assert.strictEqual(g.body.analyze.dshBin, 'D:\\e\\bin.js');
  assert.deepStrictEqual(g.body.security.trustedHosts, ['lan.example']);
  assert.strictEqual(g.body.credential, 'GIT_CONFIG_EXTRAHEADER', 'credential 仍只有来源枚举');
  // 还原默认（dwsBin/dshBin 空串=自动解析；trustedHosts 空数组=仅回环兜底）
  const reset = await api('PATCH', '/api/settings', {
    dingtalk: { dwsBin: '' },
    analyze: { dshBin: '' },
    security: { trustedHosts: [] },
  });
  assert.strictEqual(reset.status, 200);
  assert.strictEqual(reset.body.dingtalk.dwsBin, '');
  assert.strictEqual(reset.body.analyze.dshBin, '');
  assert.deepStrictEqual(reset.body.security.trustedHosts, []);
  const after = await api('GET', '/api/settings');
  assert.deepStrictEqual(after.body.security.trustedHosts, [], 'GET 如实带回重置后的值');
});

test('v2.9.17 GitHub 源页面化：PATCH enabled/org/baseUrl 生效 + 磁盘缺省回填 + 非法键/非法值 400', async () => {
  // 启用 + 组织 + baseUrl（api.github.com 在默认白名单内）
  const ok = await api('PATCH', '/api/settings', {
    github: { enabled: true, org: 'my-org', baseUrl: 'https://api.github.com' },
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.github.enabled, true);
  assert.strictEqual(ok.body.github.org, 'my-org');
  // 磁盘写回：github 节缺省键回填（hostWhitelist/eventsPages 不因局部 PATCH 丢失）
  const disk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
  assert.strictEqual(disk.github.enabled, true);
  assert.deepStrictEqual(disk.github.hostWhitelist, ['api.github.com'], 'hostWhitelist 默认值回填');
  assert.strictEqual(disk.github.eventsPages, 3, 'eventsPages 默认值回填');
  const view = await api('GET', '/api/settings');
  assert.deepStrictEqual(view.body.github.hostWhitelist, ['api.github.com'], 'GET 视图带出白名单');

  // 非法：eventsPages/hostWhitelist 不经 API（保持仅手改口径）
  const foreign = await api('PATCH', '/api/settings', { github: { eventsPages: 5 } });
  assert.strictEqual(foreign.status, 400);
  assert.match(foreign.body.error.message, /不可通过 API 修改/);
  const wl = await api('PATCH', '/api/settings', { github: { hostWhitelist: ['x.example'] } });
  assert.strictEqual(wl.status, 400);
  // 非法：enabled 非布尔 / org 超长 / baseUrl 非 URL / baseUrl host 不在白名单
  assert.strictEqual((await api('PATCH', '/api/settings', { github: { enabled: 'yes' } })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/settings', { github: { org: 'x'.repeat(101) } })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/settings', { github: { baseUrl: 'not-a-url' } })).status, 400);
  const ghe = await api('PATCH', '/api/settings', { github: { baseUrl: 'https://ghe.example.com/api/v3' } });
  assert.strictEqual(ghe.status, 400);
  assert.match(ghe.body.error.message, /不在 github\.hostWhitelist/);
  // 非法：github 节非对象
  assert.strictEqual((await api('PATCH', '/api/settings', { github: 'yes' })).status, 400);

  // 停用 + org 清空（空串 = 清除）
  const off = await api('PATCH', '/api/settings', { github: { enabled: false, org: '' } });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.body.github.enabled, false);
  assert.strictEqual(off.body.github.org, '');
});

test('v2.9.18 Gitee 源页面化：PATCH enabled/org/baseUrl 生效 + 磁盘缺省回填 + 非法键/非法值 400', async () => {
  const ok = await api('PATCH', '/api/settings', {
    gitee: { enabled: true, org: 'demo-gitee-org', baseUrl: 'https://gitee.com' },
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.gitee.enabled, true);
  assert.strictEqual(ok.body.gitee.org, 'demo-gitee-org');
  // 磁盘写回：gitee 节缺省键回填（hostWhitelist/eventsPages 不因局部 PATCH 丢失）
  const disk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
  assert.strictEqual(disk.gitee.enabled, true);
  assert.deepStrictEqual(disk.gitee.hostWhitelist, ['gitee.com'], 'hostWhitelist 默认值回填');
  assert.strictEqual(disk.gitee.eventsPages, 3, 'eventsPages 默认值回填');
  const view = await api('GET', '/api/settings');
  assert.deepStrictEqual(view.body.gitee.hostWhitelist, ['gitee.com'], 'GET 视图带出白名单');
  // 非法：eventsPages/hostWhitelist 不经 API；非法值 400
  assert.strictEqual((await api('PATCH', '/api/settings', { gitee: { eventsPages: 5 } })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/settings', { gitee: { hostWhitelist: ['x.example'] } })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/settings', { gitee: { enabled: 'yes' } })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/settings', { gitee: { org: 'x'.repeat(101) } })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/settings', { gitee: { baseUrl: 'not-a-url' } })).status, 400);
  const foreignHost = await api('PATCH', '/api/settings', { gitee: { baseUrl: 'https://gitee.example.com/api/v5' } });
  assert.strictEqual(foreignHost.status, 400);
  assert.match(foreignHost.body.error.message, /不在 gitee\.hostWhitelist/);
  // 停用 + org 清空
  const off = await api('PATCH', '/api/settings', { gitee: { enabled: false, org: '' } });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.body.gitee.enabled, false);
  assert.strictEqual(off.body.gitee.org, '');
});
