# PROPOSAL：文档即断言（docs-as-tests）——设计稿

> 状态：**设计稿，未动工**（2026-11-03）。等业主点头后实施。
> 来源：DeepSeek dsh-superagent-prototype 的 `tests/docs.spec.ts` 思路（见 `docs/reviews/REVIEW-superagent-architecture.md` §7），裁剪适配本仓。
> 性质：纯新增 `test/docs-sync.test.js` + 修两处已发现漂移。不碰 lib/、不碰存储、零新依赖（红线 1 不触）。

## 0. 一句话

把 AGENTS.md 第五章「文档同步纪律」里**可机器判定的条目**固化为测试：漏同步 → `npm test` 红。落地即修掉摸底时人工抓到的 **2 处活体漂移**。

## 1. 目标 / 非目标

**目标**：版本口径、files 白名单、locale 词典、API 契约、文档互链五类漂移，测试红。
**非目标**：语义级检查（README 描述与实现行为一致——拓扑视图三重漂移属此类，需先给 SPEC 建视图清单表才可断言，列二期）；翻译质量；CI（本仓无 CI，`npm test` 就是门禁）。

## 2. 断言清单（每条挂一条纪律或一个事故）

### A. 版本口径一致（P0）
| # | 断言 | 治什么 |
|---|---|---|
| A1 | package.json `version` 以 `v{version}` 出现在 README.zh-CN.md「当前版本」行 | **活体**：现写 v2.9.64，实际 2.9.68（README.zh-CN.md:10） |
| A2 | `version（与 package.json 同步）` 形态出现在 DISTRIBUTION.md 兼容矩阵 | **活体**：现写 2.9.63（DISTRIBUTION.md:22） |
| A3 | SPEC.md 头部变更记录含 `> v{version} 变更` | 版本 bump 不带 changelog 条目（AGENTS.md 五） |
| A4 | DISTRIBUTION.md 含 `≥22.13` 与 `18/20 不可用` 口径 | Node 环境口径回退（红线 1；现已修正，钉住防复发） |

### B. files 白名单 ↔ 磁盘双向（P0）
| # | 断言 | 治什么 |
|---|---|---|
| B1 | `files` 数组每一项在仓库根真实存在 | 白名单指向已删文件 → 打包残缺 |
| B2 | 已知运行时面（常量清单，逐项带注释）都在 `files` 里：`lib/ web/ plugin/ locale/ assets/ cordis.patch.yml scripts/migrate-data.js test/helpers/appAssembler.js` | 装配器漏白名单事故（SPEC-PLUGIN 7.4 的教训清单化） |

### C. locale 双语词典（P1）
| # | 断言 | 治什么 |
|---|---|---|
| C1 | en.json 与 zh.json 均有非空 `meta.title`/`meta.description` | 插件行回落技术名 `fde-console` 事故 |
| C2 | 两文件顶层键集一致 | 只加一边、另一边静默缺译 |

### D. API 契约 ↔ 路由注册双向（P1，规模已摸清：65 处注册 / 21 文件 / 全字面量）
| # | 断言 | 治什么 |
|---|---|---|
| D1 | lib/*.js 全部 `router.add('METHOD','/api/...')` 提取后，每条 (METHOD, path) 出现在 SPEC §3 | 「状态对、契约错」；新端点忘进契约文档 |
| D2 | 反向：SPEC §3 每条 `- **\`METHOD /api/...\`**` 都能找到注册 | 删了实现、文档还留着 |
| D3 | 白名单 `UNDOCUMENTED_OK`（有意不入契约文档的路由）必须逐条带注释，无注释即测试失败 | 防白名单本身变垃圾桶 |

### E. 文档互链可达（P2，最便宜）
- README*.md 与 docs/*.md 所有相对 markdown 链接/图片引用解析后文件存在。跳过 http(s)/mailto/纯锚点；URL decode 兼容中文路径；只查文件级不查锚点级（易碎低收益）。

### F. 反漂移负向断言（P2）
- README.md / README.zh-CN.md / DISTRIBUTION.md 不得含精确测试计数模式（`全量\s*\d+\s*绿`、`\d+\s*(例|个)\s*用例`）——SPEC 历史变更条目豁免。对齐 AGENTS.md「计数写 300+ 不写死」纪律。

## 3. 失败信息设计（修的人一眼知道改哪）

```
[docs-sync] README.zh-CN.md:10 "当前版本 v2.9.64" ≠ package.json 2.9.68 —— 同步版本行（AGENTS.md 五）
[docs-sync] DISTRIBUTION.md 兼容矩阵插件版本 2.9.63 ≠ 2.9.68 —— 同步（行内自称"与 package.json 同步"）
[docs-sync] 路由 POST /api/radar/text 注册于 lib/analyze.js 但 SPEC §3 无此条目 —— 补契约或进 UNDOCUMENTED_OK（附理由）
```

## 4. 实现要点

- 文件 `test/docs-sync.test.js`，node:test，AAA 三段式，一用例一断言主题，对齐现有测试风格。
- 纯读仓库文件、零出网、零写入（无临时目录 → 无 EPERM 面）；路径 `path.resolve(__dirname, '..')`，不依赖 CWD。
- 路由提取：`/router\.add\(\s*['"]([A-Z]+)['"]\s*,\s*['"]([^'"]+)['"]/g`（已验证全字面量；lib/ 为 CJS 无动态注册面）。
- SPEC §3 提取：`/^- \*\*`([A-Z]+) (/api/[^`]+)`\*\*/gm`；`:param` 段两侧原样比对，路径去尾斜杠归一。
- 文件读取一律 utf8（GBK 坑只在控制台，不在文件）。
- 性能：同步读 ~25 个文件，<100ms。

## 5. 分期

- **一期（半天）**：A1-A4 + B + C + E + F —— 全部文件级机械断言，零歧义。落地前先修 §6 两处活体漂移，当天全绿。
- **一期收尾**：D 先跑出 65 条清单**人工过目**，白名单定了再合入（同一 PR 或紧随）。
- **二期（视需要）**：视图清单表（治拓扑视图三重漂移那类语义漂移——先在 SPEC 增视图清单表，再断言 web/ 实现里有对应入口，是文档改造+测试两步）。

## 6. 摸底已发现的活体漂移（落地即红 → 修文档 = 第一批收益）

1. `README.zh-CN.md:10`「当前版本 v2.9.64（…）」→ 实际 2.9.68（v2.9.65-68 五批变更未上版本行）。
2. `docs/DISTRIBUTION.md:22` 兼容矩阵「2.9.63（与 package.json 同步）」→ 实际 2.9.68。
3. （顺带发现，不属于本方案改动面）AGENTS.md 红线 1 里「DISTRIBUTION.md 若写 Node ≥18 是待修口径」本身已过时——DISTRIBUTION 实际已是 ≥22.13。AGENTS.md 是共享面，建议业主或对面会话自行更新，本方案不动。

## 7. 不抄 DeepSeek 的部分（有据 declined）

- class JSDoc 断言：本仓零依赖 CJS 函数式，无 class 约定，不适用。
- 编号文档只准引用更早文档：本仓 docs/ 无编号体系。
- 模型面每角色体积预算：属提示词工程话题（lib/analyze.js/learn.js 的 prompt 长度上限校验），不在「文档即断言」范围。

## 8. 验证方案

1. 修完 §6 两处漂移后 `npm test` 全绿（新测试并入既有套件）。
2. **漂移注入演练**（防"测试永远绿"的形式主义）：临时把 package.json version 改 9.9.9 → A1-A3 红、其余绿 → 还原；临时从 files 删一项 → B2 红 → 还原。演练输出附交付汇报。
3. 边界：对 docs/reviews/ 与 docs/proposals/ 的链接同样纳入 E 断言（它们最常被互链）。
