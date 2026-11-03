# SPEC-PLUGIN：FDE 指挥台 DSH 插件化迁移规格

- 版本：v1.2（**WP1-6 全部完成态**：v1.0 完整落盘 → v1.1 探针回填 → v1.2 焊死收口——server.js 与 routes-gitea-stub.js 已删、port 退出 config.json/设置面、migrate-data 补 gateway.logDir 绝对路径重写；全量 239 测试绿）
  - **v2.9.36 增注（2026-10-31）**：**入口收敛，覆盖层退役**——`sidebar.footer.action` 页脚按钮与 `shell.overlay` 三态覆盖层（dock/float/full）整体删除，只留 `sidebar.panellist` + `main` 主列面板；相关状态机（overlayOpen/mode）、`applyDockLeft` DOM 量测、`fdec-mode` 持久化键与 8 个 overlay 文案键一并移除（client.js 485→211 行）。恢复路径：`git show v2.9.35:plugin/client.js`（分栏并排能力只在那个 tag 里）。
  - **v2.9.35 增注（2026-10-31）**：**主列面板必须单例 iframe 保活**——实测宿主切换主列会卸载 `main` 面板组件（无 keep-mounted），React 重建 iframe = 整页重载（现象：面板内切走再切回，跳回总览且滚到顶）。做法：`consoleFrame` 模块级单例，卸载时摘进游离容器 `consoleHolder`（`document.createElement('div')`，不进文档 → 浏览上下文不销毁），挂回时 `appendChild` 搬回面板；兜底 `sessionStorage['fdec-panel-hash']` 存最后 hash。**约束：不要把这个 iframe 写回 JSX**（一旦交给 React 渲染，卸载即重建）。
  - **v2.9.34 增注（2026-10-31）**：入口搬到**主导航排**——新增 `sidebar.panellist`（图标，收 `{size, active}`）+ `main`（keyed，key=`fde-console`）两处注册，点击后指挥台在**中间主列**整列打开（iframe 铺满，不再需要覆盖层条）；宿主契约：panellist 的 list id 必须等于 main 的 key，宿主自己画按钮、按 list 元数据取 label（传 thunk 可跟随语言切换），现有占用 `plugins`(0)/`schedules`(10)/`conversation`，本插件 order=20 紧随「自动化任务」。原 `sidebar.footer.action` + `shell.overlay` 三态覆盖层**保留为副入口**（dock 分栏能与会话并排看，主列面板做不到）；代价=两处各一个 SPA 实例，仅当用户同时开两种形态才并存。注册顺序=先 `main` 后 panellist（图标出现时面板必已在册）。
  - **v2.9.8 增注（2026-10-22）**：overlay 新增三态显示模式——分栏 dock（**默认**，右侧 ≤72%，不遮宿主侧栏与主界面）/浮窗 float（右下角窗体）/全屏 full（铺满，v2.9.8 前的唯一形态）；顶栏「分栏/浮窗/全屏」按钮切换，选择存 localStorage（fdec-mode）。Esc / ✕ 关闭语义不变（只隐藏不销毁 iframe）。**点外即熄**：面板开着时点击宿主任意位置（面板与开关之外）自动收起（pointerdown 捕获；iframe 内点击不冒泡到宿主文档，指挥台内操作不受影响）。
  - **v2.2 增注（2026-10-20）**：cli-gateway 集成已整体移除（业主判断该功能没用，焊死式删除）——lib/gateway.js、lib/routes-gateway.js、test/gateway*.test.js 已删；sessions launch 恒直连、session.gateway 字段与 GET /api/sessions/:id/log 端点已删；settings/GET+PATCH 与 config.json、DEFAULT_CONFIG 的 gateway 节已删；overview.gatewayExternalRunning 字段已删；setup/check 六项收敛为五项（cliGateway 项已删）；migrate-data 改为剥除遗留 gateway 节。本文其余 gateway 相关描述保留为 v1.2 历史记录，标注「v2.2 已移除」后不再约束实现。security.trustedHosts 不受影响（Host 防线仍需要）。
- 日期：2026-10-19（v1.1 同日回填 P1-P8；v1.2 同日 WP6 收口）
- 启动方式（实测定型）：插件态 `dsh --profile fde-dev [--port N]`（`web` 是 bin 层硬编码别名 profile，不可与 `--profile` 组合）；独立版 `node server.js` 已随 WP6 删除，仅 v1.9.0 tag 存档（见仓库 README「启动方式」）
- 业主决策：FDE 指挥台（独立 Node 应用）焊死为 DSH 持久化插件，删除独立 http 层；个人驾驶舱模型（A）——每人 DSH 里装自己的实例（自己的钉钉 dws / 自己的 Gitea 凭据 / 自己的任务数据），权限天然跟随身份，不做共享板/多用户；数据模型预留同步字段（只注明不实现）
- 硬约束：零 npm 依赖纪律延续；凭据零落盘；SSRF 白名单；redact 全保留
- 对象：dsh = `@deepseek-ai/dsh` rc.7，安装于 `C:\Users\<you>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\`
- 证据纪律：源码摘录（基准事实）与推断严格分离，推断标【推断】；找不到实证的列「实现期风险+探针方案」，禁止臆测

标注纪律：【证】=源码摘录（出处见附录 A）；【推】=证据+工程判断的推断，附置信度，实现期以探针复核（附录 B）。

## 0. 目标 / 非目标

- G1：指挥台以 DSH bundle 形态随宿主启动，独立 http 层（server.js 的监听/Host/静态职责）删除，移交宿主 webServer（启动形态实测修正：`dsh --profile <name> [--port N]`，`web` 为硬编码别名不可组合，见 1.1 实测）
- G2：逻辑层（lib/ 非 transport 模块）零改动；216 测试经 test 专用装配器全部存续
- G3：个人驾驶舱模型（A）：每人一份 DSH × 一份指挥台实例，权限跟随身份；数据模型预留同步字段（仅注释，不实现）
- G4：安全底线平移不降级：SSRF 三元组、凭据零落盘、redact 全保留
- G5：零 npm 依赖纪律延续（插件运行时仅 node 内建 + 宿主注入服务）
- 非目标：见 2.9

## 一、DSH rc.7 插件 API 预检（五项，每项给文件路径+关键摘录）

### 1.1 插件清单/加载机制 【证】

- 包形态：rc.7 是薄壳 CLI（`bin: lib/bin.js`，`type: module`，lib/ 仅 4 文件 620 行）；插件框架=`@deepseek-ai/cordis ^4.0.1` + `cordis-plugin-loader/hmr/include/timer`（附录 A-1）
- 插件 = **bundle**：npm 包在 package.json 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；profile=`$DSH_HOME/profiles/<name>/` 目录，内含 `package.json`（插件依赖 + `dsh.profile` 的有序 `bundles` 列表）与用户层 `cordis.patch.yml`；合成顺序 = bundles 按序打补丁 → profile 层 → launcher 层；两锚点解析（先 dsh 安装目录、后 profile 目录；`$DSH_HOME/profiles/node_modules` 平铺回退）：

```
dsh-app-boot/lib/index.js L289-295：
* A profile is a directory under `$DSH_HOME/profiles/<name>` holding a
* `package.json` ... and a `cordis.patch.yml` (the user's own patch layer ...)
* Bundles are npm packages whose manifest declares
* `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; the tree is
* composed by applying each bundle's patch list in `dsh.profile.bundles` order
```

- 安装：`dsh plugin --profile <name> add <pkg>` 转发 pnpm 到 profile 目录执行，成功后回写 `dsh.profile.bundles`；bundle 判定 = `readProfileManifest(...).dsh?.bundle?.patch !== void 0`；pnpm 必须在 PATH；git 来源插件需按提示在 `pnpm-workspace.yaml` 加 allowBuilds（附录 A-2）
- 【推·高置信】我们的插件包 = 自有 git/file 包：`package.json(dsh.bundle.patch)` + `cordis.patch.yml`（insert 一行 `- id: fde-console, name: <包名>`，样例对照 dsh-base/cordis.patch.yml L15-19 的 `- insert: - id: timer, name: '@deepseek-ai/cordis-plugin-timer'`）+ CJS 逻辑层经 `createRequire` 桥接
- 【实测】安装与启动（WP1，fde-dev profile）：`dsh plugin --profile fde-dev add <绝对路径>` 即通用安装路径——首次调用自动 init profile（bundles 默认 `["@deepseek-ai/dsh-base"]`），pnpm link 安装后自动 reconcile 回写 `dsh.profile.bundles`，退出码 0；file:/绝对路径包无需 allowBuilds。**in-box bundle（dsh-web-app）不能经 pnpm add**（不在 registry），手摆 profile `package.json` 的 bundles 列表即可——与模板机制（PROFILE_TEMPLATES）同一做法，两锚点解析 + `$DSH_HOME/profiles/node_modules` 平铺回退实证可用（junction 已含 dsh-web-app/dsh-host-webserver/dsh-base）。插件 ESM（`type:module` + 具名导出 name/inject/apply）经 loader `import(name)` 装载实证。
- 【实测】**启动形态坑**：`web` 是 bin 层硬编码别名（= `--profile web`，bin.js L89），**不能与 `--profile <其他>` 组合**（报 "web takes none of parent --profile"）。自定义 profile 起 web 面的正确形态：bundles 含 dsh-web-app，然后 `dsh --profile <name> [--port N]`（`--port` 作为 inner args 由 web-startup 解析）。

### 1.2 宿主注入服务 【证】

- webServer 服务（`@deepseek-ai/dsh-host-webserver`，cordis Service）：node:http 承载 + 命名路由表。`register(route)`：`{kind:"exact"|"prefix", path, handler}`，重复 (kind,path) 抛错，返回 disposer；`registerUpgrade(route)`（websocket）；启动期未注册路径回落 404；另有 index transform taps 与 fallback seat：

```
dsh-host-webserver/lib/index.js L48-58：
* Register a named route. Duplicate (kind, path) throws — route patterns are
register(route) {
  const table = route.kind === "exact" ? this.exact : this.prefixes;
  if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
  table.set(route.path, route);
```

监听即激活（activation listens immediately），监听失败拒绝初始化并上报失败 fiber（L15-19, L168-173）
- slots（`@deepseek-ai/dsh-client-ui-slots`）：SlotCore 管理声明/条目/renderSlot 绑定/影子与所有权错误（L39-179）；slot 键名在 UI 源码中出现：`shell.overlay`、`sidebar.footer.action`、`sidebar.settings`、`sidebar.workspaces`（附录 A-5）
- 【证】存在 `dsh-fs-local`、`dsh-session-*` 等服务包（node_modules 清单）；【推·中置信】宿主服务按 cordis 常规 `export const inject = [...]` 注入；「fs/agents/slots 在宿主侧的注入 id」未定位 → 探针 P2
- 【证】模型面插件跑在沙箱 runner：ctx 隐去框架内部件，仅暴露 `ctx.tools.register / ctx.on / ctx.provide / 注入服务`（附录 A-10）→【推·中置信】UI/宿主型插件（我们）经 bundle patch 直接装载、不适用该沙箱 → 探针 P3
- 【实测·P2/P3/P8 回填】（1）**bundle 无沙箱**：宿主侧 bundle 模块级 `createRequire(import.meta.url)('node:fs')` 直连成功（P3 答）；（2）**宿主注入面实测**：第三方 bundle 的 apply ctx 经 `ctx.get(id)` 可达 26 个服务 id：`webServer, timer, fs, agents, sessions, loader, dshHomePath, cmdlineArgs, webStartup, shellEnv, systemPrompt, cordisInspect, storageDomain, dynamicCordisRunner, appExit, llm, jobs, sessionQuery, sessionPersistence, storage, subprocess, sandbox, tools, shell, web, agentDefaultModel`——**fs 的注入 id 就是 `fs`、agents 就是 `agents`**；（3）`slots` 宿主侧**不存在**（纯客户端概念，见 2.3）；（4）`credentials/settings/workspace/locale/connection/theme/layout/clientModules` 等不可达（活在自己的子 ctx）；（5）cordis 属性访问守卫：`ctx.webServer` 这类**属性式访问必须先声明 `export const inject = ['webServer', ...]`**，否则启动即炸（"cannot get property without inject"）——`ctx.get()` 不受此限。

### 1.3 DSH web 访问模型 【证】

- 启动：`dsh --profile web`（"Serve the DeepSeek Harness browser UI"），选项 `--host`、`--port`（0=OS 分配）、`--trusted-host <authority...>`（"extra authority the /api browser-trust fence accepts"，可重复）（附录 A-7）
- 绑定面在 schema 层收窄：`host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required()`（附录 A-4 L24-25）
- 认证：无登录态证据；取而代之是 **/api browser-trust fence**：trustedHosts = LAN IPv4 字面量（绑 0.0.0.0 时）+ `--trusted-host`；防 DNS rebinding 的注释原文："DNS rebinding needs an attacker-controlled name, while an IP-literal Host is safe on any port"（附录 A-7 L37-52）；canonical URL 固定 `http://127.0.0.1:<port>`（L58-62）；fence 执行点未定位 → 探针 P4
- **去留决策**：独立版「仅绑回环 + Host 头校验」在插件态拆解——绑定交还宿主 schema；Host 头校验不删、收编进适配层继续看护自有路由（理由：DSH fence 只护它自己的 /api；若绑 0.0.0.0，LAN 可达我们路由，防线必须自持）。详见 2.5。
- 【实测·P4 回填】（1）CLI 层 `--host 0.0.0.0` 被 web-startup **硬拒**（"intentionally not supported yet for safety"，startup.js apply）；schema 层仍收 0.0.0.0——**经 profile 用户层 cordis.patch.yml 覆盖 webserver 行 config 可生效**（实测 netstat 0.0.0.0:38080 LISTENING；注意 patch 替换整行 config，host+port 要一起重写），这是业主拍板「显式配置」的唯一落地路径；（2）fence 行为实测：伪造 Host 打 `/api/*` → **403**；打 `/fde-api/ping`（第三方 prefix）→ **200**；打 `/`（静态 fallback）→ **200**——**fence 只护 /api，不波及第三方路由**（2.5 的前提实证，R-S2 由推断升级为实测）；绑 0.0.0.0 时 LAN IP 字面量 Host 自动入 allowlist（`/api` 从 LAN IP 打 → 404 = fence 放行、网关路由到达）。

### 1.4 插件生命周期 【证+推】

- 【证】定时器经 cordis-plugin-timer：`ctx.interval(cb, delay)`（`setInterval` 为弃用别名）；timer 服务本身是 dsh-base patch 的一行（`- id: timer`），随插件 ctx 销毁清理（附录 A-8）→ 60s 轮询迁移到 `ctx.interval`，比裸 setInterval 更贴合宿主生命周期
- 【实测·P1/P5 回填】（1）**`ctx.interval(callback, delay)` 参数序实证：callback 在前**——写反成 `interval(delay, cb)` 不报错，但走 promise 分支（单发定时器），心跳不跑（WP1 实踩，10s 心跳修正后按 10s 整精确递增）；（2）**P5：detached 子进程在 DSH 退出后存活**——bundle spawn `detached:true, stdio:'ignore'` + unref，taskkill 强杀 DSH 后子进程 tasklist 仍在（孤儿，ppid 残留死父 pid），无 job-object 收割；launcher 恢复扫描保留为兜底（graceful 退出路径未单测，但无收割机制存在，两路径等价）；（3）route.handler 形态见 2.1（实测 Node req/res）。

### 1.5 dsh-workbench 文章逐条对照

| 文章断言 | rc.7 判定 | 证据 |
|---|---|---|
| 宿主端 lib/index.js | **已变**：宿主逻辑按能力拆独立包（dsh-host-webserver 等），dsh 本体仅 620 行薄壳 | 附录 A-1、dsh/lib 清单 |
| package.json 的 dsh.client 字段 | **成立**：`"dsh":{"client":{"inject":[...],"platform":"web"}}`（客户端侧）；宿主侧服务包无 dsh 字段，靠 bundle 的 cordis.patch.yml 行装载 | 附录 A-6；dsh-host-webserver/package.json 无 dsh 键 |
| slots: sidebar.footer.action / shell.overlay | **成立**：两键均在源码出现 | 附录 A-5 |
| JSON RPC POST /<name>-api | **未找到→P6 实测证伪**：运行态 POST `/fde-console-api` → **405**（落入 frontend-static fallback，拒非 GET）；GET/POST `/api` → 404（网关路由活着，但无该 RPC path）。`-api` 约定在 rc.7 不存在，客户端-宿主通道 = apiproxy（`toFetchHandler`+`clientRequestSchema`） | 附录 A-9；附录 C-P6 |
| 依赖注入 webServer/fs/agents/slots | **成立（P2 实测补全）**：webServer 实证；fs 注入 id = `fs`、agents = `agents`（ctx.get 可达）；slots 宿主侧不存在（纯客户端） | 1.2 实测清单；附录 C-P2 |

【P6 已实测证伪】`/<name>-api` 在 rc.7 运行态不存在（POST → 405 fallback）；客户端-宿主通道 = apiproxy fetch-handler 形态。

## 二、迁移设计

### 2.1 HostAdapter 接口设计与 lib/ 逐个处置（目标：逻辑层零改动）

适配层入口（plugin/index.js，ESM，**全仓唯一触碰 DSH API 的文件**）：

```js
export const name = 'fde-console'
export const inject = ['webServer', 'timer']        // P2 实测：fs/sessions 亦可达，按需追加
export function apply(ctx) {
  const app = createApp(createRequire(import.meta.url)) // 复用 lib/ CJS，零改动加载
  const d = [
    ctx.webServer.register({ kind: 'prefix', path: '/fde-api', handler: adaptHttp(app.dispatchApi) }),
    ctx.webServer.register({ kind: 'prefix', path: '/fde',     handler: adaptHttp(app.dispatchStatic) }),
    ctx.interval(() => app.pollTick(), 60_000),   // 实测参数序：callback 在前
  ]
  ctx.on('dispose', () => d.forEach((x) => x()))
}
```

- 【实测·P1 已定型】route.handler = **Node (IncomingMessage, ServerResponse) 双参形态**：源码 `await route.handler(req, res)`（dsh-host-webserver lib/index.js Service.init 段），运行时捕获 `req.constructor.name === "IncomingMessage"`、`res.constructor.name === "ServerResponse"`（probe1.json）。**adaptHttp 定型单态 req/res 适配，双态实现取消**。补充：handler 抛错由宿主 createServer 层兜底捕获 → warn 日志 + **400**（非 500）——统一 500 JSON 必须自持（适配层 try/catch 保留）。
- lib/ 20 文件处置（派单口径「11 模块」，实查 lib/ 为 20 文件，全部列出）：

| 处置 | 文件 | 理由 |
|---|---|---|
| 不改（16） | analyze, attribute, dingtalk, gateway, giteaClient, inbox, jobs, launcher, members, overview, redact, sessions, settings*(见下), ssrfGuard, store, taskEvents | 纯逻辑/IO，仅依赖 node 内建；数据目录已配置化（store.js L70 `dataDir:'data'`、L186 校验 `['port','host','dataDir','webDir']`【证】），插件态由 config.json 指向新落点即可。**gateway 一项 v2.2 已移除（整文件删除）** |
| 小改 | settings.js | host/port 校验段改为「host 仅接受 127.0.0.1/0.0.0.0，与 webServer 配置同源」；监听权移交宿主（1.3） |
| 小改 | router.js | Router 类保留（适配层分发核心）；仅删独立层专用挂载注释 |
| 删 | server.js | 监听/Host/静态/装配职责整体移交 plugin/（2.6） |
| 待定 | routes-gitea-stub.js | 插件态无独立端口即无 stub 场景 → 业主确认（2.10-5） |
| 新增 | plugin/index.js、plugin/adapter.js（adaptHttp+Host 防线）、plugin/static.js（自 server.js 抽出）、scripts/migrate-data.js | — |

### 2.2 216 测试存续方案

- 结构：`test/helpers/appAssembler.js` —— `buildApp({config})` 返回 `{router, store, mods}`（fixtures 内存态）；server.js 的 require 图在装配器内重组；测试只 require `lib/*` + 装配器，不再 require server.js
- 现状：grep 显示 15/17 测试文件含 "server" 字样【证】，多为注释/间接引用；实现期以 `grep -l "require.*server" test/` 圈定真实重写面。必须重写的三类：
  1. 真监听/真端口用例 → 改 `router.handle(mockReq, mockRes)`（router 分发为纯函数形态，router.js 头注释【证】）
  2. convention.test.js 中断言 server.js 启动行为（非回环 exit 2、Host 403）的用例 → 改断言适配层等价行为
  3. 断言静态服务在 server.js 的用例 → 改指 plugin/static.js
- 验收：`node --test test/` 216 用例全绿、数量不减

### 2.3 web/ SPA 嵌入 DSH shell 方式

- **决策：iframe overlay（v1）**——经 `shell.overlay` slot 挂 iframe 指向 `/fde/index.html`；侧栏入口用 `sidebar.footer.action` 按钮开合 overlay（**v2.9.36 已废弃**：入口改 `sidebar.panellist` + `main` 主列面板，页脚按钮与覆盖层整体移除；本小节以下内容保留为历史记录）
- 理由：SPA 为 hash 路由（web/js/app.js L58、L104【证】），iframe 内 hash/样式/滚动完全自治，**零 base-path 改写**；直接挂载需把 DOM/CSS 并入宿主 shell，冒样式与路由冲突风险，违背「逻辑层零改动」
- API 前缀：SPA fetch 切到 `/fde-api/*`（web/js 一处 API_BASE 常量，web/ 不属逻辑层、允许改）；静态资产走 `/fde/*` prefix 路由；绝对路径 fetch 在 iframe 内不会误撞 DSH 的 /api
- 【实测·P8 前置/客户端机制回填】（1）**slots 是纯客户端机制**：宿主侧无 slots 服务；`sidebar.footer.action` 为 **list 型 slot**（sidebar 的 children 表声明，条目组件收 `{ wide }` props），第三方注册形态 = `ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: '<自有id>', order: 100, label: 'FDE' }, Component))`（WP1 实测渲染成功，截图 fde-sidebar.png：侧栏底部 "FDE #N pid ..." 实时心跳条目）；（2）**客户端插件包机制**：包声明 `dsh.client = { platform: "web", inject: ["react", ...] }` + `exports["./client"]` 指向**已构建的浏览器产物**（手写 `window.__ModuleLoader__.load({id, factory})` 包裹、导出 `{inject, apply}` 即可，无需构建链）；宿主 ClientModuleRegistry 扫描 loader entries → `/plugins/<包名>/client.js` 下发 + `window.__DSH_BOOT__` 图谱注入 index.html（实测 39 entries 含 fde-console-spike）；**声明 dsh.client 而 client 产物缺失 = 启动聚合报错（MissingClientBundleError → FAILED fiber）**，产物必须随包发布；（3）slot 注入id 为 `slots`（客户端 ctx），React 经 `require('react')`（dsh.client.inject 声明依赖边）。
- overlay 关闭不销毁 iframe（保任务页状态）【推·实现期定】；备选「直接挂载」记录不实施，触发条件=业主要求视觉深度融合
- **v2.9.8 三态显示模式**：面板几何从「恒铺满」改为三类模式类（fdec-mode-dock/float/full），默认 dock（右侧 `min(920px,72%)`，宿主侧栏保持可见）；顶栏新增模式按钮组，与开合按钮同栏；localStorage 持久化（键 `fdec-mode`，读侧白名单校验，缺省回退 dock）
- **v2.9.34 主导航面板（主形态）**：`sidebar.panellist` 注册图标（id=`fde-console`，order=20）+ `main` 注册 keyed 面板（key 同上）→ 点图标由宿主把中间主列切到 `<iframe src="/fde/index.html">`（`.fdec-panel` 整列铺满）。宿主契约（Slots catalog 原文）：panellist「Each list id addresses the matching main panel; the sidebar owns the button and resolves its label from list metadata」，ownerProps=`{size, active}`，label 支持 thunk（每次投影重读，故语言切换自动跟随）。覆盖层保留为副入口（dock 可与会话并排）。

### 2.4 路径与数据落点

- 落点【实测·P7 已定】：环境变量名 = `DSH_HOME`（dsh-home-paths `DSH_HOME_ENV`）；本机**实路径 = `C:\Users\<you>\.dsh`**（env 未设时默认 `~/.dsh`，fde-dev profile 实测落在该目录下；进程内 `process.env.DSH_HOME` 为 null 是正常态）。故 `<base> = C:\Users\<you>\.dsh\fde-console\`，数据=`<base>/data`；每人一份 DSH ⇒ 天然一人一份数据。不推荐 profile 目录内：pnpm workspace 重装/清理风险。另实测：`DSH_WEB_URL` 不在 DSH 进程 env（是经 shellEnv 注入子 shell 的变量）；canonical URL 以 `dsh web: http://127.0.0.1:<port>` 打印为准。
- 实现：config.json 的 `dataDir`/`webDir` 写绝对路径（store.js L186 已校验【证】）；config.json/agents.json/members.json 落 `<base>/`；插件首启无 config 则生成默认模板
- 迁移：`scripts/migrate-data.js`（零依赖、幂等）：拷 repo `data/`→`<base>/data`，拷 agents.json/members.json→`<base>/`；config 合并时删 host/port 键、重写 dataDir/webDir；已存在则跳过并报告
- 同步字段预留：members 条目与任务对象加注释位 `"_sync": {"enabled": false, "peer": null}`——只注明、不实现、不参与校验

### 2.5 安全 posture 重写

| 控制 | 插件态去留 | 说明 |
|---|---|---|
| 仅绑 127.0.0.1（非回环 exit 2） | **移交** | webServer schema 收窄 127.0.0.1/0.0.0.0（1.3【证】）；CLI `--host 0.0.0.0` 被硬拒【实测】，0.0.0.0 仅 profile config 覆盖可达（显式配置，业主已拍板允许）；settings.js 改同源校验 |
| Host 头校验（403） | **保留，收编进适配层** | 只护 `/fde-api/*`、`/fde/*`；allowlist=回环字面量+config.trustedHosts（对齐 DSH fence 思路【证】附录 A-7）。**理由已实测坐实**：fence 只拦 `/api/*`（伪造 Host → 403），`/fde-api/*` 伪造 Host → 200、LAN IP 直打 → 200 pong——宿主 fence 不波及第三方路由，防线必须自持（P4） |
| SSRF 三元组（ssrfGuard.js） | **全保留** | 逻辑层零改动 |
| 凭据零落盘 | **全保留** | 钉钉 dws/Gitea token 仍仅内存；存活期=DSH 进程存活期【推】 |
| redact | **全保留** | 零改动 |
| DNS rebinding | **双保险** | DSH fence（其 /api）+ 适配层 Host 校验（我们路由），互不依赖 |

DSH 态新增风险：R-S1 进程内共生——插件异常可击穿整个 DSH（无进程隔离）→ 适配层全路由 try/catch + 统一 500 + unhandledRejection 兜底；R-S2 禁止假设「DSH 会替我们拦」；R-S3 默认 config 强制 127.0.0.1，0.0.0.0 须显式（暴露面=LAN）；R-S4 若 rc.8 把 bundle 一律沙箱化（P3），fs/网络能力需改走宿主服务

### 2.6 焊死边界与 git 策略

- 前置：main 打 tag `v1.9.0`（独立版终版基线=回退锚点；**已执行**，锚定 f98bb2d）；分支 `feat/dsh-plugin` 完成验收后合 main，合入动作含删除
- 删：server.js（监听/Host/静态/装配移交 plugin/，gitea 路由挂载入口迁 plugin/adapter.js）；config.json 的 host/port 键及 settings.js 对应校验
- 留：lib/router.js（降为库）、16 个逻辑模块、routes-gitea.js、routes-gateway.js、web/、test/（v2.2 已移除：routes-gateway.js 与 lib/gateway.js 已随 cli-gateway 集成删除）
- 增：plugin/index.js、plugin/adapter.js、plugin/static.js、cordis.patch.yml、scripts/migrate-data.js；插件包 package.json 加 `dsh.bundle.patch` 指向（单仓根包或子目录包，派工时定）
- 回退预案：`git checkout v1.9.0 -- server.js` + web/js apiBase 常量回 `/api` + settings.js 校验还原 → 独立版即刻复活；DSH 插件文件留存互不干扰

### 2.7 任务拆解

| 包 | 内容 | 依赖 | 验收命令 |
|---|---|---|---|
| WP1 探针 spike | P1-P8 一次跑完：hello bundle 装进 profile，实测路由/slot/interval/handler 形态/子进程存活/DSH_HOME/沙箱边界 | 无（串行前置） | `dsh --profile fde-dev web` 后 `curl 127.0.0.1:<port>/fde-api/ping` 返回 `{"pong":true}`，侧栏见入口 |
| WP2 HostAdapter | plugin/index.js+adapter.js+static.js（含 Host 防线、统一 500） | WP1 | `node --test test/adapter.test.js`（mock webServer，双 handler 形态各一例+Host 403 一例） |
| WP3 测试装配器 | appAssembler.js + 圈定用例改造 | 无（并行） | `node --test test/` 全绿（期间 server.js 尚在，双轨） |
| WP4 SPA 嵌入 | shell.overlay iframe + sidebar.footer.action 入口 + apiBase 切换 | WP1 | overlay 手测清单过 + convention 断言更新 |
| WP5 数据迁移 | scripts/migrate-data.js + config 默认模板 | 无（并行） | 对 data/ 副本执行后 `node --test test/tasks.test.js test/members.test.js` 绿 |
| WP6 焊死收口 | 删 server.js、文档更新、tag 核对 | WP2-5 | `node --test test/` 216 全绿；`git tag v1.9.0` 存在；`grep -rn "require.*server" test/ web/js` 无业务命中 |

WP1 唯一串行前置；WP2/3/4/5 四线并行；WP6 收口。与存量测试关系：WP3 先行保证双轨期绿，WP6 后独立装配路径成为唯一路径。

### 2.8 风险清单

| 风险 | 概率×影响 | 缓解 |
|---|---|---|
| rc API 漂移（rc.7→rc.8 改 register/handler 签名/slot 键） | 中×高 | DSH API 触碰收在 plugin/index.js+adapter.js 两文件；文档锁 rc.7；升级只重跑 WP1 spike |
| handler 形态未实证（P1） | 高×中 | adaptHttp 双态实现；WP1 首日消除 |
| detached 子进程被宿主退出连带收割（P5） | 中×高 | 探针先行；launcher 恢复扫描兜底；若确认收割且不可接受 → 升级业主决策点 |
| GBK-cmd 坑在 DSH 进程内变化（子进程继承 DSH 的 env/cwd/代码页） | 中×中 | launcher 子进程显式 env+cwd，不依赖宿主环境；WP1 spike 跑一次真实 launcher 路径验证 |
| pnpm 缺失 / git 插件 allowBuilds 摩擦 | 低×中 | 安装文档写明前置（pnpm on PATH、allowBuilds 键）；分发优先 file: 路径 |
| 误信宿主 fence 护我们路由（R-S2） | 低×高 | 规格固化：防线自持，不依赖宿主 |

### 2.9 明确不做（Non-goals）

共享任务板/多用户/跨身份权限；跨平台（Linux/macOS 适配、landlock 路径）；同步字段实现；lib/ ESM 化；任何 npm 运行时依赖；DSH 之外宿主的兼容；DSH 自身的登录/认证体系建设。

### 2.10 开放问题（须业主拍板）

1. 数据落点：`$DSH_HOME/fde-console/`（推荐）还是 profile 目录内？（2.4）
2. 是否允许 0.0.0.0（LAN）绑定形态存在？（2.5 R-S3；规格默认否定）
3. 可用性语义变化：DSH 不运行=指挥台不可用，60s 轮询随 DSH 存活（旧独立版常驻）——接受？
4. 插件分发形态：git 私仓 URL vs file: 本地路径（allowBuilds 摩擦差异）
5. routes-gitea-stub.js 插件态去留（2.1）

## 附录 A：证据索引（ROOT=C:\Users\<you>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\）

1. ROOT/package.json L13-15,22-29,81 —— 薄壳 CLI/ESM/cordis 与插件依赖
2. ROOT/lib/plugin-9h8shc4d.js L23-32,46-77,101-124 —— dsh plugin 命令/bundle 判定/pnpm 转发/allowBuilds
3. ROOT/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js L289-311 —— profile/清单/补丁合成/两锚点解析
4. ROOT/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js L15-19,24-25,40-58,62-68,168-173 —— schema/register/registerUpgrade/监听
5. ROOT/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js L39-179；dsh-client-ui-sidebar 与 dsh-client-ui-layout 的 lib/client.js —— SlotCore 与 slot 键名
6. ROOT/node_modules/@deepseek-ai/dsh-client-ui-sidebar/package.json `dsh` 块 —— dsh.client.inject/platform
7. ROOT/node_modules/@deepseek-ai/dsh-web-app/lib/startup.js L22-44；lib/index.js L30-62 —— 命令选项/trustedHosts/fence/canonical URL
8. ROOT/node_modules/@deepseek-ai/cordis-plugin-timer/lib/index.js L9-22,48；dsh-base/cordis.patch.yml L15-19 —— ctx.interval/timer 服务行
9. ROOT/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js L2-4 —— dsh-host-apiproxy 的 toFetchHandler/clientRequestSchema
10. ROOT/node_modules/@deepseek-ai/dsh-cordis-host-runner/lib/index.js L581-634 —— 沙箱 ctx 暴露面
11. E:\agent开发\FdeHarness\lib\store.js L70,L126-139,L186 —— dataDir 配置化/原子写/键校验
12. E:\agent开发\FdeHarness\server.js L1-20；lib\router.js L1-12；web\js\app.js L58,104 —— 现状传输层与 hash 路由

## 附录 B：实现期风险与探针方案（预检未覆盖项，WP1 已一次跑完；详录见附录 C）

| 探针 | 问题 | 方法 | 实测答案（2026-10-19，fde-dev profile） |
|---|---|---|---|
| P1 | webServer route.handler 形态（req/res vs fetch） | 读附录 A-4 L100-160 调用点；WP1 实测 | **Node req/res**：`await route.handler(req, res)`，运行时捕获 IncomingMessage/ServerResponse；handler 抛错宿主兜 400。adaptHttp 定型单态（2.1） |
| P2 | 宿主侧 fs/agents/slots 注入 id 与方式 | WP1 hello bundle 注入尝试；或读 dsh-cordis-host-runner 装配段 | fs=`fs`、agents=`agents`（ctx.get 可达，共 26 id 可达，见 1.2 清单）；**slots 宿主侧不存在**（纯客户端）；属性式访问需先声明 `export const inject`，ctx.get 不需要 |
| P3 | bundle 插件是否过沙箱（非模型面） | WP1：hello bundle 直接 require('node:fs') 成立与否 | **不过沙箱**：模块级 createRequire('node:fs') 直连成功、fs 写读实测 ok；沙箱 runner 仅模型面插件 |
| P4 | /api fence 执行点；是否波及第三方 prefix 路由 | WP1：从 LAN 地址 curl /fde-api 观 403/404 | fence 在 /api 路由内部生效：伪造 Host `/api/*`→403、`/fde-api/*`→200、`/`→200（**不波及第三方路由，2.5 前提实证**）；绑 0.0.0.0 时 LAN IP 字面量自动入 allowlist（LAN 打 `/api`→404=fence 放行）；0.0.0.0 走 profile config 覆盖（CLI 硬拒） |
| P5 | DSH 退出对 detached 子进程的影响 | WP1：起任务→退 DSH→tasklist 查子进程 | **存活**：detached+unref 子进程在 DSH 被 taskkill 强杀后 tasklist 仍在（孤儿，无 job-object 收割）；launcher 恢复扫描保留兜底 |
| P6 | `POST /<name>-api` 是否存在于运行态 | WP1 抓包/枚举路由；对照 1.5 | **不存在**：POST `/fde-console-api`→405（frontend-static fallback 拒非 GET）；GET/POST `/api`→404；通道=apiproxy fetch-handler |
| P7 | DSH_HOME 实路径与环境变量名 | 读 dsh-home-paths/lib/index.js（本轮未读）；WP1 打印 | env 名=`DSH_HOME`（未设→默认 `~/.dsh`）；本机实路径=`C:\Users\<you>\.dsh`（profile 实测落于其下）；`DSH_WEB_URL` 不在进程 env（shellEnv 注给子 shell）；canonical URL 以 `dsh web: http://127.0.0.1:<port>` 打印为准 |
| P8 | 会话/身份服务可否被插件获取（驾驶舱身份绑定） | WP1 枚举 ctx 可见服务；不可得则 v1 维持本机单用户假设 | 会话面可达：`sessions`/`sessionQuery`/`sessionPersistence`；**身份/登录服务不存在**（user/identity/auth/anonymousUserId/credentials 全不可达）→ **v1 本机单用户假设成立** |

**WP1 验收（2.7 表）实测**：`dsh --profile fde-dev --port 38080` 起服后 `curl http://127.0.0.1:38080/fde-api/ping` → `{"pong":true,...}`（心跳计数每 10s 递增）；侧栏入口实测渲染（截图 `E:\agent开发\fde-plugin-spike\fde-sidebar.png`，条目 "FDE #N pid …" 实时轮询 ping）。产物目录：`E:\agent开发\fde-plugin-spike\`（bundle 源 `fde-console/`、探针证据 probe1/probe2.json、运行日志、cdp-shot.mjs）。

## 附录 C：WP1 探针实测详录（2026-10-19，DSH rc.7，profile=fde-dev）

- 载体：`E:\agent开发\fde-plugin-spike\fde-console\`（package.json 声明 `dsh.bundle.patch` + `dsh.client`；cordis.patch.yml 单行 insert `- id: fde-console, name: fde-console-spike`；index.js 宿主探针；client.js 手写浏览器 bundle）
- 安装：`dsh plugin --profile fde-dev add "E:\agent开发\fde-plugin-spike\fde-console"` → 自动 init + pnpm link + reconcile 回写 bundles；手工把 `@deepseek-ai/dsh-web-app` 补进 profile package.json 的 `dsh.profile.bundles`（in-box 包不在 registry，模板机制同款做法）
- 启动：`dsh --profile fde-dev --port 38080` → 日志打印 `[fde-console] P7 DSH_HOME=null ... pid=<pid>` + `dsh web: http://127.0.0.1:38080`
- 证据文件：`probe1.json`/`probe2.json`（/fde-api/probe 快照）、`dsh-web-run.log`、`fde-sidebar.png`（浏览器截图）、`cdp-shot.mjs`（零依赖 CDP 驱动）、心跳日志（tmpdir，探针后已清）

| # | 实测命令 → 输出（摘要） | 结论 |
|---|---|---|
| P1 | `/fde-api/probe` → `handlerShape: {reqIsIncomingMessage: true, resIsServerResponse: true, reqCtor: "IncomingMessage", resCtor: "ServerResponse"}`；源码 `await route.handler(req, res)`；handler 抛错 → 400 | req/res 单态定型 |
| P2 | probe2.json `serviceHits`：26 id present（fs/agents/sessions/sessionQuery/sessionPersistence/storage/subprocess/sandbox/tools/shell/web/loader/timer/webServer/...）；`slots` null；属性访问未声明 inject → 启动炸 "cannot get property without inject"（实踩一次） | 注入面清单坐实 |
| P3 | index.js 模块级 `createRequire(...'node:fs')` 加载成功 + `fsProbe: {ok: true}` 写读实测 | 无沙箱 |
| P4 | 回环：`curl -H "Host: evil.example.com" /api/session/list` → **403**；同 Host `/fde-api/ping` → **200 pong**；`/` → **200**。加测（业主允许 0.0.0.0）：profile 用户层 patch 覆盖 `id: webserver, config: {host: '0.0.0.0', port: 38080}`（CLI `--host 0.0.0.0` 被硬拒 "intentionally not supported yet"）→ netstat `0.0.0.0:38080 LISTENING`；`curl http://192.168.52.206:38080/fde-api/ping` → **200 pong**；`http://192.168.52.206:38080/api/session/list` → **404**（LAN 字面量 Host 被 fence 放行，网关路由到达） | fence 只护 /api；第三方路由 LAN 可达无防护；2.5/R-S2 实证 |
| P5 | `POST /fde-api/spawn` → `{spawned: true, pid: 5876}`（node -e setInterval, detached+unref）；`taskkill /PID <dsh> /F` 后 `tasklist /FI "PID eq 5876"` 仍在；wmic 示 ParentProcessId=死父 pid | 子进程存活，无收割 |
| P6 | `POST /fde-console-api` → **405**（fallback 拒非 GET）；`GET /api`、`POST /api` → **404** | `-api` 约定不存在 |
| P7 | 启动行 `P7 DSH_HOME=null`（env 未设→默认 ~/.dsh）；profile 实际落 `C:\Users\<you>\.dsh\profiles\fde-dev\`；`dsh web: http://127.0.0.1:38080` | env=DSH_HOME；实路径坐实 |
| P8 | probe2.json：`sessions/sessionQuery/sessionPersistence` present；`user/identity/auth/anonymousUserId/credentials` 全 null | 本机单用户假设成立 |
| 侧栏 | CDP（chromium headless shell + Node24 内建 WebSocket）断言：`__DSH_BOOT__` 39 entries 含 `fde-console-spike`；DOM 实测侧栏文本 **"FDE #61 pid 28208"**（10s 心跳经 5s 前端轮询实时刷新）；截图 fde-sidebar.png | dsh.client 客户端插件链路全通 |
| 心跳 | `ctx.interval(cb, 10_000)`（callback 在前）修正后：`/fde-api/ping` heartbeats 1→3 按 10s 整递增，心跳日志同拍 | 1.4 timer 契约实证 |

- 复跑注意：`web` 是硬编码别名不可与 `--profile` 组合；profile 用户层 patch 探针后已还原 `[]`；探针起的 dsh 进程与子进程已清理（taskkill + tmpdir 清扫）。

## 七、官方规范对齐审计（v2.9.30 增注，2026-10-31，基准=0.2.1-rc.2 npm 包随附文档）

业主指令「先看 DeepSeek 插件开发规范再整体优化」→ 规范本体=宿主 npm 包随附文档（`@deepseek-ai/dsh/README.zh.md` + 依赖包 README.zh.md 系列与 `lib/types/*.d.ts`；README 引用的 `packages/*` 源码仓文档不随包分发）。逐项审计结论：

### 7.1 manifest 契约对照（`@deepseek-ai/dsh-package-manifest` DshPackageManifest）

| 契约项 | 规范口径 | 本插件审计前 | 处置 |
|---|---|---|---|
| `dsh.bundle.patch` | 相对包根的 patch 文件或有序列表 | ✓ 已有（单文件） | 维持 |
| `dsh.manifestVersion` | 格式标识，声明值=`1` | ✗ 缺失 | **补齐** |
| `engines.dsh` | SemVer 范围；声明后由该范围唯一决定兼容性（未声明=无约束） | ✗ 缺失（升级零保护） | **补齐**（v2.9.30 首发 `>=0.2.1-rc.2 <0.3`；**v2.9.33 上界修正为 `<0.3.0-0`**——原写法在宿主 `includePrerelease` 语义下会放行 0.3.0-rc.x，见 7.3） |
| `engines.node` | 运行时要求 | ✗ 缺失（AGENTS.md 有口径但清单未声明） | **补齐 `>=22.13`**（node:sqlite 门槛） |
| `icon` | 相对包根 SVG/PNG/JPEG/WebP，≤256KiB，realpath 包含 | ✗ 缺失（插件页裸 id 无图标） | **补齐 assets/icon.svg（<1KB）** |
| `description` | 展示摘要 | ✓ 已有 | 维持 |
| `dsh.client` | platform/inject/immediately/external | ✓ 已有（platform=web、inject=react） | 维持；注意规范原文 **client.inject 是信息性包名依赖、不是 Cordis 服务注入**（与宿主侧 apply 的 `inject:['webServer','timer']` 是两个概念，勿混淆） |
| `locale/*.json` 展示文本 | `meta.title`/`meta.description`，`<specifier>/locale/en.json` 为必需锚点，其余语种按文件名取 id | ✗ 缺失（插件行标题回落技术名 `fde-console`） | **补齐 en/zh 双语 + 顶层导出 `./locale/*.json`**（v2.9.33；宿主 `readPluginMeta` 只认导出资源，不认 dsh 字段） |
| `files` | 打包白名单，须含**每个运行时文件**（patch/locale/icon/模块） | ✗ 缺失（本地 link 安装不受影响，故长期未暴露） | **补齐**（v2.9.33；含运行时真实依赖 `test/helpers/appAssembler.js`、`scripts/migrate-data.js`） |
| `dsh.client.exports` | **非标准字段**——宿主只读顶层 `exports["./client"]`（dsh-client-modules `clientExportOf`） | ✗ 冗余声明（从未被读） | **删除**（v2.9.33） |

### 7.2 declined 项（有意不采纳，附理由）

- **config schema 声明（schemastery）**：`--dump-config-schema` 需要插件模块导出 schema，schemastery 虽在宿主 node_modules 内，但 pnpm 严格隔离下树外插件不可解析——声明它=新增真实运行时依赖，违反红线 1。配置校验继续由 lib/settings.js 自担（等价防线），已在插件清单缺失 schema 的代价（`--dump-config-schema` 无本插件条目）记入已知限制。
- **dsh-atomic-write 采纳**：平台自带原子写（符号链接防护+跨进程写锁，直指双实例互踩事故类），但同因 pnpm 隔离不可达；依赖化违反红线 1。维持 store.js tmp+rename（原子性等价，缺跨进程锁）+ 运行纪律（单实例）+ 备份机制三层兜底。
- **dsh-jobs 采纳**：平台 jobs 归属 agent 会话内（其余 agent 不可见），本插件 job 面向 HTTP/UI 轮询，语义不同，不适用。
- **dsh.storage-json 采纳**：我们的存储形态（裸数组/任务对象/唯一键语义）与 backend 抽象不匹配，迁移侵入性大于收益。

### 7.3 patch 形状与兼容性纪律（新增约束）

- 插件 patch 形状（`- insert:` 行）与 dsh-base 官方 bundle 同构 ✓（早前 WP1 实证）；id 唯一性纪律维持（fde-console-spike 冲突记忆）。
- **engines.dsh 声明后的新行为**：宿主在 profile 装载期用 `evaluatePluginCompatibility` 判定（dsh-app-boot，声明了 `engines.dsh` 时该范围**独占决定**、peerDependencies 被忽略），不满足则整包跳过并进 `skippedBundles`、stderr 打印一行 skip 原因——这是声明的目的：强迫一次显式的兼容性重验（红线 9），而不是静默带病运行。
- **上界必须写 `<0.3.0-0` 而不是 `<0.3`**（v2.9.33 修正）：宿主用 `semver.satisfies(..., { includePrerelease: true })` 判定，此语义下 `0.3.0-rc.1` 也满足 `<0.3`，会被放行——与「跨 0.3 必停」的声明矛盾。`0.3.0-0` 才是把 0.3 的预发布一并挡在门外的写法。

### 7.4 第二轮整改（v2.9.33，按官方 skill 清单复查）

> 业主「看下是否符合开发规范」→ 以 `cordis-plugin-development` 技能的 host-plugin/ui-plugin 检查清单逐项复核（比 7.1 只看 manifest 类型更严），差异与处置如下。

| 规范条款 | 整改 | 落点 |
|---|---|---|
| 展示元数据：`locale/en.json` 的 `meta.title`/`meta.description` + 导出 `./locale/*.json` | 新增 en/zh 双语词典并导出 | `locale/*.json`、package.json exports |
| "Keep factories free of side effects"——样式/监听/定时器必须在 `apply` 内用 `ctx.effect`/`ctx.on` 登记并返回清理 | `<style>` 从工厂体移入 `ctx.effect`，销毁即移除（并接管上一代残留同名 style，修 HMR 旧 CSS 常驻） | plugin/client.js apply |
| "Route visible UI text through the Client locale service" | 入口按钮/面板标题/三态按钮/关闭的文案全部经 `ctx.get('locale')` 注册 ns=`fde-console` 的 zh/en 词典；服务缺位回落英文 | plugin/client.js STRINGS + apply |
| "Register every resource inside apply with ctx.effect or ctx.on and return cleanups" | 宿主侧手工 disposers 数组 + `ctx.on('dispose')` 改为逐个 `ctx.effect`（apply 中途失败可当场回滚） | plugin/index.mjs |
| `files` 必须含每个运行时文件 | 补 `files`；**运行时仍从 `test/helpers/appAssembler.js` 取装配器**，故该文件必须在白名单内（`files` 只对打包/发布生效，本地 link 安装不看） | package.json |

**暂缓（登记不装看不见）**：把装配器从 `test/helpers/` 机械搬迁到 `lib/`（消除「运行时依赖 test 目录」的形态异味）。搬迁需重写文件内 **30 处 `require('../../…')`** 与 `rootDir = path.resolve(__dirname,'..','..')` 的根推算（一次改错即整站起不来），而当前环境 **pwsh 不可用、`npm test` 跑不了**，盲改 1000+ 行装配器正是「业务逻辑被改乱」的高危操作——故本轮只做「`files` 显式包含」这一等价兜底，搬迁留待测试可跑时一次做完（改完必须全量 `npm test` + 冒烟三连）。
