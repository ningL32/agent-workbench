# FDE 指挥台 · 分发安装手册（DSH 插件版）

读者：拿到插件目录（FdeHarness 文件夹）的同事。会用浏览器和终端即可，不要求会编程。
适用范围：**仅 Windows**（当前只验证过 Windows）；DSH 版本 **0.2.1-rc.2**。
获取方式二选一：**从公司 Gitea 克隆**（推荐，见第 3 节第 1 步方式 A）或直接拷贝插件文件夹。

## 1. 你将得到什么

FDE 指挥台是装进 DSH 的一个插件。装好之后，每次启动 DSH，界面左下角会出现「FDE 指挥台」按钮，点开就是你的个人驾驶舱：任务看板、成员进度、团队动态、智能体管理、任务雷达。所有数据都存在你自己电脑的 DSH 目录里——每人一份、互不相通（个人驾驶舱模型，没有共享服务器）。

三件事先知道：

- **DSH 不运行 = 指挥台不可用**。指挥台随 DSH 进程存活，关掉 DSH 窗口它就没了，要用就先启动 DSH。
- **数据不共享**。你的钉钉、你的 Gitea 凭据、你的任务数据，全在你本机。
- DSH 还是 rc（候选）阶段，**DSH 升级后建议重验**一遍安装与启动（见第 8 节）。

### 版本兼容矩阵（本插件在各版本上实测/推定）

| 组件 | 当前验证版本 | 说明 |
|---|---|---|
| DSH 宿主（@deepseek-ai/dsh） | **0.2.1-rc.2** | 本插件按此版本全套验证；升 DSH 后需重跑兼容探针 |
| 超级工作台（fde-console）插件 | **2.9.68**（与 package.json 同步） | 与 DSH 0.2.1-rc.2 配套；桌面端实测宿主 0.2.1-rc.5 同样满足 `engines.dsh >=0.2.1-rc.2 <0.3.0-0`；运行期可在「总览 → 版本与兼容性」卡自证 |
| Node.js | **≥22.13 LTS**（实测 v24.15.0） | 唯一运行时依赖；node:sqlite 门槛（会话观测/阅读器必需），Node 18/20 不可用 |
| dsh-better-sidebar（可选，原生侧栏 tab） | 0.28.0 | 要求 DSH 0.2.1-rc.1+ |
| 钉钉 dws（雷达功能） | 1.0.59（实测） | 需完成钉钉登录 |
| 飞书 lark-cli（雷达功能·可选） | 1.0.98（实测） | `npm i -g @larksuite/cli`；需 `lark-cli config init` 应用配置 + `auth login` 用户授权；不用飞书妙记可不装 |
| Gitea（团队动态/自动归因） | 28.1.0（实测） | 需本人凭据（git config 预授权头） |

> 约定：升级任一组件后，先跑插件设置页的「一键体检」，再抽查一个核心动线（建任务/启动会话/雷达分析）。

## 2. 安装前自查（六项，不依赖插件）

拿到插件目录、动手安装之前，先花一分钟自查。打开 PowerShell（按 Win 键 → 输入 powershell → 回车），逐条执行：

| # | 检查项 | 命令 | 绿的标准 |
|---|--------|------|----------|
| 1 | Node ≥ 22.13 | `node -v` | v22.13 LTS 及以上（node:sqlite 门槛） |
| 2 | DSH 本体 | `dsh --version` | 打印版本号（0.2.1-rc.2） |
| 3 | pnpm | `pnpm --version` | 打印版本号 |
| 4 | Gitea 凭据（团队动态用） | `git config --global --get http.<你的Gitea地址>/.extraheader` | 打印出 `Authorization: Basic` 开头的一行 |
| 5 | 雷达三件套（任务雷达用） | `dsh --version`；dws 登录态按其自身引导确认；LLM 路由在 DSH 界面确认 | dsh 可用 + dws 已登录 + 路由已配 |
| 5b | 飞书采集（可选，飞书妙记用） | `lark-cli --version`；`lark-cli auth status --json --verify` | 打印版本号 + user 身份 `verified:true`（不用飞书可不装，雷达钉钉源不受影响） |

- 第 1~3 项红了：不慌，第 3 节第 0 步两分钟补装。
- 第 4~5 项红了：不阻塞安装，装完再补（怎么补见第 7 节 FAQ ④⑤）。
- 装完插件后，这些项在指挥台里有一键版（第 4 节「一键体检」），两张表内容等价。

## 3. 五分钟安装

### 第 0 步：补装前置三件套（自查绿了可跳过）

```powershell
node -v                    # 已装 Node 则先看版本，需 ≥ 22.13（没装去官网下 LTS 安装包；18/20 缺 node:sqlite 会话功能不可用）
npm i -g @deepseek-ai/dsh  # DSH 本体
npm i -g pnpm              # 插件安装的转发工具
```

**验证点**：`dsh --version` 和 `pnpm --version` 都能打印版本号。报「无法识别」就重开一个终端窗口再试；仍不行回到上一条命令补装。

### 第 1 步：把插件装进 profile

**方式 A（推荐）：从公司 Gitea 克隆后安装**——以后 `git pull` 一下就能升级：

```powershell
git clone https://gitea.example.com/example-org/fde-console.git "E:\agent开发\FdeHarness"
dsh plugin --profile fde-dev add "E:\agent开发\FdeHarness"
```

（克隆需要 Gitea 账号权限；仓库是私有的，找管理员把你加进 example-org 组织。）

**方式 B：拿到插件文件夹的直接安装**：

```powershell
dsh plugin --profile fde-dev add "E:\agent开发\FdeHarness"
```

说明：路径换成你实际拿到的插件目录（含空格必须带引号）；`fde-dev` 是 profile 名字，可自定义，下文保持一致即可。首次执行会自动创建 profile。

**验证点**：命令跑完没有红色报错。

### 第 2 步：启动

```powershell
dsh --profile fde-dev --port 38080
```

**验证点**：终端打印一行 `dsh web: http://127.0.0.1:38080`。

> 注意：**没有** `dsh --profile fde-dev web` 这种用法——`web` 是 DSH 的保留名，不能和 `--profile` 组合（实测会报错）。端口被占用就换个数字。

### 第 3 步：进入指挥台

浏览器打开上一步打印的地址，在 DSH 界面**左下角**点「FDE 指挥台」按钮。

**验证点**：看到任务看板（全新环境是空看板，正常）。

可选硬核验证——新开一个终端：

```powershell
curl http://127.0.0.1:38080/fde-api/ping
```

返回 `{"pong":true,...}` 即插件活着。也可以不点按钮，直接访问 `http://127.0.0.1:38080/fde/index.html` 进入。

## 4. 安装后体检：一键体检

进指挥台后的第一件事：打开「设置」页，点顶部「**一键体检**」按钮——后台一次跑完六项聚合检查（`GET /api/setup/check`），六项红绿灯，每项红灯附修复指引。

- **定位**：装完验收 + 日常自查排障的第一入口。哪项红，按页面指引处理，或翻第 7 节 FAQ 对应条目。
- **版本注记**：体检按钮随「配置页二期」（与本手册同批）发布；若你手上的版本设置页还没有这个按钮，用第 2 节的命令自查表，两者完全等价。

## 5. 按功能解锁清单

装完默认只有看板开箱即用，其余功能按需解锁：

| 功能 | 前置 | 如何确认已解锁 |
|------|------|----------------|
| 任务看板 | 无 | 装完即有 |
| 团队动态 + 分支自动归因 | Gitea 凭据（配置方法见下） | 「团队动态」页出现真实提交/PR 记录 |
| 智能体动态（工作观测/会话阅读器） | 无（只读本机各智能体会话库） | 「智能体」页出现活动条目 |
| 任务雷达 | dws（钉钉工作台 CLI）已登录 + dsh 已装 + LLM 路由已配（三件套见下） | 「设置」页「引擎测试」通过、「手动同步钉钉听记」能拉到条目 |

**Gitea 凭据（团队动态）**：凭据只配置在 git 全局配置里，指挥台自己来读——

```powershell
git config --global http.<你的Gitea地址>/.extraheader "Authorization: Basic <管理员给你的令牌串>"
```

`<你的Gitea地址>` 必须与指挥台「设置」页里的「Gitea 地址」**一字不差**。
红线：**凭据永不填进指挥台页面**。指挥台从 git config 读取，只在内存使用，不落盘、不进日志。

**任务雷达三件套**：

1. dws（钉钉工作台 CLI）安装并按其自身引导完成登录；
2. dsh 在 PATH（第 0 步已装）；
3. LLM 路由：DSH 0.2.1 起在 **DSH 界面**设置模型与路由（旧 `settings.yaml` 的自定义 providers 不自动搬运，需在 DSH 界面重配一次）；
4. 最后到指挥台「设置」页打开「钉钉听记通道」开关。

## 6. 数据在哪、怎么备份

**数据落点**：`C:\Users\<你>\.dsh\fde-console\`。首次启动指挥台会自动在这里生成默认配置，无需手工创建。

**备份（可选，v2.9.42 起默认不自动跑）**：任务、时间轴、人工日报这些数据**只存在你自己的电脑上**（Gitea 动态可重拉，但任务史和日报不可重建）。业主判断本地单机不值得每天备一份——所以自动档默认关闭，备份能力保留：

- **手动档（推荐，按需跑）**：

```powershell
node "E:\agent开发\FdeHarness\scripts\backup-data.js" --keep 14
```

- **想开自动档**：`config.json` 写 `{"backup":{"enabled":true,"keep":14,"at":"09:05"}}`（默认 09:05、保留 14 份、落 `fde-console\backups\`）。
- **恢复**：`POST /api/backup/restore`，body `{"name":"backup-20261031-090500","confirm":"RESTORE"}`——恢复前会**先给当前状态拍一份快照**，恢复错了还能再恢复回来；只覆盖同名文件，不删除 data 里多出来的文件。
- **要防盘坏/换机**：本地备份没用（同盘一起没）。把整个 `fde-console` 文件夹放进 OneDrive/坚果云等同步盘才是答案——凭据红线保证这个目录里没有令牌（凭据在 git config），同步盘零泄密面。

如果你之前用的是旧独立版（在插件目录里跑 `node server.js` 的老形态），数据迁移一条命令：

```powershell
cd "E:\agent开发\FdeHarness"
node scripts/migrate-data.js --dry-run   # 先预览要搬什么，零写入
node scripts/migrate-data.js             # 实际迁移
```

- 默认从插件目录读旧数据，写到 `C:\Users\<你>\.dsh\fde-console\`；目录不同可用 `--source <旧目录>`、`--base <目标目录>` 指定。
- 幂等：重复执行不会覆盖目标里已有的数据。

**验证点**：重启 DSH 进指挥台，旧任务和成员名册都在。

## 7. 常见问题 FAQ（体检哪项红 → 怎么办）

**① Node 红（`node -v` 报错或低于 22.13）**
安装 Node.js 22.13 或更新的 LTS 版本（官网下载 Windows 安装包，一路下一步），装完重开终端再验。注意：Node 18/20 缺少 node:sqlite，会话观测/阅读器功能不可用。

**② DSH 红（`dsh --version` 报「无法识别」）**
`npm i -g @deepseek-ai/dsh`，装完重开终端。装完还报错，把 `C:\Users\<你>\AppData\Roaming\npm` 加入 PATH。

**③ pnpm 红**
`npm i -g pnpm`，装完重开终端。缺它插件装不进去（第 1 步的 add 命令靠它转发执行）。

**④ Gitea 红（「测试连接」失败）**
按第 5 节命令配置 `git config --global http.<Gitea地址>/.extraheader`。三个高频原因：地址与设置页「Gitea 地址」不一致（多一个斜杠都不行）；令牌过期（找管理员换）；命令里的引号丢了。改完到设置页再点一次「测试连接」。

**⑤ 雷达红（「引擎测试」失败或同步不到数据）**
逐个查三件套：终端跑 `dws` 看登录态，没登录就按引导登录；`dsh --version` 确认可用；LLM 路由在 DSH 界面确认已配（0.2.1 起 settings.yaml 旧自定义项不自动搬运，需在界面重配）。最后确认设置页「钉钉听记通道」开关是开的。

**其他常见问题**

- **左下角没有「FDE 指挥台」按钮**：profile 里缺 web 界面包。用记事本打开 `C:\Users\<你>\.dsh\profiles\fde-dev\package.json`，在 `"bundles"` 列表里补一行 `"@deepseek-ai/dsh-web-app"`，保存后重启 DSH。
- **DSH 窗口关了就打不开指挥台**：正常行为。重新执行第 2 步启动命令即可，数据不会丢。
- **端口被占用（启动报错）**：`--port` 换一个数字（如 38081）。
- **想换 profile 名 / 换端口**：都可以，`--profile` 和 `--port` 后面跟新值即可；同一台机器不同 profile 各自独立。

## 8. 已知边界

- 仅支持 Windows；macOS / Linux 未验证。
- 数据不共享：每人一份 DSH、一份指挥台、一份数据，没有多人共看一块板的模式。
- 指挥台不是常驻服务：DSH 进程在它才在。
- DSH 处于 rc 阶段，DSH 升级后建议重验：重跑第 1 步安装命令 → 第 2 步启动 → 第 3 步验证点。

## 9. 回退（v1.9.0 独立版）

插件态出问题需要临时退回旧形态时，回退目标是 **v1.9.0 tag 存档的独立版**（`node server.js`，默认 `http://127.0.0.1:7788`）。该形态已停止维护，仅作应急。

两点注意：

- 回退操作涉及 `git checkout v1.9.0 -- server.js` 等代码层动作，**请找维护者执行**，细节见 `docs/SPEC-PLUGIN.md` 2.6 回退预案。
- **不要**直接拿当前插件目录跑 `node server.js`——实测当前目录的前端资产已切到插件口径，独立版进程能起但页面是坏的。回退必须按 tag 检出，数据层不受影响。
