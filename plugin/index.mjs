// fde-console — FDE 指挥台 DSH 持久化插件（WP2 宿主适配器）。
// 全仓唯一触碰 DSH API 的文件（SPEC-PLUGIN 2.1）：ctx.webServer / ctx.interval / ctx.effect。
// 其余职责各归其位：装配 = test/helpers/appAssembler.js（与测试/独立版 server.js 共用单一真相），
// 防线与统一 500 = plugin/adapter.js，静态 = plugin/static.js，业务 = lib/*（零改动 CJS，
// 经 createRequire 桥接——根 package.json 不设 "type"（实测 type:module 会把 lib/ CJS 误判为
// ESM 而炸 "module is not defined"），ESM 入口以 .mjs 扩展名定型）。
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const path = require_('node:path')
const fs = require_('node:fs')
const os = require_('node:os')
const { fileURLToPath } = require_('node:url')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { sendJSON } = require_('../lib/router')
const instanceLock = require_('../lib/instanceLock')
const pkg = require_('../package.json')
const { buildApp } = require_('../test/helpers/appAssembler.js')
const { pluginDefaultConfig } = require_('../scripts/migrate-data.js')
const { createHostGuard, createRouteHandlers } = require_('./adapter.js')

export const name = 'fde-console'

// P2 实测：cordis 属性式访问守卫——ctx.webServer / ctx.interval 必须先声明 inject，否则启动即炸。
// timer 注入面由 @deepseek-ai/cordis-plugin-timer 提供（dsh-base patch 一行）。
export const inject = ['webServer', 'timer']

// 接管切换（WP6）：插件数据/配置落点 = <DSH_HOME>/fde-console/（env 优先，缺省 ~/.dsh）。
// 首启无 config 时生成默认模板（webDir 指向插件包自带 web——资产随代码走，base 只放用户数据）。
function resolveBaseConfig() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
  const base = path.join(home, 'fde-console')
  const configPath = path.join(base, 'config.json')
  if (!fs.existsSync(configPath)) {
    const webDir = path.join(__dirname, '..', 'web')
    fs.mkdirSync(path.join(base, 'data'), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(pluginDefaultConfig(base, webDir), null, 2))
    console.log(`[fde-console] 首启生成默认配置：${configPath}（webDir=${webDir}）`)
  }
  return { configPath, configDir: base }
}

export function apply(ctx) {
  // 装配（不监听、不自动轮询）：接管切换——config/数据取 <DSH_HOME>/fde-console/（WP5 迁移落点）
  const { configPath, configDir } = resolveBaseConfig()
  // v2.9.47 宿主 LLM 服务（可选注入）：插件内直接调用 = 用「当前 profile 的默认模型」，
  // 即桌面端正在用的那个（deepseek-account / DeepSeek-V4.1-Flash），不再 spawn 子进程、
  // 也不需要 GLM_API_KEY。取不到时 lib/learn 自动回落到 spawn 引擎（旧路径），不硬依赖。
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : null
  const agentDefaultModel = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
  const app = buildApp({ poller: 'manual', configPath, configDir, llm, agentDefaultModel })

  // v2.9.43 单实例登记：同 base 目录若还有别的存活实例，启动就吼一声（不硬拦——拒绝启动会连带
  // 把整个 DSH 拖下水）。v2.9.25 的教训是「两个实例共享 data/，旧代码每 60s 写脏」。
  const portArg = (() => {
    const i = process.argv.indexOf('--port')
    return i >= 0 && /^\d+$/.test(String(process.argv[i + 1] || '')) ? Number(process.argv[i + 1]) : null
  })()
  const lock = instanceLock.acquire(configDir, { version: app.version, port: portArg })
  if (lock.others.length > 0) {
    const who = lock.others.map((x) => `pid=${x.pid}${x.port ? ` port=${x.port}` : ''}${x.version ? ` v${x.version}` : ''}`).join('、')
    console.log(`[fde-console] ⚠ 检测到其它存活实例共用 ${configDir}：${who}——多实例会互相覆盖 data/，请只保留一个`)
  }
  if (lock.error) console.log(`[fde-console] 实例登记失败（不影响启动）：${lock.error}`)

  // 存活探针（对齐 WP1 spike 的 /fde-api/ping 契约）：GET /fde-api/ping → 经适配层剥离
  // /fde-api 前缀后命中 /api/ping → pong。挂在自己的 router 上，不碰宿主路由。
  const startedAt = Date.now()
  app.router.add('GET', '/api/ping', (c) => {
    sendJSON(c.res, 200, {
      pong: true,
      name,
      version: app.version,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      pid: process.pid,
      // v2.9.37 版本与兼容性矩阵（总览页卡片）的数据源：package.json 的 engines 与进程运行时。
      // 响应只增不改——老前端/巡检脚本只读 pong/version 时不受影响。
      engines: pkg.engines || {},
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
    })
  })

  // v2.9.43 多实例查询（前端顶栏据此亮红色 pill）：只读，不写盘
  app.router.add('GET', '/api/instance', (c) => {
    const st = instanceLock.status(configDir)
    sendJSON(c.res, 200, {
      self: st.self,
      others: st.others,
      multiInstance: st.multiInstance,
      base: configDir,
    })
  })

  const hostGuard = createHostGuard({ config: app.config })
  const handlers = createRouteHandlers({ app, hostGuard })

  // 资源一律经 ctx.effect 登记并交回清理函数（官方规范：apply 内用 ctx.effect/ctx.on 注册资源并返回
  // 清理）。好处是 apply 中途失败也能当场回滚已注册的路由/定时器，不必等整个插件 dispose。
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/fde-api', handler: handlers.api }),
    'fde-console: /fde-api routes'
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/fde', handler: handlers.static }),
    'fde-console: /fde static assets'
  )
  // P5/1.4 实测：ctx.interval(callback, delay) —— callback 在前，写反走 promise 分支不报错但不跑
  ctx.effect(() => ctx.interval(() => handlers.pollTick(), 60_000), 'fde-console: 60s poll tick')
  // 装配器收尾（停轮询器、还原注入 env、摘掉自己的实例登记）；注册在最后 = 逆序最先回收
  ctx.effect(() => () => {
    try { app.close() } catch (e) { /* 收尾互不阻塞 */ }
    try { instanceLock.release(configDir) } catch (e) { /* 同上 */ }
  }, 'fde-console: app teardown')

  console.log(`[fde-console] 装配完成：/fde-api + /fde 已注册，60s 轮询待命，data=${app.ctx.dataDir}`)
}
