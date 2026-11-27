'use strict';

/**
 * flow.test.js — 调研任务流程图(v2.9.94)
 *
 * 覆盖:
 *  - parseDeps:「依赖:」文本 → 任务编号数组(无/中文冒号/多依赖/无依赖字段)
 *  - buildFlow 编号口径:只有方案拆解草稿(fromProposal)参与「任务N」编号——
 *    真机事故:一条更早创建的访谈草稿排在第 1 位,把拆解草稿整体挤后一位,依赖边全部错位
 *  - 依赖边解析、越界依赖忽略
 *  - toMermaid:语法安全(节点定义必须单行;换行→<br/>;引号→单引号)
 *  - toSvg:标题转义(无标签注入)、data-* 属性无裸换行、分层不抛错(含环)
 *  - computeLayers:线性链层数、菱形依赖、环兜底
 */

const test = require('node:test');
const assert = require('node:assert');
const flow = require('../lib/research/flow');

const at = (i) => new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();
const mkDraft = (i, title, desc, extra) => Object.assign({
  id: 'dr' + i, status: 'pending', createdAt: at(i), fromProposal: true, taskId: null,
  payload: { title, desc, priority: 'high' },
}, extra || {});

test('parseDeps:依赖文本 → 任务编号数组', () => {
  assert.deepEqual(flow.parseDeps('依赖:无。目标:xxx'), []);
  assert.deepEqual(flow.parseDeps('依赖：数据源盘点（任务1）完成后启动'), [1]); // 中文冒号
  assert.deepEqual(flow.parseDeps('依赖: 任务1、任务3 完成后启动；其它'), [1, 3]);
  assert.deepEqual(flow.parseDeps('依赖:任务2、任务2'), [2], '去重');
  assert.deepEqual(flow.parseDeps('目标:没有依赖字段'), []);
  assert.deepEqual(flow.parseDeps(''), []);
  assert.deepEqual(flow.parseDeps(undefined), []);
});

test('buildFlow:拆解草稿按创建序编号;依赖边与草稿描述一致', () => {
  const drafts = [
    mkDraft(2, '汇总规则', '依赖: 数据源盘点（任务1）、部门确认（任务2）完成后启动'),
    mkDraft(0, '数据源盘点', '依赖:无'),
    mkDraft(1, '部门确认', '依赖: 数据源盘点（任务1）完成后启动'),
  ];
  const f = flow.buildFlow(drafts); // 乱序传入,应按 createdAt 归位
  assert.deepEqual(f.nodes.map((n) => n.n), [1, 2, 3], '创建序 1..n');
  assert.deepEqual(f.nodes.map((n) => n.title), ['数据源盘点', '部门确认', '汇总规则']);
  assert.deepEqual(f.edges, [{ from: 1, to: 2 }, { from: 1, to: 3 }, { from: 2, to: 3 }]);
});

test('buildFlow 编号口径:非拆解草稿不占编号(真机事故回归锚)', () => {
  // 一条比所有拆解草稿都早的访谈草稿——若参与编号,会把「任务1」错指到它身上
  const interviewDraft = mkDraft(0, '月度报表总括', '依赖:无', { fromProposal: false, status: 'accepted' });
  const drafts = [
    interviewDraft,
    mkDraft(1, '数据源盘点', '依赖:无'),
    mkDraft(2, '部门确认', '依赖: 数据源盘点（任务1）完成后启动'),
  ];
  const f = flow.buildFlow(drafts);
  const byTitle = Object.fromEntries(f.nodes.map((n) => [n.title, n]));
  assert.strictEqual(byTitle['数据源盘点'].n, 1, '任务1 必须是第一条拆解草稿,而不是更早的访谈草稿');
  assert.strictEqual(byTitle['月度报表总括'].n, null, '非拆解草稿 n=null,不参与编号');
  assert.deepEqual(byTitle['月度报表总括'].deps, [], '非拆解草稿不解析依赖');
  // 边的端点指向拆解草稿,而不是被挤位的访谈草稿
  assert.deepEqual(f.edges, [{ from: 1, to: 2 }]);
  assert.strictEqual(f.edges[0].from, byTitle['数据源盘点'].n);
  // 节点不丢:访谈草稿仍在图里
  assert.strictEqual(f.nodes.length, 3);
});

test('buildFlow:越界/自引用依赖被忽略;空输入安全', () => {
  const f = flow.buildFlow([
    mkDraft(0, 'A', '依赖: 任务9、任务1、任务0'),
    mkDraft(1, 'B', '依赖: 任务1'),
  ]);
  assert.deepEqual(f.edges, [{ from: 1, to: 2 }], '任务9/任务1(自引用)/任务0 均无对应节点,忽略');
  assert.deepEqual(flow.buildFlow([]), { nodes: [], edges: [] });
  assert.deepEqual(flow.buildFlow(null), { nodes: [], edges: [] });
});

test('toMermaid:语法安全——节点定义单行、换行转 <br/>、引号转单引号', () => {
  const f = flow.buildFlow([
    mkDraft(0, '含换行\n第二行 "引号" (括号) {花括号} #井号', '依赖:无'),
    mkDraft(1, '后续', '依赖: 任务1'),
  ]);
  const lines = flow.toMermaid(f).split('\n');
  assert.strictEqual(lines[0], 'flowchart TD');
  // 每个节点/边定义都必须是独立单行(裸换行会把定义截断 → 渲染器语法错)
  const defs = lines.filter((l) => /^\s+(T\d+|X_\w+)/.test(l));
  assert.strictEqual(defs.length, 3, '2 节点 + 1 边,全部单行');
  const node1 = defs.find((l) => l.includes('T1['));
  assert.ok(node1.includes('换行<br/>第二行'), '换行 → <br/>');
  assert.ok(node1.includes("'引号'") && !node1.includes('"引号"'), '双引号 → 单引号(不提前闭合标签)');
  // 末尾结构:每行要么是节点/边,要么是头
  assert.ok(lines.every((l) => l === '' || l === 'flowchart TD' || /^\s+/.test(l)), '无游离续行');
});

test('toSvg:标题转义、属性无裸换行、含环不抛错', () => {
  const f = flow.buildFlow([
    mkDraft(0, '注入 <script>alert(1)</script> 与 "引号&符"', '依赖: 任务2'), // 与第二条互为依赖 = 环
    mkDraft(1, '带换行\n的标题', '依赖: 任务1'),
  ]);
  const svg = flow.toSvg(f);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(!svg.includes('<script>'), '标题里的标签必须被转义');
  assert.ok(svg.includes('&lt;script&gt;'), '转义后的实体存在');
  assert.ok(!/data-title="[^"]*\n/.test(svg), 'data-title 属性值无裸换行(否则被浏览器规范化成空格)');
  assert.ok(!/<text[^>]*>[^<]*\n/.test(svg), '<text> 显示文本无裸换行');
  assert.strictEqual((svg.match(/<g data-draft-id=/g) || []).length, 2, '每个节点一个可交互 <g>');
});

test('computeLayers:线性链、菱形依赖、环兜底', () => {
  const linear = flow.buildFlow([
    mkDraft(0, 'A', '依赖:无'), mkDraft(1, 'B', '依赖: 任务1'), mkDraft(2, 'C', '依赖: 任务2'),
  ]);
  assert.deepEqual([...flow.computeLayers(linear).values()], [0, 1, 2], '线性链逐层加深');

  const diamond = flow.buildFlow([
    mkDraft(0, 'A', '依赖:无'), mkDraft(1, 'B', '依赖: 任务1'), mkDraft(2, 'C', '依赖: 任务1'), mkDraft(3, 'D', '依赖: 任务2、任务3'),
  ]);
  const dl = flow.computeLayers(diamond);
  assert.strictEqual(dl.get(1), 0);
  assert.strictEqual(dl.get(2), 1);
  assert.strictEqual(dl.get(3), 1, '菱形两侧同层');
  assert.strictEqual(dl.get(4), 2, '汇合点在最长路径之后');

  const cyclic = flow.buildFlow([
    mkDraft(0, 'A', '依赖: 任务2'), mkDraft(1, 'B', '依赖: 任务1'),
  ]);
  assert.doesNotThrow(() => flow.computeLayers(cyclic), '环不抛错、不无限递归');
});
