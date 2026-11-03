> 中文文档 | [English](README.md)

# fde-console — 超级工作台（原 FDE 指挥台）

FDE 指挥台是装进 DSH 的个人工作台插件：任务看板（时间轴/验收人/深链/优先级/截止）、
任务雷达（钉钉听记/飞书妙记 → AI 拆解 → 收件箱闸门）、成员进度（桌面 agent + 人类 + 日报）、
智能体动态（四源工作观测 + 会话阅读器 + 项目分组）、团队动态（Gitea 归因）。
零 npm 运行时依赖；lib/ 业务层为 CJS，经 `createRequire` 桥接进插件 ESM 入口 `plugin/index.mjs`。

当前版本 v2.9.68（数字员工日报/周报 + 项目绑定与过滤 + 观测开关/备份 + 雷达纪要删除/收件箱分组折叠/合并入库 + 拆解粒度提示词收敛 + 数据源五源（zcode 改库读/codex 升面板源/GitHub+Gitee 接入）+ 任务成果展示提交说明 + 拓扑收敛树视图/commit 分组/面板限高 + 源设置页可配/可测试连接 + 任务详情派工词 + 工作搜索 Ctrl+K + 会话归因建议 + 归因仓库护栏 + Agent 活跃热力图 + 报告 Markdown 导出 + 归因协议 ATTRIBUTION.md + 新手引导 + Agent 上下文注入 + Scorecard SVG 传播卡 + Webhook 事件出口 + MCP Server + 任务复盘 + 粘贴转写 + 插件规范对齐（locale 展示元数据/客户端资源纪律）+ 主导航入口（与「插件/自动化任务」并排，点开占中间主列；页脚按钮与浮层已移除）+ 总览「版本与兼容性」矩阵（版本/引擎/兼容徽标，数据源=package.json；页面最末、默认折叠）+ 待办提醒（顶栏铃铛计数 + 侧栏图标红点，逾期/待验收/收件箱）+ IM 通知（飞书/钉钉群机器人：待验收/已完成事件 + 每日待办摘要，零新依赖）+ 数据备份（手动脚本 + 接口，恢复前自动拍快照；自动档默认关，按需开启）+ 单实例登记（多实例共用 data/ 时顶栏告警）+ 知识库学习模式（只读 vault；先测→费曼→五问→迁移 + 遗忘曲线调度；设置里配置后才出现「学习」）+ 存储迁移批次 1+2（全部自有数据单元迁 SQLite·WAL，store API 零变；已真机切换，运行态=data/fde.db，回退=删 db 改名 *.migrated 归档重启）+ 会话列表挂接按绑定态分流（绑定作用域一键「设为证据」+横幅批量）+ 成员进度人类 tab 隐藏会话列 + 开源准备（LICENSE(MIT)/英文 README）+ 文档即断言测试（test/docs-sync.test.js，版本口径/files 白名单/locale/API 契约/互链/计数六组守卫）。**AI 助手进仓必读 AGENTS.md**（架构红线/配置契约纪律/工程坑清单）。规格文档：docs/SPEC.md（功能契约）、docs/ATTRIBUTION.md（开源归因协议，附 AGENTS.md 片段模板与 commit-msg hook）、docs/ADAPTERS.md（会话源适配器协议——社区第七源开发指南）、scripts/mcp-server.mjs（MCP Server：任务/搜索/agent 状态接入任意 agent）、scripts/write-agent-context.js（数字员工互知：.fde/daily.md 注入）。
规格文档：docs/SPEC.md（功能契约）、SPEC-PLUGIN.md（DSH 插件化，第七章=官方规范对齐审计）、
docs/SPEC-STORAGE.md（自有数据 SQLite 迁移设计——红线 3 修订后的实施方案，已实施并真机切换）、
SPEC-UX-v2.1.md（体验规范）、SPEC-READER-v2.3.md（会话阅读器）、PLUGIN-COMPLIANCE.md（合规审查）、DISTRIBUTION.md（分发安装手册）。

## 启动方式

### 插件态（当前唯一维护形态）

前置：DSH 0.2.1-rc.2（`@deepseek-ai/dsh`）已安装且在 PATH；pnpm 在 PATH（插件安装走 pnpm 转发）。

```bash
# 1. 安装/更新插件到 profile（首次调用自动 init profile + pnpm link + 回写 dsh.profile.bundles）
dsh plugin --profile fde-dev add <本仓库绝对路径>

# 2. 启动（注意：没有 `dsh --profile fde-dev web` 这种用法——web 是 bin 层硬编码的别名
#    profile，不能与 --profile 组合；自定义 profile 起 web 面的正确形态是直接带 --port，
#    由 web-startup 解析，且 profile 的 dsh.profile.bundles 需含 @deepseek-ai/dsh-web-app）
dsh --profile fde-dev [--port N]
```

- 界面：`http://127.0.0.1:<port>/fde/index.html`（SPA 经 iframe overlay 嵌入 DSH shell）；API 前缀 `/fde-api/*`
- 0.2.1 起有认证门：**用启动日志打印的带 token URL 打开**（裸地址白屏是正常防御）
- 冒烟三连：`GET /fde-api/ping` → `{"pong":true,...}`；`GET /fde/index.html` → 200；伪造 Host 打 `/fde-api/*` → 403（Host 防线自持，不依赖宿主 fence）
- 数据落点：`<DSH_HOME|~/.dsh>/fde-console/`；config.json 无 port/host 键（监听参数由宿主 `--port` 承担）
- 旧版数据迁移：`node scripts/migrate-data.js [--source <旧目录>] [--base <目标base>] [--dry-run]`
  （拷 data/ 子树与 agents/members 名册；config 三方合并，剥 port/host、dataDir/webDir 重写为 base 下绝对路径、剥遗留 gateway 节；幂等可重跑）

### 独立版（v1.9.0 tag 存档，不再维护）

历史形态为独立 Node 服务：`node server.js [--config <path>]`（默认 127.0.0.1:7788）。
server.js 已自 main 删除，该形态**仅以 `v1.9.0` tag 存档，不再维护**；如需回退，见 docs/SPEC-PLUGIN.md 2.6 回退预案（`git checkout v1.9.0 -- server.js` 等）。

## 七视图导览

| 视图 | 侧栏序 | 一句话 |
|---|---|---|
| 总览 | 1 | 统计卡 + 数字员工报告（日报/周报）+ 任务拓扑 |
| 任务雷达 | 2 | 钉钉听记/飞书妙记同步 → AI 拆解 → 收件箱闸门（候选确认后入看板） |
| 任务看板 | 3 | 任务看板（时间轴/验收人/深链/优先级/截止/日报/项目过滤） |
| 智能体 | 4 | 智能体动态（六源工作观测）+ 项目分组 + 会话阅读器 |
| 成员进度 | 5 | 桌面 agent + 人类成员的状态/产出/日报标记 |
| 团队动态 | 6 | 多源活动流：Gitea 组织 + GitHub org events（可选）；actor 头像/提交分组/bot 静音/归属任务 |
| 设置 | 7 | Gitea/雷达/引擎/安全白名单 + 一键体检 |

## 数据源接入

| 源 | 状态 | 数据落点 | 凭据（零落盘，git config 运行时读取） |
|---|---|---|---|
| Gitea 组织 feeds | 默认启用 | `data/activities.json` + `data/gitea-status.json` | `git config --global http.https://gitea.example.com/.extraheader "Authorization: Basic xxx"` |
| GitHub org events | 默认关闭 | 同一 `activities.json` + 独立 `data/github-status.json` | `git config --global http.https://api.github.com/.extraheader "Authorization: Bearer ghp_xxx"` |
| Gitee org events（v2.9.18） | 默认关闭 | 同一 `activities.json` + 独立 `data/gitee-status.json` | `git config --global http.https://gitee.com/.extraheader "<私人令牌>"`（公开组织匿名可拉，私库才需要） |

启用 GitHub（v2.9.17 起设置页可配）：「设置 → GitHub 动态源」卡片——开启用开关（启用时组织名必填）、填组织名、保存即热生效（随下个轮询周期，无需重启）。私库先配令牌（页面有命令模板可复制）：`git config --global http.https://api.github.com/.extraheader "Authorization: Bearer <PAT>"`（细粒度 PAT 需目标仓库 Contents: Read；公共组织匿名可拉，限流 60 次/时/IP）。备用口径：手改 config.json 的 `github` 节后重启。自建 GitHub Enterprise：先手改 config.json 的 `github.hostWhitelist` 加 host，再在页面改 API 地址。两源独立容错：单源失败不拖垮另一源，各自 status 文件留痕；动态页来源标示自动变为「Gitea · GitHub（org）」。

多源说明：三源映射到同一套活动词表（commit/pr/branch_created/branch_deleted）与同一 `activities.json`，归因/日报预填/总览统计自动吃到 GitHub/Gitee 数据；成员册条目用 `githubLogin`/`giteeLogin` 字段认领对应平台 actor（与 giteaLogin 同规格，≤50 字符）。Gitee 源设置页可配（v2.9.18，「设置 → Gitee 动态源」，保存热生效）；令牌无效时源状态 ok:false 但不拖垮其他源。

成员册口径（v2.9.1 起）：人类成员 = 手工名册 ∪ Gitea 组织接口缓存；**动态流 actor 不再自动入册**（团队动态页仍照常显示未登记账号）。管理员/机器人类组织账号用 `gitea.ignoreLogins` 排除（默认 `["admin"]`，config.json 手改，大小写不敏感，自定义名单整体替换默认）。

## 演示数据集

想在连接任何数据源之前就看到非空的驾驶舱？灌一份全合成演示数据（成员/任务/纪要/收件箱候选/团队动态——纯占位名，零出网）：

```bash
node scripts/seed-demo.js                           # 灌缺省数据目录（~/.dsh/fde-console/data）
node scripts/seed-demo.js --data-dir <目录> --force  # 自定义目录 / 覆盖
```

灌完启动实例即可查看；删掉被灌的 JSON 文件即还原。注意：脚本走 JSON 存储通道，面向**未迁移**的数据目录——目标目录已迁 SQLite（存在 fde.db）时脚本会拒绝并提示换新目录。

## 测试

```bash
npm test        # = node --test test/*.test.js，300+ 用例（计数随迭代增长，以实际运行为准）
```
