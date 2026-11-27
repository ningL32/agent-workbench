'use strict';

/**
 * research-coverage.test.js — 访谈出口「缺口清单」(v2.9.94):核对与合并的纯函数
 *
 * 背景:contextMeta.gaps 自 R2 起是从未填充的空占位——发给模型的上下文里没有缺口清单,
 * 「访谈什么时候算聊够」没有任何判断。本模块把出口做实:
 *   - 模型只负责**摘录客户原话**;每一句都由代码与对话原文逐字核对,核对不上不算「已确认」
 *   - 多轮合并:已有依据的项不会因为模型某轮漏输出而丢掉(缺口不能靠"不提"自愈)
 *   - 闸门计数:未处理 = 没问 或 依据核对不上;「客户暂给不出」算已处理(有原话为证)
 *
 * 断言用的期望值全部是手写的工作示例(已知答案),不由被测函数反推。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const cov = require('../lib/research/coverage');

/** 客户发言(语料)。故意用中文全角标点——模型摘录时常把标点写成半角。 */
const CORPUS = [
  '每月3号财务小王从SAP导出销售数据，再和Excel台账对一遍，大概要两个小时。',
  '这个报表是运营总监王总让做的，店长每个月看一次。',
  '耗时我们没统计过，反正挺费劲的。',
];

const byKey = (stakeholders, k) => stakeholders[k];

test('原话核对:与客户发言逐字一致(仅标点/空白差异)→ 已确认', () => {
  // Act
  const r = cov.applyTurn(null, { stakeholders: { owner: { quote: '运营总监王总让做的' } } }, CORPUS);
  // Assert
  assert.equal(byKey(r.stakeholders, 'owner').status, 'answered');
  assert.equal(byKey(r.stakeholders, 'owner').quote, '运营总监王总让做的');
});

test('原话核对:模型改写/概括客户原话 → 不算已确认(依据核对不上),但保留其摘录供人查看', () => {
  // Arrange:这句话的意思对,但不是客户说过的连续原话
  const paraphrase = '财务小王每月从系统导出数据并与台账核对';
  // Act
  const r = cov.applyTurn(null, { stakeholders: { owner: { quote: paraphrase } } }, CORPUS);
  // Assert
  assert.equal(byKey(r.stakeholders, 'owner').status, 'unverified');
  assert.equal(byKey(r.stakeholders, 'owner').quote, paraphrase, '核对不上也要留下模型声称的依据,让人能判断');
});

test('原话核对:仅有细微出入(多一个字)→ 近似命中,仍算有依据', () => {
  // Arrange:比原话多了"核"一个字
  const near = '每月3号财务小王从SAP导出销售数据，再和Excel台账核对一遍';
  // Act
  const r = cov.applyTurn(null, { steps: [{ name: '月度对账', how: { quote: near } }] }, CORPUS);
  // Assert
  const step = r.steps.find((s) => s.name === '月度对账');
  assert.equal(step.how.status, 'answered');
  assert.equal(step.how.basis, 'fuzzy');
});

test('原话核对:模型没给原话(空对象)→ 未问;单字原话不足以作依据', () => {
  // Act
  const r = cov.applyTurn(null, {
    stakeholders: { sponsor: {}, it: { quote: '对' } },
  }, CORPUS.concat(['对。']));
  // Assert
  assert.equal(byKey(r.stakeholders, 'sponsor').status, 'missing');
  assert.equal(byKey(r.stakeholders, 'sponsor').quote, '');
  assert.equal(byKey(r.stakeholders, 'it').status, 'unverified', '一个字在任何对话里都找得到,不构成依据');
});

test('客户暂给不出:必须由客户亲口说出(原话可核对)才算;模型自行判定不算', () => {
  // Act
  const r = cov.applyTurn(null, {
    baseline: {
      time: { unavailable: true, quote: '没统计过' },
      quality: { unavailable: true, quote: '客户表示没有相关数据' },
    },
  }, CORPUS);
  // Assert
  assert.equal(r.baseline.time.status, 'unavailable');
  assert.equal(r.baseline.time.quote, '没统计过');
  assert.equal(r.baseline.quality.status, 'unverified', '这句是模型自己编的"客户表示",对话里没有');
});

test('基线项:保留规范写法与「实测/估算」标记,估算与实测是两种不同的已确认', () => {
  // Act
  const r = cov.applyTurn(null, {
    baseline: {
      time: { quote: '大概要两个小时', value: '约2小时/次', estimated: true },
      scale: { quote: '店长每个月看一次', value: '每月1次', estimated: false },
      quality: { quote: '反正挺费劲的', value: '返工较多' },
    },
  }, CORPUS);
  // Assert
  assert.deepEqual(
    { status: r.baseline.time.status, value: r.baseline.time.value, estimated: r.baseline.time.estimated },
    { status: 'answered', value: '约2小时/次', estimated: true }
  );
  assert.deepEqual(
    { status: r.baseline.scale.status, value: r.baseline.scale.value, estimated: r.baseline.scale.estimated },
    { status: 'answered', value: '每月1次', estimated: false }
  );
  assert.equal(r.baseline.quality.estimated, true, '模型没标明实测/估算时,按估算处理——不得把来路不明的数字当实测');
});

test('关键假设:客户确认 / 客户否认 / 待确认 三种状态都由原话决定', () => {
  // Act
  const r = cov.applyTurn(null, {
    assumptions: [
      { text: '报表是王总发起的', quote: '运营总监王总让做的' },
      { text: '耗时有两小时以上', denied: true, quote: '没统计过' },
      { text: '店长能看懂邮件里的报表', unavailable: true, quote: '店长每个月看一次' },
      { text: 'SAP 可以开放接口' },
      { text: 'IT 部门会配合改造', quote: '这个不存在的话' },
    ],
  }, CORPUS);
  // Assert
  assert.deepEqual(r.assumptions.map((a) => [a.text, a.status]), [
    ['报表是王总发起的', 'confirmed'],
    ['耗时有两小时以上', 'denied'],
    ['店长能看懂邮件里的报表', 'unavailable'],
    ['SAP 可以开放接口', 'open'],
    ['IT 部门会配合改造', 'unverified'],
  ]);
});

test('结构兜底:模型漏掉 coverage 的某些部分、或类型不对,都按「未问」处理而不抛错', () => {
  // Act
  const r1 = cov.applyTurn(null, {}, CORPUS);
  const r2 = cov.applyTurn(null, { steps: '不是数组', stakeholders: { owner: '字符串' }, baseline: null, assumptions: [null, 42] }, CORPUS);
  // Assert
  for (const r of [r1, r2]) {
    assert.deepEqual(Object.keys(r.stakeholders).sort(), ['it', 'owner', 'sponsor', 'user'], '四类干系人槽位恒存在');
    assert.ok(Object.values(r.stakeholders).every((x) => x.status === 'missing'));
    assert.ok(Object.values(r.baseline).every((x) => x.status === 'missing'));
  }
  assert.deepEqual(r2.steps, []);
  assert.deepEqual(r2.assumptions, []);
});

// ------------------------------------------------------------------ 多轮合并

test('多轮合并:已有依据的项,模型某轮漏输出(空对象)也不会退回未问——缺口不能靠"不提"自愈', () => {
  // Arrange:第 1 轮拿到了依据
  const t1 = cov.applyTurn(null, { stakeholders: { owner: { quote: '运营总监王总让做的' } } }, CORPUS);
  // Act:第 2 轮模型只回了空对象
  const t2 = cov.applyTurn(t1, { stakeholders: { owner: {}, user: {} } }, CORPUS);
  // Assert
  assert.equal(byKey(t2.stakeholders, 'owner').status, 'answered');
  assert.equal(byKey(t2.stakeholders, 'user').status, 'missing');
});

test('多轮合并:客户给了依据 → 取代「暂给不出」;客户事后改口说给不出 → 撤下原先的依据(宁缺毋错)', () => {
  const cant = { unavailable: true, quote: '没统计过' };
  const got = { quote: '大概要两个小时', value: '约2小时/次', estimated: true };
  // Act
  const t1 = cov.applyTurn(null, { baseline: { time: cant } }, CORPUS);
  const t2 = cov.applyTurn(t1, { baseline: { time: got } }, CORPUS);
  const t3 = cov.applyTurn(t2, { baseline: { time: cant } }, CORPUS);
  // Assert
  assert.equal(t1.baseline.time.status, 'unavailable');
  assert.equal(t2.baseline.time.status, 'answered', '客户后来给出了数字');
  assert.equal(t3.baseline.time.status, 'unavailable', '客户收回的数字不能再当作基线——错的数据比没有数据更糟');
});

test('多轮合并:估算不能覆盖实测,实测可以覆盖估算', () => {
  const measured = { quote: '店长每个月看一次', value: '每月1次', estimated: false };
  const guess = { quote: '大概要两个小时', value: '约2小时/次', estimated: true };
  // Act
  const keepMeasured = cov.applyTurn(cov.applyTurn(null, { baseline: { scale: measured } }, CORPUS), { baseline: { scale: guess } }, CORPUS);
  const upgrade = cov.applyTurn(cov.applyTurn(null, { baseline: { scale: guess } }, CORPUS), { baseline: { scale: measured } }, CORPUS);
  // Assert
  assert.deepEqual([keepMeasured.baseline.scale.value, keepMeasured.baseline.scale.estimated], ['每月1次', false]);
  assert.deepEqual([upgrade.baseline.scale.value, upgrade.baseline.scale.estimated], ['每月1次', false]);
});

test('多轮合并:核对不上的摘录/空对象都不能顶掉已确认的项', () => {
  // Act
  const t1 = cov.applyTurn(null, { stakeholders: { owner: { quote: '客户表示这是王总的要求' } } }, CORPUS);
  const t2 = cov.applyTurn(t1, { stakeholders: { owner: { quote: '运营总监王总让做的' } } }, CORPUS);
  const t3 = cov.applyTurn(t2, { stakeholders: { owner: { quote: '又一句对不上的摘录' } } }, CORPUS);
  const t4 = cov.applyTurn(t3, { stakeholders: { owner: {} } }, CORPUS);
  // Assert
  assert.equal(t1.stakeholders.owner.status, 'unverified', '原先未问,所以登记这条待核对的摘录');
  assert.equal(t3.stakeholders.owner.status, 'answered');
  assert.equal(t4.stakeholders.owner.status, 'answered');
});

test('多轮合并:客户更正了说法 → 新原话替换旧依据(同为已确认,以最新为准)', () => {
  // Arrange
  const t1 = cov.applyTurn(null, { stakeholders: { user: { quote: '店长每个月看一次' } } }, CORPUS);
  const corpus2 = CORPUS.concat(['其实不是店长看,是区域助理整理好发给店长。']);
  // Act
  const t2 = cov.applyTurn(t1, { stakeholders: { user: { quote: '是区域助理整理好发给店长' } } }, corpus2);
  // Assert
  assert.equal(t2.stakeholders.user.status, 'answered');
  assert.equal(t2.stakeholders.user.quote, '是区域助理整理好发给店长');
});

test('业务环节:按名称对齐合并四问;本轮没提到的环节原样保留;名称保持首次出现的写法', () => {
  // Act
  const t1 = cov.applyTurn(null, { steps: [{ name: '月度对账', who: { quote: '财务小王' } }] }, CORPUS);
  const t2 = cov.applyTurn(t1, { steps: [
    { name: '月度 对账', how: { quote: '从SAP导出销售数据' } },
    { name: '报表分发', who: { quote: '运营总监王总让做的' } },
  ] }, CORPUS);
  const t3 = cov.applyTurn(t2, { steps: [{ name: '报表分发', why: { quote: '店长每个月看一次' } }] }, CORPUS);
  // Assert
  assert.deepEqual(t3.steps.map((s) => s.name), ['月度对账', '报表分发'], '「月度对账」本轮没提,仍在清单里;名称不被后来的写法改动');
  assert.deepEqual(
    t3.steps.map((s) => [s.who.status, s.how.status, s.why.status, s.io.status]),
    [['answered', 'answered', 'missing', 'missing'], ['answered', 'missing', 'answered', 'missing']]
  );
});

test('业务环节:四问同样遵守「不因漏输出而退回」', () => {
  // Act
  const t1 = cov.applyTurn(null, { steps: [{ name: '月度对账', why: { quote: '反正挺费劲的' } }] }, CORPUS);
  const t2 = cov.applyTurn(t1, { steps: [{ name: '月度对账', why: {} }] }, CORPUS);
  // Assert
  assert.equal(t2.steps[0].why.status, 'answered');
});

test('关键假设:同一条假设换了写法也能对上(归一化相等或互相包含),状态随客户表态推进', () => {
  // Arrange
  const t1 = cov.applyTurn(null, { assumptions: [{ text: 'SAP 可以开放接口' }, { text: 'IT 部门会配合改造' }] }, CORPUS);
  const corpus2 = CORPUS.concat(['SAP那边可以给我们开接口的,IT也配合。']);
  // Act:第 2 轮模型把第一条写得更具体(包含原说法),并新增一条
  const t2 = cov.applyTurn(t1, { assumptions: [
    { text: 'SAP 可以开放接口给财务', quote: '可以给我们开接口的' },
    { text: '店长能看懂邮件里的报表' },
  ] }, corpus2);
  // Assert
  assert.deepEqual(t2.assumptions.map((a) => [a.text, a.status]), [
    ['SAP 可以开放接口', 'confirmed'],
    ['IT 部门会配合改造', 'open'],
    ['店长能看懂邮件里的报表', 'open'],
  ], '对上的那条沿用首次写法,不被改写;没对上的作为新假设追加');
});

// ------------------------------------------------------------------ 闸门计数与对外文本

/** 一份"什么情况都有"的清单:已确认 / 未问 / 核对不上 / 暂给不出 四种状态各占一些 */
function mixedCoverage() {
  return cov.applyTurn(null, {
    steps: [{ name: '月度对账', who: { quote: '财务小王' }, io: { unavailable: true, quote: '没统计过' } }],
    stakeholders: { owner: { quote: '运营总监王总让做的' }, it: { quote: '客户表示没有相关数据' } },
    baseline: {
      time: { unavailable: true, quote: '没统计过' },
      scale: { quote: '店长每个月看一次', value: '每月1次', estimated: false },
    },
    assumptions: [{ text: 'SAP 可以开放接口' }, { text: '报表是王总发起的', quote: '运营总监王总让做的' }],
  }, CORPUS);
}

test('闸门计数:未处理 = 未问 + 核对不上;「暂给不出」与已确认不算缺口;每项带可读标签', () => {
  // Act
  const g = cov.gateOf(mixedCoverage());
  // Assert
  assert.equal(g.assessed, true);
  assert.deepEqual(g.open.map((x) => x.label), [
    '环节「月度对账」·怎么做',
    '环节「月度对账」·为什么',
    '业务发起人',
    'IT/数据责任人',
    '最终用户',
    '质量(错误率/返工率)',
    '假设:SAP 可以开放接口',
  ]);
  assert.equal(g.open.find((x) => x.label === 'IT/数据责任人').status, 'unverified', '核对不上的摘录算未处理');
  assert.deepEqual(g.unavailable.map((x) => x.label), ['环节「月度对账」·交接面(输入/输出)', '耗时']);
  assert.deepEqual(g.counts, { total: 13, answered: 4, unavailable: 2, open: 7 }, '总数 = 已确认 + 暂给不出 + 未处理');
});

test('闸门:尚未评估的访谈(没有清单)既不算"有缺口",也不算"已通过"', () => {
  // Act
  for (const empty of [null, undefined]) {
    const g = cov.gateOf(empty);
    // Assert
    assert.equal(g.assessed, false);
    assert.deepEqual(g.open, []);
    assert.deepEqual(g.counts, { total: 0, answered: 0, unavailable: 0, open: 0 });
  }
});

test('给访谈模型的清单文本:一行一组,标出已确认/未问/核对不上/暂给不出,估算基线带标记', () => {
  // Arrange
  const c = cov.applyTurn(null, {
    steps: [{ name: '月度对账', who: { quote: '财务小王' }, why: { quote: '客户说这事很急' } }],
    stakeholders: { user: { unavailable: true, quote: '没统计过' } },
    baseline: { time: { quote: '大概要两个小时', value: '约2小时/次', estimated: true } },
    assumptions: [{ text: 'SAP 可以开放接口' }],
  }, CORPUS);
  // Act
  const s = cov.toPromptSection(c);
  // Assert
  assert.match(s, /- 月度对账:谁在做 ✓「财务小王」/);
  assert.match(s, /怎么做 \?/);
  assert.match(s, /为什么 核对不上「客户说这事很急」/, '核对不上的摘录原样给回模型,下一轮它才有机会重新摘录');
  assert.match(s, /最终用户 暂给不出「没统计过」/);
  assert.match(s, /耗时 ✓\(估算\)约2小时\/次「大概要两个小时」/);
  assert.match(s, /「SAP 可以开放接口」待客户确认/);
});

test('给访谈模型的清单文本:还没识别出环节时不留空,明确写出', () => {
  // Act
  const s = cov.toPromptSection(cov.applyTurn(null, {}, CORPUS));
  // Assert
  assert.match(s, /尚未识别业务环节/);
  assert.match(s, /业务发起人 \?/, '四类干系人即使全未问也要列出来,模型才知道该问谁');
});

test('给方案模型的核对结果:分四组(已确认/暂给不出/未处理/关键假设),每条带原话', () => {
  // Act
  const s = cov.discoveryForProposal(mixedCoverage());
  // Assert
  assert.match(s, /### 已确认\n- 环节「月度对账」·谁在做:「财务小王」/, '顺序以实际实现为准,这里只约束"在已确认组里且带原话"');
  assert.match(s, /- 基线·规模\(频率\/人数\):每月1次\(实测\)「店长每个月看一次」/);
  assert.match(s, /### 客户暂给不出[\s\S]*- 基线·耗时:「没统计过」/);
  assert.match(s, /### 未处理的缺口[\s\S]*- 干系人·业务发起人 —— 未问/);
  assert.match(s, /- 干系人·IT\/数据责任人 —— 摘录未核对上:「客户表示没有相关数据」/);
  assert.match(s, /### 关键假设[\s\S]*「SAP 可以开放接口」—— 待客户确认/);
  assert.match(s, /「报表是王总发起的」—— 客户已确认:「运营总监王总让做的」/);
});

test('给方案模型的核对结果:估算基线明确标成估算,方案不得把它当实测', () => {
  // Arrange
  const c = cov.applyTurn(null, { baseline: { time: { quote: '大概要两个小时', value: '约2小时/次', estimated: true } } }, CORPUS);
  // Act
  const s = cov.discoveryForProposal(c);
  // Assert
  assert.match(s, /- 基线·耗时:约2小时\/次\(估算\)「大概要两个小时」/);
});

test('给方案模型的核对结果:尚未评估时如实写明"未评估",不出现任何"已确认"', () => {
  // Act
  const s = cov.discoveryForProposal(null);
  // Assert
  assert.match(s, /未评估/);
  assert.doesNotMatch(s, /「[^」]*」/, '没有任何原话可列');
});

// ------------------------------------------------------------------ 方案章节(范围合同模板)

const FULL_PROPOSAL = [
  '# 场景方案 · 月度销售报表',
  '',
  '## 一、现状与问题', '客户每月手工对账,耗时约两小时。',
  '## 二、目标', '对账时间降到半小时以内。',
  '## 三、方案(本期做什么)', '第一步……',
  '## 四、不做什么(本期明确排除)', '- 多语言合同',
  '## 五、验收指标', '- 对账耗时:基线约2小时(估算)→ 目标 30 分钟内',
  '## 六、风险与前提', '- 基线为估算值,需先实测',
  '## 七、任务建议', '1. 盘点数据源 —— ……;依赖:无;优先级:high',
].join('\n');

test('方案章节检查:按范围合同模板七节齐全 → 无缺失', () => {
  // Act
  const r = cov.checkProposalSections(FULL_PROPOSAL);
  // Assert
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.present, ['现状与问题', '目标', '方案', '不做什么', '验收指标', '风险与前提', '任务建议']);
});

test('方案章节检查:缺「不做什么」「验收指标」会被逐个点名——这两节是范围合同的核心', () => {
  // Arrange:删掉两节,并把后面的编号顺延(模拟模型"自然地"少写两节)
  const dropped = FULL_PROPOSAL
    .replace('## 四、不做什么(本期明确排除)\n- 多语言合同\n', '')
    .replace('## 五、验收指标\n- 对账耗时:基线约2小时(估算)→ 目标 30 分钟内\n', '')
    .replace('## 六、风险与前提', '## 四、风险与前提')
    .replace('## 七、任务建议', '## 五、任务建议');
  // Act
  const r = cov.checkProposalSections(dropped);
  // Assert
  assert.deepEqual(r.missing, ['不做什么', '验收指标']);
});

test('方案章节检查:文档大标题里的"方案"二字不能顶替「方案」一节', () => {
  // Arrange:有标题,但没有方案正文那一节
  const onlyTitle = ['# 场景方案 · 测试', '', '## 一、现状与问题', 'x', '## 二、目标', 'x', '## 四、不做什么', 'x', '## 五、验收指标', 'x', '## 六、风险与前提', 'x', '## 七、任务建议', 'x'].join('\n');
  // Act
  const r = cov.checkProposalSections(onlyTitle);
  // Assert
  assert.deepEqual(r.missing, ['方案']);
});

test('方案章节检查:容忍编号与措辞的小差异,不制造假警报', () => {
  // Arrange
  const variant = [
    '# 月度销售报表自动化方案', '',
    '## 1. 现状', '### 2. 目标', '#### 3. 解决方案', '## 4. 明确排除的范围(不做)', '## 5. 验收指标与标准', '## 六 风险', '## 任务拆解建议',
  ].join('\n');
  // Act
  const r = cov.checkProposalSections(variant);
  // Assert
  assert.deepEqual(r.missing, []);
});

test('方案章节检查:空文档 / 非字符串 → 七节全缺,不抛错', () => {
  // Act
  for (const md of ['', null, undefined, 42, '只有一段话,没有任何标题']) {
    // Assert
    assert.equal(cov.checkProposalSections(md).missing.length, 7, `输入 ${JSON.stringify(md)}`);
  }
});

// ------------------------------------------------------------------ 核对的范围与成本

test('核对范围:客户很早以前说的话,后来才被摘录且有细微出入,也要能核对上(不能只看最近几条)', () => {
  // Arrange:早期消息在第 1 条,后面压着 60 条无关的后续发言
  const early = '报表是运营总监王总让做的,他每个月要向总经理汇报。';
  const corpus = [early].concat(Array.from({ length: 60 }, (_, i) => `后续第 ${i} 条:我们继续聊别的环节。`));
  // Act:摘录比原话少了一个字("的")
  const r = cov.applyTurn(null, { stakeholders: { sponsor: { quote: '运营总监王总让做,他每个月要向总经理汇报' } } }, corpus);
  // Assert
  assert.equal(r.stakeholders.sponsor.status, 'answered');
  assert.equal(r.stakeholders.sponsor.basis, 'fuzzy');
});

test('核对成本:近似核对的总计算量有上限;超出的摘录按「未核对」处理并留下标记,不会卡住服务', () => {
  // Arrange:大量长消息 × 大量对不上的摘录(最坏情况),并把预算压到很小
  const filler = '业务细节与系统名称以及各种口径说明文字';
  const corpus = Array.from({ length: 60 }, (_, i) => `第${i}条:` + filler.repeat(40));
  const bad = { quote: '业务细节与系统名称以及各种口径说明这一句根本对不上任何客户发言' };
  const input = { stakeholders: { sponsor: bad, owner: bad, it: bad, user: bad } };
  // Act
  const r = cov.applyTurn(null, input, corpus, { fuzzyCellBudget: 1000 });
  // Assert
  assert.equal(r.truncated, true, '超出预算必须留痕');
  assert.ok(Object.values(r.stakeholders).every((x) => x.status === 'unverified'), '没核对完的摘录不得被当作已确认');
  // 对照:预算充足时结果一致(同样核对不上),且不留痕
  const ok = cov.applyTurn(null, input, corpus);
  assert.equal(ok.truncated, undefined);
  assert.ok(Object.values(ok.stakeholders).every((x) => x.status === 'unverified'));
});

test('核对预算按整轮共享:先到的摘录用掉的额度,后到的就不能再用', () => {
  // Arrange:两条摘录都只差一个字(需要 DP 才能判定);预算只够其中一次 DP
  const text = '业务细节与系统名称以及各种口径说明文字'.repeat(2); // 归一化后 44 字
  const near = '业务细节与系统名称以及各种口径说明文X字'; // 23 字,比原文多一个 X
  const input = { steps: [{ name: 'A', who: { quote: near } }], stakeholders: { owner: { quote: near } } };
  const oneDp = 44 * 23;
  // Act
  const r = cov.applyTurn(null, input, [text], { fuzzyCellBudget: oneDp });
  // Assert
  assert.equal(r.steps[0].who.status, 'answered', '先核对的那条用掉了全部预算,并近似命中');
  assert.equal(r.stakeholders.owner.status, 'unverified', '后到的那条没有预算做 DP,只能按未核对处理');
  assert.equal(r.truncated, true);
});

test('闸门结论里的 items:全部检查项的扁平列表(不只未处理项),附带界面要用的字段', () => {
  // Act
  const g = cov.gateOf(mixedCoverage());
  // Assert
  assert.equal(g.items.length, 13, '与 counts.total 一致');
  assert.deepEqual(g.items.slice(0, 4).map((x) => [x.group, x.label, x.status]), [
    ['step', '环节「月度对账」·谁在做', 'answered'],
    ['step', '环节「月度对账」·怎么做', 'missing'],
    ['step', '环节「月度对账」·为什么', 'missing'],
    ['step', '环节「月度对账」·交接面(输入/输出)', 'unavailable'],
  ], '顺序:环节×四问在前');
  const scale = g.items.find((x) => x.label === '规模(频率/人数)');
  assert.deepEqual([scale.status, scale.value, scale.estimated], ['answered', '每月1次', false], '基线项带规范写法与实测/估算');
  const assumption = g.items.find((x) => x.group === 'assumption');
  assert.equal(assumption.text, 'SAP 可以开放接口');
  assert.equal(assumption.label, '假设:SAP 可以开放接口');
});
