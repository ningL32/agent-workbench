'use strict';

/**
 * seed-demo.js — 演示数据集灌入（开源发布工程 2026-11-03）
 *
 * 给 fresh clone 的用户一键灌一份全合成演示数据（零真实信息、零出网），启动实例即可看到
 * 非空的看板/成员/雷达池/收件箱。数据全部为教科书级占位（李雷/韩梅梅/example-org/demo-*）。
 *
 * 用法：
 *   node scripts/seed-demo.js [--data-dir <目录>] [--force]
 *   缺省 --data-dir = ~/.dsh/fde-console/data（与实例缺省落点一致）
 *
 * ⚠ 存储双轨须知：本脚本走 store JSON 通道（与「未迁移实例」读路径一致）。目标目录若已迁移
 *   SQLite（存在 fde.db），JSON 灌数对实例不可见——脚本会拒绝并提示换新目录。
 *
 * 幂等性：非 --force 时，目标目录已有 tasks.json 则拒绝（防覆盖真实数据）。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');

function argOf(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(name);

const dataDir = path.resolve(argOf('--data-dir', path.join(os.homedir(), '.dsh', 'fde-console', 'data')));
const force = hasFlag('--force');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// ---- 守卫 ----
if (fs.existsSync(path.join(dataDir, 'fde.db'))) {
  console.error('✗ 目标目录已迁移 SQLite（存在 fde.db）：演示数据走 JSON 通道对实例不可见。');
  console.error('  请改用全新目录，例如：node scripts/seed-demo.js --data-dir "%TEMP%\\fde-demo-data"');
  process.exit(2);
}
if (!force && fs.existsSync(path.join(dataDir, 'tasks.json'))) {
  console.error('✗ 目标目录已有 tasks.json（可能含真实数据）。确认覆盖请加 --force。');
  process.exit(2);
}

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const H = 3600e3;
const D = 24 * H;
const dayStr = (offsetDays) => {
  const d = new Date(now + offsetDays * D);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const ctx = {
  tasksPath: path.join(dataDir, 'tasks.json'),
  inboxPath: path.join(dataDir, 'inbox.json'),
  // membersPath 不在 data/ —— 运行时从 configDir（dataDir 的上级）读成员册（appAssembler 口径）；
  // 评审 P1 修正：写进 data/members.json 实例永不读，演示名册落空
  membersPath: path.join(path.dirname(dataDir), 'members.json'),
  messagesPath: path.join(dataDir, 'messages.json'),
  activitiesPath: path.join(dataDir, 'activities.json'),
};

// ---- 成员（human 两名；硅基成员由本机桌面 agent 探测自动派生，无需灌数） ----
store.saveMembers(
  ctx.membersPath,
  [
    { id: 'lilei', name: '李雷', role: '产品', giteaLogin: 'lilei', enabled: true, aliases: [] },
    { id: 'hanmeimei', name: '韩梅梅', role: '研发', giteaLogin: 'hanmeimei', enabled: true, aliases: [] },
  ]
);

// ---- 任务（覆盖四列分布 + 一条逾期 + 优先级/负责人样例） ----
const { columns } = store.loadTasks(ctx);
const tasks = [
  { id: 't-demo0001-aaaa', title: '演示：官网首页改版', desc: '落地页文案与新视觉稿对齐（演示数据）', status: 'doing', priority: 'high', memberId: 'lilei', dueDate: dayStr(-2), createdAt: iso(3 * D), updatedAt: iso(2 * H), artifacts: [] },
  { id: 't-demo0002-bbbb', title: '演示：移动端适配', desc: '断点检查与触控目标尺寸（演示数据）', status: 'doing', priority: 'medium', memberId: 'hanmeimei', dueDate: dayStr(3), createdAt: iso(2 * D), updatedAt: iso(4 * H), artifacts: [] },
  { id: 't-demo0003-cccc', title: '演示：登录流程重构', desc: 'OAuth 接入与失败分支（演示数据）', status: 'review', priority: 'high', agentId: 'zcode', dueDate: dayStr(1), createdAt: iso(4 * D), updatedAt: iso(1 * H), artifacts: [] },
  { id: 't-demo0004-dddd', title: '演示：数据看板 0.9', desc: '图表选型与空态（演示数据）', status: 'todo', priority: 'medium', memberId: 'lilei', dueDate: null, createdAt: iso(1 * D), updatedAt: iso(1 * D), artifacts: [] },
  { id: 't-demo0005-eeee', title: '演示：消息通知去重', desc: '同源合并策略（演示数据）', status: 'todo', priority: 'low', memberId: 'hanmeimei', dueDate: null, createdAt: iso(H), updatedAt: iso(H), artifacts: [] },
  { id: 't-demo0006-ffff', title: '演示：崩溃率治理', desc: '已随 0.8.2 发布（演示数据）', status: 'done', priority: 'high', memberId: 'hanmeimei', dueDate: dayStr(-5), createdAt: iso(6 * D), updatedAt: iso(1 * D), artifacts: [] },
];
store.saveTasks(ctx, { columns, tasks });

// ---- 纪要池（两条合成转写，source:'text' 形态——分析管线源无关，勾选即可走 AI 拆解） ----
function demoMessage(id, title, occurredAt, segments) {
  const content = segments.map((s) => `【${s.raw}】${s.text}`).join('\n');
  return {
    id,
    source: 'text',
    kind: 'minutes',
    title,
    speakerSegments: segments.map((s) => ({ raw: s.raw, memberId: null, text: s.text, at: null })),
    content,
    occurredAt,
    ref: {},
    contentHash: require('node:crypto').createHash('sha256').update(content).digest('hex'),
    truncated: false,
    analyzedAt: null,
    analyzeState: '',
    analyzeError: null,
    noise: [],
  };
}
const messages = [
  demoMessage('msg-demomins01aa', '演示：周会纪要（产品节奏对齐）', iso(1 * D), [
    { raw: '李雷', text: '首页改版这周必须上线，移动端适配跟进断点清单。' },
    { raw: '韩梅梅', text: '登录重构已提测，崩溃率治理版本今天发布。' },
    { raw: '李雷', text: '那把消息通知去重排进下个迭代。' },
  ]),
  demoMessage('msg-demomins02bb', '演示：评审会纪要（数据看板 0.9）', iso(2 * D), [
    { raw: '韩梅梅', text: '图表库选型定了，空态和加载态一起做。' },
    { raw: '李雷', text: '先出两个核心图的灰度。' },
  ]),
];
store.saveMessages(ctx, messages);

// ---- 收件箱候选（3 条 pending；字段形状对齐 analyze 管线产物） ----
const inbox = [
  {
    id: 'cand-demo01aaaa',
    messageId: 'msg-demomins01aa',
    messageTitle: '演示：周会纪要（产品节奏对齐）',
    occurredAt: iso(1 * D),
    title: '移动端断点清单核对',
    desc: '按新视觉稿核对三档断点与触控目标尺寸',
    priority: 'medium',
    suggestedMemberId: 'hanmeimei',
    matchSource: 'name',
    dueHint: '本周',
    confidence: 0.9,
    quote: '移动端适配跟进断点清单',
    rationale: '明确指派跟进事项，负责人语境清晰',
    speakerRaw: '李雷',
    state: 'pending',
    decidedAt: null,
    createdAt: iso(1 * D),
    confirmedTaskId: null,
    dueDate: null,
  },
  {
    id: 'cand-demo02bbbb',
    messageId: 'msg-demomins01aa',
    messageTitle: '演示：周会纪要（产品节奏对齐）',
    occurredAt: iso(1 * D),
    title: '消息通知去重排期',
    desc: '同源合并策略排进下个迭代',
    priority: 'low',
    suggestedMemberId: 'hanmeimei',
    matchSource: 'name',
    dueHint: '',
    confidence: 0.7,
    quote: '把消息通知去重排进下个迭代',
    rationale: '排期类讨论，动作明确但优先级一般',
    speakerRaw: '李雷',
    state: 'pending',
    decidedAt: null,
    createdAt: iso(1 * D),
    confirmedTaskId: null,
    dueDate: null,
  },
  {
    id: 'cand-demo03cccc',
    messageId: 'msg-demomins02bb',
    messageTitle: '演示：评审会纪要（数据看板 0.9）',
    occurredAt: iso(2 * D),
    title: '核心图表灰度两图',
    desc: '先出转化漏斗与留存两图的灰度',
    priority: 'medium',
    suggestedMemberId: 'lilei',
    matchSource: 'name',
    dueHint: '',
    confidence: 0.62,
    quote: '先出两个核心图的灰度',
    rationale: '方向性结论，范围待细化',
    speakerRaw: '李雷',
    state: 'pending',
    decidedAt: null,
    createdAt: iso(2 * D),
    confirmedTaskId: null,
    dueDate: null,
  },
];
store.saveInbox(ctx, inbox);

// ---- 团队动态（4 条合成 commit，走统一写出口） ----
store.saveActivities(ctx, [
  { id: 'act-demo0001', type: 'commit', actor: 'lilei', repo: 'example-org/demo-app', branch: 'main', title: 'feat: 首页文案对齐视觉稿', url: 'https://gitea.example.com/example-org/demo-app/commit/demo0001', occurredAt: iso(3 * H), fetchedAt: iso(H) },
  { id: 'act-demo0002', type: 'commit', actor: 'hanmeimei', repo: 'example-org/demo-app', branch: 'main', title: 'fix: 移动端断点回退', url: 'https://gitea.example.com/example-org/demo-app/commit/demo0002', occurredAt: iso(5 * H), fetchedAt: iso(H) },
  { id: 'act-demo0003', type: 'pr', actor: 'hanmeimei', repo: 'example-org/demo-app', branch: 'feat/login', title: '登录流程重构提测', url: 'https://gitea.example.com/example-org/demo-app/pulls/demo0003', occurredAt: iso(8 * H), fetchedAt: iso(H) },
  { id: 'act-demo0004', type: 'commit', actor: 'lilei', repo: 'example-org/demo-app', branch: 'main', title: 'chore: 发布 0.8.2', url: 'https://gitea.example.com/example-org/demo-app/commit/demo0004', occurredAt: iso(1 * D), fetchedAt: iso(H) },
]);

console.log('✓ 演示数据已灌入:', dataDir);
console.log('  成员名册:', ctx.membersPath, '（configDir，非 data/）');
console.log('  成员 2 · 任务 6（含逾期 1）· 纪要 2 · 收件箱候选 3 · 团队动态 4');
console.log('  启动实例即可查看；删除灌入的 JSON 文件即还原。');
