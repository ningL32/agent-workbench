'use strict';

/**
 * feishu-envelope.test.js — 飞书适配器模块级单测（全离线）
 * 形态口径 = 2026-11-03 真机样本校准：列表条目 token/display_info/meta_data.app_link；
 * 逐字稿行「Speaker 1 00:00:02.520」独立行 + 内容行 + 头部元信息。
 * 覆盖：envelope 解包、逐字稿解析（说话人行/头部丢弃/续行归并/时间锚定/空段过滤）、
 *       标题/开始时间/URL 提取、身份哈希稳定性、分窗约束（≤31 天、首窗含今天）。
 * 运行：node --test test/feishu-envelope.test.js （零进程零出网）
 */

const test = require('node:test');
const assert = require('node:assert');

const feishu = require('../lib/feishu');

// ---------------------------------------------------------------- envelope

test('unwrapLarkPayload: ok:false 抛 LARK_ERROR 且带 error.message', () => {
  assert.throws(
    () => feishu.unwrapLarkPayload({ ok: false, error: { type: 'auth', subtype: 'token_expired', message: '登录已过期', hint: 're-login' } }),
    (e) => e.code === 'LARK_ERROR' && /登录已过期/.test(e.message)
  );
});

test('unwrapLarkPayload: ok:true 取 data；非信封（老版直出）原样返回', () => {
  assert.deepStrictEqual(feishu.unwrapLarkPayload({ ok: true, identity: 'user', data: { items: [] } }), { items: [] });
  assert.deepStrictEqual(feishu.unwrapLarkPayload({ list: [] }), { list: [] });
  assert.deepStrictEqual(feishu.unwrapLarkPayload(null), null);
});

test('larkErrorDetail: 从 stdout JSON 提取 error.message', () => {
  assert.strictEqual(
    feishu.larkErrorDetail('{"ok":false,"error":{"type":"auth","message":"permission denied"}}'),
    'permission denied'
  );
  assert.strictEqual(feishu.larkErrorDetail('not json at all'), '');
});

// ---------------------------------------------------------------- 逐字稿解析（真实 Speaker 行格式）
// 结构口径取自 2026-11-03 真机样本；文本内容已合成化（开源发布面不含真实会议原话）

const REAL_TRANSCRIPT = [
  '2026-11-03 10:40:29 CST|5min 32s',
  '',
  'Keywords:',
  '示例关键词一、示例关键词二、示例关键词三',
  '',
  'Speaker 1 00:00:02.520 ',
  '开场示例发言第一句，用于验证分段。',
  '',
  'Speaker 1 00:01:47.840 ',
  '第二段示例发言，讨论示例议题。',
  '这一行没有说话人前缀，应续接上一段。',
].join('\n');

test('parseTranscript: Speaker 行分段、头部元信息丢弃、续行归并', () => {
  const segs = feishu.parseTranscript(REAL_TRANSCRIPT, null);
  assert.strictEqual(segs.length, 2);
  assert.deepStrictEqual(segs.map((s) => s.raw), ['Speaker 1', 'Speaker 1']);
  assert.strictEqual(segs[0].text, '开场示例发言第一句，用于验证分段。');
  assert.ok(segs[1].text.includes('第二段示例发言'));
  assert.ok(segs[1].text.includes('这一行没有说话人前缀，应续接上一段。'), '无说话人行的后续行续接上一段');
});

test('parseTranscript: at = 妙记开始时刻 + 行内偏移；无锚点 at=null（时区无关断言）', () => {
  const anchor = feishu.startedMsFromInfo('所有者: 测试 开始时间: 2026.11.03 10:40:29 时长: 5 分');
  assert.strictEqual(anchor, new Date(2026, 10, 3, 10, 40, 29).getTime());
  const segs = feishu.parseTranscript(REAL_TRANSCRIPT, anchor);
  // 期望值由锚点+偏移现算（不得硬编码 UTC 串——非东八区机器必红，评审 P2）
  assert.strictEqual(segs[0].at, new Date(anchor + 2520).toISOString()); // 00:00:02.520
  assert.strictEqual(segs[1].at, new Date(anchor + 107840).toISOString()); // 00:01:47.840
  const noAnchor = feishu.parseTranscript(REAL_TRANSCRIPT, null);
  assert.strictEqual(noAnchor[0].at, null);
});

test('parseTranscript: 空输入/无 Speaker 行 → 空数组（normalizeMinute 判 null 的前提，头部不误入池）', () => {
  assert.deepStrictEqual(feishu.parseTranscript('', null), []);
  assert.deepStrictEqual(feishu.parseTranscript(null, null), []);
  assert.deepStrictEqual(feishu.parseTranscript('2026-11-03 10:40:29 CST|5min\n\nKeywords:\n钉钉', null), []);
});

test('parseTranscript: 内容行含冒号不误切（真实格式只有 Speaker 行开新段）', () => {
  const t = 'Speaker 1 00:00:01.000 \n赵六：大家好。\n王五：好的。';
  const segs = feishu.parseTranscript(t, null);
  assert.strictEqual(segs.length, 1);
  assert.ok(segs[0].text.includes('赵六：大家好。'));
  assert.ok(segs[0].text.includes('王五：好的。'));
});

// ---------------------------------------------------------------- 真实列表条目形态

const REAL_ITEM = {
  token: 'obcdemo123456demo7890',
  display_info: '示例：录音时长相关讨论\n<b>关键词:</b> 示例，权限，飞书\n所有者: 示例团队 开始时间: 2026.11.03 10:40:29 时长: 5 分 32 秒',
  meta_data: {
    app_link: 'https://demo.example.feishu.cn/minutes/obcdemo123456demo7890',
    description: '所有者: 示例团队 开始时间: 2026.11.03 10:40:29 时长: 5 分 32 秒',
  },
};

test('titleOf: display_info 首行即标题（剥 HTML 标签）；item.title 优先', () => {
  assert.strictEqual(feishu.titleOf(REAL_ITEM), '示例：录音时长相关讨论');
  assert.strictEqual(feishu.titleOf({ title: '显式标题', display_info: '忽略我\n第二行' }), '显式标题');
  assert.strictEqual(feishu.titleOf({}), '未命名妙记');
});

test('startedMsOf: 毫秒字段 → ISO 串 → display_info/meta_data 的「开始时间: …」文本（本地时区）', () => {
  assert.strictEqual(feishu.startedMsOf(REAL_ITEM), new Date(2026, 10, 3, 10, 40, 29).getTime());
  assert.strictEqual(feishu.startedMsOf({ start_time: 1730000000000 }), 1730000000000);
  assert.strictEqual(feishu.startedMsOf({ startTime: '2026-01-02T03:04:05Z' }), Date.parse('2026-01-02T03:04:05Z'));
  assert.strictEqual(feishu.startedMsOf({}), null);
});

test('startedMsFromInfo: 真实文本口径；缺时间部分/无关键字返回 null', () => {
  assert.strictEqual(
    feishu.startedMsFromInfo('所有者: AI团队赵六 开始时间: 2026.11.03 10:40:29 时长: 5 分 32 秒'),
    new Date(2026, 10, 3, 10, 40, 29).getTime()
  );
  assert.strictEqual(feishu.startedMsFromInfo('没有时间关键字的文本'), null);
  assert.strictEqual(feishu.startedMsFromInfo('开始时间: 未知格式'), null);
});

test('urlOf: meta_data.app_link 命中；无 http 候选返回空串', () => {
  assert.strictEqual(feishu.urlOf(REAL_ITEM), 'https://demo.example.feishu.cn/minutes/obcdemo123456demo7890');
  assert.strictEqual(feishu.urlOf({ meta_data: { app_link: '' } }), '');
  assert.strictEqual(feishu.urlOf({}), '');
});

// ---------------------------------------------------------------- 身份哈希

test('messageIdFor: 同条目恒同哈希；token/时间变化即换 id；标题变化不换 id（改名防双份，评审 P2）', () => {
  const a = feishu.messageIdFor(REAL_ITEM);
  const b = feishu.messageIdFor({ ...REAL_ITEM });
  assert.strictEqual(a.id, b.id);
  assert.match(a.id, /^msg-[0-9a-f]{16}$/);
  const c = feishu.messageIdFor({ ...REAL_ITEM, token: 'obczzzzzzzzzzzzzzzz' });
  assert.notStrictEqual(a.id, c.id);
  const d = feishu.messageIdFor({ ...REAL_ITEM, display_info: '改了标题\n所有者: 示例团队 开始时间: 2026.11.03 10:40:29' });
  assert.strictEqual(a.id, d.id, '妙记改名不得换 id（否则同条双份入库、墓碑失效）');
  // 旧形态字段（minute_token/start_time）仍兼容
  const legacy = feishu.messageIdFor({ minute_token: 'obcabc12345', start_time: 1736102400000 });
  assert.match(legacy.id, /^msg-[0-9a-f]{16}$/);
});

test('startedMsOf: 秒级时间戳自动升幂到毫秒（单位归一，防全池换 id——评审 P2）', () => {
  const sec = 1736102400; // 秒
  assert.strictEqual(feishu.startedMsOf({ start_time: sec }), 1736102400000);
  assert.strictEqual(feishu.startedMsOf({ start_time: 1736102400000 }), 1736102400000, '毫秒量级不动');
});

// ---------------------------------------------------------------- 分窗

test('monthlyChunks: 90 天切 3 窗、每窗跨度 ≤31 天、首窗含今天（时区回归锚）', () => {
  const chunks = feishu.monthlyChunks(90);
  assert.strictEqual(chunks.length, 3);
  for (const c of chunks) {
    const span = (Date.parse(c.end) - Date.parse(c.start)) / 86400000;
    assert.ok(span >= 26 && span <= 31, `窗口跨度 ${span} 天应在 ≤31 天约束内（首窗允许收口到回溯下界）`);
  }
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.ok(chunks[0].start <= today && today <= chunks[0].end, `首窗 [${chunks[0].start}..${chunks[0].end}] 必须含今天 ${today}`);
});

test('monthlyChunks: 小回溯按需收口（lookbackDays=7 → 单窗 7 天而非 31 天，评审 P2）；越界值钳制', () => {
  const chunks = feishu.monthlyChunks(7);
  assert.strictEqual(chunks.length, 1);
  const span = (Date.parse(chunks[0].end) - Date.parse(chunks[0].start)) / 86400000;
  assert.ok(span >= 6 && span <= 7, `7 天回溯的实际窗跨度应≈7 天，实得 ${span}`);
  assert.strictEqual(feishu.monthlyChunks(0).length, 3); // 0 → 缺省 90
  assert.ok(feishu.monthlyChunks(400).length > 10); // 365 天 → 12 窗
});

// ------------------------------------------------------- minute_token 红线

test('fetchTranscript: 非法 token 在进子进程前即拒绝（真实模式，不 spawn）', async () => {
  await assert.rejects(
    () => feishu.fetchTranscript({ feishu: {} }, '../evil', null),
    (e) => /minute_token 形态非法/.test(e.message)
  );
});
