# Super Workbench 调研模块规格（docs/SPEC-RESEARCH.md）

> 版本 1.0.0 · 2026-11-22 · 依据：业主拍板「场景调研能力原生重写进工作台」（参考实现 E:\agent开发\ai-scene 已竣工审核通过，对等移植）· 设计经薛定谔审计（7 项决议见 §8，均为约束性契约）
> 硬约束沿 AGENTS.md：零 npm 依赖、零构建、凭据零落盘、AI 永不直写、失败必须留痕
> 定位一句话：调研 = 任务漏斗第三入口 + 唯一"工作面"视图；与交付侧构成三条闭环（§2）

## 1. 融合定位

任务创建三入口：手工创建 · 任务雷达（听记→拆解→收件箱）· **调研（访谈→草稿→accept→任务+证据）**。
调研草稿管线与收件箱闸门同构（AI 提案→人工闸门→validate→入库），但调研是**工作面**（主动出击：聊、看缺口、追问），非读视图。叠加态唯一容器 = `task_drafts.pending`；开盒坍缩唯一入口 = 人工 accept。

## 2. 三条闭环（产品灵魂）

- **闭环 A（前向）**：访谈 → 草稿(pending) → 人工 accept → 任务(document 证据) → 看板 → 派活 → 七源观测 → 归因 → 验收。证据链全程：访谈原句 → 草稿引用 → 任务 → 归因提交 → 验收结论。
- **闭环 B（反向·复利）**：验收完成任务 → 沉淀知识库(kb_documents,追加不改史) → 下次同场景访谈上下文自动检索历史（带 task 出处） → 草稿更准。**饥饿可观测**：可沉淀计数进行动条 chip。
- **闭环 C（横向·客户产物）**：任务拓扑+验收结论+人工日报 → BPMN 2.0 XML（纯字符串生成）/交付报告 Markdown。**输入纯度铁律（审计决议⑦）**：只吃人工确认面数据；启发式归因数据禁止直达客户产物。

## 3. 数据模型（SQLite 增量，schema_version +1）

| 表 | 关键列 | 纪律 |
|---|---|---|
| `interviews` | id · project_dir · status(open/closed) · scene_title · created_at · closed_at · context_meta(JSON) | 绑定复用 projectDir 概念；按场景分组 |
| `interview_messages` | id · interview_id · role(FDE/AI/system) · text · kind(normal/parse_error/paper) · llm_channel(dsh/direct/paper) · model_id · prompt_version · prompt_sha256 · prompt_snapshot · ts | AI 行必记通道与提示词版本；system 行留痕失败（脱敏） |
| `task_drafts` | id · interview_id · payload(JSON) · status(pending/accepted/rejected) · quote · decided_by · decided_at · task_id · created_at | 创建时即过 shape 校验（**解析/校验失败不落 pending**）；accept 失败 400 带原因留 pending |
| `kb_documents` | id · source_task_id · kind(diary/report/evidence) · title · body · created_at (+kb_fts 虚拟表) | 追加不改史；任务删除后 task_id 悬挂=审计特性，UI 显「任务已删除」 |

## 4. 提示词资产纪律（审计决议③的载体）

- `prompts/*.md` 随包发布（files 白名单）；加载器校验文件头版本标记，缺版本 → **启动 fail-fast**
- 访谈开箱即冻结：interview_messages 行内保存 prompt 全文 + 版本 + sha256——改文件不影响旧会话可解释性；同版本不同内容 → 拒绝加载
- 拆解/访谈提示词永不内嵌代码字符串（杜绝双源漂移）

## 5. LLM 通道（lib/llm.js，唯一出站点）

| 通道 | 触发 | 红线 |
|---|---|---|
| `dsh`（默认） | 雷达引擎同款本机 CLI | 无新配置 |
| `direct` | config.research.hostWhitelist 含端点 host 时可用（沿 github 节先例：默认关） | key 只走 env（RESEARCH_LLM_API_KEY）；内置 fetch；读/连接超时分离；出站文本过 redact |
| `paper` | 未配置任何通道 | 消息 kind=paper 显式留痕，不静默 |

- 解析失败 → interview_messages 落 system/parse_error 行（脱敏留痕，红线 8）
- 并发：同访谈禁在途并发；全局 LLM 有界并发（信号量语义，进程内计数）

## 6. API 契约（前缀 /api/research，均需进 SPEC §3 或棘轮登记）

```
POST   /api/research/interviews                 {projectDir?, sceneTitle}
GET    /api/research/interviews                 列表(按场景分组,含 pending 草稿计数)
GET    /api/research/interviews/:id             详情(messages + 缺口清单 + drafts)
POST   /api/research/interviews/:id/messages    {text} → AI 回复(通道路由)+草稿产出
POST   /api/research/interviews/:id/close       关闭访谈(停入站,未决草稿保持 pending 可独立处置)
POST   /api/research/drafts/:id/accept          {payload?人工修订} → 原子 validate+save_task+evidence(kind=document,quote)+task_events(research)
POST   /api/research/drafts/:id/reject          {reason} 留痕
GET    /api/research/kb/search?q=               FTS5(trigram+LIKE 回退)
POST   /api/research/kb/documents               {sourceTaskId,kind,title,body}
GET    /api/research/kb/eligible                可沉淀计数(行动条 chip 数据源)
GET    /api/research/prompts                    提示词资产清单(版本+sha256)
```

accept 失败语义：400 FIELD_INVALID 带原因（草稿留 pending）；409 ALREADY_DECIDED（pending 守卫）；双击/并发安全 = 单事务 + 状态守卫。缺口清单与 kb 检索结果在 context_meta 标注来源（历史沉淀 vs 本场景缺口），提示词明确禁止混淆。

## 7. 前端 IA

- 侧栏新增「调研」（任务雷达旁）；视图三区：场景列表(按 projectDir) | 访谈工作面(消息流+缺口清单+草稿队列) | 知识库检索面板
- 看板任务详情：`research` 来源徽标深链回访谈；验收完成页「沉淀知识库」按钮
- 总览行动条：可沉淀 N 条 chip（非零显示）

## 8. 审计决议（约束性，实现不得偏离）

1. **accept 失败可观测**：400+原因、草稿留 pending、确认表单以当前系统状态预填可改（坍缩用此刻真实值）
2. **悬挂引用=审计特性**：任务删除后 drafts/kb 的 task_id 保留，UI 显式「任务已删除」
3. **KB 饥饿可观测**：可沉淀计数 chip 非零显示
4. **context_meta 来源标注**：历史沉淀 vs 本场景缺口，提示词禁止模型混淆
5. **通道可观测**：AI 行记 llm_channel+model_id，纸面显式留痕
6. **失败留痕**：LLM 解析失败落 system/parse_error 行（红线 8 延伸）
7. **闭环 C 输入纯度**：客户产物只吃人工确认面数据，启发式归因禁入

## 9. 分期验收（每批走版本纪律+全量测试绿）

- **R1 地基**：schema 四表+FTS5（trigram+LIKE 回退）、prompts 资产+加载纪律、lib/llm.js 三通道、SPEC 本文档 → 完成条件：离线测试全绿、纸面模式端到端可跑
- **R2 访谈+草稿**：interviews/drafts/kb eligible API、上下文组装、accept 原子闸门 → 完成条件：accept 单事务真机验证、reject 留痕、双击并发测试
- **R3 知识库**：kb CRUD+检索+沉淀 → 完成条件：中文双字词检索实测命中
- **R4 渲染导出**：BPMN 2.0 XML（XSD 对齐+确定性字节）、交付报告 → 完成条件：标准建模器导入实测一次
- **R5 前端**：调研视图三区 + 徽标深链 + 沉淀按钮 → 完成条件：真机三闭环走通一遍

## 10. 边界（有意不做）

- 不做 Mermaid 交互画布（ADR-101：价值在可导入标准 XML；渲染后置）
- 不做多用户共享（local-first 红线）
- 不自动沉淀（人工触发；饥饿用 chip 提示而非自动灌库）
- 工作台不托管任何外部调研进程（模块在进程内，无生命周期问题）
