# fde-console 插件官方规范合规报告（PLUGIN-COMPLIANCE）

- 日期：2026-10-20。审查对象：本仓 DSH 插件（plugin/*、cordis.patch.yml、package.json）。
- 本地基准：`@deepseek-ai/dsh` **rc.7**（源码实证见 docs/SPEC-PLUGIN.md）；官方 master 文档为当日 HEAD，两者偏差见第四节。
- 标注纪律：【推断】= 证据 + 工程判断，未实测；其余为事实（官方原文摘录或本地行号实证）。

## 一、官方文档抓取记录（2026-10-20，经 github.com blob 页）

| 文档 | 结果 | 与插件规范的相关度 |
|---|---|---|
| docs/development.zh.md | 可达 | 低：通用开发指南（构建/TS/CI）。仅确认「普通 Client 插件在 Client 阶段同时生成 Node loader 与 browser bundle」及 api-remotes/@Remote 机制；**无**第三方插件清单/命名/注入规范 |
| docs/architecture.zh.md | 可达 | **核心**：Cordis 插件模型、profile/组合包（bundle）机制、`dsh.bundle`/`dsh.profile` 字段、patch 按 id 操作、内置 bundle 名 |
| AGENTS.md | 可达 | 高（仓库内部纪律）：注册即 effect、i18n 门禁、100% 覆盖率、ESM、配置显式化、文件尾换行等 |
| SAFETY.zh.md | 可达 | 低：面向**用户**的风险声明，无插件开发者专项技术条款；「加载第三方插件」列为风险源 |
| README.md（补充） | 可达 | 分发方式唯一官方线索："Add the dsh-plugin topic to your plugin repository for discoverability." |
| 官方文档站 deepseek-harness.github.io/deepseek-harness/ | 首页仅一行标题（疑似 JS 渲染空壳），未取得插件专页 | 如实记录：不可用 |

注：英文版（去 .zh）未逐一抓取——两份 zh 版已明确「不含插件专项规范」，【推断】英文版同构；如需可补抓。

## 二、合规清单

| # | 维度 | 结论 | 官方证据（摘录 ≤5 行） | 我方证据 |
|---|---|---|---|---|
| 1 | bundle 清单格式 | 【符合】 | architecture.zh.md：「都在各自的 package.json 中通过 dsh 字段声明自己：dsh.profile 列出一个 profile 的组合包，dsh.bundle 指向一个组合包的 patch 文件。」 | package.json L15-18 `"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}`；与 rc.7 源码 dsh-app-boot L289-295（SPEC-PLUGIN 1.1）一致 |
| 2 | patch 语义（insert） | 【符合】 | architecture.zh.md：「一条 patch 按 id 定位某个条目并替换其整个 config，或插入新条目。」 | cordis.patch.yml L5-7 单行 insert `- id: fde-console, name: fde-console`，不做 config 替换 |
| 3 | 插件命名 / id | 【官方未提及】 | architecture.zh.md 无第三方命名规范，仅列内置 bundle 名（dsh-base、dsh-web-app 等）；约束止于「patch 按 id 定位」 | id=fde-console 与包名一致；合成树内 id 唯一性约束已在 cordis.patch.yml L2-4 自注（与 spike 包互斥）；client 注册 id=包名（client.js L19，rc.7 dsh-client-modules 校验，SPEC 2.3-P8） |
| 4 | 宿主服务注入与用法 | 【符合（rc.7 实证）；master 文档未覆盖第三方注入面】 | AGENTS.md：「every contribution goes through ctx.effect() / ctx.on(); a registry's register() returns the disposer.」 | index.mjs L24 `inject=['webServer','timer']`；L62-69 register 返回值收 disposers；L71 `ctx.on('dispose')`；client.js L158-176 `ctx.effect(fn, label)` 带标签注册 |
| 5 | timer / ctx.interval | 【官方未提及，rc.7 实证】 | master 四份文档均未出现 timer/interval 注入规范（architecture.zh.md 仅列 ctx.sessions/tools/llm/fs/sandbox/jobs 等核心键） | index.mjs L68 `ctx.interval(cb, 60_000)`；参数序 callback 在前经 WP1 实测（SPEC 1.4/P1） |
| 6 | 客户端 bundle（dsh.client/__ModuleLoader__） | 【官方文档未覆盖；rc.7 实证可用】 | development.zh.md 仅有构建管线描述：「普通 Client 插件在 Client 阶段同时生成 Node loader 与 browser bundle」，未定义第三方包的 dsh.client 字段 | package.json L19-27 `dsh.client={platform:"web",inject:["react"]}` + exports["./client"]；client.js L21 `window.__ModuleLoader__.load({id,factory})`；WP1/CDP 实测链路全通（SPEC 附录 C） |
| 7 | 客户端 UI 文案 i18n | 【不符合（仅上游化进官方仓时）；第三方分发无此门禁】 | AGENTS.md：「客户端 UI 文案归 locale 管，硬编码文案会被 verify-client-ui-i18n 拒绝」 | client.js L105/L137/L141/L143 硬编码中文（「FDE 指挥台」「关闭（Esc）」等） |
| 8 | 安全 posture | 【符合 SAFETY 精神；官方无硬性开发者条款】 | SAFETY.zh.md：「不可信插件可能损坏宿主计算机…泄露数据或凭据」；「在允许运行前检查插件、配置和拟执行命令」（用户侧建议） | SPEC 2.5：SSRF 三元组/凭据零落盘/redact 全保留；adapter.js Host 防线自持（P4 实测宿主 fence 不护第三方路由）；static.js L32-36 CSP/nosniff/SAMEORIGIN |
| 9 | 子进程生命周期 | 【需披露】 | SAFETY.zh.md 精神：插件行为应在用户启用前可审查、可预期 | SPEC P5 实测：detached 子进程在 DSH 强杀后存活（孤儿），launcher 恢复扫描兜底——属「超出宿主生命周期」的插件行为，分发时应向使用者披露 |
| 10 | 覆盖率门禁 | 【不适用；上游化需补】 | AGENTS.md：「pnpm run test:coverage # CI coverage gate: per-file 100% on packages/*/*/src」 | 本仓 239 测试全绿（SPEC v1.2）但无 per-file 100% 门禁 |
| 11 | ESM 纪律 | 【偏差；第三方包不受官方 workspace 约束】 | AGENTS.md：全部 `"type": "module"`、跨包包名导入 | 根 package.json 不设 type（index.mjs L5-6：type:module 会误判 lib/ CJS），ESM 入口 .mjs + createRequire 桥接 |
| 12 | 可配置化（禁硬编码可调参数） | 【部分不符合】 | AGENTS.md：「禁止插件内硬编码可调参数，部署相关选择须为可配置的 Config 字段」 | dataDir/webDir/trustedHosts 已入 config.json；唯轮询间隔 60s 硬编码（index.mjs L68） |
| 13 | 分发方式 | 【不符合（当前形态）】 | README.md：「Add the dsh-plugin topic to your plugin repository for discoverability.」 | package.json L4 `"private": true`；安装走 `dsh plugin --profile <name> add <路径>`（rc.7 实测，SPEC 1.1）；分发形态（git 私仓 vs file:）业主未拍板（SPEC 2.10-4） |
| 14 | 文件尾恰一个换行 | 【符合】 | AGENTS.md：「文件以恰好一个换行结尾（pre-commit 用 git diff --cached --check 门禁）」 | 抽检 6 文件 od 直读末字节均为 `\n` |
| 15 | 无 bin 逃逸 | 【符合】 | AGENTS.md：「Only dsh profiles launch supported Node apps; package bins, demos, and public SDK argv escapes are forbidden.」 | package.json 无 bin 字段，唯一启动形态为挂宿主 profile |
| 16 | 配置错误大声失败 | 【符合】 | AGENTS.md：「配置错误须在加载时大声失败…绝不静默跳过缺失引用」 | 宿主重复路由抛错、缺 client 产物 MissingClientBundleError 即 FAILED（rc.7 实证）；运行期统一 500（adapter.js L48-64）是兜底非静默，错误文本过 redact |

## 三、偏差与建议动作

必须改（公开发布/上游化前）：
1. 去除 `"private": true`，仓库加 GitHub topic `dsh-plugin`，README 补安装前置（pnpm on PATH、git 来源需 allowBuilds——素材已在 SPEC 1.1/2.8）。
2. 轮询间隔入 config（对齐 AGENTS.md 可配置化条款），默认 60_000 不变。
3. 若目标含进官方仓库：客户端文案迁 locale（i18n 门禁是硬拒绝）；若仅社区分发则降级为「建议改」。

建议改：
4. 分发文档披露 P5 孤儿子进程行为与 launcher 兜底（SAFETY 视角的可审查性）。
5. 补 per-file 覆盖率门禁（上游化前置；社区分发可暂缓）。
6. id 命名空间：`fde-console` 无 registry 强校验，与其他社区包撞名风险存在但无实据——【推断】，发布前在 dsh-plugin topic 内自检同名。

可不动：
7. bundle 清单/patch 格式、webServer/timer 用法、dsh.client 客户端机制——rc.7 实证且与 master 文档无冲突。
8. CJS 桥接与根包不设 type——官方 ESM 纪律仅约束其 monorepo 内部包。

## 四、版本偏差（rc.7 vs master）

- 【已证·无冲突】bundle/profile/patch 机制：master architecture.zh.md 的定义与 rc.7 源码（dsh-app-boot L289-295）逐点一致。
- 【文档缺口，非已证冲突】dsh.client / `__ModuleLoader__` / webServer / timer 注入面：master 公开文档完全未定义第三方插件的这层 API；其可用性由 rc.7 源码与 WP1 运行态实测背书（SPEC 附录 C）。升级 rc.8+ 前须重跑 WP1 spike（SPEC 2.8 已列为风险 R-1）。
- 【未验证】development.zh.md 的 api-remotes/@Remote/hostPhase 机制在 rc.7 是否存在（我方未使用该机制，暂不影响合规）。
- 【未验证】AGENTS.md 为 master HEAD 文件，rc.7 安装树内是否有对应版本未比对；本报告按「上游化目标以 master 为准」使用。
- 【未验证】npm 上 dsh 最新发行版号（本机仅装 rc.7，未查 registry）。

## 五、事实与推断边界

- 事实：第一、二节全部摘录与行号；第 9、16 条的 rc.7 运行态实测（SPEC 附录 C P1-P8）。
- 推断（已标注）：英文版文档同构；文档缺口在 rc.8 可能收敛或恶化（R-S4：bundle 一律沙箱化的可能性，SPEC 2.5）；id 撞名风险。
- 本报告不含任何未落盘证据的断言；官方原文引用以 2026-10-20 抓取为准，master 演进后需复审。
