# ADAPTERS.md — 会话源适配器协议（v1.0，社区新源开发指南（hermes 已占第七源，2026-11-03））

> FDE 指挥台观测六源（zcode / claude / dsh / workbuddy / codex / opencode）。
> 你常用的 agent 不在列？按本协议写一个适配器即可接入全部链路——
> 智能体动态、会话阅读器、成员进度、热力图、派工词、搜索、上下文注入，零改动共享。

## 适配器在架构中的位置

```
lib/agentActivity.js   SOURCE_IDS 注册表 + aggregateAgentActivity（智能体动态/成员进度）
lib/agentTranscript.js LIST_SOURCES / TRANSCRIPT_SOURCES（会话列表 + 全文阅读器）
lib/heatmap.js         buildHeatmap（热力图）        ← 复用 listAgentSessions
lib/workSearch.js      buildSessionIndex（搜索）     ← 复用 listAgentSessions
lib/agentContext.js    buildAgentContext（上下文注入）← 复用 listAgentSessions
```

新源 = 在两处注册表各加一个函数 + `lib/sessionRef.js` 加 locator 形态。没有更深的钩子。

## 列表适配器契约（listXxxSessions）

```js
/**
 * @param {object} sourceCfg  config.agentActivity.sources.<id>（root/dbPath 由你定义语义）
 * @returns {Array<{id, listId, title, projectId, startedMs, lastActiveMs, state?, locator}>}
 */
```

| 字段 | 必填 | 口径 |
|---|---|---|
| `id` | ✓ | 会话唯一键（阅读器按它回查） |
| `listId` | ✓ | 列表分页唯一键（路径类源=相对路径） |
| `title` | ✓ | 会话标题；**必须过 redact**（出口统一，别自己发明脱敏） |
| `projectId` | ✓ | 项目目录（归一比较用；尽量存原始 cwd 字符串） |
| `startedMs` / `lastActiveMs` | ✓ | 毫秒时间戳（热力图时长口径的原料） |
| `state` | 可选 | `active/completed/failed/cancelled/idle`（缺失时按时间窗推断） |
| `locator` | ✓ | `{ s:<源id>, k:<kind>, v:{...} }`——见下节 |

**硬性纪律**：
- 只读。sqlite 一律 `{readOnly:true}`；文件 openSync 只读；压缩格式内存解压（zstd 用 node:zlib）
- 单源故障不抛出（返回空数组或内部吞掉记日志）——绝不拖垮聚合
- 读入必须有闸（单文件 ≤4MB 之类）；扫描目录数/条数设上限
- 不触碰 account/credential/token 等敏感表；标题文本必过 redact

## 阅读器适配器契约（transcriptXxx）

```js
/**
 * @param {object} sourceCfg
 * @param {object} locator  validateRef 通过后的 {s,k,v}
 * @param {object} collect  MessageCollector：collect.push(role, tsMs, text, tool)
 *                          role: 'user'|'assistant'|'tool'；tool={name,status:'ok'|'error'|'running'}
 * @returns {{title, projectId, startedMs, lastActiveMs, readTruncated?}} 元数据（degraded 态见 workbuddy 适配器）
 */
```

- 首条 user 文本 = 派工词提取原料 → **注入包裹块（system-reminder/environment_context 等）不要 push 成 user 消息**，或保证第一条 user 是真人指令
- 会话不存在抛 `HttpError(404,'SESSION_NOT_FOUND')`

## locator 双闸（lib/sessionRef.js）

每个源两种 locator 形态之一：
- **id 类**（zcode/opencode/workbuddy）：`{s,k:'session',v:{id}}`——`SOURCE_ID_RE` 白名单正则，不触 fs
- **路径类**（claude/dsh/codex）：`{s,k:'project'|'file',v:{dir,file}|{path}}`——`validateRef` 正则闸 + `resolveLocatorPath` realpath 包含闸（防 `../` 穿越）

新增源必须：注册 `SOURCE_IDS`、`LOCATOR_KINDS`、对应正则；`resolveLocatorPath` 的 root 推导加分支。

## 验收清单（PR 自查）

1. 列表/阅读器/三个复用方（热力图/搜索/上下文注入）全走通，注入缝测试零出网零 sqlite
2. 单源故障隔离：root 不存在/坏行/巨型文件 全部返回空态不抛错
3. redact 全出口；凭据表零触碰
4. `npm test` 全绿 + 真机数据抽样对照（标题/时间/项目目录三要素）
5. SPEC.md 变更记录 + 本文件源清单更新
