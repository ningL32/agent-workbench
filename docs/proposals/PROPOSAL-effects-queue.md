# PROPOSAL：Effects 持久副作用队列——切片设计稿

> 状态：**设计稿，未动工**（2026-11-03，ZCode 落稿；deepseek 会话同题请缨未派单，本文替代）。
> 来源：DeepSeek dsh-superagent-prototype 的 Effects 模式（精读 `docs/reviews/REVIEW-superagent-architecture.md` §4），按本仓裁剪。
> 性质：纸面设计。**代码动工撞「观察窗两周存储层不动刀」拍板（至 ~2026-11-15）**，届时须过评审（改数据模型门槛，报告归档 docs/reviews/）。

## 0. 一句话

把 `imNotify`/`webhookOut` 的「fire-and-forget」升级为「事务内入队 → 提交后即跑 → 失败退避重试 → 重启续跑 → 健康可观测」：**丢消息从必然变成需要连续失败才发生，且留痕可见**。

## 1. 要治的病（已验证的现状）

- `lib/taskEvents.js:93-99`：webhook / IM 派发是**有意的 fire-and-forget**（v2.9.27 纪律「绝不影响任务写路径」），异常仅 `console.error` 即吞；全 lib/ 无重试、无退避、无持久队列。
- 丢消息的三条必然路径：①改 lib/ 后重启 DSH（本仓家常便饭）必丢 in-flight；②钉钉/飞书 webhook 一次超时=永久丢；③失败只留一行 console，无聚合无健康态。
- 丢的是什么：IM 只推**「待验收 / 已完成」**两类——整个「派工→完成→验收」环里最需要人拍板的时刻，丢了就无声停滞。
- **老纪律必须保留**：出网永不阻塞任务写路径（v2.9.27 立的规矩）。Effects 化是升级语义（丢→排队续跑），不是推翻它。

## 2. 目标 / 非目标

**目标**：失败自动退避重试；重启后续跑；每 kind 一个健康项（连续 3 败 → 设置页只读可见，红线 8「单源失败必须留痕」延伸到出站口）。
**非目标（declined，有据）**：不做 worker 池并发（个人驾驶舱量级：真机 tasks=14）；不做跨目标保序广播；不做回执历史表（DeepSeek 的 outbox 收据保留我们不抄——回执无消费场景，纯增存储）；不做 `Later` 异常（无「空闲槽」概念）；不抄其无界增长债（成功即删，见 §4）。

## 3. 表设计（storeDb.js 新单元 `effect`）

```sql
CREATE TABLE IF NOT EXISTS effect (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,             -- 'im' | 'webhook' | 'digest'
  key TEXT NOT NULL,              -- 幂等键（见下），UNIQUE(kind,key)
  payload TEXT NOT NULL,          -- JSON：事件最小集（taskId/type/detail/at…，见 §7 安全对账）
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,  -- ISO 文本（本仓时间纪律：文本比较+游标分页）
  last_error TEXT,                -- 经 redact() 后的 detail，健康面直接消费
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(kind, key)
);
CREATE INDEX IF NOT EXISTS idx_effect_due ON effect(next_attempt_at);
```

- 幂等键约定：im/webhook = `taskId|type|target标识`（同任务同事件同目标天然去重）；digest = `date`（当日一次）。
- 建表走 storeDb 既有 schema bootstrap（`CREATE TABLE IF NOT EXISTS`，幂等）；effect 是**新增单元**，不触既有 6 单元路由与 `*.migrated` 台账；`backup.js` 整库拷贝天然覆盖，零改动。

## 4. 运行时（新模块 `lib/effects.js`，~150 行）

- **enqueue(kind, key, payload)**：`INSERT … ON CONFLICT(kind,key) DO UPDATE SET payload=excluded.payload, next_attempt_at=now`——重复入队只换 payload 并立即到期（DeepSeek 同款）。
- **kick()**：入队后 setImmediate 触发一次试跑——**保住今天的即时通知延迟**，队列只兜失败与重启。
- **调度**：挂既有 `pollTick`（单飞、上一轮未完成不重入的纪律现成），到期的 `next_attempt_at <= now` 行逐条处理。
- **退避表**（对齐 DeepSeek）：im/webhook 2s→60s 封顶；digest 5min→1h（一天最多 3 次，沿用 v2.9.39 口径）；重试上限到达 → 行保留、`last_error` 留痕、健康计败。
- **成功即删**：DELETE 行（无回执表）；失败行保留，pollTick 顺手清扫 `updated_at` 超 7 天的失败行（防无界增长）。
- **健康项**：每 kind 连续失败计数，≥3 → 写入 settings 只读视图（`GET /api/settings` 的 `im`/`webhookOut` 节旁挂 `queue:{depth,lastError}`，沿用 v2.9.29 D4 只读可见性纪律）；成功清零。

## 5. kind 裁剪（vs DeepSeek）

| DeepSeek kind | 本仓 | 理由 |
|---|---|---|
| delivery / notice | **im + webhook** | 唯二出站点，对应现状 |
| relay | **digest** | 每日 IM 摘要并入（`data/im-digest.json` 状态文件退役，日期幂等键天然表达「当日一次」） |
| assessment / launch | 不抄 | 无常驻 worker 池，YAGNI |
| reply | 不抄 | 我们无「回给 Channel 的回复」独立信道 |

## 6. 接线改动面（调用方签名零变）

1. `lib/taskEvents.js` `appendEvents` 尾部两处 `fireTaskEvents` → 改调 `effects.enqueue(...)+kick()`；imNotify/webhook 的 handler 签名不变，只是从「直调」变「队列回调」。
2. `lib/imNotify.js` `maybeRunDigest` → digest kind；`data/im-digest.json` 存在则忽略（历史状态无迁移价值）。
3. `lib/storeDb.js` 建表 + 单元读写 helper（全参数绑定，含 LIMIT）。
4. `lib/settings.js` 只读健康字段（~10 行）。
5. 文档：SPEC-STORAGE 增 effect 单元节、SPEC 变更记录、BACKLOG #23 收账、本提案标记已实施。

## 7. 安全与纪律对账

- **凭据零进 payload**：payload 只存事件内容（任务标题等用户自有数据，落自己 db 天经地义）；目标 URL/加签密钥**不进表**，派发时从 config 现取（沿用 webhookOut 60s TTL 缓存）。
- **redact 面不扩大**：错误出口 `scrubUrl`+`redact` 在 handler 内不变；重试=同内容多次出站，脱敏按次生效，无新泄漏面。
- **测试纪律**：全走临时目录 + 注入 fetcher（对齐 `test/im-notify.test.js` 零出网）；测试文件不用 node:sqlite 建夹具（工程坑 5）；AAA 三段式。预期用例：幂等 upsert、退避序列、重启续跑（重开 db 再调度）、成功即删、3 连败健康告警、digest 日期去重、失败 7 天清扫。
- **Mimosa 坑预警**：调度器代码避免 `exec` 字样（文档即断言批已实证会被误拦）；SQL 模板字面量插值会被拦，一律参数绑定。

## 8. 工作量与时序

切片共 ~1 天（effects.js 150 行为主体 + 10 例测试）。**代码动工等 ~2026-11-15 观察窗结束**（新增表=存储层动刀）；合入前过评审。纸面可先行评审——本稿即评审对象，反馈直接批注或口述均可。

## 9. 如果推倒重来会换的做法

会把「kick 立即试跑」直接做成 enqueue 的同步尾巴（省一次事件循环），并把 digest 的并库放在 im/webhook 稳定后的第二批（少一个同时上线的变量）——首版仍按上文一体交付，因 digest 改动实在太小。
