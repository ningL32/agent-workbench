# FDE 指挥台 扩展规格 A2A（docs/SPEC-A2A.md）

> 版本 1.0.0 · 2026-10-16 · 依据 `input-for-claude-a2a.md` · 协议 A2A v1.0.0 · 硬约束沿 M1：零构建、凭据不进日志（成员 token 存 members.json 属配置文件，允许）、契约先行
> 路线图：M1 本地指挥台（docs/SPEC.md v1.1，已开工）→ **M2 A2A 成员接入与派活（本规格）** → M3 公网上云。

## 1. 背景与里程碑

M2 目标：在 M1 本地指挥台上接入跨机器成员——每台成员机运行 **fde-a2a-server**（Node 适配器：暴露 A2A Agent Card 与 JSON-RPC 端点，收到任务 spawn 本机 CLI agent 并回传生命周期状态）；指挥台新增 A2A client 与「派任务」UI，任务状态按 §5.3 映射回流看板；成员发现沿用 Gitea 心跳（fde-presence 仓库）聚合 Agent Card 目录。M2 交付 LAN 直连形态，M3 收进 cloudflared tunnel / VPS hub。JSON-RPC 方法名一律 A2A v1.0：`message/send`、`message/stream`、`tasks/get`。

## 2. SDK 选型评估结论

**结论：用官方 SDK，不自实现。** 依赖 `@a2a-js/sdk`（a2aproject 官方 SDK，v1.0 stable，实现 A2A 协议 v1.0.0）；开工时 `npm view @a2a-js/sdk version` 核对最新 1.x 并在 package.json 锁死。

| 用途 | 取舍 | 依据（已对照官方 README 核实） |
|---|---|---|
| fde-a2a-server 服务端 | `@a2a-js/sdk` ^1.0 + peer `express` | `AgentExecutor` + `DefaultRequestHandler` + `jsonRpcHandler`（自 `@a2a-js/sdk/server/express` 导入）开箱即用；官方样例 `agents/sample-agent` 即「任务生命周期 submitted → working → artifact → completed over JSON-RPC」，与本项目场景吻合，零改造 |
| 指挥台客户端 | `@a2a-js/sdk` 仅子路径 `@a2a-js/sdk/client`（无 Express peer） | `ClientFactory.createFromUrl(baseUrl, path?)` 自动拉 card 选传输；`sendMessage`/`getTask`/`cancelTask`；`createAuthenticatingFetchWithRetry` + `AuthenticationHandler` 注入 Bearer |
| 排除 | gRPC 传输 | 需额外 peer `@grpc/grpc-js` + `@bufbuild/protobuf`；本规格仅 JSON-RPC 传输 |
| 不做（SDK 有此能力） | Agent Card JWS 签名/JWKS、push notification webhook | 属可选能力，本规格不做（§10） |

`@a2a-js/sdk` 为全项目唯一 npm 例外（fde-a2a-server 与指挥台后端各引一次）；指挥台前端仍零依赖 vanilla。

## 3. M2 容器图

```
业主浏览器（本机）http://127.0.0.1:7788
  │
  ▼
┌─ 指挥台 server.js（M1 架构不变，仍仅绑 127.0.0.1）────────────────┐
│  ├─ a2aClient.js  @a2a-js/sdk/client：ClientFactory + 认证 fetch    │
│  │     └─(Bearer token；白名单三元组放行)─▶ 成员机 A2A 端点 ───────┼─▶
│  ├─ presence.js   轮询 Gitea fde-presence 聚合 card 目录            │
│  ├─ members.json  成员 id/baseUrl/token（配置，token 不进日志）     │
│  └─ data/a2a_tasks.json  派活台账（messageId/a2aTaskId/state）      │
└─────────────────────────────────────────────────────────────────────┘
                    │ LAN：http://<成员私网IP>:7700
                    ▼
┌─ 成员机 fde-a2a-server（@a2a-js/sdk + express，绑 0.0.0.0:7700）───┐
│  GET /.well-known/agent-card.json    （全路由过 Bearer 中间件）     │
│  POST /  JSON-RPC：message/send · message/stream(SSE) ·             │
│          tasks/get · tasks/cancel                                   │
│  CliSpawnExecutor  按 a2a-member.json 模板 spawn CLI agent          │
│   └ 退出码 0 → completed（stdout 尾 ≤2KB 为 artifact）／非 0 → failed│
│  心跳线程：60s 更新 fde-presence/presence/<memberId>.json 并 push   │
└─────────────────────────────────────────────────────────────────────┘
```

## 4. fde-a2a-server 规格

独立仓库 `fde-a2a-server`：`server.js` + `executor.js` + `heartbeat.js` + `a2a-member.json`（成员机配置）+ `test/`。Node ≥18；依赖仅 `@a2a-js/sdk`（锁 1.x）+ peer `express`。

### 4.1 Agent Card（`GET /.well-known/agent-card.json`）

```json
{
  "protocolVersion": "1.0",
  "name": "fde-member-qianqi",
  "description": "FDE 成员节点：张伟（claude / goose）",
  "url": "http://192.168.1.23:7700/",
  "preferredTransport": "JSONRPC",
  "version": "1.0.0",
  "capabilities": { "streaming": true, "pushNotifications": false },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "securitySchemes": { "bearer": { "type": "http", "scheme": "bearer" } },
  "security": [{ "bearer": [] }],
  "fdeAgents": ["claude", "goose"]
}
```

`fdeAgents` 为自定义扩展字段（SDK 透传未知字段），指挥台派活 UI 的 agent 下拉取此值。

### 4.2 JSON-RPC 方法表（A2A v1.0）

端点 `POST /`，JSON-RPC 2.0 信封；`message/stream` 以 `Accept: text/event-stream` 触发 SSE 响应。

| 方法 | 参数要点 | 成功响应 | fde-a2a-server 行为 |
|---|---|---|---|
| `message/send` | `message.parts[0].text`=简报；`message.metadata.agentId` 必填 ∈ fdeAgents | Task（state 从 submitted 起） | 建 task → spawn → 生命周期回传 |
| `message/stream` | 同上 | SSE：TaskStatusUpdateEvent 序列 + 最终 Task | 同上 + SSE 订阅 |
| `tasks/get` | `{id}` | Task 快照 | 读内存/落盘台账 |
| `tasks/cancel` | `{id}` | Task（state=canceled） | `taskkill /PID <pid> /T /F` 子进程树 |
| 其余全部 | — | JSON-RPC `-32601 Method not found` | 含 v0.3 方法名；legacyCompat 层不开启 |

**术语修正**：业主原文 `tasks/sendSubscribe` 是 A2A v0.3 方法名，v1.0 对应 `message/stream`，本文一律按 v1.0 书写；SDK 的 `@a2a-js/sdk/compat/v0_3`（`legacyCompat:{enabled:true}`）提供 v0.3 兼容层，本规格不开启。Agent Card 路径 v1.0 为 `/.well-known/agent-card.json`（v0.3 为 agent.json），与业主给定一致。
错误映射：`metadata.agentId` 缺失或 ∉ fdeAgents → `-32602 Invalid params`；Bearer 缺失/不匹配 → HTTP 401（客户端据此置 auth-required）。

### 4.3 CliSpawnExecutor 生命周期（实现 SDK `AgentExecutor` 接口）

1. `execute(requestContext, eventBus)`：新 taskId → 发布 `submitted`；既有 taskId 再投递 → `working`。
2. agentId 查 a2a-member.json 命令模板，`{briefing}` 替换为转义简报（省略模板变量则不传简报）；简报剥离控制字符后含 `& | < > ^ " %` 任一字符 → 发布 `failed`（message=`BRIEFING_INVALID`），不 spawn。
3. stdout/stderr 收进 2KB 环形缓冲（保留尾部）；退出码 0 → 发布 artifact（kind=text，≤2KB）+ `completed`；非 0 → `failed`（message=`exit=N`）；spawn ENOENT → `failed`（message=`AGENT_NOT_FOUND`）。
4. 运行 600s 未退出 → `taskkill /PID <pid> /T /F` → `failed`（message=`TIMEOUT_600S`）；秒数可由启动参数 `--timeout-secs` 覆盖（验收注入 2）。
5. `tasks/cancel` → 杀子进程树 → `canceled`。
6. 每次状态变更原子写 `data/a2a_tasks.json`（tmp+rename，同 M1 store）；重启后终态任务仍可 `tasks/get` 查到，非终态任务置 `failed`（message=`SERVER_RESTARTED`）。
7. 不产生 `input-required` 状态（CLI 退出码探测不了「等输入」，§10）。

### 4.4 a2a-member.json（成员机配置）

```json
{
  "member": { "id": "qianqi", "name": "张伟" },
  "token": "Ab3xY9qLm2Vv8Kd0PwRt4nZj",
  "host": "0.0.0.0",
  "port": 7700,
  "agents": [
    { "id": "claude", "name": "Claude Code", "command": "claude", "commandTemplate": "claude \"{briefing}\"" },
    { "id": "goose", "name": "Goose", "command": "goose", "commandTemplate": "goose run \"{briefing}\"" }
  ],
  "presenceDir": "E:/ws/fde-presence"
}
```

校验（启动期，违反任一退出码 2）：`token` 匹配 `^[A-Za-z0-9_-]{24}$`；`agents[].id` 唯一且匹配 `^[a-z][a-z0-9-]{0,31}$`。token 生成：`node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"`。agents 结构与 M1 agents.json 同构。验收专用 agent（sleeper 等）定义在 `a2a-member.test.json`（不入库、不进生产配置），A2A-1 验收一律以 `--config a2a-member.test.json` 启动。

### 4.5 绑定声明

fde-a2a-server 默认绑 `0.0.0.0:7700`（host 可改 LAN IP）。理由：A2A 端点必须被业主指挥台跨 LAN 访问，127.0.0.1 将使派活不可达。缓解：全路由 Bearer token（24 字符 base64url，穷举不可行）+ 简报黑名单 + 成员机不存指挥台凭据。M3 收进 tunnel/hub 后 host 改回 `127.0.0.1`（本地转发），复跑 A2A-1 绑定校验。指挥台自身仍仅绑 127.0.0.1，不变。

## 5. 指挥台侧（M1 代码库增量）

### 5.1 新增 REST endpoint（Base 仍 `http://127.0.0.1:7788`，共 10 个）

- **`GET /api/a2a/members`** 请求：无（members.json ∪ presence 心跳 ∪ card 缓存聚合；token 不出现在响应）｜ 响应 200：`[{"id":"qianqi","name":"张伟","role":"后端","baseUrl":"http://192.168.1.23:7700","cardUrl":"http://192.168.1.23:7700/.well-known/agent-card.json","agents":["claude","goose"],"fresh":true,"lastHeartbeatAt":"2026-10-16T08:00:00Z","lastCardFetchAt":"2026-10-16T08:01:00Z","lastError":null}]`
- **`POST /api/a2a/tasks`** 请求：`{"taskId":"t-01","memberId":"qianqi","agentId":"claude","briefing":"实现 SSO 登录，参考 docs/auth.md"}` ｜ 响应 201：`{"id":"a2a-7f3a","fdeTaskId":"t-01","memberId":"qianqi","agentId":"claude","a2aTaskId":"tsk-01hw2q","messageId":"3d1fc2a6-9b4e-5d0f-8a71-2c95f0e4b7a1","state":"submitted","dispatchCount":1,"autoSync":true,"lastError":null,"createdAt":"2026-10-16T08:02:00Z","updatedAt":"2026-10-16T08:02:00Z"}`；错误：400 `MEMBER_NOT_FOUND`（不在 members.json）/ 400 `MEMBER_OFFLINE`（fresh=false）/ 400 `AGENT_NOT_ON_MEMBER`（agentId ∉ card.fdeAgents）/ 400 `BRIEFING_INVALID`（黑名单）/ 400 `HOST_NOT_ALLOWED`（三元组不在白名单，零出站）/ 400 `CARD_UNSUPPORTED`（card.protocolVersion ≠ "1.0"）/ 400 `MEMBER_AUTH_FAILED`（拉 card 得 401）/ 409 `A2A_TASK_EXISTS`（同 fdeTaskId+memberId+agentId 已有非终态记录，重派走 redispatch）
- **`GET /api/a2a/tasks?state=working&memberId=qianqi`**（两参数均可省略）｜ 响应 200：上式对象数组
- **`GET /api/a2a/tasks/:id`** 请求：无 ｜ 响应 200 单对象；404 `A2A_TASK_NOT_FOUND`
- **`POST /api/a2a/tasks/:id/sync`** 请求：无 ｜ 行为：立即 `tasks/get` 并按 §5.3 映射 ｜ 响应 200 更新后对象
- **`POST /api/a2a/tasks/:id/cancel`** 请求：无 ｜ 行为：`cancelTask` ｜ 响应 200 更新后对象（成员端已终态则原样返回并置 lastError=`ALREADY_TERMINAL`）
- **`POST /api/a2a/tasks/:id/redispatch`** 请求：无 ｜ 行为：dispatchCount+1 → 新 messageId → 重发 `message/send` ｜ 响应 200 更新后对象（a2aTaskId 替换为新值）
- **`GET /api/a2a/allowlist`** 请求：无 ｜ 响应 200：`[{"id":"e-1","scheme":"http","host":"192.168.1.23","port":7700}]`
- **`POST /api/a2a/allowlist`** 请求：`{"scheme":"http","host":"192.168.1.23","port":7700}` ｜ 响应 201 同对象；host ∈ {localhost,127.0.0.1,::1} 400 `HOST_FORBIDDEN`；scheme ∉ {http,https} 400 `SCHEME_INVALID`；重复三元组 409 `ENTRY_EXISTS`
- **`DELETE /api/a2a/allowlist/:id`** 请求：无 ｜ 响应 204（空体）；404 `ENTRY_NOT_FOUND`

设置面复用 M1：`GET/PATCH /api/settings` 增加 `a2a` 节（凭据类字段脱敏为前 4 字符+`****`）。

### 5.2 members.json / a2a_tasks 数据模型

**member**（`members.json`，项目根配置，人可手改，API 同步写回）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | `^[a-z][a-z0-9.-]{0,63}$`，与 presence 心跳文件名一致 |
| name / role | string | 展示用 |
| baseUrl | string | `http://<私网IP>:7700`，出站前过白名单三元组校验 |
| token | string | 24 字符 base64url，与成员机 a2a-member.json 同值；仅内存使用，`redact()` 过滤后不进日志 |

**a2aTask**（`data/a2a_tasks.json`）：`id`（`a2a-<4位随机>`）、`fdeTaskId`（关联 data/tasks.json）、`memberId`/`agentId`（string）、`a2aTaskId`（成员端 Task.id）、`messageId`（uuidv5，§8.3）、`state`（submitted/working/completed/failed/canceled/rejected/auth-required）、`dispatchCount`（int，从 1 起）、`autoSync`（boolean，默认 true）、`lastError`（string\|null）、`createdAt`/`updatedAt`（ISO8601 UTC）。

### 5.3 A2A state ↔ 看板列映射表（autoSync=true 时）

| A2A state | 看板动作 | 附加 |
|---|---|---|
| submitted | fdeTask 列 → `doing`（进行中） | — |
| working | 保持 `doing` | — |
| completed | fdeTask 列 → `review`（待验证） | artifact 文本以 `[a2a]` 前缀追加到 fdeTask.notes，截断至 ≤2000 字符 |
| failed | fdeTask 列 → `todo`（待分配） | notes 追加 `[a2a][failed] exit=N` |
| canceled | fdeTask 列 → `todo` | notes 追加 `[a2a][canceled]` |
| rejected | fdeTask 列 → `todo` | notes 追加 `[a2a][rejected]` |
| auth-required | fdeTask 列 → `review` | 任务卡 a2a 徽标置红（成员端 401） |

业主在看板手动改 fdeTask 列 → 该任务全部 a2aTask 记录置 `autoSync=false`，此后状态回流只更新 a2aTask.state 不动列。`completed` 不自动置 `done`，业主人工验收后手动挪 `done`。

### 5.4 派活时序

1. 业主成员页「派任务」→ 选成员/agent、填简报 → `POST /api/a2a/tasks`。
2. 校验（顺序即短路顺序）：members.json 命中 → fresh=true → 白名单三元组放行 → briefing 黑名单通过。
3. 全局单例 `ClientFactory` 注入 `createAuthenticatingFetchWithRetry` 的认证 fetch（AuthenticationHandler 按出站 host:port 查 members.json 返回 `Authorization: Bearer <token>`，覆盖含拉 card 在内的全部出站）；`createFromUrl(member.baseUrl)` 拉卡；card `protocolVersion !== "1.0"` → 400 `CARD_UNSUPPORTED`；HTTP 401 → 400 `MEMBER_AUTH_FAILED`。
4. `client.sendMessage`：messageId=uuidv5（§8.3）、parts=[text 简报]、metadata={agentId} → 返回 Task → 落 `data/a2a_tasks.json`，fdeTask 列 → `doing`。
5. 后台每 15s（`statePollSec`）对非终态 a2aTask 调 `tasks/get`，按 §5.3 映射回流；任务卡徽标显示 state。

## 6. presence 心跳与 card 目录

**fde-presence 仓库**（Gitea `example-org/fde-presence`，私有）：每成员一个文件 `presence/<memberId>.json`：

```json
{ "memberId": "qianqi", "cardUrl": "http://192.168.1.23:7700/.well-known/agent-card.json", "heartbeatAt": "2026-10-16T08:00:00Z", "v": 1 }
```

- 写入方：fde-a2a-server 心跳线程，启动参数 `--presence-dir` 指向本地克隆时启用；每 60s 更新 heartbeatAt 并 `git commit -m hb` + push（凭据走成员机 git extraheader，同 M1 机制）；连续失败 ≥5 次记本地日志，不影响任务执行；未给 `--presence-dir` → 心跳停用。
- 读取方：指挥台 presence.js 每 60s 经 Gitea API `/repos/example-org/fde-presence/contents/presence` 拉全部心跳文件（凭据同 M1 内存机制），与 members.json 按 id 合并（presence 有而 members.json 无的 id 仍列出，派活 400 `MEMBER_NOT_FOUND`）；`fresh = (now − heartbeatAt) ≤ 300s`。
- card 缓存：派活时必拉 + 每 300s 刷新已派活成员的 card；连续失败 3 次 → lastError=`CARD_FETCH_FAILED` 且 fresh 视为 false。
- config.json 增节：`"a2a": { "presence": { "repo": "example-org/fde-presence", "pollIntervalSec": 60, "freshSec": 300 }, "statePollSec": 15, "cardRefreshSec": 300 }`。

## 7. 网络模式对比与演进边界

| 维度 | LAN 直连（M2 交付态） | cloudflared tunnel（M3 选项） | VPS hub 中转（M3 目标态） |
|---|---|---|---|
| 成员端暴露 | 0.0.0.0:7700，LAN 可达 | cloudflared 出站隧道，无公网监听 | 仅出站连 hub，零监听 |
| 指挥台出站目标 | `http://<私网IP>:7700` | `https://<member>.<域>` | `https://hub.<域>` |
| 传输安全 | 明文 HTTP，LAN 边界 + Bearer token | TLS 终止于 Cloudflare 边缘 | TLS 全程 |
| 每成员额外依赖 | 无 | cloudflared 二进制 + 隧道 | 无（hub 客户端内置 M3 版 fde-a2a-server） |
| 凭据 | members.json Bearer token | 同左（可叠加 Cloudflare Access） | hub 签发 token（M3 规格） |
| 白名单条目示例 | `{http,192.168.1.23,7700}` | `{https,member.example.com,443}` | `{https,hub.example.com,443}` |
| 适用 | 同办公室/家庭 LAN | 跨网但无中心收口 | 指挥台公网上云后的最终形态 |

演进边界：① M2 验收以 LAN 直连为准；切 tunnel/hub 仅改 members.json baseUrl 与白名单条目，方法与状态机零改动。② 切换后 fde-a2a-server host 改 `127.0.0.1`，复跑 A2A-1 绑定校验。③ hub 成员发现、token 签发与审计归 M3 新规格 docs/SPEC-CLOUD.md，本规格不含。

## 8. 安全

**8.1 每成员 token**：24 字符 base64url（生成命令见 §4.4）；members.json 与成员机 a2a-member.json 同值；全路由（card/JSON-RPC/SSE/health）经 Express Bearer 中间件，缺失或不匹配 → HTTP 401；token 经 M1 `redact()`（redactKeys 增补 `Authorization`）过滤，零进日志、零进子进程环境变量。

**8.2 SSE 断线重连**：`message/stream` 的 SSE 流声明 `retry: 5000`（毫秒）；每事件带递增 `id:`（从 1 起）；服务端为每任务维护最近 256 条事件环形缓冲，收到 `Last-Event-ID: <n>` 重放 seq>n 的事件；缓冲不足（<n）→ 先重发当前 Task 全量快照再续流。客户端侧由 SDK `sendMessageStream`（AsyncGenerator）与认证 fetch 重试承接。

**8.3 task 幂等（taskId 去重）**：`messageId = uuidv5(命名空间 fde0a2a1-7b5c-4d3e-9f2a-110000000001, "<fdeTaskId>:<dispatchCount>")`（自实现 uuidv5，Node 内置 crypto SHA-1 约 20 行，不引 uuid 包）。网络超时重试重发同 messageId；CliSpawnExecutor 收到同 messageId 且任务非终态（submitted/working）→ 直接返回既有 Task，不重复 spawn；已终态 → 返回既有 Task；仅 `POST /api/a2a/tasks/:id/redispatch` 使 dispatchCount+1 → 新 messageId → 允许新 spawn。

**8.4 SSRF 白名单扩展论证**：白名单从「仅域名」扩展为显式条目数组 `[{"scheme","host","port"}]`，三元组精确匹配（host 不分大小写，无通配符、无后缀匹配），可含 RFC1918 私网地址（10.0.0.0/8、172.16.0.0/12、192.168.0.0/16）；继续硬禁 `localhost`/`127.0.0.1`/`::1`/`169.254.0.0-169.254.255.255`（云元数据服务）；出站 `redirect:"manual"`，3xx → 400 `REDIRECT_FORBIDDEN`，不跟随。M1 的 Gitea 域名白名单迁移为初始条目 `{"scheme":"https","host":"gitea.example.com","port":443}`，配置向后兼容。单用户工具可接受的理由：白名单唯一写入口是业主本人（设置页 POST 或配置文件手改），不存在低权限用户诱导出站的注入面；逐条显式添加使每条私网放行都是一次有记录的业主决策；指挥台自身回环仍禁，防借出站回打本机 API；与 M1 的差别只是把「域名信任」扩为「域名或私网地址的显式信任」，校验强度（精确匹配 + 白名单外零出站）不变。

**8.5 绑定**：指挥台仍仅绑 127.0.0.1 + Host 头校验（M1 §5-④ 原样）；fde-a2a-server 绑 0.0.0.0 的理由与缓解见 §4.5。

## 9. 任务拆解（契约 = 本文 §2–§8；A2A-1 独立仓库，A2A-2/3 在 M1 指挥台仓库）

**A2A-1 fde-a2a-server**（成员机适配器）。完成标准：§4 全量——card、4 个 JSON-RPC 方法、Bearer 全路由、§4.3 七条生命周期、幂等、落盘、SSE retry/重放、心跳。
```bash
cd fde-a2a-server
node -e "const p=require('./package.json');const d=p.dependencies||{};process.exit(d['@a2a-js/sdk']&&d['@a2a-js/sdk'].startsWith('^1')?0:1)" && echo A1-SDK-LOCK-OK
node --test test/   # 覆盖：无 token→401；同 messageId 连发两次仅 spawn 1 次（进程计数断言）；退出码 0/非0/ENOENT→completed(artifact≤2KB)/failed(exit=N)/failed(AGENT_NOT_FOUND)；--timeout-secs 2 验证超时；Last-Event-ID 重放；退出码必须 0
node server.js --config a2a-member.test.json & sleep 1
T=$(node -e "console.log(require('./a2a-member.test.json').token)")
curl -s -H "Authorization: Bearer $T" http://127.0.0.1:7700/.well-known/agent-card.json | grep -q '"protocolVersion":"1.0"' && echo A1-CARD-OK
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7700/.well-known/agent-card.json   # 无 token 期望 401
curl -s -N -X POST http://127.0.0.1:7700/ -H "Authorization: Bearer $T" -H "Content-Type: application/json" -H "Accept: text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"message/stream","params":{"message":{"role":"user","messageId":"sse-1","parts":[{"kind":"text","text":"hi"}],"metadata":{"agentId":"sleeper"}}}}' | grep -q 'retry: 5000' && echo A1-SSE-RETRY-OK
netstat -ano | grep ":7700" | grep -q "0.0.0.0" && echo A1-BIND-OK
```
心跳验收（`--presence-dir` 启用时）：`cd <presence克隆> && git pull --ff-only && node -e "const p=require('./presence/qianqi.json');if(Date.now()-Date.parse(p.heartbeatAt)>120000)process.exit(1);console.log('A1-HEARTBEAT-OK')"`（心跳龄 ≤120s）。

**A2A-2 指挥台 A2A client + 派活 UI**。完成标准：§5 全量——10 个 a2a endpoint、members 页「派任务」表单（成员下拉仅列 fresh 成员、agent 下拉取 card.fdeAgents、简报框）、任务卡 a2a 徽标（auth-required 红标）、15s 轮询与映射表自动挪列、手动挪列 autoSync=false。
```bash
node -e "const p=require('./package.json');const d=p.dependencies||{};if(!d['@a2a-js/sdk']||Object.keys(d).length>1)process.exit(1);console.log('A2-DEPS-OK')"   # 唯一依赖 = @a2a-js/sdk
node --test test/a2a.test.js   # 覆盖：白名单外派活→400 且注入假 fetch 调用计数为 0（零出站）；401→state=auth-required；§5.3 七态映射各一断言；手动挪列→autoSync=false；同 (fdeTaskId,memberId,agentId) 重复派活→409；退出码 0
A2A_FIXTURE=test/fixtures/a2a.json node server.js & sleep 1   # fixture 注入 members 名册与 card/tasks 响应，替代真实网络
curl -s -X POST http://127.0.0.1:7788/api/a2a/allowlist -d '{"scheme":"http","host":"192.168.1.23","port":7700}' > /dev/null
curl -s -X POST http://127.0.0.1:7788/api/a2a/tasks -d '{"taskId":"t-01","memberId":"qianqi","agentId":"claude","briefing":"smoke test"}' | grep -q '"state":"submitted"' && echo A2-DISPATCH-OK
curl -s http://127.0.0.1:7788/api/tasks/t-01 | grep -q '"status":"doing"' && echo A2-COLUMN-OK
curl -s -X POST http://127.0.0.1:7788/api/a2a/tasks -d '{"taskId":"t-02","memberId":"outsider","agentId":"claude","briefing":"x"}' | grep -q HOST_NOT_ALLOWED && echo A2-SSRF-OK
grep -q '/api/a2a/tasks' web/js/views/members.js && grep -q '/api/a2a/members' web/js/views/members.js && echo A2-UI-OK
```

**A2A-3 presence cardUrl 目录**。完成标准：§6 全量——60s 轮询 fde-presence、/api/a2a/members 聚合视图（cardUrl/fresh/lastHeartbeatAt/lastError）、freshSec=300 判定、card 缓存与失败 3 次标记、members 页目录表（成员/角色/心跳龄/fresh 徽标/agents）。
```bash
node --test test/presence.test.js   # 覆盖：心跳龄 301s→fresh:false；fresh:false 派活→400 MEMBER_OFFLINE；card 连续 3 次失败→lastError=CARD_FETCH_FAILED 且 fresh:false；退出码 0
PRESENCE_FIXTURE=test/fixtures/presence.json node server.js & sleep 1
curl -s http://127.0.0.1:7788/api/a2a/members | grep -q '"cardUrl":"http://192.168.1.23:7700/.well-known/agent-card.json"' && echo A3-DIR-OK
curl -s http://127.0.0.1:7788/api/a2a/members | grep -q '"fresh":true' && echo A3-FRESH-OK
node -e "const c=require('./config.json');if(!c.a2a||c.a2a.presence.freshSec!==300||c.a2a.statePollSec!==15)process.exit(1);console.log('A3-CONFIG-OK')"
grep -q 'lastHeartbeatAt' web/js/views/members.js && echo A3-UI-OK
```

## 10. M2/M3 非目标

M2 明确不做：

- `input-required` 状态（CLI 退出码探测不了「等输入」，完成信号仅 completed/failed 二元）
- 指挥台消费 message/stream SSE（派活走 `message/send` + 15s `tasks/get` 轮询；SSE 由 A2A-1 实现并验收，消费留 M3）
- v0.3 方法名兼容（legacyCompat 层不开启）；Agent Card JWS 签名/JWKS；push notification webhook
- gRPC 传输（不安装 `@grpc/grpc-js`/`@bufbuild/protobuf`）
- 同 agent 并发队列与优先级（同 agentId 新任务直接再 spawn，无排队，上限交 OS）
- fde-a2a-server 多租户、审计日志、进程守护（崩溃由业主手动重启，落盘台账保证 `tasks/get` 可查）
- 跨成员任务编排（一次派活只到一个成员）

M3 明确不做（归 docs/SPEC-CLOUD.md）：cloudflared/VPS hub 部署细节、hub token 签发与审计、指挥台迁出 127.0.0.1、TLS 终止、LAN 直连形态长期共存（切 hub 后 LAN 端点收回）。
