'use strict';

/**
 * setup-check.test.js — 环境体检聚合（GET /api/setup/check）
 * 覆盖：五项聚合形状与固定顺序、注入探测全 ok、单项失败带 hint 且互不阻塞、
 *       探测抛错降级（detail 过 redact）、llmRoute 文件级判定（注入 existsSync）、
 *       gitea 3s 超时/401 hint 映射/HOST_NOT_ALLOWED、路由级离线冒烟
 *       （GITEA_FIXTURE 零出网，node/gitea 如实 ok；v2.2 起 cliGateway 项已随 网关集成移除）。
 * 运行：node --test test/setup-check.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runSetupCheck,
  probeLlmRoute,
  probeGitea,
  dshHomeDir,
  HINTS,
} = require('../lib/setupCheck');
const { registerSecret, clearSecrets } = require('../lib/redact');
const { buildApp } = require('./helpers/appAssembler');

const okProbe = (detail) => async () => ({ ok: true, detail, hint: null });

test('runSetupCheck 全 ok：六项、固定顺序、顶层形状完整', async () => {
  const r = await runSetupCheck({}, {
    probeNode: okProbe('node-detail'),
    probeDws: okProbe('dws-detail'),
    probeLarkCli: okProbe('lark-detail'),
    probeDsh: okProbe('dsh-detail'),
    probeLlmRoute: okProbe('llm-detail'),
    probeGitea: okProbe('gitea-detail'),
  });
  assert.strictEqual(r.allOk, true);
  assert.deepStrictEqual(
    r.items.map((i) => i.id),
    ['node', 'dws', 'larkcli', 'dsh', 'llmRoute', 'gitea'],
    '六项 id 与顺序为前端契约（2026-11-03 增 larkcli 飞书采集项）'
  );
  for (const item of r.items) {
    assert.strictEqual(typeof item.name, 'string');
    assert.ok(item.name.length > 0);
    assert.strictEqual(item.ok, true);
    assert.strictEqual(typeof item.detail, 'string');
    assert.strictEqual(item.hint, null);
  }
  assert.strictEqual(typeof r.checkedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(r.checkedAt)), 'checkedAt 为 ISO 时间戳');
});

test('单项失败：携带中文 hint，其余项不受影响（互不阻塞），allOk=false', async () => {
  const r = await runSetupCheck({}, {
    probeNode: okProbe('ok'),
    probeDws: okProbe('ok'),
    probeLarkCli: okProbe('ok'),
    probeDsh: async () => ({ ok: false, detail: '未找到 dsh 引擎入口', hint: HINTS.dsh }),
    probeLlmRoute: okProbe('ok'),
    probeGitea: okProbe('ok'),
  });
  assert.strictEqual(r.allOk, false);
  const dsh = r.items.find((i) => i.id === 'dsh');
  assert.strictEqual(dsh.ok, false);
  assert.strictEqual(dsh.hint, 'dsh 未安装（npm i -g @deepseek-ai/dsh）');
  assert.strictEqual(r.items.filter((i) => i.ok).length, 5, '其余五项不受影响');
});

test('探测抛错：降级为 ok:false + 兜底 hint，detail 过 redact 不泄凭据', async () => {
  registerSecret('topsecret-credential-value');
  try {
    const r = await runSetupCheck({}, {
      probeNode: okProbe('ok'),
      probeDws: async () => {
        throw new Error('dws 探测炸了 credential=topsecret-credential-value');
      },
      probeLarkCli: okProbe('ok'),
      probeDsh: okProbe('ok'),
      probeLlmRoute: okProbe('ok'),
      probeGitea: okProbe('ok'),
    });
    const dws = r.items.find((i) => i.id === 'dws');
    assert.strictEqual(dws.ok, false);
    assert.strictEqual(dws.hint, HINTS.dws, '抛错也回退到该项修复指引');
    assert.ok(!dws.detail.includes('topsecret-credential-value'), 'detail 不得回显凭据值');
    assert.ok(dws.detail.includes('[REDACTED]'), 'detail 经 redact 脱敏');
    assert.strictEqual(r.items.filter((i) => i.ok).length, 5, '单项抛错不阻塞其余项');
  } finally {
    clearSecrets();
  }
});

test('可选组件口径：probeDws/probeLarkCli 返回 optional missing → ok:true 不卡 allOk（开源用户零噪音）', async () => {
  const r = await runSetupCheck({}, {
    probeNode: okProbe('ok'),
    probeDws: async () => ({ ok: true, optional: true, detail: '未安装（可选）', hint: HINTS.dws }),
    probeLarkCli: async () => ({ ok: true, optional: true, detail: '未安装（可选）', hint: HINTS.larkcli }),
    probeDsh: okProbe('ok'),
    probeLlmRoute: okProbe('ok'),
    probeGitea: okProbe('ok'),
  });
  assert.strictEqual(r.allOk, true, '可选组件未安装不得卡整体体检');
  const dws = r.items.find((i) => i.id === 'dws');
  assert.strictEqual(dws.ok, true);
  assert.strictEqual(dws.optional, true, 'optional 标记透传给前端');
});

test('probeLlmRoute：旧口径两文件齐 ok；0.2.1+ 认 profile 的 agent-default-model 行；都没有才失败', () => {
  const dir = path.join(os.tmpdir(), 'fde-dsh-home-fake');
  const existsBoth = (p) => p === path.join(dir, 'settings.yaml') || p === path.join(dir, '.credentials.yaml');
  const onlySettings = (p) => p === path.join(dir, 'settings.yaml');

  const both = probeLlmRoute({}, { existsSync: existsBoth, dshHomeDir: dir });
  assert.strictEqual(both.ok, true);
  assert.strictEqual(both.hint, null);

  const missingCred = probeLlmRoute({}, { existsSync: onlySettings, dshHomeDir: dir });
  assert.strictEqual(missingCred.ok, false);
  assert.ok(missingCred.detail.includes('.credentials.yaml'), 'detail 指出缺失文件');
  assert.ok(!missingCred.detail.includes(' settings.yaml 存在'), 'detail 不误报存在文件');
  assert.strictEqual(missingCred.hint, HINTS.llmRoute);

  const none = probeLlmRoute({}, { existsSync: () => false, dshHomeDir: dir });
  assert.strictEqual(none.ok, false);
  assert.ok(none.detail.includes('settings.yaml、.credentials.yaml'), '两文件均缺失时 detail 一并列出');
  assert.strictEqual(none.hint, HINTS.llmRoute);

  // 0.2.1+：settings.yaml 不存在，但 profile 的 cordis.patch.yml 有 agent-default-model 行 → 必须判 ok
  //（2026-10-31 业主实测误报：桌面 profile 里 provider=deepseek-account / model=deepseek-flash）
  const profileYml = path.join(dir, 'profiles', 'desktop', 'cordis.patch.yml');
  const yml = [
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: deepseek-account',
    '    model: deepseek-flash',
  ].join('\n');
  const modern = probeLlmRoute(
    {},
    {
      existsSync: (p) => p === path.join(dir, '.credentials.yaml'),
      dshHomeDir: dir,
      profile: 'desktop',
      readFileSync: (p) => {
        if (p === profileYml) return yml;
        throw new Error(`unexpected read: ${p}`);
      },
    }
  );
  assert.strictEqual(modern.ok, true, 'profile 里有模型路由就必须判 ok，否则宿主在跑而体检报「未配置」');
  assert.match(modern.detail, /deepseek-account \/ deepseek-flash/);

  assert.strictEqual(dshHomeDir().endsWith(path.join('.dsh')), true, '缺省目录锚定 ~/.dsh');
});

test('probeGitea：ok 带 latency/apiVersion；401 hint 按状态区分；3s 预算超时按失败表达', async () => {
  const cfg = { gitea: { baseUrl: 'https://gitea.example.com' } };

  const good = await probeGitea(cfg, {
    giteaTest: async () => ({ ok: true, latencyMs: 12, apiVersion: '1.22.0' }),
  });
  assert.strictEqual(good.ok, true);
  assert.ok(good.detail.includes('12ms'));
  assert.ok(good.detail.includes('1.22.0'));
  assert.strictEqual(good.hint, null);

  const unauthorized = await probeGitea(cfg, {
    giteaTest: async () => ({ ok: false, latencyMs: 30, error: 'Gitea HTTP 401 Unauthorized (…)' }),
  });
  assert.strictEqual(unauthorized.ok, false);
  assert.ok(
    unauthorized.hint.includes('凭据') && unauthorized.hint.includes('git config --global http.<baseUrl>/.extraheader'),
    `401 → 凭据指引（含凭据管理器与 extraheader 两种来源），实际：${unauthorized.hint}`
  );

  const notFound = await probeGitea(cfg, {
    giteaTest: async () => ({ ok: false, error: 'Gitea HTTP 404 Not Found' }),
  });
  assert.ok(notFound.hint.includes('baseUrl / apiPrefix'), '404 → 地址/前缀指引');

  const blocked = await probeGitea(cfg, {
    giteaTest: async () => {
      const e = new Error('host 不在白名单: gitea.example.com');
      e.code = 'HOST_NOT_ALLOWED';
      throw e;
    },
  });
  assert.strictEqual(blocked.ok, false);
  assert.ok(blocked.hint.includes('hostWhitelist'), '白名单外 → 白名单指引');

  const slow = await probeGitea(cfg, {
    giteaTimeoutMs: 40,
    giteaTest: () => new Promise(() => {}), // 永不 resolve
  });
  assert.strictEqual(slow.ok, false, '超过 3s 预算按失败表达（不无限等待内部 5s）');
  assert.ok(slow.detail.includes('超时'));

  const noBase = await probeGitea({ gitea: {} }, {});
  assert.strictEqual(noBase.ok, false);
  assert.ok(noBase.hint.includes('baseUrl'));
});

test('路由级 GET /api/setup/check：200 + 六项齐全 + fixture 项如实 ok（零出网）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-setupcheck-'));
  const fixturePath = path.join(tmpDir, 'gitea-fixture.json');
  // 与 test/fixtures/gitea.json 同形：version.version 即 API 版本
  fs.writeFileSync(fixturePath, JSON.stringify({ version: { version: '1.22.0' } }));
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      port: 7788,
      host: '127.0.0.1',
      dataDir: 'data',
      webDir: 'web',
      gitea: {
        baseUrl: 'https://gitea.example.com',
        apiPrefix: '/api/v1',
        org: 'example-org',
        hostWhitelist: ['gitea.example.com'],
        pollIntervalSec: 0,
      },
      security: { allowedProtocols: ['https'] },
    })
  );

  const app = buildApp({
    configPath,
    poller: 'manual',
    env: { GITEA_FIXTURE: fixturePath },
  });
  try {
    const r = await app.fetch('GET', '/api/setup/check');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(typeof r.body.allOk, 'boolean');
    assert.deepStrictEqual(
      r.body.items.map((i) => i.id),
      ['node', 'dws', 'larkcli', 'dsh', 'llmRoute', 'gitea']
    );
    const byId = Object.fromEntries(r.body.items.map((i) => [i.id, i]));

    // 恒 ok 项
    assert.strictEqual(byId.node.ok, true);
    assert.ok(byId.node.detail.includes(process.version));
    // fixture 注入项（离线确定性）
    assert.strictEqual(byId.gitea.ok, true, 'GITEA_FIXTURE → 零出网直接 ok');
    assert.ok(byId.gitea.detail.includes('1.22.0'));
    // 环境相关项（不同机器结果不同）：只验契约形状，不验结果
    for (const id of ['dws', 'larkcli', 'dsh', 'llmRoute']) {
      assert.strictEqual(typeof byId[id].ok, 'boolean');
      assert.strictEqual(typeof byId[id].detail, 'string');
      assert.ok(byId[id].ok === false ? typeof byId[id].hint === 'string' : true, '失败项必带 hint');
    }
  } finally {
    app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
