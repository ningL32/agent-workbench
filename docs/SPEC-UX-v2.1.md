# SPEC — FDE 指挥台 体验提升 v2.1

- 版本：v2.1 草案（2026-10-20）｜状态：可派工
- 前提：功能面已齐（SPEC / SPEC-PLUGIN v1.2 焊死态，239 后端测试绿），本期只做体验打磨
- 硬约束：零 npm 依赖延续；不引入新框架/路由库；改动限 `web/**`（如某项必须后端支持，单独标注「API 需求」）；后端 239 测试不回退
- 事实与建议分离：走查清单为【已验证事实】（行号实测）；每项「建议」为【设计决策】。全文行号基于 2026-10-20 HEAD

## 1. 目标 / 非目标

目标：消灭误导性反馈与交互断点，让「功能已齐」的产品「用起来舒服」；补齐任务详情的可分享直达链接。
非目标：不做新功能面（命令面板/模板/分组）、不重构归因、不改后端契约、不做 i18n。

## 2. 业主已确认问题 × 现状核实（4 条）

| # | 业主口径 | 核实结论【已验证事实】 |
|---|---|---|
| 1 | 雷达「分析所选」运行中再点 → 双 toast「没有可分析的消息」+「ALREADY_RUNNING」 | 成立，机理更精确：后端从不返回 409（lib/analyze.js:497-521，单飞靠 inFlight 集合，命中进 `skipped[].reason`）；前端 accepted===0 时把机器码拼进红色 error toast（radar.js:698）；且 `runAnalyzeJob`（radar.js:694）无 activeJob 守卫，两个「重试」入口（radar.js:204、792）直调绕过 `analyzeChecked` 的守卫（radar.js:688）；`activeJob` 在 POST 返回后的 pollJob 里才赋值（radar.js:712），await 窗口内二击同样过守卫 |
| 2 | app.js:147 / api.js:56 仍写「启动 server.js」 | 成立。独立版已随 WP6 删除（SPEC-PLUGIN.md:5），现形态 `dsh --profile <name> [--port N]` |
| 3 | 任务详情无 URL，不能分享/收藏 | 成立。详情是弹层（board.js:559 openTaskDetail）；app.js:58 currentRoute 已按 `?` 截断，`#/board?task=x` 不破坏现有路由 |
| 4 | 批量拒绝有确认、批量确认无二次核对 | **口径修正**：批量确认已有确认弹层（radar.js:581），但只报数量不列清单——核对粒度不足，非「无确认」 |

## 3. 走查清单（≥10 条，均带实测行号）

优先级：P0=阻断/误导；P1=显著提升；P2=打磨。工作量：S≤2h / M≤4h / L>4h。

| # | 级 | 文件:行号 | 问题 | 建议 |
|---|---|---|---|---|
| W1 | P0 | radar.js:687-706,180,712,733 | 见核实#1；另 pollJob 对 404/连败无终态兜底（catch 吞掉后每 1.2s 死循环，radar.js:733），一旦「启动即禁用」落地会把工具栏永久锁死 | 见 §4-A |
| W2 | P0 | app.js:147; api.js:56 | 离线文案指向已删除的 server.js | 见 §4-B |
| W3 | P0 | index.html:15; app.js:113-116 | 侧栏地址硬编码 `127.0.0.1:7788`，插件态端口任意（如 --port 38080）常显错误；非 mock 模式无人改写 | 显示 `location.host` |
| W4 | P1 | board.js:559; app.js:57-60 | 详情弹层无深链 | 见 §4-C |
| W5 | P1 | radar.js:574-593,188,328-338 | 批量确认弹层无候选清单；纪要池/收件箱均无全选 | 见 §4-D |
| W6 | P1 | 多处（清单见 §4-E） | 表单 submit 与点击型操作无 busy 锁：await 期间可再点 → 重复创建任务/重复 PATCH | 见 §4-E |
| W7 | P1 | board.js（全文无 startPolling） | 看板无轮询（对照 overview/members/agents 10s、radar 30s、activity 60s），外部改任务不可见、无「更新于」 | 见 §4-F |
| W8 | P1 | ui.js:177,189 | 叠加弹层（详情+删除确认，board.js:817/767）按 Esc 一次全关，丢上下文 | 弹层栈只关栈顶 |
| W9 | P2 | radar.js:161,224 | `m.ref.url \|\| '#'` 死链：无 url 渲染可点 `href="#"`（跳页顶），且未过 safeHttpUrl，与全站防御口径不一致 | 无合法 url 降级纯文本 |
| W10 | P2 | settings.js:537-571 | 「手动同步」5min while 轮询无 rootEl/hidden 守卫：切走照跑、回来可叠出第二条同步循环（对照 radar.js:715 pollJob 有 rootEl 检查） | 补同款守卫 |
| W11 | P2 | board.js:90-93; app.js:89-94 | 视图加载失败只有错误文案，无「重试」按钮（看板是停留最久的视图） | 错误态加重试 |
| W12 | P2 | radar.js:583-589 | 批量确认部分失败逐条 toast，10 条全败=10 条叠加（叠 ui.js:139-156 无手动关闭） | 失败明细并入汇总 |
| W13 | P2 | board.js:21,211-214 | 搜索无匹配时只有各列「无任务」，无「N 条匹配 / 清除搜索」 | 加结果计数+清除 |
| W14 | P2 | ui.js:139-156 | toast 无手动关闭/图标、4.2s 固定 | 可点关闭 |
| W15 | P2 | ui.js:162-195 | openModal 无焦点圈禁、关闭不还焦点（仅 192-193 focus 首输入） | a11y 打磨 |
| W16 | P2 | board.js:232-241 | moveTask PATCH 期间无 pending 指示，慢网下用户重开下拉见旧值 | 瞬时徽标 |
| W17 | P2 | agents.js:156 | 停用智能体的「启动」按钮可点（title 自述「启动将报错演示」），提交才报 AGENT_DISABLED | 禁用态 |
| W18 | P2 | board.js:211-214 | 全新环境空看板无引导 CTA（分发手册明言「全新环境是空看板」）；零列已有提示（board.js:214） | 空态 CTA |
| W19 | P2 | settings.js:447,165 | 保存无脏状态跟踪，切视图静默丢弃编辑 | 脏跟踪+离开提示 |
| W20 | P2 | overview.js:105 | 匹配任务链接显示裸 id（activity.js:242 带标题，口径不一致） | 统一口径 |

## 4. v2.1 范围（本期一批，总量约 2 个工作日）

实施顺序：B → E → A（复用 E 的锁模式）→ D → G → C → F。

### A. 雷达分析/同步单飞与反馈修复（W1，P0，S-M）

设计【判断：claude 复核纠正后采纳】：
1. **占位认领**：`runAnalyzeJob`/`startSync` 在 await 之前同步认领 `activeJob = { id: null, kind }`（认领失败即返回）；POST 返回回填 jobId；`accepted===0`/catch 释放。消除 POST RTT 窗口内的二击双 POST。sync 与 analyze 经共享 activeJob 互斥。
2. **触发点状态同步**：新增 `syncJobControls()`，按 activeJob 同步 `#radar-sync`、`#radar-analyze`、池行「重试」、结果条「重试」的 disabled；认领/释放与 pollJob 终态均调用；drawPool/drawInbox 渲染同样读 activeJob。**所有出口（成功/失败/异常/终态/视图销毁）必须恢复**，恢复逻辑收敛在 syncJobControls 一处。
3. **pollJob 终态兜底**：轮询 404（ApiError.status===404，server 重启丢 job）或连续失败 ≥10 次或总时长 >10min → 按终态处理：清 activeJob、syncJobControls、toast「任务状态丢失，请重试」。
4. **reason→人话分级**：`accepted===0` 时按 skipped reason 分级——ALREADY_RUNNING→info「所选纪要已在分析中，请等当前批次完成」；ALREADY_ANALYZED→info「所选纪要均已分析过」；NOT_FOUND→error「所选纪要不存在，请刷新后重试」；混合→计数汇总。不再出现「没有可分析的消息（ALREADY_RUNNING）」式机器码红 toast。

改动文件：`web/js/views/radar.js`（无需后端/mock 改动，契约不变）。
验收（手工冒烟，网络面板佐证）：
- 触发分析后 1s 内再点「分析所选」/两个重试入口：无第二个 POST、无矛盾 toast，按钮呈禁用态。
- 分析运行中「同步钉钉听记」禁用；反之亦然。
- 分析运行中重启后端：≤15s 内轮询停止、按钮恢复、有明确提示、可重新发起。
- 各 reason 场景显示对应人话 info/error，无机器码拼接文案。

### B. 离线文案与侧栏地址口径（W2+W3，P0，S）

验收：
- app.js:147 非 mock 分支改为「服务离线：请确认 DSH 宿主已启动、FDE 指挥台插件已启用」；mock 分支文案不变。
- api.js:56 NETWORK 文案改为「无法连接服务：请确认 DSH 宿主已启动且插件已启用」（不提 server.js/127.0.0.1）。
- 非 mock 模式 `#side-addr` 显示 `location.host`（实际访问地址）；mock 保持「MOCK 数据 · 零出网」。
改动文件：`web/js/app.js`、`web/js/api.js`。

### C. 任务详情深链 `#/board?task=<id>`（W4，P1，M）

设计要点：hash 双向同步一律 `history.replaceState`（不进历史栈、不触发 hashchange，规避回写循环与返回键怪异行为）；`currentRoute()`（app.js:57-60）不动；不改产出方链接（activity/radar/agents 的 pendingTaskFocus 机制照旧，统一收口进 backlog）。
改动文件：`web/js/views/board.js`（消费参数、hash 同步、复制链接）、`web/js/ui.js`（仅当 openModal 需暴露 onClose 已有——无需改则不动）。
验收：
- 打开详情 → URL 变 `#/board?task=<id>`，无新增历史记录；Esc/遮罩/×/按钮关闭均恢复 `#/board`。
- 新标签直接粘贴 `#/board?task=<id>`：看板加载后自动打开详情并高亮该卡（滚动+flash，复用 focusPending 模式）。
- 任务不存在：详情显示「任务已不存在」空态（board.js:592 现成）；被搜索过滤不影响（深链进看板时 q 为空）。
- 详情弹层新增「复制链接」按钮：clipboard 优先、execCommand 兜底（复用 board.js:720-743 copyBranchName 模式），失败 toast 给完整 URL。

### D. 批量确认清单 + 全选 + 失败汇总（W5+W12，P1，S）

验收：
- 批量确认弹层列出所选候选清单（标题+建议负责人+优先级；update 提案带「任务更新」标），清单区可滚动（max-height），确认按钮带数量。
- 纪要池表头全选框：仅勾选可分析行（待分析/失败，radar.js:174 selectable 口径）；收件箱全选框：勾全部候选。
- 批量确认/拒绝部分失败：逐条 error toast 取消，末条汇总「成功 N/共 M，失败 X」+ 失败明细并入一条提示。
改动文件：`web/js/views/radar.js`。

### E. 提交/点击型操作 busy-lock（W6，P1，M）

设计：ui.js 导出 `busyBtn(btn, fn)` 包装（进入即 disabled，finally 恢复；异常路径必解锁），调用点逐一接入。清单（≥13 处，均已实测）：
board.js:414 任务表单、board.js:770 挂接成果表单、board.js:218 moveColumn、board.js:232 moveTask；
radar.js:429 更新确认、radar.js:535 入库确认、radar.js:637 拒绝表单、radar.js:574 batchConfirm、radar.js:664 batchReject；
agents.js:218 智能体表单、agents.js:275 启动表单、agents.js:174 toggleAgent、agents.js:343 stopSession；
members.js:260 成员表单；settings.js:485 save。
验收：
- 任一提交点 await 期间按钮 disabled（双击只发一次请求，网络面板佐证）；失败后按钮恢复可重试。
- A 项的触发点禁用与本项不冲突（A 用 syncJobControls，E 用 busyBtn，互不覆盖对方状态）。
改动文件：`web/js/ui.js` + 上述 5 个视图。

### F. 看板静默轮询（W7，P1，S-M）

设计【判断：fetch 常开、只门控 apply——焦点占用时延后重绘而非丢弃数据】：30s `startPolling(refresh)`（modalDepth>0 暂停为既有全局守卫）；refresh 后做规范化脏比较（列按 order、任务按 id 排序后 stringify）不变则不动 DOM；有变化但 `document.activeElement` 在 `#board-grid` 内 → 标记 pending，下个 tick（或焦点离开时）应用。
验收：
- 双窗口：A 改任务状态/标题，B 30s 内可见且无整板闪烁（DOM 节点引用不变，数据无变化时零重绘）。
- 用户正操作列下拉时轮询到变更：不立即重绘打断，松开焦点后下一拍呈现。
- 弹层打开期间不轮询（现状保持）。
改动文件：`web/js/views/board.js`。

### G. 弹层 Esc 栈顶关闭（W8，P1，S）

验收：
- 详情+确认弹层叠加时按 Esc 只关顶层确认框；再按一次关详情。遮罩/×/按钮路径行为不变。
- ui.js 维护弹层 close 栈（modalDepth 已有，补栈结构即可），onKey 只对栈顶生效。
改动文件：`web/js/ui.js`。

## 5. Backlog（本期不做 + 理由）

| 项 | 级/量 | 缓做理由 |
|---|---|---|
| Ctrl+K 命令面板 | L | 七视图侧栏导航已够用，收益/成本比低；零依赖可实现但交互打磨重 |
| 任务模板 | M | 无使用数据支撑需求；先用雷达候选入库（已是「半模板」）观察 |
| 任务分组视图（按成员/优先级） | M | 看板已按状态分组；先做更便宜的「过滤 chips」验证需求再谈视图 |
| 产出归因重构 | L | 分支约定自动归因已跑通（board.js:614+），无故障证据不动 |
| 深链产出方统一（activity/radar/agents 链接改深链、删 pendingTaskFocus 双机制） | S | 应用内跳转已可用，双机制无用户可感知差异；待 C 稳定后一次收口 |
| W9 死链与 safeHttpUrl 口径、W10 同步守卫、W11 重试按钮、W13 搜索计数、W14 toast 打磨、W15 焦点圈禁、W16 moveTask 指示、W17 启动禁用、W18 空态 CTA、W19 脏跟踪、W20 链接口径 | P2/S~M | 均不阻断；排 v2.2 按 W 序号优先级消化 |

## 6. 开放问题（待业主拍板）

1. 离线文案是否要带具体 profile 名（如「请启动 dsh --profile fde-dev」）？带名字需后端把 profile 注入前端（API 需求，本期默认不带，只写通用口径）。
2. 看板轮询间隔定 30s（与雷达对齐）还是更短？10s 会放大重绘门控的测试面。
3. 「重分析已分析过的纪要」是否需要？现在 ALREADY_ANALYZED 直接 skip、行勾选禁用，唯一入口是失败重试；放开需后端支持（API 需求，单列不做入本期）。
4. W17「停用智能体禁止启动」与 agents.js:156 title 自述的「报错演示」是否为业主故意保留的演示行为？需确认后改。

## 7. 验证方式与影响面

- 前端无自动化测试（test/ 仅覆盖 lib/）：每项按 §4 验收标准走手工冒烟；`web/index.html?mock=1` 可离线走查（mock.js:836 已按 `{jobId, accepted, skipped}` 契约返回，A 项无需改 mock）。
- 回归底线：`node --test` 239 用例全绿（改动限 web/**，理论零影响）；冒烟后 `git diff` 确认无 web/ 之外改动。
- 派工拆分建议：B+E+G 一人一天；A+D 一人一天；C+F 一人一天（三人并行可压缩到 1 天，串行 2 天）。
