# ATTRIBUTION.md — 任务归因协议（v1.0）

> 让 AI agent 的每一次提交、每一个会话，自动挂到它服务的任务上。
> FDE 指挥台的开源归因协议：三条约定 + 一个护栏，零基础设施，任何 git 仓库 + 任何 agent 可用。

## 为什么需要协议

AI agent 干完活，证据散落三处：git 提交、本地会话、聊天记录。人验收时逐个狩猎对号入座——
这是 AI 协作时代最贵的隐性成本。归因协议用**约定优于配置**解决它：agent 按约定留下痕迹，
指挥台自动把证据挂到任务，人只做验收。

## 三条约定

### 约定一：分支名 = `task/<任务id>`

agent 开工前从任务系统取任务 id，把工作分支命名为 `task/<任务id>`：

```bash
git checkout -b task/t-mvnlagld-vq7q
```

指挥台侧：任务详情「复制分支名」按钮一键复制约定名；分支上的提交经 branch 相等规则自动归因。

### 约定二：提交信息带 `[#任务id]`

不便于开分支的小改动，在 commit message 任意位置带上 `[#<任务id>]`：

```
git commit -m "fix: 修复导出编码 [#t-mvnlagld-vq7q]"
```

指挥台侧：标题含 `[#<id>]` 的提交自动归因（规则与分支同级）。

### 约定三：任务绑定项目目录

在指挥台把任务绑定到项目目录（任务详情 → 绑定项目）。绑定后：
- 该目录下的 agent 会话归属本任务（会话观测、派工词、归因建议全链生效）
- 会话可经「建议挂接」一键确认为验收证据

## 一个护栏：仓库必须匹配

**branch 名只在仓库内有意义。** 归因匹配（写侧自动挂接与读侧「匹配任务」提示共用同一规则）
在双方仓库已知且不同时一律不命中——全公司都叫 `main` 的分支不会互相污染。
任务填了 `repo`（如 `example-org/fde-console`）即启用护栏；不填则退化为不校验仓库的宽松口径。

## 归因规则总表（指挥台实现口径）

| 优先级 | 规则 | 命中条件 | 说明 |
|---|---|---|---|
| 0 | 仓库护栏 | activity.repo ≠ task.repo（双方已知） | 一票否决，先于一切规则 |
| a | branch 相等 | activity.branch === task.branch | 双方非空才参与 |
| b | 约定分支前缀 | activity.branch 以 `task/<任务id>` 开头 | 历史兼容：本地启动注入时代产物 |
| c | 提交标记 | activity.title 含 `[#<任务id>]` | commit message 任意位置 |

幂等保证：同一 url 只归因一次；重复轮询/全量重扫不产生重复成果。

## 给 agent 的片段（粘贴进你仓库的 AGENTS.md / CLAUDE.md）

```markdown
## 任务归因协议（FDE 指挥台）

- 接到任务先取任务 id（本仓库工作统一由 FDE 指挥台管理）
- 开工作分支：git checkout -b task/<任务id>
- 小改动不开分支时：commit message 任意位置带 [#<任务id>]
- 一次提交只服务一个任务；多任务拆多次提交
```

## 配套工具

- **commit-msg hook**（本仓 `scripts/hooks/commit-msg`）：提交信息为空时从当前分支名
  自动补 `[#<任务id>]`，装到你的仓库 `.git/hooks/` 即用
- **CI 校验**（规划中）：归因覆盖率检查——N 条提交里多少带任务标记

## 实现索引（指挥台侧，开源贡献者入口）

- 写侧自动归因：`lib/attribute.js`（matchReason / repoMismatch）
- 读侧匹配提示：`lib/routes-gitea.js`（matchTaskIds）
- 会话→任务：任务详情「建议挂接」（`lib/sessionSuggest.js`）+ 手动挂接（artifacts session 形态）
- 第七源适配器：见 `docs/ADAPTERS.md`（规划中）
