# PRD · 任务雷达（钉钉听记 → AI 拆解 → 任务收件箱）v1.0

> 2026-10-18 · 依据 docs/BRAINSTORM-task-inbox.md v2 + 业主四问拍板 · 状态：待业主确认开工

## 1. 目标（3 句）

把散落在钉钉听记里的需求/待办，自动采集进指挥台「雷达池」，由 AI（dsh 无头引擎）识别并拆解为结构化候选任务，经人工确认闸门后进入看板。误识率从第一天起可度量，一个月后据数据决定是否放开高置信度自动入库。指挥台从「人录任务的看板」升级为「任务自己来找你的雷达」。

## 2. 已锁定决策（业主拍板，不再讨论）

| 决策点 | 结论 |
|---|---|
| MVP 数据源 | 只接钉钉听记/纪要（dingtalk-minutes 通道）；群聊不接 |
| 采集范围 | **全量自动**：所有听记自动进雷达池（含历史，有就拉没有算） |
| 分析闸门 | **二次选择制**：进池≠分析；业主在池中选中纪要 → 才触发 AI 分析 → 候选卡进收件箱 |
| 确认闸门 | 候选卡一律人工确认/编辑/拒绝，v1 无自动入库；跑一个月看误识率再议 |
| 分析引擎 | **`dsh --profile headless "<任务>"`**（本机 rc.7，官方帮助实锤；开发首日先跑通一次真实调用冒烟） |
| 回写钉钉 todo | 二期 |
| 说话人映射 | 成员 aliases + 确认卡时「记住此映射」勾选 |

## 3. 端到端流程

```
钉钉听记 ──自动同步──▶ 雷达池(全量,增量,含历史) ──业主选中──▶ dsh分析 ──▶ 收件箱候选卡
                                                          (三件套输入)      │ 人确认/编辑/拒
                                                                       ▼
                                                              看板任务(带 origin 溯源)
```

同步节奏：设置页开关 + 手动「同步」按钮（v1 不做定时轮询，按钮驱动；增量靠 contentHash）。

## 4. 数据模型增量

- `data/messages.json`（雷达池）：统一消息模型 `{id(内容哈希), source:"dingtalk", kind:"minutes", title, speakerSegments[{raw,memberId,text,at}], content, occurredAt, ref, contentHash, analyzedAt}`
- `data/inbox.json`（候选池）：`{id, messageId, title, desc, priority, suggestedMemberId, dueHint, confidence, quote, rationale, state:pending|confirmed|rejected, decidedAt}`
- `members.json` 成员 +`aliases:[]`；task +`origin:{type:"inbox",refId,quote}|null`

## 5. AI 管线

- 单元=一条被选中的纪要；输入三件套=纪要全文（说话人分段）+ 成员名册快照 + **当前看板任务清单（防重复建卡）**
- 输出 JSON：`{tasks:[{title,desc,priority,suggestedMemberId,dueHint,confidence,quote,rationale}], noise:[{quote,reason}]}`；解析失败重试一次，再失败该条标记 ANALYZE_FAILED 可重试
- 置信度规则写进 prompt：0.9+（动作+人+时间全明确）/0.7~0.9（动作明确人时模糊）/0.5~0.7（推断性）/<0.5 不产出；few-shot 正反例（寒暄✗ "我看看"✗ "周五前给我给我"✓）
- 单纪要候选 ≤10 张超限截断；v1 拍平无父子；dueHint 只存原文词不转日期

## 6. UI（复用 v1.3 高级感体系）

- 侧栏新视图「雷达」：两段式——上=纪要池列表（源徽标/时间/已分析标记/选中框+「分析所选」按钮）；下/切页=收件箱候选卡流（置信度降序、批量确认/拒绝、原文引用折叠）
- 收件箱头部：近 30 天拒绝率徽标（=误识率仪表，数据从第一天攒）
- 设置页：钉钉通道开关、同步按钮、引擎健康状态（dsh 可达性）

## 7. 验收标准（量化）

1. 真实听记 → 选中 → 候选卡出现，含置信度/引用/建议负责人，全程 ≤60s/条
2. 同一纪要重复同步不出重复候选（哈希防重）；已在看板的同类任务 AI 主动标注疑似重复
3. 确认入库 → 看板出现带 origin 溯源的任务卡；拒绝 → 进 rejected 不再出现；「记住映射」→ 下条同说话人自动归人
4. 误识率徽标数字 = rejected/(confirmed+rejected) 正确
5. dsh 不可达/超时 → 该纪要标记 ANALYZE_FAILED 且可手动重试，不阻塞其他
6. 全量测试绿（93 存量 + 新增）；goose 真机验收过闸

## 8. 明确不做（二期+）

钉钉群聊源、回写钉钉 todo、高置信度自动入库、自然语言日期强转、跨源/跨消息去重合并、定时轮询、父子任务层级。

## 9. 开发首日预检（实现岗第一步）

①`dsh --profile headless "输出JSON测试"` 真实跑通 + 输出格式可控性（system prompt/温度面）；②dingtalk-minutes 技能拉取一条真实纪要验证数据形态。两项任一不通 → 停下来上报，不带假设硬写。
