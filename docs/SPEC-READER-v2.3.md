# SPEC — FDE 指挥台 智能体动态 v2.3「会话列表 + 内容阅读器」

- 版本：v2.3（2026-10-20）｜状态：可派工
- 硬约束：零 npm 依赖延续；全链路只读（sqlite `{readOnly:true}`、文件 openSync 读、zstd 内存解压）；凭据红线：workbuddy 只碰 sessions 表、opencode 不碰 account/credential 表
- 事实与设计分离：【已验证事实】（F1-F10，2026-10-20 HEAD 实测行号）直接引用；【设计决策】一律结论+一句理由+否决备选
- §3 API 契约冻结：包 A / 包 B 并行依据，包 B 以 mock 先行

## 1. 目标 / 非目标

目标（业主确认动线，不可变更）：智能体动态面板（agents.js act-panel）点活动条目 → 弹出该 agent 会话列表（时间+标题+项目）→ 点会话 → 内容阅读器（提示词/回复/工具调用按序只读渲染）→ 看中的产出一键挂到任务成果区（复用既有归因闭环）。同步退役两块旧 UI：agents-grid 观测卡阵、sessions-table 会话登记表。
非目标：写回/编辑会话、跨源语义聚合、ChatGPT 云端对话（§9）；不改 agent-activity 活动流既有形状（仅条目增可选 ref）；不重构归因；不做 i18n。

## 2. 关键设计决策

| # | 决策点 | 结论 | 理由 | 否决备选 |
|---|---|---|---|---|
| D1 | ref 编码 | 后端签发 base64url(JSON{s,k,v}) 不透明串；解码后按源 locator 白名单正则 + realpath 前缀双闸校验（§3.3） | 客户端永不持有原始路径，穿越面收口到后端一处 | 原始路径参数（F10 编码风险、穿越面扩大）；HMAC 签名（ref 非机密，白名单校验已足，徒增钥管理） |
| D2 | 长转录渲染 | IntersectionObserver 哨兵分段懒渲染：首批 100 条，哨兵进视口向上续染 100 条，已染节点保留 | 零依赖；实测 855 条规模 DOM 可控；浏览器 Ctrl+F 对已染节点可用 | 一次性渲染（主线程数百 ms 卡顿）；真虚拟滚动（零依赖实现复杂、破坏查找/锚点，此规模不值） |
| D3 | artifacts 契约扩展 | POST /api/tasks/:id/artifacts kind 增 `'session'`：url 改条件必填（kind≠'session' 时必填 http(s)，kind='session' 时 url/repo/ref 一律不入库置 null）；新增 `sessionRef`（kind='session' 必填，≤512 字符，过 §3.3 校验）与 `title`（必填 ≤200 字符）两个独立字段 | 复用既有端点/事件流/解除逻辑，零新暴露面，存量 commit/pr 零影响。**不复用既有 `ref` 字段**：board.js:641 将 art.ref 按「PR 序号/commit 哈希」语义渲染，双义会把 base64 串漏进成果区 | 独立挂接端点（重复鉴权/去重/事件流三套逻辑）；ref 双义按 kind 判读（撞上 board.js:641 既有渲染） |
| D4 | workbuddy 降级 | 会话列表照出；transcript 返回 200 + `degraded:true` + reason，前端提示「该源暂不支持全文阅读」，列表挂接不受影响 | 实测 workbuddy.db 无消息/转录表（F2），与派单「全文已实证」矛盾，实测优先；列表价值仍在 | 硬造 transcript（编造数据违红线）；隐藏 workbuddy（丢列表价值） |
| D5 | topology 会话节点层 | 数据源从 data.sessions 改为 /api/agent-activity 条目（makeItem 增可选 ref，可回查的源才填），点击节点直接开阅读器 | /api/sessions 退役后，会话数据唯一真相是 agent-activity | 节点置灰保留（死 UI 即误导）；删除节点层（任务拓扑信息量回退） |

## 3. API 设计【设计决策，契约冻结】

### 3.1 会话列表：GET /api/agent-sessions

- 查询：`agent` 必填（∈六源 id，否则 400 BAD_AGENT）；`limit` 默认 20、上限 50（超出按 50）；`cursor` 可选（base64url(JSON{t,id})，t=lastActiveAt 键集游标）。
- 响应 200：`{agent, items:[{ref, id, title, projectId, startedAt, lastActiveAt, state}], nextCursor|null}`，按 lastActiveAt 倒序；title 空回退「（未命名会话）」。
- 标题来源与活动流同源（复用各适配器现有取法）：zcode/opencode/workbuddy 取 session 表 title 列；claude 取首条有文本行（与活动流一致，回退 last-prompt）；dsh/codex 取首行元数据/首条 user 文本前 60 字。
- 限额入 config：config.agentActivity 增 `sessionList:{limit:20,maxLimit:50}` 与 `transcript:{maxMessages:1000,maxCharsPerMessage:20000}`，normalizeAgentActivity 兜底（F1）。

### 3.2 会话全文：GET /api/agent-session?ref=<opaque>

- ref 走查询参数（F10：规避路径参数中 %2F 的编码/匹配风险）。
- 响应 200（正常）：`{ref, agent, title, projectId, startedAt, lastActiveAt, degraded:false, total, truncated, messages:[…]}`。
- 消息归一化 schema（seq 升序=阅读顺序）：`{seq, role:'user'|'assistant'|'tool', ts|null, text, tool:null|{name, status}}`；status ∈ ok/error/running。一条源记录含多块（如 claude 助手行 text+tool_use）拆为多条 message，seq 连续递增；tool_result → role:'tool'（不沿用原生 user role，按语义归位）。
- 文本管线：sanitizeText（ANSI/控制字符剥离，agentActivity.js:115 既有）→ 截断至 maxCharsPerMessage（超长尾部 `…[截断]`）→ redact(text)。
- 响应 200（降级，workbuddy）：`{ref, agent, title, degraded:true, reason:'SOURCE_NO_TRANSCRIPT', messages:[]}`（挂接所需 ref/title 仍齐备）。
- 错误（HttpError，F10）：400 BAD_REF（解码/白名单/realpath 任一不过，错误信息不回显解析后路径）、404 SESSION_NOT_FOUND。
- 超限：消息数 > maxMessages 时保留前 N 条、`truncated:true` 且 total=实际总数。

### 3.3 ref 不透明引用（D1）

- 结构：`base64url(JSON {s:源 id, k:locator 种类, v:locator 对象})`；仅后端构造，出现在列表条目、activity 条目、artifact.sessionRef 中。
- 校验流水线（lib/sessionRef.js 单一收口）：① base64url+JSON 解码失败 → 400；② s ∈ 六源、k ∈ 该源白名单；③ v 逐字段过 §3.4 正则；④ path.resolve 后 realpath 必须 startsWith 对应源根（config.agentActivity.sources.*.root|dbPath 推导）；⑤ 无状态不落库，无失效问题。

### 3.4 六源 → 一 schema 映射表（基于 F2 实测形态；首日 spike 结论已回写，2026-10-20）

| 源 | locator（k:v 模式） | user | assistant | 工具调用 | 备注 |
|---|---|---|---|---|---|
| zcode | session:{id=三形态正则 sess_<uuid>/session_<hex32>/sess_subagent_agent_<uuid>}，db.sqlite（<root>/db/db.sqlite）session 表按 id 查行 | message(role=user) 关联 parts 的 text | role=assistant 的 parts text | 工具类 part → role:'tool' | 【R1 已验证】session.id 与 sess_* 目录名同名同形（db 为超集：576 id ⊇ 458 目录，0 目录缺席）；time_deleted 非空=已删，列表/全文均排除；【R2 已验证】message.data={role,...}、part.data={type:text\|tool\|...}，tool part state.status ∈ completed\|error\|...、state.input/output；message/part 按 sequence 列排序，data 为 JSON 列 |
| claude | project:{dir=无路径分隔符, file=<uuid>.jsonl 正则} | type=user 行 text 块 | type=assistant 行 text 块 | tool_use 块→tool 发起（tool.name/status:ok）、tool_result 块→role:'tool'（按 tool_use_id 配对继承工具名，is_error→error） | 跳过 isSidechain=true（子代理旁支）与 attachment/queue-operation/last-prompt 行 |
| dsh | file:{path=session*.jsonl.zstd 相对路径，禁 ..、禁盘符} | extractLineText 多形态（:191） | 同左 | 行内工具标记 → role:'tool' | 【R3 已验证】zstd 为多帧拼接（单次 sync 只出首帧，须按 0x28B52FFD magic 逐帧解压）；行形态 {type,seq,time,data}，消息行 user/message、assistant/message、tool/call（data.name/arguments）、tool/result（data.message.content[].isError），tool/call→running、tool/result→ok/error（callId 配对）；其余行（session 元数据/step/turn/*-chunks 流水）跳过不报错；rollout-*.jsonl 明文分支同构 |
| codex | file:{path=YYYY/MM/DD/rollout-*.jsonl 正则} | response_item payload role=user | role=assistant | function_call/function_call_output → tool 发起/role:'tool'（call_id 配对；无则降级纯文本） | session_meta→头部字段；跳过 turn_context/world_state/event_msg |
| opencode | session:{id=ses_+24 位大小写字母数字正则（【R2 已验证】实测非 uuid）} | 同 zcode 三表构型 | 同左 | 同左 | 只碰 session/message/part 表；message/part 无 sequence 列，按 time_created,rowid 排序 |
| workbuddy | session:{id}（sessions 表只读 SELECT） | —（降级，D4） | — | — | 仅列表；transcript 恒 degraded |

## 4. 前端交互【设计决策】

- **钻取动线**：act-panel 条目（agents.js:326-342 现无点击行为）增 click → openModal「会话列表」弹层（modalStack：Esc 只关栈顶，ui.js:198）；列表行 click → 叠开「阅读器」弹层（modal-wide）；阅读器「← 返回列表」按钮/Esc 逐层回退，列表弹层不销毁不重拉（滚动位置与分页态保留）。modalDepth>0 轮询自动暂停（ui.js:177 既有）→ 阅读中零重绘跳屏。
- **可点 affordance**：条目 cursor:pointer + hover「查看会话」提示；workbuddy 条目照常可点（列表+挂接仍可用，进阅读器见降级态）。
- **阅读器三分视觉**：用户提示=左侧 accent 竖条+「用户」标浅底块；助手回复=「助手」标常规底块；工具调用=灰底 mono 折叠块（折叠态=工具名+状态徽标，点击展开入参/结果全文），与对话流显著区分。
- **长转录**（D2）：头部显示标题+起止时间+项目+「共 M 条」；truncated 提示「仅载入前 N / 共 M 条」；「回到底部」浮动按钮。

## 5. 挂接闭环【设计决策】

- 阅读器工具栏「挂到任务」→ 复用 activity.js openAttachModal 范式（F6 :319-393：任务下拉 updatedAt 倒序 + 摘要只读 + 去重提示）→ POST /api/tasks/:id/artifacts `{kind:'session', sessionRef, title}`（不带 url，D3 契约）。
- 去重口径：现有同 url 去重对 session 不适用，改「同 task 下同 sessionRef 去重提示」，复用同款交互。
- 事件流：detail=`挂接成果：session <title 前 40 字>`，type 仍 'artifact'（时间轴成果节点零改动）。
- board.js 降级：kind='session' 无 url → 成果区/时间轴渲染纯文本徽标「会话：<title>」（safeHttpUrl 口径不动、不渲染 href="#" 死链，吸取 v2.1 W9 教训，board.js:612）；art.ref 天然为 null 不渲染（:641），**零改动**。
- workbuddy 降级态挂接照常：列表条目与阅读器头部均有挂接入口。

## 6. 退役清单（F4/F5，逐一列出）

前端：

| 项 | 位置 | 处置 |
|---|---|---|
| agents-grid 观测卡阵 | agents.js renderGrid/recentHtml 卡内分支 | 删容器与渲染；智能体页仅留 act-panel（钻取入口）+拓扑 |
| sessions-table + refreshSessions 10s tick | agents.js | 整体删除（含 stopSession/openLogModal 与相关 state；openLogModal 引用的 GET /api/sessions/:id/log 后端本无注册，死链，F4） |
| topology「AI 会话」节点层 | views/topology.js:67/83 + jumpToSessionRow | 按 D5 改造：数据源 agent-activity，点击开阅读器 |
| mock.js sessions 段 | web/js/mock.js:378-380/573-575 + 概览 sessionsRunning | 删；新增 agent-sessions/agent-session 两组 mock（含工具调用样本、workbuddy 降级样本、一条 ~855 条长转录样本） |

后端：

| 项 | 位置 | 处置 |
|---|---|---|
| lib/sessions.js（81 行） | GET /api/sessions + POST /api/sessions/:id/stop（taskkill） | 删文件；「停止会话」能力随之退役（无消费方，派单「评估去留」结论=退） |
| 端点注册 | test/helpers/appAssembler.js:774 | 删注册行 |
| store.loadSessions/saveSessions | lib/store.js:313/318 | 删方法（数据层收口） |
| data/sessions.json、data/session-logs/ | 数据残留（仅剩 sleeper 测试行，F4） | 删文件与目录 |

保留：GET /api/agents 不动——board.js:142 任务表单执行者下拉依赖（F3），与本次退役无涉。

## 7. 隐私红线（验收级）

1. 全链路只读：六源 sqlite 均 `{readOnly:true}` 打开、文件 openSync 只读、zstd 内存解压；对任何源目录/db 零写入、零删除。
2. 表级白名单：workbuddy 仅 SELECT sessions 表；opencode 仅 session/message/part 表；两源其余表（使用统计/自动化/account/credential）一概不触碰。
3. 服务端统一脱敏：会话列表 title 与 transcript 每条 text 在组装时过 redact(text)（F8，registerSecret 接线 appAssembler.js:756），前端不做脱敏（不信任端原则）。
4. ref 双闸校验即 §3.3；非法 ref 一律 400，错误响应不回显解析后路径（防探测）。
5. 暴露面零新增：仅两条新 GET 端点；插件态走既有 /fde-api/* 前缀与宿主回环监听（F9）。

## 8. 任务拆解（两包并行）

包 B 以 mock 先行，与包 A 全并行；联调仅需包 A 冒烟通过。测试共用 test/helpers/appAssembler.js 装配真相（F9）。

### 包 A：后端（约 1.5 天）

| # | 任务 | 要点 |
|---|---|---|
| A0 | 首日 spike（§10 三项） | 结论回写本规格 §3.4，不定则 zcode 按 R1 回退实现 |
| A1 | lib/sessionRef.js | D1 编解码 + 六源白名单 + realpath 校验，单一收口 |
| A2 | lib/agentTranscript.js 六源适配器 | §3.4 映射表；复用 ADAPTERS 构型与 codex/opencode 先例（agentActivity.js:788/:834/:869） |
| A3 | 两条端点 + config 扩展 + makeItem 增可选 ref | normalizeAgentActivity 兜底（F1）；zcode ref 受 R1 制约 |
| A4 | artifacts 契约扩展 | D3；kind 校验、url 条件必填、sessionRef 过 §3.3 校验（appAssembler.js:280/:293） |
| A5 | 后端退役 | §6 后端表 |

验收：`node --check lib/sessionRef.js lib/agentTranscript.js lib/agentActivity.js test/helpers/appAssembler.js`；新增 `test/agent-sessions.test.js`（用例：ref 编解码与穿越——`..`/绝对路径/错源/坏 JSON/越权 realpath、六源映射样本断言、workbuddy degraded、artifacts kind=session 契约与 sessionRef 非法拒收、退役端点 404）；`node --test` 全量（239+新增）全绿；curl 冒烟：`GET /fde-api/agent-sessions?agent=zcode` → `GET /fde-api/agent-session?ref=<上一步 ref>` 200 且 seq 升序。

### 包 B：前端（约 1.5 天）

| # | 任务 | 要点 |
|---|---|---|
| B1 | act-panel 点击 + 会话列表弹层 | §4 前两条；limit/cursor 分页「加载更多」 |
| B2 | 阅读器弹层 | D2 分段渲染 + 三分视觉 + truncated 提示 |
| B3 | 挂接闭环 | §5：复用 attach 范式 + kind=session 提交 + 降级态入口 |
| B4 | board.js 降级渲染 | §5 纯文本徽标（ref 路径零改动，仅无 url 分支） |
| B5 | topology 改造 | D5 |
| B6 | 退役 UI + mock 更新 | §6 前端表 |

验收：`node --check web/js/views/agents.js web/js/views/topology.js web/js/views/board.js web/js/mock.js`（语法闸）；`node --test` 239 不回退（前端改动理论零影响）；`web/index.html?mock=1`（api.js:26 isMock）手工冒烟：三层动线往返、Esc 栈顶逐层关、阅读中轮询暂停、工具块折叠展开、855 条样本滚动不掉帧、workbuddy 降级提示与挂接、挂接后看板出现「会话」徽标、旧 UI（卡阵/会话表/拓扑旧会话层）不复现；联调后真实源（zcode+claude）各走一条完整动线。

## 9. 明确不做（本期 + 理由）

| 项 | 理由 |
|---|---|
| 写回/编辑/删除会话 | 源是各 CLI/应用的私有数据，只读是红线；阅读器定位纯观测 |
| 跨源语义聚合/全局搜索 | 六源 schema 本期刚归一，先验证单源动线，聚合列 v2.4+ |
| ChatGPT 云端对话接入 | 需出网+云端凭据，违反零出网红线 |
| 会话实时 tail/直播 | 只读快照语义；tail 需常驻句柄，暴露面扩大 |
| 看板会话徽标点击重开阅读器 | 需跨视图弹层接线，待动线验证后列 backlog |

## 10. 风险与首日验证项（【判断推测】→ 已全部验证并回写 §3.4，2026-10-20）

- R1 zcode：✅ 已验证——db.sqlite 位于 ~/.zcode/cli/db/db.sqlite（非 <root> 直下）；session.id 与 sess_* 目录名**同名同形**（含 sess_<uuid> / session_<hex32> / sess_subagent_agent_<uuid> 三形态），db 为超集（抽样最近 200 条：目录命中按形态分桶 136/169、27/29、1/2，未命中=纯 db 会话；反向 458 目录 0 条缺席）→ 按主路径实现：列表/全文以 db session 表为准，activity 条目透传目录名 id 构造 ref 可回查。
- R2 zcode/opencode：✅ 已验证——message.data JSON 内部字段 role（'user'|'assistant'）；part.data JSON {type: text|step-start|reasoning|tool|step-finish|patch|file, text?, tool?, callID?, state?{status:completed|error|..., input, output}, time?{start,end}}；zcode message/part 有 sequence 列，opencode 无（按 time_created,rowid 排序）。
- R3 dsh：✅ 已验证——zstd 文件为**多帧拼接**（实测 419KB/778 帧；单次 zstdDecompressSync 只出首帧=会话元数据行，这正是活动流 dsh 预览常态为空的根因），须按 magic 逐帧解压；行形态 {type,seq,time,data}，映射见 §3.4 回写。
- R4 六源体量：claude/codex 单 jsonl 可达数 MB，全文读入需 maxMessages/maxBytes 双闸（§3.2 已含消息闸，实现补 4MB 读入闸，超限 truncated）。
