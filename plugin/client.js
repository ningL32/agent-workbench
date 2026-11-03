// FDE 指挥台 DSH 客户端 bundle（SPEC-PLUGIN WP4）——手写零构建（零依赖纪律），
//   window.__ModuleLoader__.load({id, factory}) 包裹，导出 cordis 客户端插件 {inject, apply}。
//
// 集成岗搬运（client 文件落位 = 插件包内 client.js）：
//   1) 包清单声明 "dsh": { "client": { "platform": "web", "inject": ["react"] } }，
//      且 exports["./client"] 指向本文件（宿主下发路径 /plugins/<包名>/client.js）；
//   2) BUNDLE_ID 必须等于发布包名——宿主 dsh-client-modules 校验「bundle 脚本必须以
//      图谱 id 注册」，id 与包名不符 = "loaded without registering" 启动失败；
//   3) 路由契约（后端 WP2）：SPA 静态 = /fde/*（入口 /fde/index.html），API = /fde-api/*。
//
// 行为（SPEC-PLUGIN 2.3）——**单一入口：中间主列面板**：
//   - sidebar.panellist（list slot，收 {size, active}）+ main（keyed slot，key=PANEL_KEY）：
//     与「插件 / 自动化任务」并排的导航图标，点它宿主把中间主列切成指挥台（整列 iframe）。
//     契约：panellist 的 id 必须等于 main 的 key；按钮与无障碍名由宿主画，label 取 list 元数据
//     （传 thunk 可跟随语言切换）；图标组件只负责画图形。
//   - 面板 iframe 是**模块级单例**：宿主切换主列会卸载面板组件，若交给 React 渲染就会被重建
//     → 整页重载、视图/滚动/弹层全丢（v2.9.34 实测）。故卸载时把节点摘进游离容器保活，
//     切回时搬回面板（v2.9.35）。**别把这个 iframe 写回 JSX。**
//   - v2.9.36：页脚按钮 + shell.overlay 三态覆盖层（dock/float/full）整体移除——主列面板已覆盖
//     入口需求，浮层是冗余第二实例。历史实现见 git tag v2.9.35 的 plugin/client.js。
// React 经宿主注入（require('react')，dsh.client.inject 声明依赖边），无 JSX、无打包链。

var BUNDLE_ID = 'fde-console'; // 集成岗注意：必须与发布 npm 包名一致（见文件头注 2）

window.__ModuleLoader__.load({
  id: BUNDLE_ID,
  factory: function (require) {
    var React = require('react')
    var module = { exports: {} }

    // ---- 样式：一律在 apply 内经 ctx.effect 注入并登记清理（规范：工厂体零副作用）----
    // 变量名取自宿主 sidebar/layout 源码，带兜底值
    var CSS = [
      // 主列面板：整列铺满，无自带外框（标题栏由 SPA 自己画）
      '.fdec-panel{width:100%;height:100%;min-height:0;display:flex;flex-direction:column;',
      'background:var(--dsw-alias-bg-base,#0f1216)}',
      '.fdec-frame{flex:1;width:100%;min-height:0;border:none;background:#0f1216}',
      // 待办红点：挂在导航图标右上角（宿主只画按钮，红点由图标内容自带）
      '.fdec-icon-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center}',
      '.fdec-dot{position:absolute;top:-3px;right:-3px;width:7px;height:7px;border-radius:50%;',
      'background:#f87171;box-shadow:0 0 0 2px rgba(15,18,22,.9)}'
    ].join('')

    // ---- 文案：走宿主 Client locale 服务（ns=fde-console，zh/en 双语）；服务缺位时回落英文 ----
    // 键名即契约：改文案只动这张表，组件里一律 t('key')，不写字面量（规范：可见文案经 locale 服务）
    var NS = 'fde-console'
    // 主导航入口 id 与主列面板 key 必须是同一个值：宿主按 panellist 的 id 去找 main 的 key
    var PANEL_KEY = 'fde-console'
    var STRINGS = {
      en: {
        'button.label': '超级工作台',
        'frame.title': '超级工作台'
      },
      zh: {
        'button.label': '超级工作台',
        'frame.title': '超级工作台'
      }
    }
    function defaultTranslate(key) {
      return (STRINGS.en && STRINGS.en[key]) || key
    }
    var translate = defaultTranslate
    function t(key) { return translate(key) }

    // ---- 图标：内联 SVG（终端符），不依赖宿主 primitives 的导出名 ----
    // size 由宿主给（导航排 panellist 传 {size, active}；缺省 20）
    function TerminalIcon(props) {
      var size = (props && props.size) || 20
      return React.createElement('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { flex: 'none' }
      },
        React.createElement('polyline', { points: '4 17 10 11 4 5' }),
        React.createElement('line', { x1: '12', y1: '19', x2: '20', y2: '19' })
      )
    }

    // ---- 待办提醒（红点）：面板关着时也要能提示，故由插件自己轮询 ----
    // 口径与 SPA 顶栏铃铛一致：逾期 + 待验收 + 收件箱待确认；任一请求失败都保留上次数值，绝不清零骗人。
    var attention = 0
    var attentionListeners = new Set()
    function setAttention(next) {
      var n = Number(next) || 0
      if (n === attention) return
      attention = n
      attentionListeners.forEach(function (fn) { try { fn() } catch (e) { /* 单个订阅者异常不扩散 */ } })
    }
    function useAttention() {
      var pair = React.useState(attention)
      React.useEffect(function () {
        attentionListeners.add(pair[1])
        return function () { attentionListeners.delete(pair[1]) }
      }, [])
      return pair[0]
    }

    // ---- 主导航入口（sidebar.panellist）：宿主自己画按钮，我们只提供图标 + 待办红点 ----
    // 契约：list id 必须等于 main 面板的 key（点击 = 宿主把中间主列切到该面板）
    function FdePanelIcon(props) {
      var count = useAttention()
      var size = (props && props.size) || 20
      return React.createElement('span', { className: 'fdec-icon-wrap' },
        React.createElement(TerminalIcon, { size: size }),
        count > 0 ? React.createElement('span', { className: 'fdec-dot', 'aria-hidden': true }) : null
      )
    }

    // ---- 主列面板（main，key = PANEL_KEY）：整列嵌入指挥台 SPA ----
    // 实测（v2.9.34）：宿主切换主列会**卸载**面板组件 → React 重建 iframe = 整页重载 = 视图/滚动/
    // 弹层全丢。修法：全扩展只用一个 iframe 节点（consoleFrame 单例）；卸载时把节点摘到游离容器
    // （consoleHolder，不在 document 里，浏览上下文不销毁），切回时原节点搬回面板。
    // 兜底：sessionStorage 记 hash，万一同源搬运仍触发重载，至少回到上次那一页。
    var consoleFrame = null
    var consoleHolder = null
    var HASH_KEY = 'fdec-panel-hash'

    function readSavedHash() {
      try {
        var h = sessionStorage.getItem(HASH_KEY) || ''
        return h.charAt(0) === '#' ? h : ''
      } catch (e) { return '' }
    }
    function ensureConsoleFrame() {
      if (consoleFrame) return consoleFrame
      consoleFrame = document.createElement('iframe')
      consoleFrame.className = 'fdec-frame'
      consoleFrame.src = '/fde/index.html' + readSavedHash()
      consoleFrame.title = t('frame.title')
      consoleHolder = document.createElement('div') // 游离容器：不进文档，只负责保活
      consoleHolder.appendChild(consoleFrame)
      return consoleFrame
    }
    function rememberFrameHash() {
      try {
        var win = consoleFrame && consoleFrame.contentWindow
        var h = win && win.location ? win.location.hash : ''
        if (h) sessionStorage.setItem(HASH_KEY, h)
      } catch (e) { /* 读不到就放弃（同源失败/尚未加载） */ }
    }

    function FdePanel() {
      var hostRef = React.useRef(null)
      React.useEffect(function () {
        var host = hostRef.current
        if (!host) return undefined
        var frame = ensureConsoleFrame()
        frame.title = t('frame.title')
        host.appendChild(frame) // 从游离容器搬进面板（同源搬移不重建浏览上下文）
        // 兜底②：万一当前环境搬 DOM 仍重建了 iframe，只把 hash 补回去（改 hash 不会整页重载）
        try {
          var saved = readSavedHash()
          var win = frame.contentWindow
          if (saved && win && win.location && win.location.hash !== saved) win.location.hash = saved
        } catch (e) { /* 同源失败/尚未加载：忽略 */ }
        return function () {
          rememberFrameHash()
          if (consoleHolder && frame.parentNode === host) consoleHolder.appendChild(frame) // 摘回保管，不销毁
        }
      }, [])
      return React.createElement('div', { className: 'fdec-panel', ref: hostRef })
    }

    var inject = ['slots']

    function apply(ctx) {
      // 样式：进 apply 的 ctx.effect（规范：工厂体零副作用、资源登记清理）。若上一代插件残留同名
      // style，接管并在销毁时一并移除——修 HMR 后旧 CSS 常驻的观感问题
      ctx.effect(function () {
        if (typeof document === 'undefined') return undefined
        var selector = 'style[data-plugin-css="' + BUNDLE_ID + '/client.css"]'
        var existing = document.querySelector(selector)
        if (existing) {
          existing.textContent = CSS // 接管旧标签时同步成当前样式（HMR 后不留旧 CSS）
          return function () { if (existing.parentNode) existing.parentNode.removeChild(existing) }
        }
        var tag = document.createElement('style')
        tag.dataset.plugin = BUNDLE_ID
        tag.dataset.pluginCss = BUNDLE_ID + '/client.css'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return function () { if (tag.parentNode) tag.parentNode.removeChild(tag) }
      }, 'fde-console: client styles')

      // 文案：注册 zh/en 词典并绑定本插件命名空间（可见文案一律经宿主 locale 服务）。
      // locale 属可选服务（ctx.get 访问，不做硬 inject）：老宿主缺位时保留英文兜底，不阻塞激活
      ctx.effect(function () {
        var svc = null
        try { svc = typeof ctx.get === 'function' ? ctx.get('locale') : null } catch (e) { svc = null }
        if (!svc || typeof svc.register !== 'function' || typeof svc.bind !== 'function') return undefined
        var disposers = []
        try {
          disposers.push(svc.register(NS, 'en', STRINGS.en))
          disposers.push(svc.register(NS, 'zh', STRINGS.zh))
          translate = svc.bind(NS)
        } catch (e) {
          // 重复注册/服务异常：回收已注册部分并回落英文兜底——文案问题绝不拖垮整个客户端插件
          for (var i = 0; i < disposers.length; i++) {
            try { disposers[i]() } catch (e2) { /* 逐个回收 */ }
          }
          translate = defaultTranslate
          return undefined
        }
        return function () {
          translate = defaultTranslate
          for (var i = 0; i < disposers.length; i++) {
            try { disposers[i]() } catch (e) { /* 逐个回收，互不阻塞 */ }
          }
        }
      }, 'fde-console: locale dictionaries')

      // 主列面板（点击导航图标后宿主把中间列切到这里）；key 必须等于 panellist 的 id
      ctx.effect(function () {
        return ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_KEY }, FdePanel)
        })
      }, 'fde-console: main panel')

      // 待办红点轮询：60s 一次（面板内的 SPA 自己 30s 一轮，并通过 postMessage 推更实时的一次）
      ctx.effect(function () {
        var timer = null
        var stopped = false
        function sum(d) {
          return (Number(d && d.overdue) || 0) + (Number(d && d.review) || 0) + (Number(d && d.pending) || 0)
        }
        function getJSON(url) {
          return window.fetch(url, { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null })
            .catch(function () { return null })
        }
        function tick() {
          if (stopped) return
          Promise.all([getJSON('/fde-api/overview'), getJSON('/fde-api/inbox/stats')]).then(function (list) {
            if (stopped) return
            var ov = list[0]
            var st = list[1]
            if (!ov && !st) return // 两个都失败：保留上次数值
            var n = 0
            if (ov && ov.tasks) n += (Number(ov.tasks.overdue) || 0) + (Number(ov.tasks.review) || 0)
            if (st) n += Number(st.pending) || 0
            setAttention(n)
          })
        }
        // 面板开着时由 SPA 主动推（更实时）：只认同源消息
        function onMessage(e) {
          if (!e || e.origin !== window.location.origin) return
          var d = e.data
          if (!d || d.type !== 'fde:attention') return
          setAttention(sum(d))
        }
        window.addEventListener('message', onMessage)
        timer = window.setInterval(tick, 60000)
        tick()
        return function () {
          stopped = true
          if (timer) window.clearInterval(timer)
          window.removeEventListener('message', onMessage)
        }
      }, 'fde-console: attention polling')

      // 主导航排入口（插件 / 自动化任务 那一排）：label 传 thunk，宿主每次投影重读 → 跟随语言切换
      // 注：先注册 main 再注册 panellist——保证图标出现时对应面板已在册
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_KEY,
              order: 20, // 0=插件, 10=自动化任务 → 20 紧随其后
              label: function () { return t('button.label') }
            },
            FdePanelIcon
          )
        })
      }, 'fde-console: sidebar.panellist entry')
    }

    module.exports.inject = inject
    module.exports.apply = apply
    return module.exports
  }
})
