# Super Workbench (fde-console) · 安装手册（DSH 插件版）

读者：从 GitHub 找到这里、想在本机跑起来的用户。会用浏览器和终端即可，不要求会编程。
适用范围：**仅 Windows**（当前只在 Windows 验证过）；DSH 版本 **0.2.1-rc.2**。
获取方式：`git clone https://github.com/ningL32/agent-workbench.git`（或直接 Download ZIP 解压）。

## 1. 你将得到什么

Super Workbench 是装进 DSH 的一个插件。装好之后，每次启动 DSH，界面左下角会出现「超级工作台」按钮，点开就是你的个人驾驶舱：任务看板、成员进度、团队动态、智能体动态、任务雷达。所有数据都存在你自己电脑的 DSH 目录里——**本机单实例设计**，数据不出你的机器。

三件事先知道：

- **DSH 不运行 = 工作台不可用**。工作台随 DSH 进程存活，关掉 DSH 窗口它就没了，要用就先启动 DSH。
- **数据全在本机**。你的凭据、你的任务数据，全在你自己的电脑上；凭据走 git config 运行时读取，永不落盘。
- DSH 还是 rc（候选）阶段，**DSH 升级后建议重验**一遍安装与启动（见第 8 节）。

### 版本兼容矩阵（本插件在各版本上实测/推定）

| 组件 | 当前验证版本 | 说明 |
|---|---|---|
| DSH 宿主（@deepseek-ai/dsh） | **0.2.1-rc.2** | 本插件按此版本全套验证；升 DSH 后需重跑兼容探针 |
| 超级工作台（fde-console）插件 | **2.9.92**（与 package.json 同步） | 与 DSH 0.2.1-rc.2 配套；运行期可在「总览 → 版本与兼容性」卡自证 |
| Node.js | **≥22.13 LTS**（实测 v24.15.0） | 唯一运行时依赖；node:sqlite 门槛（会话观测/阅读器必需），Node 18/20 不可用。注：`zlib.zstd*`（DSH 会话 zstd 日志解压）需 ≥22.15，22.13/22.14 上 DSH 源自动降级只读明文 rollout，不影响其余功能 |
| dsh-better-sidebar（可选，原生侧栏 tab） | 0.28.0 | 要求 DSH 0.2.1-rc.1+ |
| 钉钉 dws（雷达功能·可选） | 1.0.59（实测） | 需完成钉钉登录；不用任务雷达可不装 |
| 飞书 lark-cli（雷达功能·可选） | 1.0.98（实测） | `npm i -g @larksuite/cli`；需 `lark-cli config init` 应用配置 + `auth login` 用户授权；不用飞书妙记可不装 |
| GitHub（团队动态·主源） | api.github.com（实测） | 个人账号经 user events 即可接入（仅公开活动）；组织可含私库（需 PAT） |
| Gitea / Gitee（团队动态·可选） | Gitea 28.1.0（实测） | 自建环境可选接入；凭据走 git config 预授权头，零落盘 |

> 约定：升级任一组件后，先跑插件设置页的「一键体检」，再抽查一个核心动线（建任务/启动会话/雷达分析）。

## 2. 安装前自查（六项，不依赖插件）

拿到仓库、动手安装之前，先花一分钟自查。打开 PowerShell（按 Win 键 → 输入 powershell → 回车），逐条执行：

| # | 检查项 | 命令 | 绿的标准 |
|---|--------|------|----------|
| 1 | Node ≥ 22.13 | `node -v` | v22.13 LTS 及以上（node:sqlite 门槛） |
| 2 | DSH 本体 | `dsh --version` | 打印版本号（0.2.1-rc.2） |
| 3 | pnpm | `pnpm --version` | 打印版本号 |
| 4 | GitHub 凭据（团队动态·主源，可选） | 公开活动匿名即可；私库/组织需 `git config --global http.https://api.github.com/.extraheader` | 打印出 `Authorization: Bearer` 开头的一行 |
| 5 | 雷达三件套（任务雷达用，可选） | `dsh --version`；dws 登录态按其自身引导确认；LLM 路由在 DSH 界面确认 | dsh 可用 + dws 已登录 + 路由已配 |
| 5b | 飞书采集（可选，飞书妙记用） | `lark-cli --version`；`lark-cli auth status --json --verify` | 打印版本号 + user 身份 `verified:true`（不用飞书可不装，雷达钉钉源不受影响） |

- 第 1~3 项红了：不慌，第 3 节第 0 步两分钟补装。
- 第 4~5 项红了：不阻塞安装，装完再补（怎么补见第 7 节 FAQ ④⑤）。
- 装完插件后，这些项在工作台里有一键版（第 4 节「一键体检」），两张表内容等价。

## 3. 五分钟安装

### 第 0 步：补装前置三件套（自查绿了可跳过）

```powershell
node -v                    # 已装 Node 则先看版本，需 ≥ 22.13（没装去官网下 LTS 安装包；18/20 缺 node:sqlite 会话功能不可用）
npm i -g @deepseek-ai/dsh  # DSH 本体
npm i -g pnpm              # 插件安装的转发工具
```

**验证点**：`dsh --version` 和 `pnpm --version` 都能打印版本号。报「无法识别」就重开一个终端窗口再试；仍不行回到上一条命令补装。

### 第 1 步：把插件装进 profile

**方式 A（推荐）：npm 一行安装**——以后 `dsh plugin --profile fde-dev add fde-console` 重跑即升级：

```powershell
dsh plugin --profile fde-dev add fde-console
```

**方式 B：从 GitHub 克隆本地安装**——适合想用未发版代码的场景：

```powershell
git clone https://github.com/ningL32/agent-workbench.git
dsh plugin --profile fde-dev add .\agent-workbench
```

（路径换成你实际克隆到的目录，含空格必须带引号；`fde-dev` 是 profile 名字，可自定义，下文保持一致即可。首次执行会自动创建 profile。）

**验证点**：命令跑完没有红色报错。

### 第 2 步：启动

```powershell
dsh --profile fde-dev --port 38080
```

**验证点**：终端打印一行 `dsh web: http://127.0.0.1:38080`。

> 注意：**没有** `dsh --profile fde-dev web` 这种用法——`web` 是 DSH 的保留名，不能和 `--profile` 组合（实测会报错）。端口被占用就换个数字。

### 第 3 步：进入工作台

浏览器打开上一步打印的地址（**用日志里带 token 的完整 URL**——0.2.1 起有认证门，裸地址白屏是正常防御），在 DSH 界面**左下角**点「超级工作台」按钮。

**验证点**：看到任务看板（全新环境是空看板，正常）。想先看非空效果，可以灌一份全合成演示数据再启动：

```powershell
node .\agent-workbench\scripts\seed-demo.js
```

可选硬核验证——新开一个终端：

```powershell
curl http://127.0.0.1:38080/fde-api/ping
```

返回 `{"pong":true,...}` 即插件活着。也可以不点按钮，直接访问带 token 的 `http://127.0.0.1:<port>/fde/index.html` 进入。

## 4. 安装后体检：一键体检

进工作台后的第一件事：打开「设置」页，点顶部「**一键体检**」按钮——后台一次跑完六项聚合检查（`GET /api/setup/check`），六项红绿灯，每项红灯附修复指引。

- **定位**：装完验收 + 日常自查排障的第一入口。哪项红，按页面指引处理，或翻第 7 节 FAQ 对应条目。
- **版本注记**：体检按钮随「配置页二期」发布；若你手上的版本设置页还没有这个按钮，用第 2 节的命令自查表，两者完全等价。

## 5. 按功能解锁清单

装完默认只有看板开箱即用，其余功能按需解锁：

| 功能 | 前置 | 如何确认已解锁 |
|------|------|----------------|
| 任务看板 | 无 | 装完即有 |
| 团队动态 + 自动归因 | 对应平台凭据（配置方法见下） | 「团队动态」页出现真实提交/PR 记录 |
| 智能体动态（工作观测/会话阅读器） | 无（只读本机各智能体会话库） | 「智能体」页出现活动条目 |
| 任务雷达 | dws（钉钉工作台 CLI）已登录 + dsh 已装 + LLM 路由已配（三件套见下） | 「设置」页「引擎测试」通过、「手动同步钉钉听记」能拉到条目 |

**凭据（团队动态）**：凭据只配置在 git 全局配置里，工作台自己来读——

```powershell
git config --global http.<你的Gitea地址>/.extraheader "Authorization: Basic <你的令牌串>"
```

`<你的Gitea地址>` 必须与工作台「设置」页里的「Gitea 地址」**一字不差**。GitHub/Gitee 源同理（GitHub 用 `Authorization: Bearer <PAT>`，Gitee 用私人令牌），设置页有命令模板可复制。

红线：**凭据永不填进工作台页面**。工作台从 git config 读取，只在内存使用，不落盘、不进日志。

**任务雷达三件套**：

1. dws（钉钉工作台 CLI）安装并按其自身引导完成登录；
2. dsh 在 PATH（第 0 步已装）；
3. LLM 路由：DSH 0.2.1 起在 **DSH 界面**设置模型与路由（旧 `settings.yaml` 的自定义 providers 不自动搬运，需在 DSH 界面重配一次）；
4. 最后到工作台「设置」页打开「钉钉听记通道」开关。

## 6. 数据在哪、怎么备份

**数据落点**：`C:\Users\<你>\.dsh\fde-console\`。首次启动工作台会自动在这里生成默认配置，无需手工创建。

**备份（可选，默认不自动跑）**：任务、时间轴、人工日报这些数据**只存在你自己的电脑上**（动态流可重拉，但任务史和日报不可重建）。本地单机默认不每天自动备份，但备份能力保留：

- **手动档（推荐，按需跑）**：

```powershell
node .\agent-workbench\scripts\backup-data.js --keep 14
```

- **想开自动档**：`config.json` 写 `{"backup":{"enabled":true,"keep":14,"at":"09:05"}}`（默认 09:05、保留 14 份、落 `fde-console\backups\`）。
- **恢复**：`POST /api/backup/restore`，body `{"name":"backup-20261031-090500","confirm":"RESTORE"}`——恢复前会**先给当前状态拍一份快照**，恢复错了还能再恢复回来；只覆盖同名文件，不删除 data 里多出来的文件。
- **要防盘坏/换机**：本地备份没用（同盘一起没）。把整个 `fde-console` 文件夹放进 OneDrive/坚果云等同步盘才是答案——凭据红线保证这个目录里没有令牌（凭据在 git config），同步盘零泄密面。

**验证点**：重启 DSH 进工作台，任务和成员名册都在。

## 7. 常见问题 FAQ（体检哪项红 → 怎么办）

**① Node 红（`node -v` 报错或低于 22.13）**
安装 Node.js 22.13 或更新的 LTS 版本（官网下载 Windows 安装包，一路下一步），装完重开终端再验。注意：Node 18/20 缺少 node:sqlite，会话观测/阅读器功能不可用。

**② DSH 红（`dsh --version` 报「无法识别」）**
`npm i -g @deepseek-ai/dsh`，装完重开终端。装完还报错，把 `C:\Users\<你>\AppData\Roaming\npm` 加入 PATH。

**③ pnpm 红**
`npm i -g pnpm`，装完重开终端。缺它插件装不进去（第 1 步的 add 命令靠它转发执行）。

**④ Gitea/GitHub/Gitee 红（「测试连接」失败）**
按第 5 节命令配置 `git config --global http.<平台地址>/.extraheader`。三个高频原因：地址与设置页配置不一致（多一个斜杠都不行）；令牌过期（重新生成）；命令里的引号丢了。改完到设置页再点一次「测试连接」。

**⑤ 雷达红（「引擎测试」失败或同步不到数据）**
逐个查三件套：终端跑 `dws` 看登录态，没登录就按引导登录；`dsh --version` 确认可用；LLM 路由在 DSH 界面确认已配（0.2.1 起 settings.yaml 旧自定义项不自动搬运，需在界面重配）。最后确认设置页「钉钉听记通道」开关是开的。

**其他常见问题**

- **左下角没有「超级工作台」按钮 / 启动日志报 `fde-console: pending (waiting for service: webServer)`**：profile 缺 web 界面包（新 profile 只自带 `@deepseek-ai/dsh-base`）。一条命令补上，版本与 dsh 对齐，别漏版本号：
  `dsh plugin --profile fde-dev add @deepseek-ai/dsh-web-app@<dsh --version 的值>`，然后重启 DSH。
  （也可以手工在 `~\.dsh\profiles\<profile>\package.json` 的 `bundles` 里加 `"@deepseek-ai/dsh-web-app"`，但包版本仍要对得上，不如命令稳。）
- **DSH 窗口关了就打不开工作台**：正常行为。重新执行第 2 步启动命令即可，数据不会丢。
- **端口被占用（启动报错）**：`--port` 换一个数字（如 38081）。
- **想换 profile 名 / 换端口**：都可以，`--profile` 和 `--port` 后面跟新值即可；同一台机器不同 profile 各自独立。

## 8. 已知边界

- 仅支持 Windows；macOS / Linux 未验证（欢迎按 [docs/ADAPTERS.md](ADAPTERS.md) 的协议适配并在 issue 里反馈）。
- 单机单实例：数据不共享，没有多人共看一块板的模式——这是设计取向，不是缺陷（见 README「Local-first」一节）。
- 工作台不是常驻服务：DSH 进程在它才在。
- DSH 处于 rc 阶段，DSH 升级后建议重验：重跑第 1 步安装命令 → 第 2 步启动 → 第 3 步验证点。
