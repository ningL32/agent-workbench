'use strict';

/**
 * webhook-out.test.js — v2.9.27 Webhook 事件出口：出站闸矩阵 + 派发 + 脱敏
 *
 * 覆盖：
 *  - guardWebhookUrl：http(s) 放行；ftp/非法 URL 拒；localhost/[::1]/127.x/10.x/172.16-31/
 *    192.168/169.254/0.x 拒；公网 IPv4 与域名放行
 *  - fireTaskEvents：disabled/url 空/守卫拒/无事件 → 零出网（fetcher 一次都不调）；
 *    enabled + 合法 url → POST JSON（source+events）；fetcher 抛错不外抛；>20 条截断
 *  - scrubUrl：query 值全部 [REDACTED]（webhook token 纪律）
 * 纪律：fetcher 全注入（测试零真实出网）。
 * 运行：node --test test/webhook-out.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { fireTaskEvents, guardWebhookUrl, scrubUrl } = require('../lib/webhookOut');

const EVENTS = [{ taskId: 't-1', type: 'artifact', detail: '挂接成果：commit', at: '2026-10-31T00:00:00.000Z' }];

test('guardWebhookUrl 出站闸矩阵', () => {
  assert.equal(guardWebhookUrl('https://hooks.slack.com/services/x/y/z').ok, true, '公网 https 放行');
  assert.equal(guardWebhookUrl('http://example.com/hook').ok, true, '公网 http 放行');
  assert.equal(guardWebhookUrl('ftp://example.com').ok, false, '非 http(s) 拒');
  assert.equal(guardWebhookUrl('not a url').ok, false, '解析失败拒');
  assert.equal(guardWebhookUrl('http://localhost/hook').ok, false);
  assert.equal(guardWebhookUrl('http://api.localhost/hook').ok, false);
  assert.equal(guardWebhookUrl('http://[::1]/hook').ok, false);
  assert.equal(guardWebhookUrl('http://127.0.0.1/hook').ok, false);
  assert.equal(guardWebhookUrl('http://10.1.2.3/hook').ok, false);
  assert.equal(guardWebhookUrl('http://172.16.0.9/hook').ok, false);
  assert.equal(guardWebhookUrl('http://172.32.0.9/hook').ok, true, '172.32 不在私网段');
  assert.equal(guardWebhookUrl('http://192.168.1.1/hook').ok, false);
  assert.equal(guardWebhookUrl('http://169.254.169.254/meta').ok, false, '云元数据端点拒');
  assert.equal(guardWebhookUrl('http://0.0.0.0/hook').ok, false);
});

test('fireTaskEvents：disabled / url 空 / 守卫拒 / 无事件 → fetcher 零调用', () => {
  let calls = 0;
  const fetcher = () => { calls += 1; return Promise.resolve({ status: 200 }); };
  assert.equal(fireTaskEvents({ webhookOut: { enabled: false, url: 'https://x.com' } }, EVENTS, { fetcher }).fired, 0);
  assert.equal(fireTaskEvents({ webhookOut: { enabled: true, url: '' } }, EVENTS, { fetcher }).fired, 0);
  assert.equal(fireTaskEvents({ webhookOut: { enabled: true, url: 'http://127.0.0.1/hook' } }, EVENTS, { fetcher }).fired, 0, '守卫拒');
  assert.equal(fireTaskEvents({ webhookOut: { enabled: true, url: 'https://x.com/hook' } }, [], { fetcher }).fired, 0, '无事件');
  assert.equal(calls, 0, '零出网');
});

test('fireTaskEvents：enabled + 合法 url → fetcher 收到 POST JSON（source+events）', async () => {
  let captured = null;
  const fetcher = (url, init) => {
    captured = { url, init };
    return Promise.resolve({ status: 200 });
  };
  const r = fireTaskEvents(
    { webhookOut: { enabled: true, url: 'https://hooks.example.com/abc?token=secret123' } },
    EVENTS,
    { fetcher }
  );
  assert.equal(r.fired, 1);
  await new Promise((res) => setTimeout(res, 30)); // fire-and-forget 异步落地
  assert.ok(captured);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.source, 'fde-console');
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].taskId, 't-1');
  assert.ok(!captured.init.body.includes('secret123'), 'body 不带 URL 里的 token（token 在 url 由下游校验）');
});

test('fireTaskEvents：fetcher 抛错不外抛；事件 >20 条截断', async () => {
  const boom = () => Promise.reject(new Error('down'));
  assert.doesNotThrow(() => fireTaskEvents({ webhookOut: { enabled: true, url: 'https://x.com' } }, EVENTS, { fetcher: boom }));
  const many = Array.from({ length: 50 }, (_, i) => ({ taskId: 't', type: 'memo', detail: String(i), at: 'x' }));
  let seen = null;
  const fetcher = (url, init) => { seen = JSON.parse(init.body); return Promise.resolve({ status: 200 }); };
  const r = fireTaskEvents({ webhookOut: { enabled: true, url: 'https://x.com' } }, many, { fetcher });
  assert.equal(r.fired, 20, '截到 20 条');
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(seen.events.length, 20);
});

test('scrubUrl：query 值全部 [REDACTED]', () => {
  const out = scrubUrl('https://hooks.example.com/abc?token=secret123&wait=true');
  assert.ok(!out.includes('secret123'));
  assert.ok(out.includes('token=%5BREDACTED%5D') || out.includes('token=[REDACTED]'));
});

// ---------- v2.9.29 D1：config 懒加载器 TTL 缓存（写路径禁用态零同步读盘） ----------

test('fireTaskEvents(configLoader)：TTL 内 loader 只调一次；空事件列表不碰 loader', async () => {
  const { clearConfigCache } = require('../lib/webhookOut');
  clearConfigCache();
  let loads = 0;
  const loader = () => { loads += 1; return { webhookOut: { enabled: false, url: 'https://x.com' } }; };
  const fetcher = () => Promise.resolve({ status: 200 });
  // 禁用态连发 3 次事件 → loader 只在首次真实调用（TTL 缓存）
  fireTaskEvents(loader, EVENTS, { fetcher });
  fireTaskEvents(loader, EVENTS, { fetcher });
  fireTaskEvents(loader, EVENTS, { fetcher });
  assert.equal(loads, 1, 'TTL 内配置只读一次');
  // 无事件 → 不碰 loader（零成本闸在前）
  const loadsBefore = loads;
  fireTaskEvents(loader, [], { fetcher });
  assert.equal(loads, loadsBefore);
  // loader 抛错 → 视为关闭不外抛
  const boom = () => { throw new Error('config gone'); };
  assert.doesNotThrow(() => fireTaskEvents(boom, EVENTS, { fetcher }));
  // TTL 过期后重读（用真实时钟推进不了 60s——clearConfigCache 模拟过期）
  clearConfigCache();
  const loader2 = () => { loads += 1; return { webhookOut: { enabled: false } }; };
  fireTaskEvents(loader2, EVENTS, { fetcher });
  assert.equal(loads, 2, '缓存失效后重读');
});
