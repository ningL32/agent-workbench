# FDE 指挥台 架构规格（docs/SPEC.md）

> 版本 1.1.0 · 2026-10-16 · 依据 `input-for-claude.md` · 硬约束：仅绑 127.0.0.1、凭据零落盘、零构建、契约先行
> v1.1 变更（业主补充需求）：新增成员进度视图——每个成员（AI 智能体 + 人类成员）的当前任务、推导进度、时效（停留时长/无更新预警）、状态、今日产出；新增 `GET /api/members`、F5 前端包、config 时效阈值。
> v1.2 变更：新增手工名册 `members.json` 与成员写接口（POST/PATCH/DELETE `/api/members`，409/400 分支齐全）、`GET /api/members` 聚合并入手工条目（新增 `manual` 字段 + giteaLogin 活动归因）、看板列 `PATCH /api/columns/:id` 支持 `order` 绝对序号（服务端归一化为 1..n）、任务新增 memberId 负责成员字段与 ?memberId= 过滤。
> v1.4 变更：任务新增 dueDate 截止时间（YYYY-MM-DD|null，允许过去日期）与 priority 优先级（high/medium/low，缺省 medium）；`GET /api/tasks` 支持 ?priority= 过滤；`GET /api/overview` tasks 对象新增 overdue 逾期计数；`GET /api/members` currentTask 透传 dueDate/priority。
> v1.5 修复变更（goose 真机验收第五轮 P1×3 + 附带，任务雷达域）：①说话人映射匹配源从手工名册扩为**聚合名册**（`store.aggregateRoster`：手工名册 ∪ Gitea 成员缓存，手工已认领 login 吸收为别名），四优先级 alias/name/gitea 精确 → 全字段小写双向包含（≥2 字），候选卡新增 `matchSource`（alias/name/gitea）归人依据；②分析引擎超时缺省 120→300s，对已失败纪要重试自动**升压 ×2**（job.results 记录 `attempt`/`timeoutSec`），`POST /api/radar/analyze` 202 响应新增 `items:[{id,segmentCount}]` 供前端长会预估提示；③「记住映射」目标为 Gitea 派生 id 时自动创建关联手工条目（`POST /api/members/:id/aliases` 响应 201+`created:true`；确认响应新增 `rememberedAlias`）；④`PATCH /api/settings` 对 `dataDir/webDir` 只读（忽略不写回），`GET` 回显磁盘原值而非运行期绝对路径。
> **分析时延目标修订（修订 PRD-task-inbox §7-1「全程 ≤60s/条」，以本行为准）**：短会 ≤60s；长会上不封顶但可观测——引擎超时缺省 300s、失败重试升压 ×2、job 记录 attempt/timeoutSec/耗时，202 响应带 segmentCount 供「长会，可能 2-4 分钟」类预估提示。
> v1.7 变更（任务时间轴域）：①task 新增 `completedAt` 完成日期（进入内置 done 列记当前时间、移出清 null、重进刷新，详见 §3「任务完成日期」）；②新增任务事件流 `data/task_events.json` 与 `GET /api/tasks/:id` 响应 `events` 数组（每任务最近 100 条、全文件 5000 条上限，详见 §3「任务事件流」）；③收件箱拒绝原因必选（400 `REASON_REQUIRED`）、新增 `POST /api/inbox/:id/done-already` 已完成处置（不入看板）、误识率口径改为 `rejected30d/(confirmed30d+doneAlready30d+rejected30d)`（详见 §3「收件箱 v1.7 契约」）。
> v1.7 修订（收件箱说话人映射解耦，语义变更）：`POST /api/inbox/:id/confirm` 新增可选 `speakerMemberId`（说话人身份映射目标），`rememberAlias` 的别名改写到 speakerMemberId 名下而非 `memberId`（任务负责人）——负责人 ≠ 说话人；旧客户端只传 `memberId`+`rememberAlias` 时**不再写别名**（`rememberedAlias:null` + `reason:"SPEAKER_UNRESOLVED"`，宁可不学不可错学），详见 §3「收件箱 v1.7 契约」。
> v1.9 变更（分支约定最小切片）：①launch 带 `taskId` 时自动注入分支工作约定到最终简报（黑名单只校验用户原文、`briefingHead` 仍为用户原文、session 新增 `conventionInjected`，taskId 无效软处理照常启动）；②Gitea 轮询落盘后按**精确规则**自动归因成果到任务（artifacts + artifact 事件，url 去重幂等），详见 §3「分支约定注入与成果自动归因」。
> v2.0 变更（验收签字 + 动态数据面增补）：①task 新增 `acceptorId` 验收签字人（与 memberId 负责人、agentId 执行者三方独立），事件流新增 `accept` 类型（变更/清除 + 进 done 且已有验收人时的「验收通过」联动事件），详见 §3「任务验收人 acceptorId」；②commit 类 activity 新增 `sha`（提交 id）与 `messageBody`（提交说明正文首段 ≤300 字符）两字段，`branch_created`/`branch_deleted` 的 `actor` 不再合成 `'unknown'`（置 null，前端显示中性图标；存量数据容错），响应只增不改，详见 §3「动态 / 设置」与 §4 activity 模型。
> v2.7 变更（任务日报）：新增 `data/diary.json` 与任务日报端点——`GET/PUT /api/tasks/:id/diary`（唯一键 taskId+date，同日 upsert 覆盖，201/200）、`DELETE /api/tasks/:id/diary/:date`（204/404）、`GET /api/tasks/:id/diary/prefill?date=`（Gitea 当天提交 + 当天 memo 事件两源预填拼草稿，date 缺省服务器本地今天，非法 400）；PUT 首存发事件流 `type:"diary"`（detail=`日报 <date>`，同日重写不重复发）；`GET /api/members` 成员对象仅增 `diaryToday`（名下 doing 任务当天是否有日报）；删任务顺带清理其日报；task 不加 diaryCount 冗余计数（前端从 diary 接口取数，避免 tasks.json 写放大），详见 §3「任务日报」与 §4 diary 模型。

> v2.9 变更（GitHub 组织动态源 + feeds 词表兼容归一）：①新增 `lib/githubClient.js`——`GET {github.baseUrl}/orgs/{org}/events` 适配为统一活动模型（PushEvent 逐 commit → `commit`、PullRequestEvent action=opened/reopened → `pr`、closed 且 merged → `pr`、Create/DeleteEvent ref_type=branch → `branch_created/branch_deleted`，其余事件计 `skippedEventTypes`），与 Gitea 源共写同一 `data/activities.json`（type|url 去重口径一致），状态独立落 `data/github-status.json`；启用仅经 config.json 手改 `github:{enabled:true,org}`（不入 settings PATCH 白名单，`GET /api/settings` 视图带出 enabled/baseUrl/org），凭据走 `git config --global http.<github.baseUrl>/.extraheader`（零落盘纪律同 Gitea），SSRF 白名单双节（gitea ∪ github，无 github 节行为不变）。②多源刷新编排：`GET /api/activities?refresh=1` 与 60s pollTick 均为「全部启用源失败才报错」——单源失败不拖垮其余源，各源 status 留痕；守卫类错误（HOST_NOT_ALLOWED 等）维持 400 快速失败。③feeds 词表兼容归一：config `activityTypes` 与存量 activities 条目的老三接口词表（commit_pushed/pr_opened/pr_merged）在 loadConfig/pollActivities 双入口自动归一为 feeds 新词表——修复历史部署 config.json 携带老词表导致 mapper 产出的 commit/pr 每轮被过滤丢弃的动态流停更事故（现象：轮询 ok:true 但 fetchedAt 冻结）；存量老词表条目轮询时原地改名，借 type|url 去重与新条目坍缩（零数据丢失）。④成员册增 `githubLogin`（动态 actor 匹配链与 giteaLogin 并列）；前端 activity/ui 全线双词表容错。⑤v2.9.1：**动态流 actor 自动派生成员整条退役**（业主指令「动态流 actor 派生的先不接入」）——`GET /api/members` 人类成员来源收敛为手工名册 ∪ Gitea 成员缓存（`/orgs/{org}/members` 轮询缓存），仅出现在动态里的 actor（如忘忧、qianqi）不再入册，团队动态页仍按未登记 actor 降级展示（中性图标+账号名）；任务 memberId 归领、活动归因、bot 静音等口径不变。⑥v2.9.2：**gitea.ignoreLogins 忽略账号**（默认 `["admin"]`，业主拍板 admin 过滤）——Gitea 成员缓存派生入册时的排除名单（大小写不敏感，config.json 手改/PATCH 可改，GET /api/settings 带出）；自定义名单整体替换默认。⑦v2.9.3：**会话列表钻取按项目过滤**——`GET /api/agent-sessions` 新增 `project` 参数（存在即过滤，含空串=未知项目组；归一口径与前端项目分组一致：去尾分隔符+分隔符统一+小写），过滤在键集分页前执行（游标不串组）；前端智能体动态条目钻取携带 projectId，弹层标题带项目短名、附「全部项目」键可切全量。⑧v2.9.4：**项目级绑定（task.projectDir）**——任务可绑定一个项目目录（ambient 归属关联，**不产生 artifacts**，与逐会话挂接完全独立）：POST/PATCH `/api/tasks` 增 `projectDir` 可空字符串（null=未绑定，非字符串 400 FIELD_INVALID），绑定/解绑发 `bind` 事件（detail 带路径，to=null=解绑）；前端会话列表弹层（项目作用域时）顶部显示绑定条——未绑定可「绑定到任务…」（一对一，改绑自动解旧并明示）、已绑定显示任务名 +「查看任务」（深链直开详情）/「解绑」；任务详情增「绑定项目」显示行；时间轴 bind 事件紫色节点。⑨v2.9.5：**数字员工周报 + 雷达摘要预览**——①`POST /api/weekly/generate`（202 job 轮询 `GET /api/weekly/job/:id`，引擎蒸馏 30~120s）：聚合四路养料（六源本周会话标题/项目（滤窗外、单源故障隔离、cap 120 条）、Gitea 提交/PR（滤 `[demo-team]` bot）、任务动态（本周完成/进行中）、人工日报）→ `buildWeeklyPrompt`（结构化中文指令+防编造约束）→ harness 引擎（dsh headless，DSH_FIXTURE 离线）蒸馏 → Markdown 落 `data/weekly.json`（仅存最新：weekKey/generatedAt/report/stats）；`GET /api/weekly`（404 WEEKLY_NOT_FOUND=未生成）。总览页「数字员工周报」面板：生成/重生成、极简 Markdown 渲染（esc 后转换防注入）、复制 Markdown。②`GET /api/radar/messages` slim 增 `excerpt`（首 2 段拼合、压空白、截 120 字，全文不进列表）——纪要池行内两行截断预览，治听记标题与内容错位（串场）识破。⑩v2.9.6：**数字员工日报（自动档）**——报告管线按 KINDS 参数化（daily：1 天窗/抽样 20 条/≤300 字/report-daily.json；weekly：7 天/35 条/≤600 字/weekly.json），新端点 `POST /api/daily/generate`、`GET /api/daily/job/:id`、`GET /api/daily`（404 DAILY_NOT_FOUND）；**自动档** `maybeAutoDaily` 挂轮询 tick——本地时间 ≥08:00 且当日未生成则自动跑昨日窗口，失败每小时最多重试一次（进程内节流），守卫序=今日已有→未到点→节流；总览面板改「数字员工报告」（日报|周报 tab，localStorage 记忆），日报键 dayKey=服务器本地日期。
> v2.9.8 变更（指挥台嵌入形态）：插件面板（shell.overlay iframe）新增三态显示模式——分栏（默认，右侧 ≤72%，不遮挡宿主侧栏与主界面）、浮窗（右下角窗体）、全屏（铺满，此前唯一形态）；顶栏按钮切换 + localStorage 记忆（fdec-mode）；关闭语义不变（隐藏不销毁 iframe，Esc/✕ 均可）；点外即熄——点宿主任意位置（面板与开关之外）自动收起，iframe 内操作不受影响。嵌入契约详见 SPEC-PLUGIN §2.3。
> v2.9.9 变更（任务雷达）：①纪要池新增删除——`DELETE /api/radar/messages/:id`（200 `{ok,deleted}`；未知 id 404 `MESSAGE_NOT_FOUND`；只删纪要本体，已产出的收件箱候选独立流转不连带）；②收件箱按会议标题（messageTitle）分组渲染：组序按组内最新候选倒序、组内按创建时间倒序，组头带条数与最近提议时间（纯前端分组，`GET /api/inbox` 契约不变）；③候选卡创建时间以绝对值（YYYY-MM-DD HH:mm）明示（createdAt 字段已有，仅前端展示补强）。
> 2026-11-03 修复（数字员工日报/周报·会话采集出窗即止误伤整源）：业主报「昨天 zcode 和 chatgpt 都有工作记录，日报里没有」——`collectWeeklyFacts` 会话采集假设六源列表新→旧且「出窗即止」，但该假设只对窗口上界≈当前时刻成立；**日报/周报是当天生成、采过去窗口**，列表最前是比窗口新的条目（生成当天的会话），首个条目即触发 outOfRange break → 整源计 0（真机 perAgent zcode:0/codex:0，而热力图同日 zcode 12 会话/2894 分钟——底层数据在，纯采集层缺陷）。修法：比 `until` 新的条目 **跳过继续**（后面才会进窗），越过 `since` 下界才止。回归锚=夹具改为真实的新→旧排序（旧夹具今日会话排在昨日后，恰好掩盖本缺陷——AGENTS 坑 6 的又一实证）；周报自然窗同路径同修复。全量 497 绿（+1 断言），真机重生成日报对账：zcode 12/codex 3 入报，蒸馏内容含巡检/升级评估/代码评审等真实工作。
> 2026-11-03 变更（开源发布·批 A/B）：**批 A 公司信息清理 + 雷达 optional 化**——全仓机械替换 48 文件（真实主机名/组织/项目名/同事真名→example 口径占位，含大小写变体与映射明细不回显原值，作者代号保留；运行时默认 baseUrl/org 随之转 example 口径，SSRF 大小写用例同步换名零断链）；setupCheck dws/lark-cli 未安装 → ok:true+optional:true（不卡 allOk，detail 明示仅雷达同步不可用，字段透传前端）；内部历史草稿归档 docs/internal/（input-for-claude.md、spec-a2a-draft.md，发布面可整体排除）。**批 B 演示数据集 + 发布包补漏**——新 scripts/seed-demo.js（全合成演示数据：成员/任务/纪要/收件箱候选/团队动态，李雷/韩梅梅占位、零出网；走 store JSON 通道面向未迁移目录，目标存在 fde.db 即拒绝；临时目录灌数→读回全对账→清理实证）；package.json files 白名单补齐 scripts 六脚本（**修复既有缺口：mcp-server.mjs/write-agent-context.js/backup-data.js README 宣传了但不在发布包**）；README 双语补「演示数据集」节。全量 505 绿（+可选组件口径 1 例）。
> 2026-11-04 修复（双评审终审·7 P1+11 P2 收口，报告 docs/reviews/REVIEW-code-2026-11-03.md）：**P1-1 日报/周报养料断粮**（claude 实锤）——weekly.js 直读 activities.json/diary.json 绕过 store 路由，已迁移实例上 Gitea 提交与人工日报养料静默恒空（真机 `.migrated-*` 归档实证；同日「日报漏源修复」只修了会话源窗口，养料源在真机上是死的）；改走 `store.loadActivities`/`diaryMod.loadDiaries`，真机重生成对账 commitsTotal 0→5（真实 Gitea 账号的当日提交入库）。**P1-2 bot 词表改名无读取归一**——weekly/activity.js 滤 `[demo-team]` 双认历史 `[teamai]`（AGENTS 词表纪律「换词表必须配读取时归一」的复发形态）。**P1-3 seed-demo 成员落点错目录**——members 运行时读 configDir（dataDir 上级）非 data/，脚本改写 ctx.membersPath。**P1-4 feishu 同步并发丢消息**——收尾重读磁盘按 id 合并写（盘上为准仅补真新增）+ settings 前端轮询超时不解禁按钮（防并发覆写）。**P1-5 开源残留二次清**——feishu-envelope 真会议原话/真 token/真租户域合成化、真实同事 login 与真实姓名→占位（不回显原值）、smoke PNG 真名断链（git mv 对齐引用）、mock sun.qian→demo.user。**P1-6 diaryMissing 排除 agentId 属主**（diary 是人工日报，硅基属主恒虚计）+ 空 catch 改 console.error(redact)。**P1-7 feishu identity 去掉 title 锚**（妙记改名防全池换 id/双份入库/墓碑失效）+ start_time 秒/微秒自动升幂 + page_token allowlist + 分窗收口 floor + 逐字稿路径 realpath 归一 + weekly NaN 留痕 + dingtalk feishu 健康 catch redact + settings redactedView 缩进复原 + setupCheck optional 前端「可选」中性徽标（不再假绿）+ 两处时区硬编码断言改现算（开源外部贡献者可跑）+ 桌面健康夹具补 hermes 显式关（防真探本机库）+ docs-sync 棘轮措辞修订（新路由带理由登记合法化）+ DISTRIBUTION 克隆改 https + ADAPTERS「第七源」改「新源」+ feishu 评审报告三处自评失实修正。**P2 记档不修**（裁决理由见终审报告）：钉钉侧 identity 锚 title 冻结（改锚点=存量池换 id）、两套健康徽标源集边界、源注册表 manifest 收敛（发布后演进）、smoke 截图发布面排除。全量 506 绿。
> 2026-11-03 变更（小尾巴合集：桌面源健康外显 + 驾驶舱行动条 + Hermes 第七源 + Mimosa 审计收口）：四项一批。**①桌面源健康外显**（评审尾巴+红线 8 现状反例收口）——desktopAgents 空 catch 改 console.error(redact) 留痕；新增 `GET /api/members/source-health`（逐源 {id,name,enabled,ok,detail,scannedAt}，limit:1 轻探、adapters 注入缝同成员册、关闭源 ok:null 不计分母）；成员进度页硅基 tab 右侧「N/N 源正常」徽标（title 逐源 detail，与智能体动态页同款）。**②驾驶舱行动条**（业主早期拍板「薄条+跳转不做仪表盘」）——总览统计卡下 thin chips：逾期/待验收/收件箱待处理/日报未填/在岗，只显示非零、全零整条隐藏，点击直达对应页；`/api/overview` 只增 `diaryMissing`（名下 doing 无当天日报的负责人去重计数，纯 tasks+diary 零源扫描）。**③Hermes 第七源**（评审 docs/reviews/REVIEW-hermes-source.md，opencode 先例完整复刻）——`hermesAdapter` 读 %LOCALAPPDATA%/hermes/state.db sessions 表（明文 SQLite 只读、Unix 秒浮点 ×1000、archived/hidden 出局、全参数绑定、id 白名单正则、opts.listSessions 注入缝）；成员册 4→5 源、设置归一化 6→7 键（normalize 显式键名单自动回填）；会话阅读器**真全文**（messages 表 display_order 装配，非 workbuddy 式降级）；活动面板五源不动（aggregate/snapshot/heatmap/agentContext 零波及，升源条件=活跃度起来，codex 先例）。**④Mimosa 完整审计收口**——deep 扫描终跑通（19 findings 0 业务逻辑候选），分诊=第三方参考代码/本地操作员工具/前端同源误报/已有跨函数防线/非安全用途指纹五类零开刀，报告 docs/reviews/AUDIT-mimosa-2026-11-03.md。测试 502→504 绿（+健康探针 4+hermes 2+diaryMissing 1，夹具四→五源与七源磁盘键更新）；真机：健康探针逐源实测、hermes 清单 3 条/阅读器全文/适配器 5 会话全通。
> 2026-11-03 变更（任务雷达·飞书妙记通道，lark-cli 桥接）：雷达入站第二源，与钉钉听记同构。**新 `lib/feishu.js`**：直调本机 lark-cli 原生 exe（bin 解析 config.feishu.larkBin → ~/.local/bin/lark-cli.exe → `where lark-cli` 命中 npm shim 同级包内 exe；凭据由 CLI 内部管理，本模块零凭据接触）；「我的妙记」= `--owner-ids me` ∪ `--participant-ids me` 并集按 minute_token 去重（官方口径），回溯期按 ≤31 天分窗查询（官方单窗最长 1 个月约束），新条目逐条 `+detail --transcript` 拉逐字稿——落地临时目录内 transcript.txt（路径越界即拒、读完即删）；逐字稿 TXT 行格式**已按真机样本校准**（2026-11-03）：「Speaker 1 00:00:02.520」独立行 + 内容行 + 头部元信息（录音日期/Keywords 块，丢弃）；段级 `at`=妙记开始时刻+行内偏移（精确到毫秒），无说话人行前缀的后续行一律续接（内容含冒号不误切）。消息模型 `source:'feishu'`（池/分析/收件箱管线零改动，复用 v2.9.28 多源先例）；增量锚点 sha256(`feishu|minutes|<token>|<开始时刻>|<标题>`)。**同日真机校准批次**（首个真实妙记触发两缺陷修复）：①分窗时区错位——窗口日期用 `toISOString()` 切串把东八区本地零点倒回一天，首窗不含当天 → 当天妙记永远搜不到（现象：同步 total=0）；改本地日期格式化后首窗恒含今天。②列表条目真实形态 `token/display_info/meta_data.app_link`（非 API 文档惯用的 minute_token/title/start_time/url）——标题=display_info 首行（剥 HTML 标签）、开始时间=display_info/description 的「开始时间: 2026.11.03 10:40:29」文本解析（程序式，本地时区）、URL=meta_data.app_link；旧形态字段保留兼容。纵深防御：minute_token allowlist（列表入口 validListItem + 子进程参数使用点 fetchTranscript 双校验）、ref.url 过 `feishu.hostWhitelist`（默认 `['feishu.cn','larksuite.com']`）、radarIgnore 墓碑/规则复用。**契约**：`POST /api/radar/sync/feishu`（202 job 轮询 `GET /api/radar/jobs/:id`；返回 `{total,added,skippedExisting,skippedIgnored,failed[]}` 与钉钉同步同口径；通道关 409 `RADAR_DISABLED`）；`GET /api/radar/engine` 增 `feishu:{enabled,larkBin,fixtureMode}` 节；`GET /api/setup/check` 增 larkcli 项（六项，文件级探测）。**config.feishu 节三处同步**：`DEFAULT_CONFIG.feishu={enabled:false,larkBin:'',larkTimeoutSec:60,maxMessages:200,lookbackDays:90,hostWhitelist}`（默认关——未装 CLI 的机器=功能不存在）+ `mergeConfigDefaults` 显式键名单 + settings PATCH/脱敏视图/缺省回填（TOP_LEVEL_ALLOWED 增 feishu）。**前端**：雷达页「同步飞书妙记」按钮（与钉钉同步同 job 互斥管线）+ 飞书来源徽标 + 原文链接标签分流、设置页「飞书采集」卡（路径/超时/上限/回溯窗）+「飞书妙记通道」开关（即时 PATCH）+ 手动同步按钮。测试 +20（`test/feishu-envelope.test.js` 15 模块级：envelope 解包/真实形态逐字稿解析/标题与时间与 URL 提取/身份哈希/分窗约束含今天回归锚/token 红线；`test/radar-feishu.test.js` 5 装配链：LARK_FIXTURE 同步入池→真实形态徽标与段级 at→哈希防重→RADAR_DISABLED→引擎健康节，全离线），全量 497 绿。**真机前置**：`npm i -g @larksuite/cli` → `lark-cli config init --new --force-init`（hermes 上下文被检测时需 force）→ `lark-cli auth login --recommend`（实测 `minutes:minutes:readonly` 被跳过也不阻塞 `+detail` 逐字稿拉取）。出站 IM 通知的飞书机器人（v2.9.39）不受本批影响，本批纯入站。
> v2.9.10 变更（任务雷达，纯前端）：收件箱分组折叠——组头整行可点（含键盘 Enter/Space，aria-expanded）展开/收起该组，折叠态只留组头（标题/条数/最近提议时间）；工具行新增「全部折叠/全部展开」（分组数 >1 时显示）；折叠状态存 localStorage（fde-radar-folded-groups）跨刷新记忆，渲染时剪除已消失的分组 key。`GET /api/inbox` 契约不变。
> v2.9.11 变更（任务雷达，纯前端）：收件箱组头在「最近 X 前」旁增加「创建于 YYYY-MM-DD HH:mm」——组创建时间 = 组内最早候选的 createdAt（该会议进收件箱的时刻）；纯展示，无契约变化。
> v2.9.12 变更（任务雷达）：**合并入库**——`POST /api/inbox/confirm-merged`：`{ids[≥2], title(人工必填 1..200), desc?, memberId?, priority?, dueDate?}` → 原子建 1 个任务（origin 溯源主候选 ids[0]，relatedMemos 收全部候选引用），N 条候选全部转 `merged`（新增状态，`mergedInto/mergedAt/decidedAt`），各候选记一条 memo 事件（原文可溯）；任一 id 非 pending → 409 `ALREADY_DECIDED`，update 型候选混入 → 400 `UPDATE_KIND_UNSUPPORTED`，未知 id 404。`GET /api/inbox` 候选视图新增 `mergedInto/mergedAt`（只增）；`GET /api/inbox/stats` 新增 `merged/merged30d`（**merged 不进误识率分母**——合并≠误识，单独观测拆解粒度）。前端：勾选 ≥2 条任务型候选 → 工具行「合并入库（N）」→ 合并弹层（标题/描述全人工填，候选只读预览）。update 型候选不参与合并。
> v2.9.13 变更（任务雷达，拆解提示词）：分析引擎提示词「拆解规则」重写粒度口径——删除「一句话含多个任务时拆成多张」的鼓励性指令，改为粒度原则（一张候选 = 可独立指派/验收的工作单元；同目标同负责人的连续子步骤合成一张、步骤写入 desc；宁大勿碎）+ 判断标准 + 正反例。输出 schema/置信度规则/查重分诊/名册与看板清单均不变，coerceResult 不受影响（测试夹具为引擎 stdout 存根，与提示词解耦）。预期效果：单纪要候选数下降、碎候选减少；观测口径 = merged30d（合并频次）与单纪要候选数。
> v2.9.14 变更（智能体动态，数据源）：①zcode 改以 `~/.zcode/cli/db/db.sqlite` 的 `session` 表为主源（新版 ZCode 已把会话迁库、`agents/sess_*` 只剩残留；旧文件布局保留为兜底，同 id 去重、`time_deleted` 会话出局、`last_outcome` 映射 completed/failed）；②codex 由「桌面成员册专用」升为活动面板正式第五源（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，首行 session_meta 取 id/cwd/timestamp，标题取首条真实用户消息、预览取尾部文本）。`GET /api/agent-activity` 的 `sources` 由 4 项变 5 项（顺序 zcode/claude/dsh/workbuddy/codex），条目形状与 ref 契约不变（zcode 仍为 `k:"session"` + db 主键）。
> v2.9.15 变更（Gitea 凭据读取）：`readCredential()` 在 `git config --global http.<baseUrl>/.extraheader` 未配置时，回退 `git credential fill` 走系统凭据管理器（wincred/GCM）。目标是「配置里零明文」部署：`~/.gitconfig` 不再需要写令牌，凭据由 OS 保管，且与 `git push` 共用同一份凭据，不会出现两个 Authorization 头冲突（该冲突曾导致推送 403）。失败/无 helper/超时一律退化为匿名请求（`GIT_TERMINAL_PROMPT=0` 保证不弹交互框）；无论来源，凭据值均注册进 redact。设置页 401/403 提示同步改为「凭据管理器或 extraheader 二选一」。
> 2026-11-03 变更（文档即断言 + §3 契约面清淤，零功能代码改动）：新增 `test/docs-sync.test.js` 11 用例六组断言——A 版本口径（package.json ↔ README.zh-CN 版本行 / DISTRIBUTION 兼容矩阵 / 本变更记录 / engines.node）、B files 白名单↔磁盘双向、C locale 双语词典、D API 契约↔路由注册双向对账（注册面=lib/*.js ∪ plugin/index.mjs ∪ test/helpers/appAssembler.js；**D2 首跑即清 12 条失效契约**——gateway/* 与 agents CRUD、旧 /api/sessions 系列实现早已移除而 §3 仍载（appAssembler:921 移除注释可证），已删；D1 为棘轮白名单，挂账 49 条 §3 存量覆盖缺口（现覆盖 16/65），**只减不增**，债务登记 BACKLOG #22）、E 文档互链可达（README*/AGENTS/docs/**，剥代码块防伪链接）、F 用户面文档禁精确测试计数。落地即修活体漂移 3 处：README.zh-CN 版本行 v2.9.64→v2.9.68（补 65-68 功能摘要与存储切换状态）、DISTRIBUTION 兼容矩阵 2.9.63→2.9.68、README.zh-CN 的 SPEC-STORAGE「待评审」→「已实施并真机切换」。设计：docs/proposals/PROPOSAL-docs-as-tests.md。全量 477 绿（+11）。
> v2.9.68 变更（成员进度·会话列按 tab 显隐，纯前端）：业主问人类 tab 的「会话」列是什么——该列=成员名下最近一次本机 agent 会话（六源观测的会话 id 短码+存活态），**只对硅基成员有意义；人类不产生本机 agent 会话，恒「无会话」= 噪音**。修法：人类 tab 整列隐藏（表头 `#mem-th-sess` hidden 切换 + memberRow 人类行不输出该 td + 加载/错误/空态 colspan 随 7/6 动态）；硅基 tab 不变。
> v2.9.67 变更（底部运行时版本号 + 批量挂接按钮时序修复，纯前端）：①footer 首位新增「运行时 vN」——refreshChrome 每次 30s 轮询顺带 GET /api/health，version=实例加载时的 package.json（随实例重启更新；仓库最新版见总览「版本与兼容性」矩阵，两者错位=该重启了）；②修 v2.9.66 批量挂接按钮「看不到」：原实现按钮在绑定横幅渲染时**条件生成**（N>0 才有节点），而横幅渲染常早于会话列表加载（items 尚空 → N=0 → 按钮节点不存在），此后 refreshAttachAllBtn 只更新既有节点 → **按钮永不出现**（业主实测复现）。修法=按钮恒渲染（hidden 起始），可见性与计数由 refreshAttachAllBtn 统一驱动（横幅渲染后/每次 draw 后均调用）。测试 466/466 绿（纯前端）。
> v2.9.66 变更（会话列表挂接按绑定态分流 + 批量挂接，纯前端）：业主实测困惑「顶部已绑定任务，行内怎么还要挂接」——三套入口（v2.3 行内按钮墙 / v2.9.4 绑定横幅 / v2.9.24 建议挂接）叠在一层没互相让位，绑定=归属、挂接=验收证据的语义没被界面表达。**C 方案按绑定态分流**：绑定作用域行按钮「设为证据」**一键直挂绑定任务**（目标无歧义免弹层；幂等由后端 url 去重+客户端台账保证）；已挂显示「已挂 ✓」置灰；未绑定/全部项目保留「挂接」弹层（需选任务，合理）；renderBindArea 维护 boundTask + rerenderRows 整表重放（绑定/解绑/改绑后按钮形态跟随；本地 artifacts 同步使弹层去重粗查随之准确）。**批量（业主追加「不能一键挂所有吗」）**：绑定横幅增「全部设为证据（N）」——N=已加载列表未挂数（加载更多后跟随），点击确认后**串行** POST（服务端 tasks.json 读-改-写，并发丢更新）+ 单条失败计数不中断，进度写按钮文案；挂完 N 归零按钮消失、全部行「已挂 ✓」。真机闭环：6 条批量挂接 toast/状态翻转/API 对账 20 条 session 证据零重复；还原流程未触发（本次为业主意图内数据变更，保留）。与建议挂接互补：任务侧打分挑证据、浏览侧单条/批量确认，同落 artifacts。纯前端零后端改动。
> v2.9.65 变更（存储迁移批次 2：tasks/activities/inbox/diary + learn 五单元——自有数据全部进 SQLite，一步到位）：SPEC-STORAGE v1.1 批次 2 落地（业主「learn 能迁就迁，期望一步到位」）。**storeDb 新增**：tasks（13 投影列+data 真源，含 artifacts[]）/activities（url=幂等键）/inbox/diary（task_id+date 复合主键）四行表 load/save（全量替换事务语义与 JSON 版同构）+ learn_docs 单文档行 load/save（learn 五单元 items/pages/schedule/sessions/scan 整文档一行——零形状风险最小侵入，行记录化留学习域演进）。**路由接入**：store.loadTasks/saveTasks（**列定义抽伴生 columns.json**——db 路径列定义来源，迁移时 afterImport 从源 tasks.json 抽出；loadTasks 返回 {columns,tasks} 形状不变）/loadInbox/saveInbox；diary.js loadDiaries/saveDiaries；**learn.js 漏斗收敛**——loadJSON/saveJSON 两封装按台账路由（六处 store.writeJSON(fileOf) 写点全部收敛进漏斗，业务 1300+ 行零改；**db 推导用 ctx.dataDir 而非 learnDir 子目录**——库在 data 根，首版用子目录推导致路由永不生效已修）。**散点收敛（迁移正确性关键）**：routes-gitea 本地 fs loader 删除（loadTasks 返回 .tasks 数组保持调用方契约；store 导入补齐）；三 poller 客户端 activities 写点 + giteaClient.readExistingActivities 基线读全部改走 store 路由——**fs 直读在迁移后拿空基线 merge=轮询一次丢全部历史**（静默缺陷，靠「写点清点」工序暴露）。**migration.js 重构**：DDL 八表；UNITS 全单元注册表（read/validate/clear/count/afterImport 分发表，通用循环取代两单元硬编码；learn:* 五单元整文档单行）；unitFile 路径边界闸（Mimosa 拦路径穿越→UNITS 常量虽硬编码仍补显式边界——纵深防御）；tasks 列抽取 afterImport。**backup unitFileOf 映射扩展**（含 learn/ 子目录路径，恢复重导入覆盖全单元）。**测试 +1 大例**：五域往返同构（11 单元全迁移/9 有源+2 无源正确跳过/store·diary·learn 公开 API 读回同构含 artifacts 开放字段/写路由后 JSON 不再生/伴生列更新），全量 466 绿。**切换仍未执行**（同批次 1 口径）：真机导入=备份→停实例→`node scripts/migrate-storage.js`（--dry-run 先行）→冒烟，排自然重启边界；执行后 data/ 下业务 JSON 全部消失（*.migrated 归档+columns.json 伴生例外）。
> v2.9.64 变更（存储迁移批次 1 实施：后端抽象 + messages/task_events 两单元 + 迁移器）：SPEC-STORAGE v1.1 设计（红线 3 修订后）落地。**单元路由层**：新 `lib/storeDb.js`——`data/fde.db`（WAL + busy_timeout 5s）；meta 表单元台账缓存进程内，**台账无标记=原 JSON 路径逐字节不变（默认零行为变更）**；全部 prepared statement 参数绑定（LIMIT/OFFSET 亦可绑定，零字符串拼装 SQL）；quick_check 失败 → fde.db 改名 *.corrupt-* + throw 503 DATA_CORRUPT loud（绝不静默回落旧数据——JSON 原档已归档，回落=拿旧当新）。**路由接入**：store.loadMessages/saveMessages、taskEvents.loadEvents/saveEvents/appendEvents/removeTaskEvents 逐单元路由（调用方签名零变；removeTaskEvents 返回删除计数与 JSON 版同构，node:sqlite run().changes）。**迁移器**：`lib/migration.js` runMigration + `scripts/migrate-storage.js` CLI（前置备份→instanceLock 存活实例拒绝→形状校验坏行不静默丢→单事务导入→行数对账→台账登记→JSON 改名 *.migrated-<ts> 归档；幂等/--force/--dry-run）。**自纠缺陷三枚**：①台账缓存投毒（runMigration 幂等检查先于导入调用 unitBackend 缓存空台账→路由永回 json——导入完成即 clearCache）；②裁剪差一（`seq<=` 边界行多删——Mimosa 拦模板字面量 SQL 插值，改全参数绑定顺带修复）；③删除计数缺失。**备份语义**（SPEC-STORAGE §5）：backupOnce 先 wal_checkpoint(TRUNCATE) 再拷 fde.db；*.migrated/tmp/corrupt 排除；restoreBackup 双格式——档案含 db→清 storeDb 缓存，旧代纯 JSON 档案+已迁移单元→自动重导入（恢复后系统可用）。**测试 +5**：task-events 路由同构（追加/双重裁剪边界/removeTaskEvents）、迁移器 dry-run 与往返同构（坏行剔除报告/原档归档）、备份含 db 与旧代档案自动重导入——全部经 runMigration 建库，测试文件自身零 node:sqlite（Mimosa 钩子）；backup 恢复用例独立根目录（共享 Temp\backups 的 keep:5 滚动清理会剪掉测试档案）。全量 465 绿（JSON 默认路径零回归）。**切换未执行**：台账初始空=JSON 仍是运行态；真机导入（备份→停实例→migrate-storage→冒烟）排下一次自然重启边界。
> v2.9.63 变更（任务雷达：删过的纪要不回来 + 关键词/标题过滤）：业主反馈"钉钉同步过来的，之前删了，再次同步又会显示"。根因：同步是**拉取式**的——删除纪要只删本地记录（`DELETE /api/radar/messages/:id`），下次同步从钉钉按 `taskUuid` 重新拉、重新分析，候选自然又冒出来。改法：新增 `lib/radarIgnore.js`（`data/radar-ignore.json`）两道闸——①**墓碑**：删除纪要时自动记 `{id,title,at}`，同步循环在建 id 后**先查墓碑再拉逐字稿**（省一次 dws 调用）；②**规则**：关键词（匹配标题 + 正文前 2000 字，大小写不敏感）/ 标题片段，命中即跳过。接口：`GET /api/radar/ignore`（名单 + 规则）、`POST /api/radar/ignore {rules}`、`DELETE /api/radar/ignore/messages/:id`（恢复）。同步返回值新增 `skippedIgnored`。UI：雷达页工具栏加「过滤规则」（弹窗里改关键词/标题、看已删除列表并逐条恢复），删除确认文案改为"删除并忽略"。**注意**：本次之前删掉的纪要没有墓碑，会再回来一次——要么再删一次，要么在过滤规则里加关键词。测试：新增 `test/radar-ignore.test.js` 4 例（墓碑、规则匹配、规则清洗、路由级删除即忽略），全量 460 绿。
> v2.9.62 变更（版本错位可见化，修"接口不存在"的困惑）：业主截图点「查看原文」弹"接口不存在"。根因不是 bug——**web 改动刷新即生效、lib 改动必须重启**，当时前端已是 2.9.61、后端进程还停在 2.9.57，于是点到 2.9.59 才有的接口。改法：①`GET /api/learn/status` 新增 `version: {loaded, disk, stale}`（`loaded` = `ctx.version`，`disk` = 读仓库 `package.json`，比对不一致即 `stale`）；②学习页顶部出现琥珀色横幅"实例运行 vX，仓库已是 vY——新接口要重启插件实例才生效"；③「查看原文」失败且是 404/接口不存在时，错误提示改成"这个功能要重启一下插件实例（后端还是旧进程）"，不再丢原始错误码给用户。这条以后能省掉一整轮"这是怎么回事"。测试 456 绿。
> v2.9.61 变更（到期与新题并行，修"每日 3 新题"失效）：业主实测今日队列只有 1 条（尺度效应到期）。根因：v1 的出队规则是"到期优先，到期为空才补新题"，而设置里已有「每日新题 3 / 复习 3」两个独立旋钮——两者语义冲突：只要有一条到期，当天就只剩那一条。改法：`pickDaily` 改为 **到期 ≤dailyReview + 新题 ≤dailyNew 并行**（先出到期，再按单双日池交替补新题）。测试同步：1 条到期 + 1 条新题 = 队列 2 条；2 条到期 + 1 条新题 = 3 条。全量 456 绿。
> v2.9.60 变更（进度条区分学习/复习 + 模式提示）：业主截图指出矛盾——文字说"先别看资料"（复习），进度条却从「读材料」开始高亮。根因：v2.9.57 把进度条步骤写死成 `study → 费曼 → 五问 → 迁移`，没区分复习。改法：①`createSession` 响应带 `isReview`（新学 false / 复习 true，含恢复旧会话的迁移分支）；②前端 `progressBar(stage, isReview)` 按模式取步骤：复习 `recall → 费曼 → 五问 → 迁移`，新学 `study → …`；③题面下加一行模式提示（"复习模式：先自己回忆（不给材料），提交后才对照原文" / "新学模式：先读材料，再用自己的话讲一遍"）。测试补 `isReview` 断言，全量 456 绿。
> v2.9.59 变更（材料可查看本地原文，模态框）：业主贴截图要求"材料里支持查看本地引用的 md，搞个模态框看详情"。①新增 `GET /api/learn/source?page=<rel>`（**只读**）：只允许 `.md`、必须落在知识库根内（`path.resolve` + 前缀比对，挡 `..` 与绝对路径穿越）、单文件上限 400KB（超了截断并标记 `truncated`）；`import:` 前缀的页面改从 `data/learn/imports/` 读，同样校验标识字符。②材料卡底部加「查看原文」按钮（无本地原文的内置主题不显示），知识点列表每行加「读原文」，两者都开**模态框**（`openModal` wide）按等宽行文显示全文 + 路径 + 截断提示。③样式 `.learn-src`（等宽、可滚动、最大 62vh）。测试 +1（readSource：正常读取 / `..` 越界 / 非 md / 不存在 / 空参 / 导入资料 / 导入标识非法），全量 456 绿。
> v2.9.58 变更（修新学材料丢失 + 材料加厚）：业主截图问"材料在哪"——服务端 2.9.57 已把材料随建会话下发（实测 stage=study、material 56 字），但前端 `startSession()` 里硬写 `material: null`，把响应里的材料丢了，于是界面只有题面没有内容。修：`material: s.material || null`（`source` 一并带上），并按阶段换输入框提示语（读材料阶段提示"读完用一句话概括"）。同时把材料加厚：新增 `materialFor()`——知识点卡片（定义 + 为什么重要）之后追加**来源页原文摘录**（页面 digest，≤400 字，导入资料标"导入资料摘录"），避免只给一句定义读不出上下文。前端为 web 改动：**刷新页面即生效**（无需重启）。测试 19 例通过。
> v2.9.57 变更（新知识先给材料再讲，"先测"只用于复习）：业主实测截图指出"这个逻辑不合理，我什么都不知道，你让我怎么写"——v1 对所有条目一律"先测（不给材料）"，对**从没接触过的知识点**是错的：检索练习的效果建立在"有部分记忆可提取"之上，纯新内容只会卡住人并打击动机。改法：①按**有无调度记录**区分入口——复习（有 dueAt/level）走 `recall`（先测、不给材料，仍守先测门）；新学（无记录）走 **`study`**（建会话即给知识点卡片，题面变成"读完用一句话概括"）；②`study` 收下概括后进入费曼讲解，后续五问/迁移不变（"必须自己输出"的原则没丢）；③**旧会话自动迁移**：v2.9.57 之前建的 `recall` 会话在恢复时补上材料（否则用户仍会对着空白发呆）；④顺带修**题面 markdown 泄漏**——纯文本渲染却输出了 `**第一性原理**`，全部改成「」或去掉星号（题面与材料都改）。测试改造 +1（新学给材料 / 复习仍守先测门），全量 455 绿。
> v2.9.56 变更（导入器：pdf/docx/html/md/txt → 学习库，零依赖）：业主"接着做导入器"。**约束**：AGENTS 红线 1 不许加第三方包，所以三种二进制格式全部自己解——`docx` 自己实现 zip 读取（EOCD → 中央目录 → local header → `inflateRawSync`）+ 抽 `w:t`；`html` 去 script/style、块级标签转 markdown、解实体；`pdf` 解 `FlateDecode` 流 + 抓 `Tj/TJ` 文本操作符（含八进制转义）。**落点**：`data/learn/imports/<slug>.md`（原子写），页面索引用 `import:` 前缀——**绝不写用户知识库**；`syncPages` 重扫时保留 `import:` 页面（否则一重扫就丢）。**诚实的限制**：PDF 若为扫描件或子集字体编码，抽不出字就**明确报错**（"先用 OCR/转换工具转成 md"）而不是塞乱码；实测本机唯一一份 PDF（3.8MB 电子书）就是这种，抽不出。接口：`POST /api/learn/import/preview {path}`、`POST /api/learn/import {path}`；设置页新增「导入资料」行。测试：新增 `test/learn-import.test.js` 6 例（html/docx/pdf 解析、格式过滤、导入落库 + 重扫不丢 + 能抽知识点），全量 455 绿。
> v2.9.55 变更（别人也能用：放宽库校验 + 初始化向导）：业主追问"别人用自己知识库时怎么办"。查出两个产品级缺陷：①`validateRoot` **硬要求** 根目录有 `AGENTS.md` 且含 "LLM Wiki" 标记——别人的 Obsidian 库/文档导出/普通 md 目录一律被拒；②没有初始化路径，只能手填路径→点扫描→祈祷抽出来能用。改法：①校验放宽为 **绝对路径 + 存在 + 目录**，LLM Wiki 只作 `flavor`（`llm-wiki`/`generic`）+ 一条 warning，不再拦；`learn.scope` 留空默认 `.`（整库），不再默认 `wiki`（那是本仓业主的目录约定）；②新增 `POST /api/learn/probe`（只读探测：md 数、顶层目录分布、会被过滤的比例、样本、推荐范围）与 `POST /api/learn/init`（一步落盘 → 建索引 → **试抽一页做预览**，预览不落库）；③学习页未配置时不再是"去设置"一句话，而是**三步向导**：填目录 → 探测结果（勾选范围、显示自动跳过多少）→ 初始化并试抽（列出 6 个知识点让用户确认颗粒度）→ 开始学习。测试 +3（普通目录合法、probe 过滤统计、init 落盘与预览不落库），19 例全绿。
> v2.9.54 变更（课程快照适配：只学课文，不学索引/产出物）：业主抓了 aieng 全仓快照（`raw/Agent抓取/ai-engineering-from-scratch/…`，9,827 文件 / 2,798 md，`phases/` 下 1,131 篇 = 542 节课），并新增 wiki 资产地图页。把这些课接进学习流时踩到三个坑，都在扫描器修掉：①**README.md 是阶段/课级索引**（22 篇），抽出来全是"本阶段有哪几课"这种元信息 → 跳过；②**`outputs/` 是课级产出物**（208 篇），不是课文 → 跳过该目录；③**`en.md` 是同一课的英文副本** → 跳过（`docs/zh.md` 已单独成条）。选定的 7 个阶段（00/07/10/11/13/14/17）实测：441 篇 md → **198 篇真课文**。另加**小节标题入料**：扫描时抓 h2/h3（≤12 条）存进页面索引，抽知识点时随材料一起喂模型——课程页的小节名（"核心概念/为什么这个循环无处不在/2026 年的坑"）比正文前 400 字更能定位该抽什么。实测一课（阶段 14 第 1 课）抽出 **8 个知识点**：ReAct 循环、Thought、Action、Observation、工具注册表、停止条件、基于 prompt 的思考 token、原生推理，全部带 ≤60 字定义与"为什么重要"。
> v2.9.53 变更（并入 aieng 术语表 + 修 today 路由 await）：业主点了 `https://aieng-zh.cn`（AI 工程从零开始，542 课/20 阶段/243 术语，MIT），其知识库里只抓到了**目录页**一页，学不到内容。处理：①新增 `lib/learnSeedsAiEng.js`——按该站术语表**只取术语名**、定义与"为什么重要"由本仓库自写（不逐字复制原站文案，便于二次分发），精选 **51 条**补齐本仓原有主题没覆盖的维度（分块/混合检索/RRF/Reranker/HNSW/Recall@K/Grounding、TTFT/TPOT/持续批处理/分页 KV Cache/前缀缓存/张量并行/分离式服务/Goodput、Eval Set/LLM 当裁判/Calibration/Pass@k/精确率召回率/验证门、SLI-SLO/错误预算/尾延迟/优雅降级/熔断/退避重试/幂等/读就绪/灰度/复盘、工具契约/结构化输出/Agent Harness/终止条件/HITL/委派/持久执行/补偿/权限最小化、模型路由/可观测性/任务成功成本/回归测试/抖动测试/范围契约/渐进披露/仓储地图）；②作为第 5 个内置主题「AI 工程」并入 `learnSeeds`，内置主题总数 56 → **107**；③**修 bug**：`todayQueue` 在 v2.9.51 改异步后，路由仍同步 `sendJSON(…, todayQueue(ctx))`，返回的是 Promise（客户端收到 `{}`）——改为 `async` + `await`，并补 `todayQueue` 契约用例（断言 resolve 出 `{queue,status}` 而非 Promise）。真机验证（临时实例）：`GET /learn/today` → `queue=1 / new / term=尺度效应 / source=wiki/学习卡片/2026-09-21-尺度效应.md`，`counts.items=113`（107 主题 + 6 抽取）。测试 16 例全绿。
> v2.9.52 变更（内置主题知识点：模型/Java/Agent/Python）：业主提出「还要模型相关、Java 开发、Agent 开发、Python 开发的知识，你自己去抓取也行」。知识库只读、且以业务笔记为主，所以这批不放 vault，做成**随插件走的内置主题库** `lib/learnSeeds.js`：4 个主题 × 14 条 = **56 个原子知识点**（每条 `term/definition(≤60字)/why(≤40字)`），只收不会快速过期的硬概念（上下文窗口/KV cache/量化/MoE/LoRA；JMM/volatile/CAS/GC 分代/虚拟线程；工具调用协议/ReAct/上下文工程/MCP/沙箱；GIL/asyncio/描述符/MRO/打包），版本号榜单参数推荐一律不收。**物化幂等**：`materializeSeeds` 只补缺不动调度，scan 后与出题前各补一次（老部署不重扫也有）。**混排**：单日先知识库、双日先内置主题（各取 1 条），保证业务知识与工程基础都轮得到；`learn.seeds=[]` 即完全只用知识库。配置：`learn.seeds`（白名单校验，未知主题直接 400 并列出可选值）。测试 443 绿（+2：物化幂等与交替、`seeds=[]` 关闭）。
> v2.9.51 变更（学习单元从「整页」改为「原子知识点」）：业主实测指出"出的题太宽泛，应该学每个知识点、比如专业术语"。诊断：v1 把**一个 wiki 页**当成学习条目，页面多是综述，自然出宽泛题。改法：①**pages / concepts 两层**——`data/learn/pages.json` 存页面索引（只读元数据），`items.json`（`version:2`）只存**原子知识点** `{term, definition, why, sourcePath, pageTitle}`；②**按需抽取**——未学知识点少于 3 条时，挑一页未抽过的页面调一次引擎（`buildConceptPrompt`：优先抽专业术语/机制名/关键判据，3-8 条，禁止"总体介绍"这类宽泛条目），抽完给页面打 `conceptsAt`，页内容变了（mtime）自动重置待抽；③**题面点名知识点**——先测/费曼/迁移都用 `term` 生成（"给完全外行解释「纳什均衡」…"），批改提示词明确"学员讲别的话题哪怕讲得对也给 level 0 并指出跑题"；④调度/会话/幂等全部按知识点粒度（id=`C-<sha1(page#term)>`，稳定可复算）。**只读门不变**：vault 仍只有 readdir/stat/readFile。**旧数据就地重建**（一页一条的旧 items 与知识点语义不符，读到旧版本即丢弃，孤儿调度无害）。实测：真实库 300 页；「博弈论八层阶梯」一页抽出 6 个知识点（纳什均衡 / 稳≠好 / 低阶与高阶 / 破局…），每个带 ≤60 字定义与"为什么重要"。测试重写为 11 例（含知识点粒度门），全量 441 绿。
> v2.9.50 变更（学习扫描跳过 ``_`` 前缀元页面）：首日实测今日队列挑中了 `wiki/学习卡片/_题库.md`——那是"卡片规范"元页面，不是知识。本库对 `_index`/`_方法论`/`_audit-notes`/`_题库` 一律用 `_` 前缀标元数据，故扫描器按约定跳过以 `_` 开头的文件与目录（可再用 `learn.exclude` 做局部例外）。实测：条目 312 → **310**，今日队列改为真正的知识页（标书AI 四仓横向对比）。
> v2.9.49 变更（学习批改默认关闭推理，实测 3.5s）：真机三档对照——`high` 串行 187s、`low` 并行 89.4s、**`off` 并行 3.5s**；`off` 下五问链仍 5 问齐全、批改仍能指出具体漏点（"没提基础率→条件修正→期望值的三步顺序""没提高估自己"）。故 `learn.engine.reasoningEffort` 默认由 `low` 改为 **`off`**（三处同步：DEFAULT_CONFIG / giteaClient.DEFAULTS / settings 视图），代码内 `hostEngine` 缺省同步；想更严可切回 `low`/`high`（配置项已支持）。桌面实例的 config.json 已由 PATCH 落成 `off`，实时生效无需重启。
> v2.9.48 变更（学习引擎并行 + 压推理强度，实测 137s → 62s）：桌面 2.9.47 真机一次批改 187s，且五问链失败被误标成「本次无 AI 批改」。三处修：①**并行**——批改与造链互不依赖，改 `Promise.all` 同时跑（串行=等两遍）；②**压推理强度**——宿主 `llm.stream` 的 `GenerateOptions` 支持 `reasoningEffort`/`maxTokens`（读 `dsh-llm/lib/types/types.d.ts` 确认），默认 `reasoningEffort=low`、`maxTokens=1200`（批改/造题是短输出任务，high 纯属白等）；③**降级语义纠偏**——只有**批改**失败才叫 `degraded`（界面才显示「本次无 AI 批改」），造链失败单独 `chainFallback`（界面显示「五问为通用追问」），两段错误分别记 `engineError`/`chainError`。配置新增 `learn.engine.reasoningEffort`（off/low/medium/high/max，默认 low）与 `maxTokens`（100..8000，默认 1200）。实测（fde-dev/GLM）：62.3s、`degraded=false`、`chainFallback=false`、五问 5 问齐全、批改 level 2 且指出漏讲点。测试 441 绿（新增推理强度断言）。
> v2.9.47 变更（AI 批改改用宿主模型，进程内直连）：业主问「为什么不是桌面端自己的模型」——此前 `lib/learn` 与雷达共用 `analyze.runHeadless`（spawn `dsh --profile headless`），而该 profile 的 provider 是 `zai-coding-cn`（`apiKeyEnv: GLM_API_KEY`），**不是**桌面 app 在用的账号模型；实测用 `--patch` 把子进程指向 `deepseek-account` 直接失败：`ACCOUNT_SIGN_IN_REQUIRED … The request destination must allow account authentication`——账号通道只在 app 内可用。改法：`plugin/index.mjs` 可选取 `ctx.get("llm")` 与 `ctx.get("agentDefaultModel")` 传进装配器（`ctx.llm` / `ctx.agentDefaultModel`），`lib/learn` 新增 `hostEngine`：进程内 `llm.stream()` 收集 `text-delta`，provider/model 取 `agentDefaultModel.currentSelection()`（桌面 = deepseek-account / DeepSeek-V4.1-Flash），`AbortController` 管超时。**优先级**：`auto`（新默认）= 有宿主 llm 就用、没有回落 spawn；`host` = 只用宿主（拿不到按无引擎降级，**不偷偷换 profile**）；`dsh` = 强制旧子进程路径；`off` = 关闭。雷达（`analyze.js`）本轮不动，仍走 spawn（避免牵动既有验收）。实测：真机一场批改 `degraded:false`、批改与追问质量正常；CLI 实例仍 137s 是因为**它 profile 的默认模型就是 GLM**，桌面 app 重启后即走 DeepSeek。测试 +2（宿主直连 / `mode=dsh` 不碰宿主），全量 441 绿。
> v2.9.46 变更（对外展示名改为「超级工作台」）：宿主侧栏入口与插件页标题此前是英文「FDE Console」／中文「FDE 指挥台」，业主指令统一改为 **超级工作台**。改动仅展示层：`plugin/client.js` 的 STRINGS（en/zh 的 `button.label`、`frame.title`）、`locale/en.json` + `locale/zh.json` 的 `meta.title`、SPA 的 `<title>` 与顶栏品牌名。**包名 `fde-console` 与代码/文档里的内部称谓不变**（profile link、测试断言、安装路径全依赖包名，改包名牵一发动全身）；品牌名在中英两个词典里都写中文，不做翻译。生效：客户端改名刷新页面即可；插件页标题由宿主读 locale 资源，需重启宿主。
> v2.9.45 变更（知识库学习模式 v1 视图）：接 v2.9.44 后端——**SPA 学习页 + 导航门控 + 设置卡片**。①`web/js/views/learn.js`：三标签（今日 / 学习库 / 统计）；会话按服务端状态机推进 **先测 → 费曼 → 五问 → 迁移 → 结果页**（每步必须提交文字，Ctrl+Enter 提交；刷新不丢，因为状态在服务端）；费曼批改结果以「讲对/漏掉/术语替代/与材料相反/追问」五行呈现；结果页显示掌握度、下次复习日、间隔，`needsRewrite` 与 `degraded` 都如实标注。②**导航门控**：`#nav-learn` 默认 `hidden`，`app.js` 用 `GET /api/learn/status` 的 `configured` 决定显隐（**配置了才有，不是灰掉**），30s 随顶栏轮询刷新；门控关闭时 `#/learn` 路由回落总览。③设置页新增「知识库学习」卡：总开关、根路径、扫描范围/排除、每日新题与复习数、**测试根路径**（只读校验）/ **重建索引**；开关随「保存设置」提交（`learn` 节入 PATCH）。新增图标 `book-open` 与 `.learn-*` 样式。真实知识库冒烟（临时数据目录，未碰真实 `~/.dsh`）：**312 条目 / 8 张卡片 / 扫描 2.8s**，今日队列正常产出。**真机跑通一整场会话**（recall → 费曼 → 五问 ×5 → 迁移 → 落调度）：引擎批改给出「讲对/漏掉/追问/level」，调度写入 `next=2026-11-01`。实测两个环境事实记入 `SPEC-LEARN.md §17`：① headless profile 靠 `apiKeyEnv: GLM_API_KEY`，DSH 进程必须从带该变量的环境启动，否则按设计降级；② 一次批改 + 五问链约 **137s**（reasoningEffort=high），界面已给「AI 批改中… Ns」计时。全量 439 绿（前端无自动化用例，以语法检查 + 冒烟补位）。
> v2.9.44 变更（知识库学习模式 v1 后端，视图下一批）：业主点名——本地知识库（**只读**）每日学习、费曼/5why、管遗忘曲线、**配置了才有**；方案见 `docs/SPEC-LEARN.md`。本批落地后端：新增 `lib/learn.js`（只读扫描 / 条目 / 调度 / 会话状态机 / 路由）。**只读门**：对 `learn.root` 只有 readdir/stat/readFile，产出全在 `data/learn/`（items/schedule/sessions/scan）；测试断言扫描前后 vault 目录快照（路径→mtime）完全一致。**先测门**：`POST /api/learn/session` 只回 recall 问题，材料正文要提交 recall 后才返回（响应里搜不到 digest）。**调度**（纯函数、表驱动）：阶梯 1/3/7/16/35 天；0/1 分 → 明日重来且 `lapses+1`（≥3 → `needsRewrite` 熔断，说明材料讲不清/选题太大）；2 分逐级、3 分跳级、35 封顶；>90 天未复习且 level≤1 → 当新条目重学；到期优先、**到期为空才补新题**（对齐 vault 题库「复习优先于新题」）。**会话**：recall → feynman（AI 批改：讲对/漏掉/术语替代/追问/level）→ why5（引擎生成链、逐问推进）→ transfer（迁移题）→ 落调度；一次会话固定 **2 次引擎调用**（批改 + 5why 链），引擎失败 `degraded:true` 降级继续不卡死。**接口**：`GET /api/learn/status|today|items`、`POST /api/learn/scan|session|session/:id/turn|session/:id/finish|items/:id/exclude`。**配置**：`learn:{enabled,root,scope,exclude,dailyNew,dailyReview,minutes,engine}` 三处同步（DEFAULT_CONFIG + mergeConfigDefaults + giteaClient DEFAULTS）+ settings PATCH 校验（root 必须绝对路径；存在性/AGENTS 标记由 status 校验——配路径时盘可能没挂，不该拦住保存）。引擎复用 `lib/analyze.js` 的 `runHeadless`（`dsh --profile headless`，超时/脱敏/fixture 全继承，零新依赖）。测试：`test/learn.test.js` 9 例。全量 439 绿。
> v2.9.43 变更（单实例登记与多实例告警，不硬拦）：背景=v2.9.25 真事故（桌面版 DSH 与 CLI 同跑共享 `data/`，旧代码每 60s 写脏归因，累计清 156 条）。新增 `lib/instanceLock.js`：`apply` 时在 `<base>/.instance.json` 原子登记 `{pid, startedAt, version, port}`，启动若发现**其它存活实例**就打一行 `⚠` 日志并列出 pid/port/版本；**不硬拦**——插件跑在宿主进程里，拒绝启动会连带把 DSH 拖下水，正确姿势是知情后自己决定杀哪个。`dispose` 时摘除自己，最后一个退出删除锁文件。判活 = `process.kill(pid, 0)`（`EPERM` 视为存活）；死 pid 在登记时清理，不制造假告警。新增只读端点 `GET /api/instance` → `{self, others, multiInstance, base}`；前端顶栏据此亮琥珀色「多实例」pill（30s 轮询；旧版后端无此端点则静默跳过），首次发现 toast 一次并带 pid/端口明细。测试 `test/instance-lock.test.js` 5 例（活体用父进程、死体用 spawn 后立即退出的子进程，不 mock `process.kill`）；`test/adapter.test.js` 补 `DSH_HOME` 临时目录隔离——`apply` 现在会写实例登记，测试绝不允许落到真实 `~/.dsh`（红线 3）。全量 430 绿。
> v2.9.42 变更（备份自动档默认关闭）：业主判断「数据都在本地，没必要每天备一份」——采纳，`config.backup.enabled` 默认由 `true` 改为 **`false`**（三处同步：`DEFAULT_CONFIG` + `giteaClient.DEFAULTS`；`mergeConfigDefaults` 结构不变）。备份**能力**全部保留：手动脚本 `scripts/backup-data.js`、`POST /api/backup/now`、`POST /api/backup/restore`（confirm + 先快照）；想开自动档改 config 一个键即可。同时纠正 v2.9.41 的说法：本地备份**防不住盘坏**（同盘一起没），它只防逻辑损坏（误删/误操作/双实例互踩写脏）；要防盘坏只能把 `fde-console` 挂同步盘。文档（AGENTS 红线 3 / DISTRIBUTION §6 / README）同步改口径。测试：`maybeDailyBackup` 用例本就显式传 `enabled:true`，不受默认值影响，425 仍绿。
> v2.9.41 变更（数据备份与恢复：唯一不可逆缺口的收口）：此前只有手动脚本 `scripts/backup-data.js`（`backupOnce` 带 manifest + 滚动保留 + 幂等不覆盖），**没有任何调度与恢复入口**。本批：①实现下沉 `lib/backup.js`（CLI 改为薄壳转调，CLI/API/调度共用一条代码路径）；②**每日自动备份**（默认开启；**v2.9.42 已改为默认关闭**）——`config.backup = {enabled:true, keep:14, at:'09:05'}`（三处同步：`DEFAULT_CONFIG` + `mergeConfigDefaults` + `giteaClient.DEFAULTS`），`pollTick` 到点且当日未跑才跑，状态记 `<base>/backups/.state.json`，保留 14 份（两周）滚动清理；③接口：`GET /api/backup/list`、`POST /api/backup/now`、`POST /api/backup/restore`（**必须 `confirm:"RESTORE"`**；备份名白名单 `backup-YYYYMMDD-HHMMSS(-n)`，恢复接口不吃任意路径；**先给当前状态拍快照再覆盖**，可再回滚；只覆盖同名文件、不删除 data 里多出来的文件）；④`GET /api/settings` 新增只读 `backup` 字段（份数/最近备份/最近恢复）。**KEEP_DEFAULT 12→14**（按每日一份留两周定档，`test/backup.test.js` 断言同步更新）。落点 `<base>/backups/`（data 的兄弟目录），data/ 只读不删；`data/` 仍是唯一运行态这一点没变，测试纪律不变（AGENTS 红线 3 已同步改写）。测试：`test/backup-api.test.js` 7 例（临时目录，恢复往返/三道闸/滚动/每日去重）。
> v2.9.40 变更（环境体检 LLM 路由误报修复 + 项数口径校正）：业主实测「环境未就绪：1 项待配置 / LLM 路由未配置（~/.dsh/settings.yaml）」而宿主明明在跑——根因是**体检规则停在 ≤0.2.0 口径**：0.2.1+ 把模型路由搬进 **profile** 的 `cordis.patch.yml`（`agent-default-model` 行，provider/model），`~/.dsh/settings.yaml` 根本不存在（本机实测：`profiles/desktop/cordis.patch.yml` 里 provider=deepseek-account / model=deepseek-flash，`~/.dsh` 下只有 `.credentials.yaml`）。修法：`probeLlmRoute` 双口径——① 旧版两文件齐 → 通过（历史部署不受影响）；② 扫 profile（优先 `DSH_PROFILE` 环境变量，否则遍历 `profiles/*`）读 `agent-default-model` 行 → 通过并回显 `profile/默认模型`；③ 都没有才失败，detail 如实说明「看过 settings.yaml、.credentials.yaml、profiles/*/cordis.patch.yml」。hint 文案同步改写（旧文案只指两个文件，已误导）。另修：设置页「环境体检」副本从「六项」改「五项」（gateway 退役后实际是 node/dws/dsh/llmRoute/gitea 五项，文案漂移）。用例更新：`test/setup-check.test.js` 增 0.2.1+ profile 分支断言（注入 readFileSync，零真实 IO）。
> v2.9.39 变更（IM 通知通道：飞书 / 钉钉自定义机器人，零新依赖）：业主「加 IM 通道」→ 新增 `lib/imNotify.js`（唯一出网点 `sendOne`），实现与取舍见 `docs/reviews/REVIEW-im-channel.md`。**配置**：`config.im = {enabled, digest:{enabled,at:'HH:MM'}, events:{review,completed}, targets:[{platform:'dingtalk'|'feishu', url, secret?}]}`——三处同步（`store.DEFAULT_CONFIG` + `mergeConfigDefaults`（digest/events 键级深合并、targets 整体替换）+ `settings` 白名单/视图/PATCH 校验）；`im.targets` 的 PATCH **按平台合并**（只填一个平台不冲掉另一个、同平台未给 secret 沿用旧值、显式 `[]` 清空）。**推送**：①事件——`taskEvents.appendEvents` 落盘后并联 fire-and-forget，只推 `events.review`（进待验收）与 `events.completed`（进 done）两类，未开启零出网；②每日摘要——`pollTick` 调 `maybeRunDigest`，到点且当日未成功才发，`data/im-digest.json` 记 `{date,attempts,lastSentDate}`，一天最多 3 次尝试（失败不刷屏）。**安全**：目标 URL 必过 `webhookOut.guardWebhookUrl`（http(s) + 回环/私网/链路本地拒绝）；**HTTP 200 但业务码非 0 判失败**（钉钉 errcode / 飞书 code）；错误出口 `scrubUrl`+`redact`；设置页只回显 `platform/urlHost/tokenTail/hasSecret`，令牌与加签密钥永不进视图。**接口**：新增 `POST /api/im/test`（无可用目标 → 400 `IM_NOT_CONFIGURED`；结果逐目标 `{platform,ok,status,error}`，**不含 URL**）；`GET /api/settings` 响应只增 `im` 节。**依赖**：零新增（Node 内置 `fetch` + `node:crypto`）。加签口径：钉钉 `timestamp(ms)\nsecret`（secret 作 HMAC key，base64 后 URL 编码进 query）；飞书 `timestamp(s)\nsecret`（整串既作 HMAC key 也作待签串，进 body）——**首次用真实机器人对账**，对不上只影响加签模式（机器人可改「关键词/IP 白名单」）。测试：`test/im-notify.test.js` 9 例（全注入 fetcher，零出网）。**同日回归修复**：`fireTaskEvents` / `maybeRunDigest` 把「im 节」当整个 config 传给 `normalizeTargets`（该函数读 `config.im.targets`），结果**事件与摘要永远返回「未配置可用目标」**——静默不推、不报错，典型的"看起来配了但没发"。由全量 425 用例回归捕获，两处调用改为传 `ctx.config`。**界面修正（同日）**：两个「即时事件」开关改用 `.chip`——`.switch` 是固定尺寸拨动钮（36×20），里面放文字会把按钮撑成竖排色块并压住下方按钮；chip 用 `.on` 表示开启，逻辑与 `.switch` 的 `.off` 相反，`drawIm` 与点击处理已按 `classList.contains('chip')` 分流。
> v2.9.38 变更（待办提醒，纯前端，零后端改动）：业主「没人提醒你看」→ 两处提示，口径复用既有端点（**不新增接口**）：**①顶栏「待办」铃铛**——计数 = 逾期（`/api/overview` 的 `tasks.overdue`）+ 待验收（`tasks.review`）+ 收件箱待确认（`/api/inbox/stats` 的 `pending`），30s 轮询（与既有顶栏胶囊同拍）；点击展开三行明细（0 项灰显但仍可点），行点击跳 `#/board` 或 `#/radar`，点外即收 / Esc 收起；**拉取失败保留上次数值不清零**（宁可红点旧，不用空值骗人）。**②宿主侧栏图标红点**（`plugin/client.js`）——同一口径，插件侧 60s 自轮询（面板关着也能亮，这是该功能存在的意义），面板内 SPA 每 30s 用 `postMessage({type:'fde:attention'})` 推更实时的一次（只认同源消息）。新增 `bell` 图标、`.attn-*` 与 `.fdec-dot` 样式。**已知限制**：iframe 内 `Notification.requestPermission()` 依赖宿主给 iframe 加 `allow="notifications"`（不在我们手里），故**不做系统桌面通知**；钉钉/邮件推送留待下一批（需要群机器人 webhook 与一日一次节流）。
> v2.9.37 变更（版本与兼容性矩阵产品化，BACKLOG「下一轮队列」首项）：总览页**最末**新增「版本与兼容性」卡，**默认折叠**（诊断信息不抢首屏；展开态存 localStorage `fde-matrix-open`，兼容徽标常驻标题行、收起也可见）——四行一手事实：①FDE 指挥台版本（`GET /fde-api/ping` 的 `version`）；②DSH 宿主版本（宿主页面 `window.__DSH_BOOT__.release.version`，经同源父窗口读取；独立打开 /fde/index.html 时如实显示「未知」，不猜）；③Node 运行时（ping 的 `runtime.node`）；④可选插件 dsh-better-sidebar 是否出现在宿主引导清单 entries 内（**只报已安装/未检测到**——其 semver 不随引导清单下发）。**兼容性徽标**由本地极简 semver 比较给出（支持 `>=`/`>`/`<=`/`<`/`=` 组合与预发布序；任何无法解析一律「未知」）：比较对象 = ping 新增的 `engines.dsh` 与宿主版本。**`GET /api/ping` 响应只增不改**——新增 `engines`（package.json 原样）与 `runtime`（node/platform/arch），`pong/version/uptimeSec/pid` 不变；`web/js/mock.js` 同步补 ping 桩，mock 模式卡片不再降级。样式新增 `.vmatrix` 与 `.pill.ok/.pill.err`。无新端点、无新依赖；数据源单一（package.json），README/DISTRIBUTION 的版本行自此可被产品自证。
> v2.9.36 变更（入口收敛为单一主列面板，纯前端）：业主「底部的工作台可以隐藏或者移除了吗」→ **删除 `sidebar.footer.action` 页脚按钮 + `shell.overlay` 三态覆盖层（dock/float/full）**，只保留 v2.9.34 的 `sidebar.panellist` + `main` 主列面板。理由：入口已迁到导航排，浮层是同一 SPA 的第二个实例（各自轮询、各自状态），维护与观感都是冗余。随删：`fdec-btn*`/`fdec-overlay`/`fdec-mode-*`/`fdec-bar*`/`fdec-close` 全部样式、overlay 开合与模式状态机、`applyDockLeft` 宿主 DOM 量测、`fdec-mode` localStorage 键、STRINGS 里 8 个 overlay 专用文案键；client.js 由 485 行降到 211 行。保留：单例 iframe 保活（v2.9.35）、locale 词典（zh/en 两键）、图标组件。历史实现见 git tag v2.9.35 的 `plugin/client.js`（如需恢复分栏并排能力，从该 tag 取回）。后端契约零改动。
> v2.9.35 变更（主列面板状态保持，纯前端）：v2.9.34 上线后业主实测「面板里进设置 → 切插件 → 切回，跳回总览并滚到顶」= 宿主在切换主列时**卸载**面板组件，React 重建 iframe 导致整页重载。修法：全扩展只保留**一个 iframe 节点**（`consoleFrame` 单例），面板组件卸载时把该节点摘进游离容器 `consoleHolder`（不进 document、浏览上下文不销毁），挂回来时 `appendChild` 搬回面板——同源搬移不重建 iframe；兜底 `sessionStorage['fdec-panel-hash']` 记最后 hash，万一仍触发重载至少回到上次那一页。副入口覆盖层仍用自己那份 iframe（两种形态各自的 SPA 实例语义不变）。后端契约零改动。
> v2.9.34 变更（入口位置：页脚按钮 → 主导航排，纯前端）：业主问「为什么这个插件不在自动化任务下面」——原入口注册在 `sidebar.footer.action`（宿主定义=「侧栏页脚、设置按钮旁的附加动作」），故落在工作区列表下方；那排「插件 / 自动化任务」属 `sidebar.panellist`，宿主契约要求**每个 list id 对应一个同 key 的 `main` 面板**（点图标 = 把中间主列切过去）。**本批**：新增 `sidebar.panellist`（id=`fde-console`，order=20，紧随 schedules=10）+ `main`（key=`fde-console`）两处注册，指挥台成为**主列面板**（`.fdec-panel` 整列 iframe，无覆盖层条）；label 传 thunk 由宿主每次投影重读 → 跟随 Client locale；注册顺序先 main 后 panellist（图标出现时面板已在册）。原页脚按钮 + 三态覆盖层保留为**副入口**（dock 分栏可与会话并排看，主列面板做不到）。后端契约零改动。
> v2.9.33 变更（官方插件规范对齐第二批：展示元数据 + 客户端资源纪律）：业主「是否符合开发规范」全量复核后的整改，业务逻辑零改动（lib/ 未动一行）。**①展示元数据补齐**——新增 `locale/en.json` / `locale/zh.json`（`meta.title`/`meta.description`）并在 package.json 导出 `./locale/*.json`：此前插件行标题回落到技术名 `fde-console`（宿主 `readPluginMeta` 口径：title←manifest.name、description←package.json.description，locale 词典只增不改）。**②客户端资源纪律**——`<style>` 从 bundle 工厂体（模块顶层副作用）挪进 `apply` 的 `ctx.effect` 并登记清理（HMR 后不再残留旧 CSS）；可见文案（入口按钮/面板标题/三态按钮/关闭）全部改经宿主 Client `locale` 服务（ns=`fde-console`，zh/en 双语；`ctx.get('locale')` 可选访问，缺位回落英文，不阻塞激活）。**③清单与打包**——删除 `dsh.client.exports`（宿主只认顶层 `exports["./client"]`，该字段从不被读）；补 `files` 白名单（含运行时真实依赖的 `test/helpers/appAssembler.js` 与 `scripts/migrate-data.js`；装配器搬迁解耦因本机无法跑测试而暂缓，登记 SPEC-PLUGIN 7.4）；`engines.dsh` 上界改 `<0.3.0-0`（原 `<0.3` 在宿主 `includePrerelease` 语义下会放行 0.3.0-rc.x，与「跨 0.3 必停」声明不符）。**④宿主侧生命周期**——`plugin/index.mjs` 的手工 disposers 数组 + `ctx.on('dispose')` 改为逐个 `ctx.effect`，apply 中途失败可当场回滚已注册路由/定时器。测试未跑（本机 pwsh 不可用），仅静态核对。
> v2.9.32 变更（拓扑会话阅读器打开修复，纯前端单点）：业主报「任务拓扑的会话阅读器打不开」——真机逐节点排查（10/10，仅同一节点复现失败）定位根因=**会话点击被纳入选中切换语义**：onNodeClick 的 wasOn 判断把「同一节点第二次点击」当作取消选中吞掉（原代码仅在 `!wasOn` 时触发 onDataSessionClick），用户视角=点开阅读器关掉后再点同一会话节点毫无反应。修复=会话节点改为**每次点击都打开**（高亮保持不切换），取消选中语义仅保留给任务/成果节点；回归实测同一节点连续两次点击均打开（真机、还原业主页面）。契约零改动，410/410 绿。
> v2.9.31 变更（智能体动态可读性重构，纯前端，业主「不太易看」→ 头脑风暴对齐后 A+B+C+D 一次迭代）：**A 三段式叙事**——顶部「正在运行」区（state=active，alive 口径与成员页/desktopAgents 同源；呼吸灯 pulse-dot）+ 条目按 今天/昨天/更早 分桶（更早默认折叠，天头带计数）。**B 保守合并**——同 agent+同项目+标题前 20 字符（规范化空白）一致 → 一行「×N」徽标（巡检类定时会话刷屏治理，拓扑 commit×N 先例），「展开其余 N-1 条」逐条子项（缩进线），子项仍各自可点钻取。**C 条目信息升级**——来源状态中文化配色（active→运行中绿/failed→失败红/completed→已完成灰/idle·cancelled→灰，原值进 title）；标题两行钳制（原单行半截截断）；项目路径改短名 chip（完整路径进悬浮）；预览文本并入悬浮（zcode 库读源预览恒空，标题即主信息）。**D 项目 tab 收敛**——只出最近 6 个项目 tab，其余进「更多 (N)」下拉（change 委托切换）；未知项目组 tab 灰显降权（.seg-unknown）。交互守卫：.act-fold-toggle 点击绝不触发钻取（委托先判折叠）；data-orig-label 记忆展开前文案。30s 轮询重绘不丢监听（委托挂 #act-list/#act-tabs 不变）。真机验证：三段结构对账（运行 1+今天 2+昨天 9+更早 26=40 ✓ 含合并消减）、天折叠/合并展开/下拉切换全通、原页面还原。契约零改动（GET /api/agent-activity 响应未动），测试 410/410 绿（纯前端不触用例）。
> v2.9.30 变更（官方插件规范对齐）：业主指令「先读 DeepSeek 插件开发规范再整体优化」——规范本体=宿主 npm 包随附文档（dsh README.zh + 依赖包 README 系列与 lib/types/*.d.ts），全文审计落 docs/SPEC-PLUGIN.md 第七章（manifest 契约逐项对照表 + declined 清单）。**本批落地**：package.json 补齐 `engines.node >=22.13`（node:sqlite 门槛进清单）与 `engines.dsh >=0.2.1-rc.2 <0.3`（此前缺失=升级零保护；声明后 DSH ≥0.3 宿主将显式拒绝加载并列 skippedBundles——强迫兼容性重验而非静默带病运行，红线 9 的清单化落地）+ `dsh.manifestVersion:1` + `icon`（assets/icon.svg <1KB，插件页展示；规范约束 ≤256KiB/realpath 包含）。**declined 有据**：config schema（schemastery 经 pnpm 隔离不可达，依赖化违反红线 1，校验自担）、dsh-atomic-write（同因不可达；tmp+rename+单实例纪律+备份三层兜底）、dsh-jobs（会话归属语义不适用）、storage-json（存储形态不匹配）。审计另证实：client.inject 是信息性声明非服务注入（与宿主侧 apply inject 是两个概念）；patch 形状与 dsh-base 同构。测试 410/410 绿（manifest 变更不触代码路径；重启实例验证 engines 通过加载）。
> v2.9.29 变更（技术债偿还批：P0×2 + D3 快照收敛 + D4 可见性）：自查 14 场景交付后的债务登记（业主问「有没有技术债」→ 全量盘点 P0/P1/P2 三档）。**D1 webhook 配置 TTL 缓存**——原实现每次任务事件落盘都同步 readFileSync+merge 全量 config（哪怕 disabled），任务写路径是全系统最热路径；改懒加载器（webhookOut 内 60s TTL 缓存，配置失败视为关闭绝不影响落盘）+ 调用点传 loader；测试 +1（TTL 内只读一次/空事件不碰 loader/抛错不外抛/过期重读）。**D3 共享会话快照**——`lib/sessionSnapshot.js` getSnapshot（60s TTL 进程内快照；adapters 纯注入语义不变：注入即不回落真实路径不走缓存、注入源抛错=零贡献），heatmap/agentContext/scorecard 三消费方收敛（scorecard 原「buildHeatmap 后再 list 一遍」双倍扫描顺带消灭，重写为纯快照单遍计算=每 agent 会话/分钟/项目/最近活跃）；workSearch 暂留自有索引（同 TTL，P1 再并）。**D2 口径诚实化**——热力图统计行/scorecard SVG 页脚/agentContext markdown 头三处补「每源计最近 50 条会话」口径标注（原「近 28 天 N 会话」是虚假精确——重度用户系统性少算且无提示；范围查询是真修法，进 backlog）。**D4 集成出口可见性**——settings redactedView 增 webhookOut（enabled+urlHost，query 令牌不进视图）/agentContext（enabled+白名单目录数）只读字段 + 设置页「集成出口（只读状态）」卡（手改指引内联）。测试 410/410 绿（+1 webhook 缓存语义）。遗留：P1（workSearch 并快照/MCP 真机客户端验证/postmortem 首击成本随 D3 缓解）与 P2（挂起会话跨日口径/协议文档漂移风险/board.js 单体）已在债务登记，不装看不见。
> v2.9.28 变更（尾批：任务复盘 + 转写入口泛化）：**⑫任务复盘闭环**——`lib/postmortem.js` buildPostmortem（done 时刻确定性蒸馏，零 LLM）：证据=挂接会话（ref 回读派工词，getDispatchPrompt 120s 缓存兜底；同 ref 去重）+commit/pr 成果+本任务日报（摘录 ≤80 字）；数字=会话/提交/PR/日报计数 + 跨度（证据时间 min..max、完成时刻并入、零证据 span 全 null 诚实空态不虚增）；每类截 8 条；`GET /api/tasks/:id/postmortem`（404 TASK_NOT_FOUND）。前端：done 任务详情「复盘」行——折叠组一页纸（统计行+当时怎么派工的/做了什么提交/哪天留了痕 三节，空态提示随挂接充实）；detail 回来后按 done 态触发拉取。**⑬转写入口泛化**（去钉钉专有，开源用户的转写入口）——`POST /api/radar/text {title,text}`（title 1..200、text 10..200000 字）：只持久化合成消息入既有纪要池（source:'text' 徽标、全文单段 speakerSegments raw='文本投喂'、analyzedAt=null 可分析态）——**分析复用既有 POST /api/radar/analyze 零管线改动**；前端雷达工具行「粘贴转写」弹层（字数计数，提交后自动 runAnalyzeJob([messageId]) 走既有 202+轮询，候选出收件箱）。测试 +6（postmortem 3/radar-text 3，radar-text 走 DSH_FIXTURE 离线引擎全链验证入池→分析→候选），全量 406 绿。
> v2.9.27 变更（开源第二批：上下文注入/ADAPTERS 协议/Scorecard/Webhook 出口/MCP Server）：**⑪Agent 上下文注入**（数字员工互知）——`lib/agentContext.js` buildAgentContext（六源会话按 projectId 归一聚合，**只认 config.agentContext.dirs 白名单目录，白名单外零依据零泄漏**）+ renderMarkdown（HTML 元字符转义+.redact）+ writeAgentContext（enabled!==true 零写盘；原子写 `<dir>/.fde/daily.md`；无活动目录跳过不写空文件）；scripts/write-agent-context.js 薄壳 CLI（--days N，读 ~/.dsh/fde-console/config.json）；opt-in=纯手动跑脚本（自动档待拍板）。**⑧适配器协议文档化**：docs/ADAPTERS.md（列表/阅读器契约字段表、locator 双闸、硬性纪律、PR 验收清单——社区第七源开发指南）。**⑨Scorecard 传播卡**：`lib/scorecard.js` buildScorecard（单 agent 精确口径=热力图 agent 桶重算，projects 取自 listAgentSessions）+ renderSvg（深色主题数字卡：sessions/active time/projects/last active）+ `GET /api/scorecard/<agent>[.svg]`（router :param 捕获整段，.svg 后缀 handler 内剥；无数据 404 SCORECARD_NOT_FOUND 宁缺勿滥；image/svg+xml 原生 res 写）。**⑥Webhook 事件出口**：`lib/webhookOut.js` fireTaskEvents（taskEvents.appendEvents 落盘后 fire-and-forget，绝不阻塞写路径；disabled/url 空/守卫拒/无事件零出网；8s AbortController 超时不重试；>20 条截断）+ guardWebhookUrl（http(s)+私网/回环/链路本地字面量拒绝——webhook 是用户主动出站，不经数据源白名单而自带私网闸）+ scrubUrl（query 值全 [REDACTED]，下游 token 纪律）；config 新节 webhookOut {enabled:false,url:''}（DEFAULT_CONFIG+mergeConfigDefaults 两处同步；暂不进设置页仅手改）。**⑩MCP Server**（agent 生态出口，本批最重）：`lib/mcpCore.js` handle 纯函数 JSON-RPC 2.0 分发（initialize/tools/list/tools/call/ping；通知不回包；未知方法 -32601）+ 三只读工具 fde_list_tasks（status 过滤）/fde_search_work（四组聚合）/fde_agent_status（健康+28 天聚合）+ scripts/mcp-server.mjs stdio 壳（newline-delimited；日志全走 stderr 防 stdout 协议污染；DSH_HOME 注入配置）；用法=agent 的 mcpServers 配置指向脚本；**Mimosa 拦 spawn 测试（命令注入模式）→ 架构响应=协议核心下沉 lib 直测（零 spawn 零注入面），壳只剩接线**。测试 +20 例（agent-context 5/ADAPTERS 无/scorecard 4/webhook-out 5/mcp-core 6），全量 403 绿；MCP agent_status 用例曾撞真实源（809ms）已修六源全临时空目录。全程零新依赖零出网（webhook 出站为 opt-in 用户自配）。
> v2.9.26 变更（开源 T1 批：热力图/报告导出/归因协议/新手引导）：开源路线图第一批落地（业主拍板「全部开干」）。**①Agent 活跃热力图**：`lib/heatmap.js` 新增 `buildHeatmap`（六源 listAgentSessions 每源最近 50 条，会话计入 lastActiveAt 本地日、时长=clamp(起止差,1min,6h) 防挂起会话撑爆）+ `GET /api/agent-heatmap?days=`（钳 1..90 默认 28）；总览新增「Agent 活跃热力图」卡（行=agent 列=28 天，4 档深浅 color-mix 色弱可辨，悬浮=日期·会话数·分钟，今天边框高亮，无活动源降级一行提示）；`adapters` 注入模式=纯注入语义（提供即不回落真实路径——测试曾撞真实源 2.8s+数据污染，语义修正）。测试 heatmap.test.js 5 例（聚合/钳制/连续性/隔离/时区）。**②报告 Markdown 导出**：报告面板「导出 .md」按钮（Blob 下载 fde-daily-<dayKey>/fde-weekly-<weekKey>.md，与复制按钮并列，零后端改动）。**③归因协议文档化**：新增 docs/ATTRIBUTION.md（三条约定=task/<id> 分支、[#taskId] 提交标记、任务绑定项目目录；仓库护栏规则总表；agent AGENTS.md 片段模板；实现索引）——把已实现功能升维成可引用的开源生态协议。**⑭commit-msg hook**：scripts/hooks/commit-msg（task/<id> 分支自动补 [#id] 标记，已有不重复、非约定分支不动；沙盒仓三态实测通过）。**④Onboarding 向导**：views/onboarding.js 三步弹层（欢迎定位→本机 agent 源检测逐项点亮（GET /api/agent-activity sources[]+overview.gitea 连接态，全只读零写盘，唯一持久化=localStorage fde-onboard-done）→三入口下一步），首访自动弹（setTimeout 600ms 等骨架）、设置页「新手引导」按钮重开（onboardingRedo 自定义事件防循环 import）。全批 383 测试绿（+5 热力图），零新依赖零出网。
> v2.9.25 变更（归因仓库护栏 + 挂接仓库下拉）：**跨仓同名 branch 误归因（业主实测报错：demo-plan/tds/demo-hub 的 main 提交全被灌进 fde-console 任务，40 条脏成果，已两轮清理 156 条）**。根因=读侧 matchedTaskIds 与写侧自动归因都只比对 branch 名相等、不比对仓库——branch 名只在仓库内有意义。修复：`lib/attribute.js` 新增 `repoMismatch`（双方 repo 已知且不同 → 一切匹配规则不出；任一方未知维持旧口径）作单一事实源，写侧 matchReason 最前统一拦截（规则 a/b/c 全覆盖），读侧 routes-gitea matchTaskIds 同款护栏（require 复用）。数据修复：精确条件（repo≠task.repo 且 attributedBy=auto，手动挂接绝不动）清除脏成果 39 条，修复前已跑 scripts/backup-data.js。配套：为「生产看板项目」任务补绑 repo=example-org/demo-plan + branch=main，demo-plan 提交从此归对（真机验证：500 条动态 fde-console→仅FDE任务、demo-plan→仅生产看板、tds/demo-hub 正确无匹配）。**双实例教训再次兑现：桌面版 DeepSeek Harness 与 CLI 实例同跑共享 data 目录，桌面版内存中旧代码（无护栏）每 60s 继续写脏归因（16:04 一次 65 条实锤）——修复必须以「全部实例都跑新代码」为完成态，杀干净一个实例不等于修复完成**。另：挂接成果弹层「仓库」字段由手输改 datalist 下拉（GET /api/repos 组织仓库建议 + 保留手输兜底——GitHub/Gitee 链接仓库名不在组织清单；任务已绑 repo 自动预填；拉取失败降级纯手输不阻塞表单）。测试 attribute.test.js +2 例（matchReason 跨仓矩阵 / matchTaskIds 读侧同款），378 全绿。
> v2.9.24 变更（会话归因建议·验收证据送货上门）：闭环四环归因环补最后一块——commit 已自动归因（branch 约定），会话仍要人工狩猎挂接。任务详情成果区新增「建议挂接（N）」折叠组：绑定项目下与任务同期活跃的最近会话，一键确认挂接（走既有 POST artifacts session 通道，零新写路径）。后端 `GET /api/tasks/:id/session-suggestions`（`lib/sessionSuggest.js`）——识别链三层：①主键（确定性）`task.projectDir` × 会话 projectId 经 normalizeProjectKey 相等入候选池（多任务可绑同目录，主键只圈候选不唯一；未绑定项目 → 空建议零扫描）；②排序信号（只加减分不做门禁——真机实证派工词与任务标题词项重合可为零但分明同一活）：时间窗 +2 / 已完成任务完成时刻后活跃 -3 / 远早于创建 7 天前 -2 / commit 桥（±24h 内有本任务已归因 commit/pr）+2 / 派工词存在 +1 / 派工词含任务标题再 +2 / 7 天内活跃 +1；③闸门：score<2 不出（宁缺勿滥，attribute.js 同款）、已挂 sessionRef 幂等出局、每源最近 5 条进候选、总截 5 条按分排序，逐条带 reasons 供悬浮解释。数据面复用 workSearch 六源标题索引（60s TTL 共享缓存）与 getDispatchPrompt（120s 缓存），全只读零写盘零出网。前端：建议行=来源徽标+派工词首行+相对时间+[挂接]按钮（虚线卡与成果卡区分；挂接中防双击；成功后 toast+重拉成果+该 ref 从建议出局）。测试 session-suggest.test.js 6 例（新文件不用 node:sqlite，claude 文件源夹具；覆盖纯打分函数逐信号/候选池过滤/幂等/已完成降级/端点 404·200·POST-201 幂等闭环）。响应只增不改（新端点）。
> v2.9.23 变更（工作搜索·考古层）：Ctrl+K 呼出的跨任务/会话/提交/日报统一检索——把观测层的「看见」升级为「找到」（个人工作台找回入口）。后端 `GET /api/work-search?q=`（`lib/workSearch.js`）：四组读时聚合零新存储——①tasks.json（标题+描述+成果提交说明）②六源会话标题（listAgentSessions 聚合，进程内 60s TTL 索引，每源最近 50 条；不做全文转录提取——每会话 ≤4MB 读入对搜索不经济）③activities.json（commit/pr 的 title+messageBody+repo）④diary.json 全文；匹配=查询按空白拆词（≤6 词）全词项 AND、字段间 OR，大小写不敏感；摘要=首命中字段词项首现 ±40/90 字符窗口；全部出口过 redact；每组截 8 条、组内时间倒序、响应 `{q,tookMs,total,groups:{tasks,sessions,commits,diaries}}`；单文件/单源故障该组空返不拖垮其余组；空 q → 400 FIELD_INVALID。前端：顶栏「搜索 Ctrl K」按钮 + Ctrl/Cmd+K 全局快捷键（防浏览器默认冲突 preventDefault）；结果弹层（views/search.js 单例）输入 250ms 防抖查询，↑/↓+Enter 键盘可达（aria-activedescendant 模式）；点击行为——任务/日报 → `#/board?task=<id>` 深链、会话 → openSessionReader 直达阅读器、提交/PR → safeHttpUrl 放行才开新窗。离线测试 work-search.test.js 10 例（新文件不用 node:sqlite，会话索引走 claude 文件源夹具；TTL 语义用缓存引用同一性断言）。真机截图回归修复三处：①app.js navigate 早退缺口——同视图但完整 hash（含 query）变化也重渲染（v2.1 深链契约「看板内搜索点任务」盲区，currentHash 追踪修复）；②结果行时间列 white-space:nowrap（窄弹层下「7 分钟前」逐字竖排）；③会话行空标题 fallback（trim 后空 → 「（未命名会话）」）。响应只增不改（新端点）。
> v2.9.22 变更（任务详情·派工词）：任务详情新增「派工词」——按绑定项目聚合最近会话的首条「真人指令」（这单当时是怎么派工的）。后端 `GET /api/agent-dispatch?project=<绑定项目>`：首批三源 zcode/claude/codex 各取最近 2 条有真人指令的会话（`lib/agentTranscript.js` 新增 `getDispatchPrompt`/`listDispatchPrompts`，复用六源全文适配器——redact 脱敏、4MB 读入闸、单源故障隔离照搬；ref→文本 TTL 120s 内存缓存 ≤200 条；project 缺省/空=未绑定项目零扫描直接空列表）。响应 `{project, items:[{agent,ref,startedAt,lastActiveAt,text}]}`（startedAt 倒序，text ≤800 字尾部 …[截断]），响应只增不改。派工词提取 = 归一化消息第一条非注入 user 文本，清洗两层：全源剔除 `<system-reminder>`/`<environment_context>`/`<untrusted_gen_ui_state>` 标签块；codex 专属跳过 `# AGENTS.md instructions` 指令块与 `<user_instructions>`、`# Files mentioned by the user:` 包裹取最后一个 `## ` 条目之后的真指令（真机实证：codex 首条 user 常是 23KB 指令注入而非派工；会话首条消息含纯注入时顺延下一条）。前端任务详情新增「派工词」行（绑定项目才渲染）：来源徽标+相对时间，长文本 2 行钳制+`.fold-toggle` 折叠展开全文，加载/失败/空态降级不阻塞详情主体；详情接口晚回带出 projectDir 时自动补拉。离线测试：dispatch-prompt.test.js 9 例（新文件不用 node:sqlite，AGENTS.md 坑 5——zcode 用例落在 agent-sessions.test.js 复用三表夹具，两文件合计新增 10 例）。
> v2.9.21 合并修正（撞车合并顺手修）：①`zcodeDbItems` 的 `last_outcome` 为空（运行中/未知）时不再强制 `state:"idle"`——原实现会把正在工作的 ZCode 打回「空闲」（成员进度 alive 判定失真）；②`zcodeAdapter` 增 `opts.listSessions` 测试注入缝（测试不建 sqlite 夹具，AGENTS.md 坑 5）。

> v2.9.16 变更（任务成果可读性）：成果条目增提交说明——①自动归因写路径随归因落库 `title`/`messageBody`（activity 提交主题/正文首段，≤300 字截帽，null 容错）；②GET /api/tasks 与 GET /api/tasks/:id 读取时按 url 从 activities.json 回填存量/手动成果缺失的说明（纯响应不落盘，零迁移；会话成果不参与、已有值不覆盖）；③前端任务详情成果区：带说明的 commit/PR 改卡片式（说明主行 + 仓库/链接/ref 元行 + 正文首段两行截断弱化行），无说明保持原单行布局；成果多于 5 条只展开最近 5 条，其余折叠进「展开其余 N 条/收起」（解除挂接 data-idx 恒为数组原下标）；同一折叠机制泛化为详情弹层长列表通用件 foldListHtml——动态时间轴（倒序 100 条）与日报列表（按日倒序）同样只展开最近 5 条。响应只增不改（artifacts 可选键 title/messageBody）。
> v2.9.17 变更（总览·任务拓扑瘦身，纯前端，业主实测两轮否决后定稿）：①**删除 SVG 工作流图模式，拓扑收敛为树视图单形态**（三列图在长任务场景要么节点刷屏要么大片空白，评审实拍否决）——视图切换 seg、GEO 几何、edge/节点 SVG 渲染与配套 CSS 全部移除，会话源下拉/只看活跃/任务折叠/选中高亮/未关联会话区等交互不变。②commit 类成果按「任务 × 仓库」分组合并——同仓几十条提交收敛为一行「commit ×N 仓库 · 最新说明」（悬浮列组内最新 8 条提交说明（v2.9.15 回填的 title）+ 溢出提示，完整列表仍指任务详情成果区）；PR/会话成果语义各异保持单节点。③面板体限高 480px + 纵向滚动（overscroll-behavior contain）。成果组 data-id=任务id:g:组序（仅选中高亮语义）；响应契约零改动。
> v2.9.18 变更（设置页 GitHub 源页面化）：GitHub 动态源从「仅 config.json 手改」升级为设置页可配置——新卡「GitHub 动态源」（启用开关即时 PATCH 同雷达开关口径；组织名/API 地址随「保存设置」提交），保存后**热生效**（PATCH 原地覆写运行期 config，pollOnce 每 tick 读 github.enabled，随下个轮询周期生效，无需重启；仅手改 config.json 仍需重启）。PATCH 契约：github 节入 TOP_LEVEL_ALLOWED，仅 enabled/org/baseUrl 三键可改（携带 eventsPages/hostWhitelist 即 400，保持仅手改口径）；org ≤100 字符（空串=清除）；baseUrl 校验协议 + host 须在 github.hostWhitelist（自建 GHE 先手改白名单再改地址）；磁盘写回缺省回填（同 dingtalk/analyze 口径，局部 PATCH 不丢 hostWhitelist/eventsPages）。凭据红线不变：PAT 走 git config http.<baseUrl>/.extraheader 零落盘，页面仅生成命令模板不接触令牌。GET /api/settings 视图增 github.hostWhitelist 展示；响应只增不改。
> v2.9.19 变更（Gitee 组织动态源）：新增 `lib/giteeClient.js`——`GET {gitee.baseUrl}/api/v5/orgs/{org}/events` 适配为统一活动模型（PushEvent 逐 commit → `commit`；PullRequestEvent 按 GitHub 同构容错；其余类型计 `skippedEventTypes`），与 Gitea/GitHub 源共写同一 `activities.json`（type|url 去重一致），状态独立落 `data/gitee-status.json`；启用经设置页「Gitee 动态源」卡或 config.json `gitee:{enabled,org}`（默认关闭零出网；SSRF 白名单扩三节 gitea ∪ github ∪ gitee，默认 gitee.com）。真机探针实证的字段差异已在适配器消化：repo 用 full_name、commits 无 timestamp（occurredAt 退事件 created_at）、commits[].url 为 API 地址（动态链接自拼 web 地址）。凭据红线：私人令牌走 `git config http.<baseUrl>/.extraheader`（值=令牌原文）零落盘；Gitee v5 令牌走 URL query——错误出口经 scrubUrl（access_token 参数剥为 [REDACTED]）+redact 双防线。设置页同 GitHub 卡口径（enabled/org/baseUrl 三键可 PATCH 热生效；eventsPages/hostWhitelist 仅手改）。注意：凭据缓存为进程生命周期，换令牌需重启；公开组织匿名可拉。评审报告见 docs/reviews/gitee-source-review-v2.9.18.md。
> v2.9.20 变更（设置页源探测）：「测试连接」从 Gitea 卡推广到 GitHub/Gitee 源——新端点 `POST /api/sources/test`（`{"source":"github"|"gitee", "org"?, "baseUrl"?}`，org/baseUrl 可用表单当前值覆盖，**保存前先测**）；探测只拉 events 第 1 页 per_page=1（最小流量），与 enabled 开关无关、不改任何状态文件，返回 `{ok, latencyMs, hasToken, latest:{type,repo,occurredAt}, error?, code?}`；白名单/守卫类错误 → 400，其余失败 → 200 `{ok:false,error}`（测试语义不 5xx）。两 client 新增 `testConnection(cfg, override)`（永不 throw）。前端两卡各加「测试连接」按钮（结果行内展示：延迟/令牌·匿名模式/最新事件摘要）。离线单测覆盖 fail-fast（org 缺失）与守卫路径（白名单外 host，fetch 前抛零出网）。另修 weekly.test.js 两处潜伏的日期锚缺陷（周一 00:00–01:00 运行必挂：TD_ONE 锚落滚动窗外 + 上周报断言边界反转拿窗起点当截至线——历史靠非周一运行与空集空洞通过）。

## 1. 背景与目标

本地 Web 指挥台（Windows Server 2022，单机单用户），提供三块能力：任务看板（自建自管）、团队 Gitea 动态流（只读拉取 example-org 组织）、本地 CLI 智能体一键携简报启动与会话管理。技术基线为 Node 原生 http + 无构建 vanilla SPA + JSON 文件存储，全程不出 127.0.0.1，Gitea 凭据运行时读入内存、绝不落盘绝不进日志。成功标准：业主在浏览器完成「建任务 → 携简报启动智能体 → 看动态 → 改状态」全流程，后端/前端两岗可依本文档并行开发。

## 2. 容器图与选型

```
浏览器（本机）http://127.0.0.1:7788
  │
  ▼
┌──────────────────────────────────────────────────────────────┐
│ server.js — Node ≥18 原生 http，仅绑 127.0.0.1               │
│  ├─ router.js        方法+路径分发，统一 JSON 错误出口        │
│  ├─ store.js         data/*.json 原子写（tmp + renameSync）  │
│  ├─ giteaClient.js ──▶ ssrfGuard：协议+host 白名单校验       │
│  │        └──────────▶ https://gitea.example.com/api/v1     │
│  ├─ launcher.js      spawn(shell,detached) / taskkill /T /F  │
│  └─ sessions.js      process.kill(pid,0) 存活实测            │
└──────────────────────────────────────────────────────────────┘
  │ 读写运行态                          │ 每次出站前读取（仅内存）
  ▼                                     ▼
data/                          git config --global
  tasks.json sessions.json     http.https://gitea.example.com/.extraheader
  activities.json              → Gitea 预授权头（不落盘、不进日志）
  ▲
web/ index.html + css/app.css + js/*.js（零构建 vanilla SPA，hash 路由，静态托管）
```

| 选型 | 理由 |
|---|---|
| Node ≥18 原生 http，不用 Express | 零依赖；路由约 60 行自写；Node18 内置 fetch，Gitea 客户端免 axios（本机实测 v24.15.0） |
| vanilla ES Modules SPA，无框架无构建 | 硬约束「零构建优先」；实现岗长任务易断，构建链是最大中断源；5 视图规模不需要框架 |
| JSON 文件 + tmp/rename 原子写 | 单机单用户无并发写竞争；免 SQLite；进程崩溃不损坏文件。**2026-11-01 红线 3 修订（业主拍板「直接考虑 sqlite3」）**：node:sqlite 引擎内置后依赖成本归零，允许自有数据迁 node:sqlite（**仅引擎内置，禁第三方 sqlite 包**）；JSON 保留为导出/互操作格式。执行分阶段（store 后端抽象 API 零变 → 先迁 messages/task_events 追加型大文件 → tasks/inbox/diary 第二批），带导入器+回退锚点 tag；开工前与并行会话对表（store.js 全场公共依赖） |
| node:test 内置测试框架 | 验收命令零外部依赖 |
| spawn(shell:true, detached) + taskkill /T /F | 本机 CLI 均为 .cmd shim 必须经 shell；分离进程不受父进程退出影响 |

## 3. REST API 契约

Base `http://127.0.0.1:7788`；除静态文件外均为 `/api/*` JSON；请求体一律按 JSON 解析；带请求体的写方法（POST/PATCH/DELETE）必须携带 `Content-Type: application/json`，否则 400 `CONTENT_TYPE_REQUIRED`；请求携带 `Sec-Fetch-Site` 头且值非 `same-origin/none` 时 403 `CSRF_REJECTED`（两道 CSRF 防线，curl 等非浏览器客户端不受影响）。无鉴权（回环绑定 + Host 头校验即边界，见 §5-④）。统一错误体：`{"error":{"code":"<大写蛇形>","message":"<中文>"}}`；400 参数非法 / 404 不存在 / 409 冲突 / 502 Gitea 失败。

**通用 / 总览**

- **`GET /api/health`** 请求：无 ｜ 响应 200：`{"ok":true,"version":"1.0.0","uptimeSec":12}`
- **`GET /api/overview`** 请求：无 ｜ 响应 200：`{"tasks":{"todo":3,"doing":2,"review":1,"done":5,"overdue":1},"agents":9,"sessionsRunning":2,"gatewayExternalRunning":1,"activities24h":17,"gitea":{"ok":true,"lastPollAt":"2026-10-16T08:00:00Z","lastError":null}}`（v1.8.1 新增 `gatewayExternalRunning`：经 cli-gateway 的外部运行中调用数——`source='external'` 且 `state='running'` 的条数，即业主在自家终端跑 codex 等调用；workbench 运行中调用与 `sessionsRunning` 统计的 alive 会话是同一事物，不重复计入；`sessionsRunning` 语义不变，仍为指挥台 alive 会话数）

**列（看板列可增删改名）**

- **`GET /api/columns`** 请求：无 ｜ 响应 200：`[{"id":"todo","name":"待分配","order":1},{"id":"doing","name":"进行中","order":2},{"id":"review","name":"待验证","order":3},{"id":"done","name":"已完成","order":4}]`
- **`POST /api/columns`** 请求：`{"name":"阻塞"}` ｜ 响应 201：`{"id":"col-3f","name":"阻塞","order":5}`
- **`PATCH /api/columns/:id`** 请求：`{"name":"待办"}` ｜ 响应 200：`{"id":"todo","name":"待办","order":1}`；404 `COLUMN_NOT_FOUND`
- **`DELETE /api/columns/:id`** 请求：无 ｜ 响应 204（空体）；列内有任务 409：`{"error":{"code":"COLUMN_NOT_EMPTY","message":"先移走该列的 3 个任务"}}`

**任务**

- **`GET /api/tasks?status=doing&q=sso&priority=high`**（status/q/priority/memberId 均可省略；q 模糊匹配 title/branch/notes）｜ 响应 200：`[{"id":"t-01","title":"接入SSO","status":"doing","agentId":"claude","repo":"example-org/fde-api","branch":"feat/sso","prUrl":null,"notes":"优先级高","dueDate":"2026-10-20","priority":"high","createdAt":"2026-10-16T02:00:00Z","updatedAt":"2026-10-16T03:00:00Z"}]`
- **`POST /api/tasks`** 请求：`{"title":"接入SSO","agentId":"claude","repo":"example-org/fde-api","branch":"feat/sso","prUrl":null,"notes":"优先级高"}`（title 必填 1..200 字，status 缺省 `"todo"`）｜ 响应 201：完整对象含服务端生成的 `id` 与两个时间戳
- **`GET /api/tasks/:id`** 请求：无 ｜ 响应 200：同上单对象；404：`{"error":{"code":"TASK_NOT_FOUND","message":"任务不存在"}}`
- **`PATCH /api/tasks/:id`** 请求：`{"status":"done","notes":"已验收"}`（任意可写字段子集）｜ 响应 200：更新后完整对象；status 非法 400 `COLUMN_NOT_FOUND`
- **`DELETE /api/tasks/:id`** 请求：无 ｜ 响应 204（空体）

**智能体（注册表）**

- **`GET /api/agents`** 请求：无 ｜ 响应 200：`[{"id":"claude","name":"Claude Code","command":"claude","commandTemplate":"claude \"{briefing}\"","builtin":true,"enabled":true}]`

**成员进度（v1.1）**

- **`GET /api/members`** 请求：无（读时聚合，不落盘）｜ 响应 200：`[{"id":"claude","name":"Claude Code","kind":"agent","role":"架构/攻坚","status":"working","currentTask":{"id":"t-01","title":"接入SSO","status":"doing","ageSec":23400,"sinceUpdateSec":1800,"progress":0.6},"lastActivityAt":"2026-10-16T07:30:00Z","todayCommits":4,"openPrs":1,"weekDone":2,"session":{"id":"s-9f2","alive":true}}, {"id":"qianqi","name":"张伟","kind":"human","role":"后端","status":"idle","currentTask":null,"lastActivityAt":"...","todayCommits":0,"openPrs":0,"weekDone":0,"session":null}]`
  - **花名册**：`agents.json` 全部项 ∪ Gitea 组织成员（`/orgs/{org}/members`，Gitea 轮询时顺带缓存）；`kind` 区分 agent/human；`role` 取 agents.json 备注或 Gitea full_name，缺省 `""`。
  - **status 推导**：`working` = 有进行中任务或有活会话；`stale` = 有进行中任务且 `sinceUpdateSec > staleWarnSec`（超过 `staleDangerSec` 前端升级为危险色）；其余 `idle`。
  - **progress 推导（演示值，非真实完成率）**：todo 0 / doing 无 PR 0.3 / doing 且有匹配 PR 0.6 / review 0.85 / done 1。
  - **时效字段**：`ageSec` = now − 任务进入当前状态的时间（用 updatedAt 近似）；`sinceUpdateSec` = now − 该成员最近一条 Gitea 动态时间（无动态则取任务 updatedAt）。
  - **todayCommits / openPrs / weekDone**：从 activities.json 按作者统计（24h 提交、开放 PR、本周已完成任务数）；Gitea 分页拉取范围 = 组织仓库 × 最近 7 天，随轮询缓存。

**动态 / 设置**

- **轮询器（服务端常驻）**：启动后每 `pollIntervalSec` 单飞轮询（上一轮未完成不重入）Gitea 组织仓库 × 最近 7 天，写 `data/activities.json`、`data/gitea-status.json`，并顺带拉 `/orgs/{org}/members` 写 `data/gitea-members.json`（`[{login, full_name, name}]`，为 `GET /api/members` 人类花名册来源）；`PATCH /api/settings` 改 `pollIntervalSec` 即时重排定时器（0 = 关闭轮询）；`GITEA_FIXTURE` 模式轮询同样生效且零出网（成员拉取跳过）。
- **`GET /api/activities?refresh=1`**（refresh=1 强制拉取 Gitea，缺省读缓存）｜ 响应 200：`[{"id":"a-71","type":"pr_opened","actor":"agent-kilo","repo":"example-org/fde-api","branch":"feat/sso","title":"feat: SSO 登录","url":"https://gitea.example.com/example-org/fde-api/pulls/12","occurredAt":"2026-10-16T07:30:00Z","matchedTaskIds":["t-01"]}]`；`matchedTaskIds` 计算于读取时（branch 精确相等，或任务 title/branch 与动态 title/branch 互为 ≥4 字子串）
  - **v2.0 数据面增补（只增不改）**：commit 类活动（`commit_pushed`）新增 `sha`（Gitea commits API 提交 id 原样带出，非 commit 类为 null）与 `messageBody`（提交说明**正文首段**——首行 title 之后的第一个段落，≤300 字符截断，无正文为空串 `""`）；响应与落盘均带出，存量旧条目缺字段时归一为 `sha:null` / `messageBody:""`（再轮询命中同 url 自动补齐）。
  - **branch 事件 actor 去合成（v2.0）**：`branch_created`/`branch_deleted` 的 `actor` 不再合成 `'unknown'` 而置 `null`（前端显示中性图标）；存量已落盘的 `'unknown'` 原样保留（容错），成员聚合对 `null`/`'unknown'` 一致排除（不进花名册、不计统计）。
- **`GET /api/settings`** 请求：无（脱敏视图）｜ 响应 200：`{"port":7788,"host":"127.0.0.1","dataDir":"data","gitea":{"baseUrl":"https://gitea.example.com","apiPrefix":"/api/v1","org":"example-org","pollIntervalSec":60,"hostWhitelist":["gitea.example.com"]},"credential":"GIT_CONFIG_EXTRAHEADER"}`
- **`PATCH /api/settings`** 请求：`{"gitea":{"pollIntervalSec":120}}`（部分更新，按节 deep merge 后整体写回 config.json）｜ 响应 200：同 GET 脱敏视图；`host` 请求值非 `127.0.0.1` → 400 `HOST_FORBIDDEN`；port 改动需重启生效
- **`POST /api/gitea/test`** 请求：`{"baseUrl":"https://gitea.example.com"}`（省略用 config 值）｜ 响应 200：`{"ok":true,"latencyMs":143,"apiVersion":"1.22.0"}`；白名单外 400：`{"error":{"code":"HOST_NOT_ALLOWED","message":"host 不在白名单"}}`

**成果自动归因（v1.9 起，实现见 `lib/attribute.js`；分支/提交信息工作约定见 `docs/ATTRIBUTION.md` 与 AGENTS.md 片段模板）**

- **成果自动归因**：`pollActivities` 每次落盘后（轮询器与 `GET /api/activities?refresh=1` 两路自动生效）执行全量扫描：`data/activities.json`（≤500 条）× 全部任务，**精确规则**命中任一即归因——a) `activity.branch === task.branch`（双方非空）；b) `activity.branch` 以 `task/<task.id>` 开头（工作约定 task/<taskId> 分支，规范见 docs/ATTRIBUTION.md）；c) `activity.title` 含 `[#<task.id>]`（约定的提交信息前缀）。与 §3 `matchedTaskIds` 的 ≥4 字模糊子串口径无关（那是展示层匹配，本规则是落盘归因，宁缺勿滥）。
- **类型与 URL 门槛**：`activity.type` 映射 artifact `kind`：`commit_pushed→commit`、`pr_opened/pr_merged→pr`；`branch_created`/`branch_deleted` 及未知类型跳过；无 url（或非 http(s) 伪协议，与手动挂接同门槛）跳过。
- **幂等去重**：`task.artifacts` 已含同 url 一律跳过——重复轮询落盘后全量重扫不重复挂（同 PR 的 opened/merged 双动态同 url，只挂先扫描到的一条）。
- **命中写盘**：`task.artifacts` 追加 `{url, kind, repo, ref:activity.branch, at:activity.occurredAt, title, messageBody, attributedBy:"auto"}`（v2.9.15 起 title/messageBody=activity 提交主题/正文首段随归因落库，≤300 字截帽、null 容错；读取端 GET /api/tasks 与 GET /api/tasks/:id 按 url 从 activities.json 回填存量/手动成果缺失的说明——纯响应不落盘，会话成果不参与、已有值不覆盖） + 事件流 `type:"artifact"`（detail=`自动归因：branch <branch>` 或 `自动归因：提交 [#<taskId>]`）+ `task.updatedAt` 刷新；无任务/无动态/无命中零写盘；归因异常只记服务日志，不影响轮询成败与 `gitea-status.json`。

**成员名册 CRUD 与列排序（v1.2）**

手工名册落盘项目根 `members.json`（配置文件，人可手改，API 走 tmp+rename 原子写回）：`{"members":[{"id":"qianqi","name":"张伟","role":"后端","giteaLogin":"wangwu","enabled":true}]}`；`id` 匹配 `^[a-z][a-z0-9.-]{0,31}$` 且名册内唯一；`name` 必填 1..50 字；`role`/`giteaLogin` 可选字符串 ≤50 字（缺省 `""`）；`enabled` 布尔缺省 `true`。

- **`POST /api/members`** 请求：`{"id":"qianqi","name":"张伟","role":"后端","giteaLogin":"wangwu","enabled":true}`（id/name 必填，其余可省略）｜ 响应 201：完整对象（缺省字段补齐）；id 重复 409 `MEMBER_EXISTS`；字段非法 400 `MEMBER_INVALID`
- **`PATCH /api/members/:id`** 请求：`{"name":"张伟（组长）","role":"后端","giteaLogin":"wangwu","enabled":false}`（任意子集）｜ 响应 200：更新后完整对象；名册中不存在 404 `MEMBER_NOT_FOUND`（智能体与派生成员不经此接口修改）
- **`DELETE /api/members/:id`** 请求：无 ｜ 响应 204（空体），仅允许删手工名册条目；目标 id 若属 `agents.json` 智能体或 Gitea 派生成员（缓存 ∪ 动态 actor）409：`{"error":{"code":"MEMBER_IMMUTABLE","message":"…智能体走 /api/agents，Gitea 成员为派生只读"}}`；两边都不沾 404 `MEMBER_NOT_FOUND`
- **`PATCH /api/columns/:id` 扩展**：请求在 `{name}` 之外也接受 `{"order":<正整数>}`（可单独或与 name 同传）。语义：`order` 为目标绝对序号（超 n 收敛到末位），被移列独占该位、其余列按原有相对顺序填充剩余序号位，全列归一化为 1..n 连续序列——该语义对 ←/→ 双向对称，1..n 内响应 `order` 恒等于请求值（goose 验收 P1-1 修订：旧「同号并列被移列优先」写法在 → 方向会静默偏移，作废）；非正整数 400 `ORDER_INVALID`；归一化结果落盘持久。

`GET /api/members` 聚合扩展（v1.2）：手工名册条目并入现有视图——无 Gitea 缓存/动态也出现（`kind:"human"`、`status:"idle"`），每条新增 `manual:true/false` 字段（智能体与 Gitea 派生成员为 `false`，响应形状仅增此字段）；手工条目的 `giteaLogin` 若命中动态 actor（小写精确相等）→ 合并其活动数据（`todayCommits`/`openPrs`/`lastActivityAt` 照常计算，实现活动归因），且该 login 不再重复输出 Gitea 缓存/动态派生条目；`enabled:false` 仍出现在名册视图（配置位，不隐藏）。

**任务负责成员（v1.2 追加）**：task 新增 `memberId`（string\|null）字段——任务的人类负责成员 id，校验风格同 `agentId`（undefined/null→null，非字符串 400 `FIELD_INVALID`）且长度 ≤64（超限 400 `FIELD_INVALID`，message 提及 memberId）；不强制该 id 存在于名册；可与 `agentId` 同时设置（互不冲突）。

- `GET /api/tasks` 支持 `?memberId=<id>` 查询过滤：精确相等匹配，与既有 `status`/`q` 完全叠加。
- `GET /api/members` 的 `currentTask`/`weekDone`/`status` 计入 `memberId` 命中任务：agent 条目归领范围 = `agentId` 或 `memberId` 命中；human 条目（手工名册 + Gitea 派生）= `memberId` 命中，推导规则与 agent 完全相同（`session` 恒为 null 不变）。

**任务描述字段（v1.2 追加）**：task 新增 `desc`（string）字段——多行描述，缺省 `""`；POST/PATCH 接受，校验为字符串且长度 ≤2000（非字符串/超长均 400 `FIELD_INVALID`，message 提及 desc），允许空串与多行（`\n` 不剥离，卡片段落渲染由前端负责）。

- `GET /api/tasks` 的 `q` 模糊匹配范围从 title/branch/notes 扩为 **title/branch/notes/desc**。

**任务截止时间与优先级（v1.4）**：task 新增 `dueDate`（string\|null）与 `priority`（string）字段，规则如下。

- **dueDate 截止时间**：`YYYY-MM-DD` 格式字符串或 `null`（POST 缺省 `null`）。校验两道：正则 `^\d{4}-\d{2}-\d{2}$` + 真实日历回读（年/月/日必须与 `new Date(y, m-1, d)` 回读一致，拦下 `2026-13-99`、`2026-02-30` 这类正则通过但日历不存在/溢出的值——V8 的 `new Date('2026-02-30')` 会滚动到 3 月 2 日，不能只判 NaN）；任一不过即 400 `FIELD_INVALID` 且 message 提及 dueDate。允许过去日期（补录逾期场景），不做逾期拦截；PATCH 传 `null` 即清空。
- **priority 优先级**：枚举 `high`/`medium`/`low`，缺省 `"medium"`。POST 时 `undefined`/`null`/`''` 一律归一为 `medium`（宽缺省），非法取值 400 `FIELD_INVALID` 且 message 提及 priority；PATCH 时必须严格属于枚举（`null` 也 400，不接受宽缺省）。
- **`?priority=` 过滤参数**：`GET /api/tasks` 支持按 priority 精确相等过滤，与既有 `status`/`q`/`memberId` 完全叠加；取值非法（如 `nope`）不报错，自然过滤为空数组。
- **overview `overdue` 计数口径**：`GET /api/overview` 的 `tasks` 对象新增 `overdue` 键——`dueDate` 非空且严格早于服务器本地今天的任务数（按服务器本地时区取年月日做字符串比较，非毫秒差）；到期当天不算逾期，`dueDate` 为 `null` 不计入；响应形状仅增此字段，其余键不变。
- **currentTask 透传**：`GET /api/members` 的 `currentTask` 新增 `dueDate` 与 `priority` 透传；历史数据缺字段时回退 `dueDate:null`、`priority:"medium"`。
- **成员活动锚点合并（v1.4 修订，goose 验收 P1-2）**：成员的「最近活动时间」= max(其名下未完成任务中最新的 `updatedAt`，最近一条 Gitea 动态时间)——`currentTask.sinceUpdateSec` 与 `lastActivityAt` 均用该合并锚点。有在办任务时任务本身就是活动证据，刚派任务不得因陈旧 Gitea 动态误报 stale；无任务成员维持纯 Gitea 锚点不变。§3 成员进度小节「`sinceUpdateSec` = now − 最近一条 Gitea 动态时间（无动态则取任务 updatedAt）」旧口径自本行起作废。

**任务完成日期 completedAt（v1.7）**：task 新增 `completedAt`（string\|null，ISO8601 UTC）字段，语义只由「是否处于内置列 id `"done"`」驱动：

- `POST /api/tasks`：创建即带 `status:"done"` → `completedAt` = 当前时间；否则 `null`。
- `PATCH /api/tasks/:id`：仅当请求**携带 `status` 字段**时处置——新值为 `"done"` → `completedAt` = 当前时间（已设过则**刷新为最新**，同值重提交亦刷新）；新值非 `"done"` → `completedAt` = `null`。请求不带 `status` 时**不 touch**（保持原值）。
- `GET /api/tasks` 列表与 `GET /api/tasks/:id` 详情自然带出该字段；存量老任务（v1.7 前落盘）无此键，首次 PATCH 携带 status 后照常获得。

**任务事件流（v1.7，时间轴数据源）**：新存储 `data/task_events.json`（`{events:[...]}`），事件模型 `{id, taskId, type, from, to, detail, at}`（id `e-<base36时间戳>-<6位随机>`；from/to 可为 null；at ISO8601 UTC），追加式。双上限防膨胀：**每任务保留最近 100 条**（超出丢最旧）、**全文件 5000 条**（丢最旧）。

- 记录时机（server.js 任务路由内；收件箱确认入库同记 created）：每次 POST/PATCH/DELETE 的变更**按字段类型合并防噪——同一次 PATCH 每类型最多一条**。

| type | 触发 | from | to | detail |
|---|---|---|---|---|
| created | 任务创建（含收件箱确认入库） | null | 初始 status | 来源描述：手工创建 / `来源：收件箱候选 <refId>` |
| status | status 变更（to ≠ done） | 旧列 id | 新列 id | `状态 a → b` |
| completed | status 变更且 to === `"done"` | 旧列 id | `"done"` | `状态 a → done，任务完成` |
| assign | agentId 或 memberId 任一变更（双向清空也记；两字段同次变更合并一条） | 旧指派描述（`agent:x + member:y`，均空 `未指派`） | 新指派描述（同前） | `指派变更（agentId、memberId）` |
| accept | acceptorId 变更（双向清空也记，v2.0）；status 变更进 done 且已有验收人时额外一条联动事件 | 旧验收人 id 或 null（联动事件为 null） | 新验收人 id 或 null | `验收人变更` / `清除验收人`（清空时）；联动事件 `验收通过：by <acceptorId>` |
| due | dueDate 变更 | 旧值或 null | 新值或 `"清除"` | `截止时间变更` |
| priority | priority 变更 | 旧值 | 新值 | `优先级 a → b` |
| edit | title/desc/notes 任一变更（合并一条） | null | null | `编辑了 title、desc`（**只注字段名，不存全文**） |

- **`GET /api/tasks/:id`** 响应新增 `events` 数组：该任务倒序（最新在前）最近 ≤100 条；存量老任务为空数组，**不回填**。列表响应（`GET /api/tasks`）与 POST/PATCH 响应**不带** events（仅详情带）。
- **`DELETE /api/tasks/:id`** 顺带清理该任务全部事件（文件本就无其事件时不写盘）。

**任务验收人 acceptorId（v2.0）**：task 新增 `acceptorId`（string\|null）字段，语义 = **完成工作的验收签字人**，与 `memberId`（负责人）、`agentId`（执行者）三方独立，可任意组合设置。校验风格与 `memberId` 完全一致（undefined/null→null；非字符串 400 `FIELD_INVALID`；长度 >64 字符 400 `FIELD_INVALID` 且 message 提及 acceptorId），**不校验该 id 存在于名册**。

- `POST /api/tasks` 与 `PATCH /api/tasks/:id` 均接受 `acceptorId`；PATCH 传 `null` 即清除。`GET /api/tasks` 列表与详情自然带出该字段；存量老任务无此键，首次 PATCH 携带后照常获得。
- **事件流**：PATCH 使 `acceptorId` 变更 → `type:"accept"` 事件（from=旧值，to=新验收人 id；清空时 to=null、detail=`清除验收人`，否则 detail=`验收人变更`）；PATCH 使 status 变更进 `done` 且任务已有（或同次 PATCH 设置了）验收人 → **额外**一条 `type:"accept"` 事件（from=null，to=验收人 id，detail=`验收通过：by <acceptorId>`）——与 completedAt 联动但事件独立，验收人为空时不发。同一次 PATCH 内变更 + 联动两条并存（防噪合并只针对同类型同语义）。
- `GET /api/tasks/:id` 的 `events` 类型表扩为 `created|status|completed|assign|accept|due|priority|edit|memo|artifact`（前端时间轴对 accept 的渲染归前端）。

**任务日报（v2.7）**：存储 `data/diary.json`（裸数组，唯一键 `taskId+date`，同日再存 = 覆盖更新；原子写；删任务顺带清理其全部日报）。日期一律 `YYYY-MM-DD`，校验 = 正则 + 本地日历回读（拦 `2026-02-30`/`2026-13-99`），「当天」口径统一为**服务器本地时区**（与 overview 逾期口径一致；`occurredAt`/`at` 任意时区偏移先换算本地日再比较）。

- **`GET /api/tasks/:id/diary`** ｜ 响应 200：`[{"taskId":"t-01","date":"2026-10-19","content":"…≤2000 字","updatedAt":"…"}]`（按日期倒序；无日报为空数组）；任务不存在 404 `TASK_NOT_FOUND`
- **`PUT /api/tasks/:id/diary`** 请求：`{"date":"2026-10-19","content":"…"}`（均必填；content 字符串 1..2000，纯空白拒绝）｜ 响应 201（首存）/ 200（同日覆盖，`updatedAt` 刷新）；date 缺失/非法或 content 非法 400 `FIELD_INVALID`。首存追加事件 `type:"diary"`（from=null，to=date，detail=`日报 <date>`）；**同日重写不重复发事件**
- **`DELETE /api/tasks/:id/diary/:date`** ｜ 响应 204（空体）；该日期无日报 404 `DIARY_NOT_FOUND`；路径日期非法 400 `FIELD_INVALID`
- **`GET /api/tasks/:id/diary/prefill?date=YYYY-MM-DD`**（date 缺省 = 服务器本地今天）｜ 响应 200：`{"date":"…","giteaCommits":[{"sha":string|null,"title":"…","url":"…"}],"memoUpdates":[{"quote":"引用原句","note":"纪要标题"}],"draft":"拼装草稿文本"}`。两源匹配口径：①`giteaCommits` = activities.json 当天 `commit_pushed`，命中 = attribute 精确规则（branch 相等 / `task/<taskId>` 前缀 / 标题含 `[#<taskId>]`）**或任务 repo 相等兜底**（存量动态 branch 多为 null，只按 branch 永远命中不了），url 非 http(s) 剔除，按 `occurredAt` 倒序，存量无 `sha` 为 null；②`memoUpdates` = task_events 当天该任务 `type:"memo"` 事件，`detail`（`纪要《标题》：引用原句`）拆为 note/quote，不合形态兜底 `quote=detail`、`note=""`，按 `at` 倒序。`draft` 两块条件拼装（`■ Gitea 提交（N）`/`■ 纪要摘录（N）` 小节），两块皆空为空串。date 非法 400 `FIELD_INVALID`，任务不存在 404 `TASK_NOT_FOUND`
- **`GET /api/members` 联动（仅增不改）**：成员对象新增 `diaryToday: true|false`——该成员名下进行中（内置 doing 列）任务当天是否有日报；agent 类条目（桌面源）归领 = `agentId` 或 `memberId` 命中，human 类（手工名册 ∪ Gitea 派生）= `memberId` 命中。`currentTask`/`weekDone`/时效等既有口径一概不动
- task **不设** `diaryCount` 冗余计数（决策记录）：计数需在每次日报写时同步刷 tasks.json，写放大与存量迁移都不划算；日报数据量小（每任务每天 ≤1 条），前端详情页经 `GET /api/tasks/:id/diary` 一次取全即可

**收件箱 v1.7 契约（拒绝原因必选 + 已完成处置 + 新误识率口径）**：

- **`POST /api/inbox/:id/reject`** 请求改为 `{"reason":"duplicate"|"wont_do"|"invalid"|"other"（必填）, "note?": string≤500}`：缺 `reason` 或取值不在枚举 → 400 `REASON_REQUIRED`；`note` 非字符串或超 500 字 → 400 `FIELD_INVALID`。落盘 `rejectReason`/`rejectNote`，`state='rejected'`。
- **`POST /api/inbox/:id/done-already`**（新增）请求 `{"note?": string≤500}`：`state='done_already'`、`decidedAt`、落 `doneNote`；**不入看板（不建任务）**。pending 之外重复决定一律 409 `ALREADY_DECIDED`。
- **`GET /api/inbox/stats`** 新增 `doneAlready` / `doneAlready30d` 计数；**误识率口径改为 `rejectRate30d = rejected30d/(confirmed30d+doneAlready30d+rejected30d)`**（done_already 属正确处置计入分母，分子仍只算 rejected；分母为 0 时 `null`）。旧口径 `rejected/(confirmed+rejected)` 自本行起作废。
- **`POST /api/inbox/:id/confirm` 说话人映射解耦（v1.7 修订）**：请求体新增可选 `speakerMemberId`（`string|null`，≤64 字符）= **说话人身份映射目标**（「这个说话人是名册里的谁」），与 `memberId`（任务负责人）彻底解耦——负责人 ≠ 说话人，历史上曾把说话人昵称错挂到负责人名下。`rememberAlias:true` 时：①`speakerMemberId` 非空 → 别名（候选 `speakerRaw`）写到 **speakerMemberId** 名下（沿用 `resolveAliasTarget` 自动建档，Gitea 派生 id 自动建关联条目），响应 `rememberedAlias` 形状 `{memberId（=映射目标）, alias, memberCreated}`；②`speakerMemberId` 为空 → **不写任何别名**，响应 `rememberedAlias:null` 且附顶层 `reason:"SPEAKER_UNRESOLVED"`（不报错——用户有权不映射）；③映射目标不在手工名册与 Gitea 缓存 → 404 `MEMBER_NOT_FOUND` 前置拦截（不建任务）；④非法类型（非字符串非 null）→ 400 `FIELD_INVALID`。**兼容性语义变更**：旧客户端只传 `memberId`+`rememberAlias`（无 `speakerMemberId`）→ 按新语义**不写别名**（宁可不学，不可错学），同 ② 响应。未请求 `rememberAlias` 时行为不变（`rememberedAlias:null`，无 `reason` 字段）；候选落库与任务事件流不受本次修订影响。

## 4. 数据模型

存储分工：项目根 `agents.json`/`config.json` = 配置（人可手改，API 同步写回）；`data/` = 运行态（仅服务读写）。

**task**（`data/tasks.json`，含 `columns` 数组）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | `t-<base36时间戳>-<4位随机>`，服务端生成 |
| title | string | 必填，1..200 字符 |
| status | string | 列 id，默认 `"todo"` |
| agentId | string\|null | 对应 agents.json 的 id |
| memberId | string\|null | 任务的人类负责成员 id（≤64 字符，不强制存在于名册，可与 agentId 同设，v1.2） |
| acceptorId | string\|null | 验收签字人 id（≤64 字符，不强制存在于名册；与 memberId/agentId 三方独立，v2.0；accept 事件语义见 §3） |
| repo | string\|null | 形如 `example-org/fde-api` |
| branch / prUrl | string\|null | 分支名 / PR 链接 |
| notes | string | 默认 `""` |
| desc | string | 多行描述，缺省 `""`，≤2000 字符（v1.2） |
| dueDate | string\|null | 截止日期 YYYY-MM-DD 或 null，允许过去日期（v1.4） |
| priority | string | 优先级 high/medium/low，缺省 `"medium"`（v1.4） |
| completedAt | string\|null | 完成日期 ISO8601 UTC；进内置 done 列置值/刷新，移出清 null（v1.7） |
| createdAt / updatedAt | string | ISO8601 UTC，服务端维护 |
| origin | object\|null | 收件箱确认入库溯源 `{type:'inbox', refId, quote}`，仅雷达链路写入 |

**task_event**（`data/task_events.json`，v1.7，追加式）：`id:string`（`e-<base36时间戳>-<6位随机>`）、`taskId:string`、`type:string`（`created|status|completed|assign|accept|due|priority|edit`，语义见 §3 事件类型表；v1.9 另有 `memo`/`artifact`；`accept` 为 v2.0 验收签字事件；`diary` 为 v2.7 日报首存事件，to=date）、`from:string\|null`、`to:string\|null`（due 清空为 `"清除"` 字面量；assign 空为 `"未指派"`；accept 清空 to=null）、`detail:string`（human 可读摘要；edit 只注字段名不存全文）、`at:string`（ISO8601 UTC）。上限：每任务最近 100 条、全文件 5000 条，均丢最旧；删任务顺带清理。

**diary**（`data/diary.json`，v2.7，裸数组，唯一键 taskId+date）：`taskId:string`、`date:string`（YYYY-MM-DD，已过日历回读校验）、`content:string`（1..2000 字符，不裁剪原样保存）、`updatedAt:string`（ISO8601 UTC，同日覆盖时刷新）。删任务顺带清理该任务全部条目；无 per-task/全文件上限（每任务每天至多 1 条，天然有界）。

**column**：`id:string`（slug）、`name:string`、`order:int`（1 起）。内置四列 id 固定：todo/doing/review/done。

**agent**（`agents.json`）：`id:string`（`^[a-z][a-z0-9-]{0,31}$`）、`name:string`、`command:string`（PATH 中可执行名）、`commandTemplate:string`（可含 `{briefing}`，启动时替换为转义后的 `"..."` 双引号参数，省略则不传简报）、`builtin:boolean`、`enabled:boolean`（false 时 launch 返回 400）。

**activity**（`data/activities.json`，滚动保留 ≤500 条）：`id:string`（`a-<seq>`）、`type:string`（`pr_opened|pr_merged|commit_pushed|branch_created|branch_deleted`）、`actor:string\|null`（v2.0 起 `branch_created`/`branch_deleted` 为 null 不再合成 `'unknown'`；存量 `'unknown'` 容错保留；pr/commit 仍为登录名或作者名兜底）、`repo:string`、`branch:string|null`、`title:string`、`sha:string\|null`（v2.0：commit 类活动的提交 id，其他类型 null）、`messageBody:string`（v2.0：commit 提交说明正文首段 ≤300 字符，无正文 `""`）、`url:string`、`occurredAt:string`、`fetchedAt:string`（均 ISO8601 UTC）。`matchedTaskIds` 仅存在于 API 响应，不落盘。

**session**（`data/sessions.json`）：`id:string`（`s-<4位随机>`）、`agentId:string`、`pid:number`、`taskId:string|null`、`workdir:string`（必须绝对路径，launch 时校验 isDirectory）、`briefingHead:string`（简报前 80 字符）、`startedAt:string`、`alive:boolean`（每次 GET /api/sessions 以 `process.kill(pid,0)` 实测回写；PID 复用误报为已知限制）。v1.6 追加 `gateway:object`：`mode`（`"cli-gateway"`=经网关包装 / `"direct"`=降级直连）、`version`（探测到的网关版本或 null）、`logPath`（回捞成功后回写的日志绝对路径，direct 恒 null）、`logDir`/`cmdHead`（cli-gateway 模式日志回捞参数）、`reason`（direct 模式降级原因）。

**会话网关**（`config.json` `gateway` 节，v1.6）：`enabled`（bool，缺省 true）、`bin`（缺省 `cli-gateway`，API 只读）、`minVersion`（语义版本下限，空串=不校验，API 只读）、`timeoutSec`（网关超时秒数，缺省 3600，超时杀进程树）、`logDir`（相对项目根，启动期归一化为绝对路径，API 只读）。版本管理唯一口径：已验证版本清单与升级检查单维护在 `lib/gateway.js` 文件头，能力位按 `minVersion`/`KNOWN_FLOOR` 语义比较判定。

## 5. agents.json / config.json

`agents.json`（项目根；内置 9 项 id 固定：opencode/crush/kilo/mcode/goose/codex/claude/dsh/demo-team；其余 7 项与下列两项同构，`commandTemplate` 一律 `"<command> \"{briefing}\""`）。用户新增任意 CLI 走 `POST /api/agents`，写回本文件：

```json
{
  "agents": [
    { "id": "claude", "name": "Claude Code", "command": "claude", "commandTemplate": "claude \"{briefing}\"", "builtin": true, "enabled": true },
    { "id": "demo-team", "name": "DemoBot", "command": "demo-team", "commandTemplate": "demo-team \"{briefing}\"", "builtin": true, "enabled": true }
  ]
}
```

`config.json`（项目根；无环境变量硬编码，支持 `node server.js --config <path>` 覆盖路径）：

```json
{
  "host": "127.0.0.1",
  "dataDir": "data",
  "webDir": "web",
  "gitea": {
    "baseUrl": "https://gitea.example.com",
    "apiPrefix": "/api/v1",
    "org": "example-org",
    "pollIntervalSec": 60,
    "staleWarnSec": 14400,
    "staleDangerSec": 86400,
    "hostWhitelist": ["gitea.example.com"],
    "activityTypes": ["pr", "commit", "branch_created", "branch_deleted"],
    "feedsLimit": 50,
    "maxActivities": 500
  },
  "github": {
    "enabled": false,
    "baseUrl": "https://api.github.com",
    "org": "",
    "eventsPages": 3,
    "hostWhitelist": ["api.github.com"]
  },
  "security": {
    "allowedProtocols": ["https"],
    "credentialSource": "git-config-extraheader",
    "redactKeys": ["Authorization", "extraheader"]
  }
}
```

（port 已随 WP6 退出 config.json、gateway 节已随 v2.2 移除——磁盘遗留键会被运行期装配静默剥除；以上为 §5 config 样例的现状口径。activityTypes 为 feeds 新词表；历史部署的老词表（commit_pushed/pr_opened/pr_merged）经 loadConfig 自动归一，无需手改。）

启动期与运行期校验规则：

1. `host` 仅允许 `127.0.0.1`（启动期违反则退出码 2，PATCH 期 400）。
2. 出站请求协议必须 ∈ allowedProtocols，且 URL host（不分大小写）`===` 白名单某项——精确匹配即天然免疫 SSRF；白名单写入 localhost/IP/私有段字面量时启动即拒绝；白名单外一律 400 且零出站请求。
3. 凭据读取 key 由 `config.gitea.baseUrl` 推导：`git config --global http.<baseUrl>/.extraheader`；读入后仅存内存变量，所有日志写出必经 `redact()`（按 redactKeys 与凭据原值双重过滤），不写入任何文件、不进子进程环境变量。
4. 每个入站请求 Host 头必须为 `127.0.0.1:<port>`，否则 403（防 DNS rebinding 跨源打 API）。

## 6. 并行任务拆解

契约 = 本文 §3/§4/§5。文件归属：后端独占 `server.js`、`lib/*.js`、`test/`；前端独占 `web/index.html`、`web/css/`、`web/js/`、`web/mock.json`；两侧零共享可写文件，互不阻塞。

### 后端包（B）

**B1 服务骨架**：router + 静态托管 + store 原子写 + Host 头校验 + /api/health。完成标准：仅绑 127.0.0.1；未知 `/api/*` 返回 JSON 404；Host 头非 `127.0.0.1:7788` 返回 403。
```bash
node server.js & sleep 1
curl -s http://127.0.0.1:7788/api/health | grep -q '"ok":true' && echo B1-OK
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7788/api/nope        # 期望输出 404
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: evil.example" http://127.0.0.1:7788/api/health   # 期望 403
netstat -ano | grep ":7788" | grep -q "127.0.0.1" && echo B1-BIND-OK
```

**B2 任务/列 CRUD**：完成标准：§3 任务 5 个 + 列 4 个 endpoint 全实现，409/400 分支齐全。
```bash
node --test test/tasks.test.js    # 覆盖：增查改删、status非法400、删非空列409；退出码必须为 0
curl -s -X POST http://127.0.0.1:7788/api/tasks -d '{"title":"t"}' | grep -q '"id":"t-' && echo B2-OK
```

**B3 Gitea 客户端 + 红线 + SSRF**：完成标准：凭据仅内存；`GITEA_FIXTURE` 环境变量可注入 fixture 替代真实网络；白名单外一律 400 且零出站请求。
```bash
node --test test/gitea.test.js test/redaction.test.js   # 含 SSRF 用例(127.0.0.1/169.254.169.254/10.0.0.1/evil.com→400)与凭据落盘扫描；退出码 0
GITEA_FIXTURE=test/fixtures/gitea.json node server.js & sleep 1
curl -s "http://127.0.0.1:7788/api/activities?refresh=1" | grep -c '"id":"a-'    # 期望 ≥2（fixture 2 条）
curl -s -X POST http://127.0.0.1:7788/api/gitea/test -d '{"baseUrl":"http://127.0.0.1:7788"}' | grep -q HOST_NOT_ALLOWED && echo B3-SSRF-OK
```

**B4 启动/会话/停止**：完成标准：launch 校验 workdir（绝对路径+存在）与 enabled；briefing 字符黑名单生效；spawn detached（父退子不死）；stop 用 `taskkill /PID <pid> /T /F`；alive 实测。
```bash
node --test test/agents.test.js   # 启动→alive:true→stop→alive:false；briefing 含 "&"→400；退出码 0
curl -s -X POST http://127.0.0.1:7788/api/agents -d '{"id":"sleeper","name":"Sleeper","command":"ping","commandTemplate":"ping -n 31 127.0.0.1"}' > /dev/null
ID=$(curl -s -X POST http://127.0.0.1:7788/api/agents/sleeper/launch -d '{"workdir":"E:/","briefing":"smoke test"}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -s http://127.0.0.1:7788/api/sessions | grep -q '"alive":true' && echo B4-ALIVE-OK
curl -s -X POST http://127.0.0.1:7788/api/sessions/$ID/stop | grep -q '"alive":false' && echo B4-STOP-OK
```

**B5 总览/设置聚合**：完成标准：/api/overview 汇总各存储；/api/settings 脱敏读写、deep merge 写回 config.json、host 白名单校验。
```bash
node --test test/overview.test.js test/settings.test.js
curl -s http://127.0.0.1:7788/api/overview | grep -q '"sessionsRunning"' && echo B5-OK
curl -s -o /dev/null -w "%{http_code}\n" -X PATCH http://127.0.0.1:7788/api/settings -d '{"host":"0.0.0.0"}'   # 期望 400
```

### 前端包（F）

**F1 骨架**：index.html + hash 路由（`#/overview|#board|#agents|#members|#activity|#settings`）+ 深色主题 CSS 变量 + mock 模式（URL 含 `?mock=1` 时读 web/mock.json，零出网）。
```bash
for v in overview board agents members activity settings; do grep -rq "#/$v" web/js/ || exit 1; done && echo F1-OK
node -e "const m=require('./web/mock.json');['overview','columns','tasks','agents','sessions','activities','settings'].forEach(k=>{if(!(k in m))process.exit(1)});console.log('F1-MOCK-OK')"
```

**F2 看板视图**：列渲染、任务卡增/改/删/下拉移动状态、列管理（增/改名/删，删非空列展示 409 提示），深色主题。
```bash
grep -q '/api/tasks' web/js/views/board.js && grep -q '/api/columns' web/js/views/board.js && echo F2-OK
grep -qE 'method:\s*"PATCH"' web/js/views/board.js && echo F2-PATCH-OK
```

**F3 智能体视图**：注册表列表（builtin 徽标/启停开关）、新增/编辑（含 commandTemplate 输入）、启动表单（workdir/briefing/关联任务下拉）、会话列表（alive 徽标 + 停止按钮，10s 轮询）。
```bash
grep -q '/api/agents' web/js/views/agents.js && grep -q '/api/sessions' web/js/views/agents.js && grep -q '/launch' web/js/views/agents.js && echo F3-OK
```

**F4 动态/总览/设置视图**：动态流倒序、每条含 actor/repo/branch/类型徽标/匹配任务链接（点击跳 `#/board` 并高亮）、手动刷新；总览统计卡绑 /api/overview；设置页读写 /api/settings + 「测试连接」按钮调 /api/gitea/test。
```bash
grep -q '/api/activities' web/js/views/activity.js && grep -q 'matchedTaskIds' web/js/views/activity.js && echo F4-OK
grep -q '/api/overview' web/js/views/overview.js && grep -q '/api/gitea/test' web/js/views/settings.js && echo F4-B-OK
```

**F5 成员进度视图（v1.1）**：`#/members` 视图 + 侧栏入口；成员表（成员/状态/当前任务+进度条/时效/今日产出/会话），status 徽标（working 绿 / idle 灰 / stale 黄、超 staleDangerSec 升红），进度条按 progress 推导值渲染；顶部汇总（成员数/工作中/空闲/超时预警）；时效阈值展示取自 /api/settings；10s 轮询。
```bash
grep -q '/api/members' web/js/views/members.js && grep -q '#/members' web/js/app.js && echo F5-OK
node -e "const m=require('./web/mock.json');if(!m.members||!Array.isArray(m.members))process.exit(1);console.log('F5-MOCK-OK')"
```

### 联调包（I，B+F 全绿后执行）

完成标准：真实服务（无 GITEA_FIXTURE）冒烟全流程——建任务 → launch claude → 会话出现 → 动态匹配该任务分支 → 改状态 → 总览数字变化；DevTools 网络面板仅出现 127.0.0.1 请求。
```bash
node --test test/*.test.js   # 后端全量，退出码 0（Node ≥24 下 `node --test test/` 的裸目录写法按 glob 解释会漏匹配，勿用）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7788/   # 期望 200；人工 10 步清单见 docs/SMOKE.md（联调时产出）
```

## 7. v1 明确不做的事（Non-goals）

- 多用户、登录、权限体系；API 鉴权与登录态/令牌类 CSRF 防护（跨源已实施三道防线：§5-④ Host 头校验 + 写请求 Content-Type 强制 + Sec-Fetch-Site 校验，豁免仅指登录态/令牌类防护）
- 看板与 Gitea 强绑定（无 webhook、无双向同步；仅展示层模糊匹配）
- 拖拽改列（用任务卡状态下拉替代）
- WebSocket/SSE 实时推送（一律轮询：会话 10s、动态 60s，均可手动刷新）
- 桌面源适配器仅覆盖内置六源（zcode/claude/dsh/workbuddy/codex/opencode，全部只读）；新源（trae/qoder/hermes 等）需专项适配器开发，按需另议不进默认范围
- Gitea 写操作（建 PR/评论/合并——客户端只读）
- 数据库、多实例部署、局域网访问、TLS/反向代理
- 凭据任何形式的持久化或外发（含加密落盘、写入日志、传入子进程环境变量）
- 团队成员管理、demo-team 集成（任务数据完全自管）
- 真实完成率跟踪（成员进度为状态+动态信号推导值，非任务内部真实百分比；无逐任务 checklist）
