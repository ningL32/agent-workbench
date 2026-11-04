# 验证手册：从克隆到「真跑通」

面向第一次拿到这个仓库的人（也包括替你干活的 AI 助手）。目的不是「看起来能开」，而是**每一步都有可断言的输出**——四档递进，任何一档不过就停下来查那一档。

全流程零外部服务：默认配置不发任何外部请求（Gitea / 钉钉 / 飞书都是按需开启，未配就是关闭态）。

前置：Node ≥ 22.13、`pnpm` 在 PATH、`dsh`（0.2.1-rc.2）在 PATH。

---

## 第 0 档 · 不装 DSH 也能自证

```bash
npm test
```

判据：末尾 `fail 0`（用例总数随版本增长，看 fail 而不是看总数）。

这一档证明：代码树完整、零第三方运行时依赖、所有夹具离线合成。

## 第 1 档 · 装进 profile

```bash
dsh plugin --profile oss add <本仓库路径>
```

判据两条：

1. 输出里有 `+ fde-console link:<路径>`；
2. profile 清单里出现它：

```bash
# Windows: type %USERPROFILE%\.dsh\profiles\oss\package.json
cat ~/.dsh/profiles/oss/package.json
```

`dsh.profile.bundles` 应包含 `fde-console`。

> **坑 1（必看）**：新 profile 只自带 `@deepseek-ai/dsh-base`，**不含 web 界面包**。
> 直接启动会看到 `fde-console: pending (waiting for service: webServer)`，端口不监听、浏览器打不开——
> 插件没问题，是宿主缺 `webServer` 服务。
>
> 补装时**必须与 dsh 版本对齐**：
>
> ```bash
> dsh plugin --profile oss add @deepseek-ai/dsh-web-app@0.2.1-rc.2   # 换成 dsh --version 的值
> ```
>
> 不写版本会解析到旧构建（如 `0.0.1-rc.1`），被宿主以
> `incompatible with dsh 0.2.1-rc.2` 直接拒绝。

## 第 2 档 · 起实例

```bash
dsh --profile oss --port 38082
```

判据——日志三行：

```
[fde-console] 首启生成默认配置：…\fde-console\config.json（webDir=…\web）
[fde-console] 装配完成：/fde-api + /fde 已注册，60s 轮询待命，data=…\fde-console\data
dsh web: http://127.0.0.1:38082/?token=<token>
```

`[poller] 轮询失败: fetch failed` **是正常的**：默认 `gitea.baseUrl=https://gitea.example.com`，
没配就不通，且失败必须留痕——这正是「单源失败不许静默」的设计，不是故障。

## 第 3 档 · 接口与写入闭环

认证门在 0.2.1 起生效：先打开一次 `http://127.0.0.1:38082/?token=<token>` 建立会话。
之后记住两条命名空间：

- `/fde-api/*` = 插件自己的 API（与内部 `/api/*` 同构重定基）
- `/api/*` = 宿主命名空间，插件数据不在这里

| 探针 | 期望 |
|---|---|
| `GET /fde-api/ping` | 200，`{"pong":true,"name":"fde-console","version":…,"engines":{…},"runtime":{…}}` |
| `GET /fde/index.html` | 200，SPA 外壳 |
| `GET /fde-api/overview` | 200，任务计数 + `gitea.ok`（未配为 `false`） |
| `GET /fde-api/members` | 200，桌面 agent 自动识别成成员 |
| `GET /fde-api/agent-sessions?agent=zcode` | 200，`items[]`（本机有该源会话时非空；只读观测） |
| `POST /fde-api/tasks`，体 `{"title":"验证任务","status":"todo"}` | 201 |
| 再 `GET /fde-api/tasks` | 数组含该标题；`overview.tasks.todo` 加 1 |

字段名是 `status`（写 `column` 会 400）。

落盘自检：`<DSH_HOME>/fde-console/` 下应出现 `config.json`、`agents.json`、`.instance.json`，
以及 `data/tasks.json`、`data/task_events.json`（未迁移 SQLite 时）。

## 第 4 档 · 界面

浏览器打开带 token 的 URL → 侧栏/主列出现 **Super Workbench** → 六个视图可切换 →
第 3 档 POST 的任务出现在看板上 → `Ctrl+K` 能搜到它。

---

## 隔离验证（不想动自己日常实例时）

`DSH_HOME` 决定数据落点。给它一个临时目录，整套验证就与自己那套完全隔离：

```powershell
$env:DSH_HOME = "$env:TEMP\fde-verify"
dsh plugin --profile oss add <本仓库路径>
dsh plugin --profile oss add @deepseek-ai/dsh-web-app@<dsh --version 的值>
dsh --profile oss --port 38099
```

```bash
export DSH_HOME=/tmp/fde-verify          # macOS / Linux 同理
```

数据全在 `$DSH_HOME/fde-console/`，用完删目录即可，不影响 `~/.dsh` 下的真实数据。

## 存储形态（容易误读的一点）

全新数据目录写的是 **JSON**（`data/*.json`），不是 SQLite。要切 SQLite + WAL：

```bash
# 先停掉所有实例——迁移器会探测 .instance.json，拒绝在运行状态下迁移
node scripts/migrate-storage.js --dry-run
node scripts/migrate-storage.js
```

迁移后运行态是 `data/fde.db`，原 JSON 改名归档。SQLite 的硬需求只来自会话观测
（`node:sqlite`），所以 Node ≥ 22.13 是不可降的门槛。

## 一句话判据

`npm test` 全绿 + `/fde-api/ping` 吐出带版本号的自述 + 能 POST 一条任务再读回 + 界面里看得到它。
四件事齐了，就是真跑通。
