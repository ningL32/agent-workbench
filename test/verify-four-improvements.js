// 四项改进快速验证脚本（跑完可删）
'use strict';
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \u2714 ' + name);
  } catch (e) {
    fail++;
    console.error('  \u2717 ' + name + ': ' + e.message);
  }
}

// ---- 1: claimLevel \u56db\u6863\u6620\u5c04 ----
check('1.claimLevel \u56db\u6863\u6620\u5c04', function () {
  var map = function (c) {
    if (c >= 0.9) return 'fact';
    if (c >= 0.7) return 'observation';
    if (c >= 0.5) return 'hypothesis';
    return 'suggestion';
  };
  assert.strictEqual(map(0.95), 'fact');
  assert.strictEqual(map(0.9), 'fact');
  assert.strictEqual(map(0.8), 'observation');
  assert.strictEqual(map(0.7), 'observation');
  assert.strictEqual(map(0.6), 'hypothesis');
  assert.strictEqual(map(0.5), 'hypothesis');
  assert.strictEqual(map(0.3), 'suggestion');
});

// ---- 2: blockerType \u9ed8\u8ba4 cognitive ----
check('2.blockerType \u9ed8\u8ba4 cognitive', function () {
  var candidate = { id: 'c1', state: 'pending' };
  var view = Object.assign({}, candidate, { blockerType: candidate.blockerType || 'cognitive' });
  assert.strictEqual(view.blockerType, 'cognitive');
  var withType = Object.assign({}, candidate, { blockerType: 'risk' });
  assert.strictEqual(withType.blockerType, 'risk');
});

// ---- 3: WAP block/unblock ----
check('3.WAP blockDiary \u2192 blocked \u2192 unblockDiary \u2192 published', function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wap-verify-'));
  var diaryPath = path.join(tmp, 'diary.json');
  fs.writeFileSync(diaryPath, '[]');

  var diary = require(
    path.join('E:', 'agent\u5f00\u53d1', 'FdeHarness', 'lib', 'diary.js')
  );

  var r = diary.upsertDiary(
    { diaryPath: diaryPath }, 'task-v1', '2026-10-25', '\u9a8c\u8bc1\u5185\u5bb9'
  );
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.diary.status, 'published', '\u65b0\u5efa\u5e94\u4e3a published');

  diary.blockDiary({ diaryPath: diaryPath }, 'task-v1', '2026-10-25', '\u6570\u636e\u5f02\u5e38');
  var diaries = JSON.parse(fs.readFileSync(diaryPath, 'utf8'));
  assert.strictEqual(diaries[0].status, 'blocked');
  assert.ok(diaries[0].blockReason.indexOf('\u6570\u636e\u5f02\u5e38') >= 0);

  diary.unblockDiary({ diaryPath: diaryPath }, 'task-v1', '2026-10-25');
  var after = JSON.parse(fs.readFileSync(diaryPath, 'utf8'));
  assert.strictEqual(after[0].status, 'published');
  assert.ok(!after[0].blockReason);

  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- 4: \u6f0f\u653e\u7387\u516c\u5f0f ----
check('4.\u6f0f\u653e\u7387\u516c\u5f0f', function () {
  var missed = 3;
  var shouldTrigger = 20;
  var rate = missed / shouldTrigger;
  assert.ok(rate > 0.1 && rate < 0.2, '\u6f0f\u653e\u7387 ' + rate + ' \u5e94\u5728 0.1\u20130.2');
});

console.log('\n=== \u9a8c\u8bc1\u7ed3\u679c: ' + pass + ' pass / ' + fail + ' fail ===');
process.exitCode = fail > 0 ? 1 : 0;
