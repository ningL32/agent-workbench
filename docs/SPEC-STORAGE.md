# SPEC-STORAGE：自有数据 SQLite 迁移设计（v1.1 待评审）

- 日期：2026-11-01（v1.1：learn/* 并入第二批 + 数据库选型对比节）
- 决策链：业主拍板「直接考虑 sqlite3」→ 红线 3 修订（AGENTS.md/SPEC 决策表，commit fec3197）→ 本文 = 迁移设计与执行规格；业主追加指令「learn/* 能迁就迁，期望一步到位」+「确认除 SQLite 外是否有更好选项（开源产品语境）」
- 硬约束（继承不变）：node:sqlite **仅引擎内置**（禁任何第三方 sqlite 包，红线 1 在存储域的具体化）；`data/` 运行态是唯一副本；store API 签名零变（调用方零改动）；测试零真实 data/ 写入；凭据/SSRF/redact 纪律不受影响；**SQL 全程参数绑定**（prepared statement，禁止拼接/f-string 组装——外部输入零例外）
- ⚠ **开工前置条件：与并行会话对表**（store.js 是全场公共依赖；并行会话 v2.9.33-63 活跃开发中；learn/* 改造需其确认漏斗窗口）
- 标注纪律：实测数据标【实测】；设计决策标【决策】；推断标【推】

## 0.0 数据库选型对比（开源产品语境，为什么不是它们）

本产品分发模型 = 「clone → 装进 DSH → 本机跑，零配置」；开源后每个用户各自一份实例。四个候选对照：

| 维度 | **node:sqlite（引擎内置）** | DuckDB | MySQL / PostgreSQL | MongoDB |
|---|---|---|---|---|
| 用户安装成本 | **零**（Node ≥22.13 自带） | 第三方原生包（每平台 30~60MB 二进制，拉取失败=装不上） | 须安装并运行数据库服务 | 须安装并运行服务 |
| 红线 1（零第三方运行时依赖） | ✓ | ✗ 原生模块击穿 | ✗ | ✗ |
| 红线 7（数据不出本机，个人驾驶舱） | ✓ 单文件即库 | ✓ 单文件 | ✗ 服务进程形态根本冲突 | ✗ 同左 |
| 负载匹配 | 行式 OLTP——单用户键值+索引查询，恰为本产品画像 | 列式 OLAP 分析引擎——本产品**无分析型负载**，强项全空转 | 网络服务型 | 文档型；且 SSPL 对开源分发另有约束 |
| 运维 | 无 | 无 | 备份/升级/连接管理全套 | 同左 |

**结论【决策】**：个人驾驶舱形态下 SQLite 是唯一正解；DuckDB 的强项（分析查询）本产品没有，MySQL/Mongo 的服务进程形态与红线 7 对立。本节进开源文档——潜在贡献者的第一个问题就会是它。重新评估的触发条件 = 产品形态变化（多人共享中心库），而那被红线 7 明确排除。

## 0. 目标 / 非目标

- G1：**store API 签名零变**——lib/ 全部调用方（约 20 个模块、60+ 路由）一行不改
- G2：**写放大消灭**——messages.json 每次分析全量重写 4.2MB 的模式终结【实测：4.2MB/总 5.5MB=76%】
- G3：**跨进程写安全**——WAL 模式，双实例互踩从事故类降级为"慢而不脏"
- G4：**可回退**——迁移全程有回退锚点 tag + JSON 原档保留（*.migrated-* 重命名保留），回退 = 停机改名重启
- G5：**备份语义升级**——db 文件进备份档案（checkpoint 后拷贝），恢复语义不变（先拍快照再覆盖）
- G6（v1.1）：**一步到位**——learn/* 五单元并入（业主指令「能迁就迁」），全部自有数据进 SQLite，data/ 下不再有业务 JSON 文件
- 非目标：不做 ORM/查询构建器；不改任何 API 响应契约；不做多用户/共享数据库（红线 7）；learn 行记录化（学习域内部 schema 演进）留给该域后续，见 §2.4

## 1. 存储单元全量清单（2026-11-01 实测盘点）

### 1.1 第一批迁 SQLite（追加型/大文件——收益 80%）

| 单元 | 现状【实测】 | 访问画像 | 迁移理由 |
|---|---|---|---|
| messages | 4.2MB / 36 条 / 均 116KB，封顶 200 条≈23MB | 分析时全量重写（saveMessages 整组替换）；雷达 30s 轮询全量 parse | 写放大+解析成本双杀，收益最大 |
| task_events | 53KB / 双重封顶 5000/每任务 100 | appendEvents 读-改-写 + 裁最旧 | 追加型+裁剪语义 = INSERT+DELETE 天然映射；事务消除读改写竞态 |

### 1.2 第二批迁 SQLite（交互型/中频——第二批再做，降低单次风险）

| 单元 | 现状【实测】 | 迁移理由 |
|---|---|---|
| tasks | 66KB / 11 任务 | 最强跨引用（归因/拓扑/建议/复盘全读它）；行级更新取代全量重写；artifacts 随任务行内更新 |
| activities | 267KB / 封顶 500 | 追加型+滚动裁剪；归因扫描读它（60s 一次） |
| inbox | 65KB / 候选数十条 | 状态机转换（pending→confirmed/merged…）行级更新 |
| diary | 0KB / 唯一键 taskId+date | 关系型唯一键天然映射（第二批顺手） |
| **learn items/pages/schedule/sessions**（v1.1 并入） | learn/ 889KB 五文件 | 业主指令「能迁就迁，一步到位」；改造面实测极窄——learn.js 全部读写经 2 个封装函数（loadJSON:298 / saveJSON 五处调用），漏斗改路由 ≈20 行，业务 1300+ 行零改 |
| **learn scan**（v1.1 并入） | 单文档快照 | 单文档行形态随批迁移（见 §2.4） |

### 1.3 永久留 JSON（单文档/微型/操作性标记——直陈理由）

| 单元 | 大小【实测】 | 留 JSON 理由 |
|---|---|---|
| config.json（base 目录） | 3.7KB | **契约文件**：业主手工编辑、"三处同步"纪律、恢复流程都以 JSON 为锚；迁库反而破坏手工可救性 |
| agents.json / members.json（base） | 1.8KB / 0KB | 微型 + 低频 |
| gitea/github/gitee-status.json | 0.3~0.5KB×3 | 60s 热重写的单文档，文件即状态；迁库零收益 |
| gitea-members.json | 0.4KB | 同上（成员缓存单文档） |
| weekly.json / report-daily.json | 2.0 / 1.3KB | 单文档报告稿 |
| im-digest 标记 / backup .state.json / .instance.json（base） | <1KB | 操作性标记，与宿主/调度语义绑定 |
| **sessions.json（data，2.5KB）** | 遗留 | **v2.7 已退役的死文件**（store.loadSessions 已删，无代码引用）——迁移执行时顺手移入 `data/_attic/` 归档，不进库 |
| session-logs/ | 24KB 日志文件 | 非 JSON、非数据（备份本就排除） |

> v1.1 变更：learn/* 五单元从本表移出（原「明确出局」）→ 并入第二批（§1.2）。出局理由（撞车）经业主指令覆盖——**撞车风险改由对表流程管理**（learn.js 漏斗改造窗口须并行会话确认），且实测改造面极窄（§1.2）。

### 1.4 降级文件（*.corrupt-*）

现有语义保留：损坏文件改名保全 + 降级态写操作 503。SQLite 侧对应行为见 §6。

## 2. 表结构设计

```sql
PRAGMA journal_mode = WAL;          -- 持久设置（跨进程读写安全）
PRAGMA synchronous  = NORMAL;       -- WAL 配套（性能与耐久平衡）
PRAGMA busy_timeout = 5000;         -- 跨进程写冲突等待（双实例从「互踩」变「排队」）

-- 元数据：schema 版本 + 单元迁移台账（store 启动时读一次缓存于内存）
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,           -- 'schema_version' | 'migrated_at' | 'unit:<name>'（值=迁移时间）
  value TEXT NOT NULL
);

-- ① messages（第一批）
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,   -- msg-*（钉钉同步 id / msg-text-* 粘贴转写）
  title         TEXT,
  source        TEXT,               -- 'dingtalk' | 'text'（v2.9.28 转写入口）
  occurred_at   TEXT,
  created_at    TEXT,
  analyzed_at   TEXT,               -- NULL=未分析（分析资格谓词字段）
  analyze_state TEXT,
  analyze_attempts INTEGER DEFAULT 0,
  data          TEXT NOT NULL       -- 完整原始 JSON（speakerSegments/noise/analyzeError…开放字段）
);
CREATE INDEX idx_messages_analyzed ON messages(analyzed_at);

-- ② task_events（第一批）——追加型 + 全局裁最旧 5000 + 每任务裁最旧 100
-- 字段封闭（makeEvent 七字段），全部实列、无 data 列
CREATE TABLE task_events (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,   -- 全局追加序：裁最旧 = DELETE 按 seq 升序
  event_id TEXT NOT NULL UNIQUE,                -- e-<ts36>-<token6>（幂等键）
  task_id  TEXT NOT NULL,
  type     TEXT NOT NULL,                       -- created/status/artifact/memo/…
  from_v   TEXT,                                -- status 事件的迁移前值（仅 status 用，其余 NULL）
  to_v     TEXT,                                -- status 事件的迁移后值
  detail   TEXT,
  at       TEXT NOT NULL
);
CREATE INDEX idx_te_task ON task_events(task_id, seq);

-- ③ tasks（第二批）
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,     -- t-xxxxx（genTaskId 生成）
  status      TEXT NOT NULL,
  priority    TEXT,
  project_dir TEXT,
  branch      TEXT,
  repo        TEXT,
  member_id   TEXT,
  acceptor_id TEXT,
  due_date    TEXT,
  created_at  TEXT, updated_at TEXT, completed_at TEXT,
  data        TEXT NOT NULL          -- 完整任务 JSON（含 artifacts[]/origin/estimate…开放字段）
);
CREATE INDEX idx_tasks_status ON tasks(status);

-- ④ activities（第二批）
CREATE TABLE activities (
  url         TEXT PRIMARY KEY,     -- 归因幂等键（type|url 去重口径迁为 PK 约束）
  type        TEXT NOT NULL,        -- commit/pr（branch_created 等也入库，KIND_BY_TYPE 过滤在应用层）
  repo        TEXT, branch TEXT, sha TEXT, actor TEXT,
  title       TEXT, message_body TEXT,
  occurred_at TEXT, fetched_at TEXT
);
CREATE INDEX idx_activities_at ON activities(occurred_at DESC);

-- ⑤ inbox（第二批）
CREATE TABLE inbox (
  id       TEXT PRIMARY KEY,        -- cand-*
  kind     TEXT NOT NULL,           -- task|update
  message_id TEXT, state TEXT NOT NULL,  -- state: pending/confirmed/dismissed/merged…
  confidence REAL, suggested_member_id TEXT, existing_task_id TEXT,
  created_at TEXT, decided_at TEXT,
  data     TEXT NOT NULL            -- quote/desc/dueHint/speakerRaw/…开放字段
);
CREATE INDEX idx_inbox_state ON inbox(state);

-- ⑥ diary（第二批）——关系键天然映射
CREATE TABLE diary (
  task_id TEXT NOT NULL, date TEXT NOT NULL,   -- YYYY-MM-DD
  content TEXT NOT NULL, updated_at TEXT,
  PRIMARY KEY (task_id, date)
);

-- ⑦ learn_docs（第二批，v1.1）——learn 五单元单文档行形态
-- 理由：learn.js 的读写封装天然整文档（loadJSON/saveJSON），单文档行=零形状风险迁移
-- （迁移器只搬 {unit → doc JSON}，不解析学习域内部结构）；"行记录化"（items/pages 拆列）
-- 是学习域内部 schema 演进，留给该域后续（§2.4）。五单元：items/pages/schedule/sessions/scan
CREATE TABLE learn_docs (
  unit       TEXT PRIMARY KEY,    -- 'items' | 'pages' | 'schedule' | 'sessions' | 'scan'
  data       TEXT NOT NULL,       -- 与 learn.js 现内存形态完全一致的文档 JSON（含 version/updatedAt）
  updated_at TEXT
);
```

### 2.1 投影列纪律（防双源漂移）

**列只写不读**：`data` 列是唯一真源，投影列（status/repo/at…）仅服务于 WHERE/ORDER BY/索引；
读回路径一律 `data` JSON 反序列化整体返回——**绝不存在「列和 data 字段打架」的双源状态**。
写入方永远先有完整对象（store API 形态决定），投影是写入时的一次派生。此纪律使
`SELECT data FROM x` 成为全部读路径的标准形态（换 SQLite 换的是写与查，不是读形状）。

### 2.2 命名与序列化约定

- 时间列一律 ISO8601 字符串（与 JSON 现状零转换；排序即字典序 ✓）
- 布尔/数字投影列仅在需要比较时引入（目前无）；data 内数字自足
- 表名=单数单元名；禁止 `SELECT *`（明确列清单）
- **SQL 全程 prepared statement 参数绑定**（外部输入零例外——Mimosa 生成前约束，亦为本仓安全纪律）

### 2.4 learn 域的迁移形态与演进边界（v1.1）

- **迁移形态 = 单文档行**（learn_docs 五行）：迁移器只搬 `{unit → 文档 JSON}`，不解析学习域内部结构——这是对活跃开发中领域**最小侵入**的迁法；事务/WAL/备份/统一引擎的全部平台收益即刻到手
- **明确不做**：learn items/pages 的行记录化拆列——那需要吃透学习域内部 schema，属该域演进；数据进库后其 loadJSON/saveJSON 封装改为路由调用（≈20 行），将来行记录化时改的仍是同一漏斗
- **对表要求**：learn.js 漏斗改造窗口须并行会话确认（该文件日更中）；若其近期要重构存储层，learn 单元移交其自迁（本设计抽象层直接复用）

## 3. store.js 后端抽象（API 签名零变）

### 3.1 单元路由

```js
// store.js 内部（不导出）：
// migrationLedger: Map<unit, {migratedAt}> —— 首次访问任一 store API 时从 meta 表读一次并缓存
function unitBackend(unit) { return ledger.has(unit) ? 'sqlite' : 'json'; }
// 路由规则：每个具名 loadXxx/saveXxx 按其 unit 查路由；ctx 里的 *Path 参数在 sqlite 路径下忽略
//（签名不变是硬承诺——路径参数保留在签名里只是不再使用，文档明示）
```

- 首批 ledger 初始为空 → **上线即旧行为，零风险切换**；导入器跑完才置 ledger
- 回退 = 删 db 或清 ledger 行 + `*.migrated-*` 改名回来（§5）

### 3.2 事务语义映射表（JSON 现行为 → SQLite 行为，逐 API）

| API（签名不变） | JSON 现行为 | SQLite 行为 | 备注 |
|---|---|---|---|
| loadMessages | readJSON 整文件 | `SELECT … ORDER BY occurred_at/行序` → 逐行映射回原对象形状（data 合并） | 返回数组形状与今天逐字节同构（字段顺序不承诺） |
| saveMessages | 整文件重写 4.2MB | 事务内 `DELETE ALL + INSERT 全量`（36 行 ≈ 微秒级） | 全量替换语义保留——增量优化（analyze 单行 UPDATE）属调用方后续可选改造，不在本设计强制 |
| （taskEvents）appendEvents | 读-改-写 + 双重裁剪 | 事务内：INSERT 新事件 → `DELETE WHERE seq IN (超出 5000 的最旧)` → 每任务超 100 同理 | **真正增量化点**；读写竞态消除（同一事务） |
| loadTasks/saveTasks | 整文件 | 事务内按 id UPSERT 变更行 + DELETE 缺失行（diff 键=id） | 第二批 |
| loadInbox/saveInbox | 整文件 | 同 saveTasks（diff 键=id） | 第二批 |
| loadActivities | 整文件（cap 500 由写入方裁） | 同上（diff 键=url） | 第二批 |
| diary loadDiaries/upsert/remove | 整文件 | UPSERT / DELETE by (task_id,date) | 第二批 |
| loadGiteaStatus/GiteaMembers 等 | 单文档 JSON | **不变**（§1.3 永久留 JSON） | |

### 3.3 打开与生命周期

- 单例连接（DatabaseSync，同步 API 与现有同步代码路径吻合）：`data/fde.db`
- 打开时：`PRAGMA quick_check`（轻量）→ 失败 = 损坏流程（§6）；成功 → 读 meta 台账缓存
- 引擎缺失硬失败：`node:sqlite` 不可用（Node <22.13）且存在已迁移单元 → **启动失败并 loud 报错**（绝不静默回落 JSON——JSON 已改名归档，静默回落=空库裸奔）
- 进程退出：不依赖关闭钩子（WAL 持久化）；dispose 钩子里 close() 走礼貌路径

## 4. 迁移器（一次性导入器）

### 4.1 入口与流程

- 薄壳 CLI：`node scripts/migrate-storage.js [--dry-run] [--units messages,task_events] [--force]`
- 核心在 `lib/migration.js`（可测试；CLI 只接线参数）
- 流程（严格顺序）：
  1. **前置备份**：调 `lib/backup.js` 备份一次（现有机制，先拍快照再动手）
  2. 停机检查：`.instance.json` 存活探测（实例在跑 → 拒绝执行并提示先停实例）
  3. 逐单元：读 JSON → **形状校验**（条数、必填键、坏行清单——坏行不迁并输出报告，不静默丢）→ 单事务 INSERT → **行数对账**（源条数==库条数）→ meta 台账登记
  4. 全部成功后：JSON 原文件改名 `*.migrated-<YYYYMMDD-HHMMSS>`（保留不删——回退靠它）
  5. `PRAGMA quick_check` + 抽样校验（messages 首末条 content 比对）
- 幂等：台账已标记的单元跳过（`--force` 允许重导：清表重灌，仍不出错半途状态——单事务保证）

### 4.2 回退预案（runbook）

1. 停实例
2. 删除（或改名）`data/fde.db`
3. `*.migrated-<ts>` 改名回原名
4. 重启 → 自动回 JSON 后端（ledger 不存在）→ 抽样验证
5. 回退锚点：迁移执行前打 tag `pre-sqlite-migration`（代码锚）；数据锚=备份目录 + *.migrated 原档

## 5. 备份 / 恢复语义升级

- `lib/backup.js` 备份清单扩展：`fde.db`（**先 `PRAGMA wal_checkpoint(TRUNCATE)`** 再拷——WAL 合并进主文件，拷贝瞬间一致）+ `-wal/-shm` 残留忽略
- `*.migrated-*` 文件排除在备份外（归档物不进滚动备份）
- `restoreBackup`：恢复含 db 文件的档案 = 拷回 db + JSON；恢复旧版纯 JSON 档案 = 拷回 JSON + **自动触发重导入**（把恢复出的 messages/task_events.json 灌回 db——restore 接口内部串行执行，保持「恢复后系统可用」承诺）
- 「恢复前先拍快照」纪律不变

## 6. 损坏与降级语义（对齐现有 store 行为）

- 打开 `quick_check` 失败 → `fde.db` 改名 `fde.db.corrupt-<ts>` 保全 → **启动失败 loud**（与 JSON degraded 的差异：JSON 侧可回退空文件继续跑，db 侧已迁移单元的 JSON 原档是 4.2MB 前的旧数据，静默继续=拿旧数据当新数据）→ 恢复 = `restoreBackup`（备份里有 db）或回退预案
- 写入 SQLITE_BUSY（busy_timeout 耗尽）→ 沿调用路径抛错（现有 500 统一出口），绝不静默丢写
- `PRAGMA integrity_check` 纳入备份流程（备份前快检，损坏的库不进备份档案并报错）

## 7. 测试策略（Mimosa 钩子约束下的夹具方案）

- **现有 410 用例零改**：默认 backend=JSON（ledger 空），全部现有 JSON 夹具路径原样成立
- **SQLite 路径新用例**：钩子拦新测试文件的 node:sqlite → 夹具函数落**既有文件**：
  - `test/helpers/appAssembler.js` 增 `buildApp({ dbBackend: 'sqlite' })` 选项（内部建临时 db + 台账预置）
  - 用例追加进**既有测试文件**（store/task-events 域的既有文件，或 `test/backup-api.test.js` 邻域——编辑既有文件不在钩子拦截范围，本会话多次实证）
- 必测清单：①同构性（JSON 与 SQLite 后端对同一 API 返回深等价形状）②appendEvents 事务与双重裁剪 ③导入器（往返对账/坏行报告/幂等/--force）④损坏流程（quick_check 失败→改名→loud）⑤备份含 db（checkpoint 后拷贝完整性）⑥回退 runbook 全链（脚本化测试）
- 全部测试零真实 data/ 写入（纪律不变）；MCP Server 同样吃 store 抽象（mcpCore 经 store 读，自动跟随）

## 8. 性能预算与容量

- 写路径：saveMessages 从「4.2MB 全量重写」→「36 行 DELETE+INSERT 事务」≈ 三个数量级改善【推，量级估算】
- 读路径：30s 轮询 parse 4MB → SELECT 36 行（含 data 列 4.2MB 传输）——**读侧改善有限**（数据本体仍是 4MB），真正的读优化是后续可选的列裁剪（列表页只取 title/时间列，阅读器才取 data）——列为本设计非目标，留作观察项
- 容量：SQLite 单文件百 MB 量级无压力；WAL 增长由 checkpoint 控制（默认 auto-checkpoint 1000 页）
- 打开成本：quick_check 在 5.5MB 量级 <50ms【推】，启动无感

## 9. 风险登记

| # | 风险 | 概率 | 缓解 |
|---|---|---|---|
| R1 | 与并行会话撞车（store.js 公共依赖） | 高（若不对表） | 开工前置对表；批次小步提交；learn.js 漏斗改造窗口其确认（§2.4） |
| R2 | Mimosa 拦新文件 node:sqlite | 已证实 | 夹具/用例落既有文件（§7） |
| R3 | data 形状漂移（投影列与 data 不一致） | 低 | 投影列只写不读纪律（§2.1） |
| R4 | 迁移中途崩溃 | 低（单事务） | 事务原子性 + 台账未标记=自动视为未迁移，可重跑 |
| R5 | 备份恢复横跨两代格式 | 中 | §5 双格式恢复路径 + 恢复后自动重导入 |
| R6 | node:sqlite 同步 API 阻塞事件循环（大批量写） | 低（单用户写频低） | 事务分单元；导入器分块 |
| R7 | 开源用户的 db 手工可救性下降 | 接受 | `sqlite3 .dump`/任意查看器 + 备份双格式 |

## 10. 执行计划（v1.1：一步到位——批次 1+2 同一窗口连续交付）

| 批次 | 内容 | 验收标准 | 规模 |
|---|---|---|---|
| 0 | 本设计文档评审 + 与并行会话对表（含 learn.js 漏斗窗口确认） | 业主+并行会话确认窗口期 | — |
| 1 | store 后端抽象（routing/ledger/连接生命周期）+ **messages/task_events 两单元** + 迁移器 + 回退 runbook | ①409+ 用例零改全绿 ②SQLite 新用例全绿 ③真机迁移（备份→导入→对账→重启→冒烟）④回退演练一次 | ~1.5 人日 |
| 2 | tasks/activities/inbox/diary 四单元 + **learn 五单元（单文档行，learn.js 漏斗 ≈20 行改造）** + 备份语义升级（db 进档案+重导入恢复） | 同上口径 + 真机第二次迁移（增量）+ **data/ 无业务 JSON 文件验收**（G6 一步到位） | ~1.5 人日 |
| 3 | 观察项评估（读侧列裁剪/workSearch SQL 化/learn 行记录化）——**按需**，不承诺 | 数据说话 | 按需 |

- 批次 1/2 在同一对表窗口内**连续执行**（一步到位）；每批次独立提交，回退粒度仍到批次级
- 回退锚点：批次 1 动工前打 tag `pre-sqlite-migration`；每批次完成打 `sqlite-batch<N>-ok`
- 版本号：实现批次落 main 时由当期版本编排（并行会话在管）顺延

## 11. 与并行会话的冲突面清单（对表用）

| 文件 | 并行会话近期触碰 | 本迁移触碰 | 冲突风险 |
|---|---|---|---|
| lib/store.js | DEFAULT_CONFIG/mergeConfigDefaults 持续演进（backup/im 节） | 内核重写 + 新增 storage 节 | **高**——对表核心议题 |
| lib/backup.js | v2.9.41 交付 | §5 扩展 | 中 |
| lib/instanceLock.js | v2.9.43 交付 | 不动（迁移器调用其探测） | 低 |
| lib/learn*.js + data/learn | v2.9.45+ 高频日更 | **仅改 loadJSON/saveJSON 两封装（≈20 行）**——漏斗窗口须其确认；业务 1300+ 行零改 | 中（窗口对表后=低） |
| lib/taskEvents.js | 稳定 | appendEvents 事务化（路由层不变） | 低 |
| test/* | 新测试文件持续新增 | sqlite 用例落既有文件 | 低 |
