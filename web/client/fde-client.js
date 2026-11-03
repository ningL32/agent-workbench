// FDE 指挥台 DSH 客户端 bundle（SPEC-PLUGIN WP4）——手写零构建（零依赖纪律），
// 形态照抄 WP1 spike（E:\agent开发\fde-plugin-spike\fde-console\client.js 实测可用）：
//   window.__ModuleLoader__.load({id, factory}) 包裹，导出 cordis 客户端插件 {inject, apply}。
//
// 集成岗搬运（client 文件落位 = 插件包内 client.js）：
//   1) 包清单声明 "dsh": { "client": { "platform": "web", "inject": ["react"] } }，
//      且 exports["./client"] 指向本文件（宿主下发路径 /plugins/<包名>/client.js）；
//   2) BUNDLE_ID 必须改为发布包名——宿主 dsh-client-modules 校验「bundle 脚本必须以
//      图谱 id 注册」，id 与包名不符 = "loaded without registering" 启动失败；
//   3) 路由契约（后端 WP2）：SPA 静态 = /fde/*（入口 /fde/index.html），API = /fde-api/*。
//
// 行为（SPEC-PLUGIN 2.3）：
//   - sidebar.footer.action（list slot，收 { wide } props）：「FDE 指挥台」按钮，开合面板；
//   - shell.overlay（list slot）：iframe src="/fde/index.html" 挂宿主 overlayLayer
//     （absolute inset:0 z-index:20），三种显示模式：分栏 dock（默认，右侧 ≤72%，不遮宿主
//     侧栏）、浮窗 float（右下角窗体）、全屏 full（铺满，2.9.8 前的唯一形态）；选择存
//     localStorage（fdec-mode）。关闭只隐藏不销毁 iframe（保 SPA hash 路由与页面状态），
//     iframe 首次打开才创建、之后常驻。
// React 经宿主注入（require('react')，dsh.client.inject 声明依赖边），无 JSX、无打包链。

var BUNDLE_ID = 'fde-console'; // 集成岗注意：必须与发布 npm 包名一致（见文件头注 2）

window.__ModuleLoader__.load({
  id: BUNDLE_ID,
  factory: function (require) {
    var React = require('react')
    var module = { exports: {} }

    // ---- 样式：宿主同款 <style data-plugin> 注入（变量名取自宿主 sidebar/layout 源码，带兜底值）----
    var CSS = [
      '.fdec-btn{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;min-width:0;',
      'height:38px;margin:0 2px 8px;padding:8px 16px;border:1px solid var(--dsw-alias-border-l2,#30343c);',
      'border-radius:12px;background:var(--dsw-alias-button-elevated-fill,#1b1e24);',
      'color:var(--dsw-alias-label-primary,#e8eaed);font-family:inherit;font-size:14px;font-weight:500;',
      'line-height:22px;cursor:pointer;overflow:hidden;text-align:left}',
      '.fdec-btn:hover,.fdec-btn[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover,#262a32)}',
      '.fdec-btn[aria-pressed=true]{border-color:var(--dsw-alias-border-l3,#3d434d)}',
      '.fdec-btn .fdec-btn-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.fdec-btn[data-rail=true]{width:36px;height:36px;margin:0 0 8px;padding:0;justify-content:center;',
      'border-color:transparent;background:transparent}',
      '.fdec-btn[data-rail=true]:hover{background:var(--dsw-alias-interactive-bg-hover,#262a32)}',
      '.fdec-overlay{position:absolute;display:flex;flex-direction:column;',
      'background:var(--dsw-alias-bg-base,#0f1216)}',
      '.fdec-mode-full{inset:0}',
      '.fdec-mode-dock{top:0;right:0;bottom:0;left:var(--fdec-dock-left,250px);',
      'border-left:1px solid var(--dsw-alias-border-l2,#30343c);box-shadow:-12px 0 32px rgba(0,0,0,.35)}',
      '.fdec-mode-float{right:24px;bottom:24px;left:auto;top:auto;width:min(1080px,78vw);',
      'height:min(82vh,820px);min-width:420px;border:1px solid var(--dsw-alias-border-l2,#30343c);',
      'border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.5);overflow:hidden}',
      '.fdec-overlay[data-closed=true]{display:none}',
      '.fdec-modebtn[aria-pressed=true]{border-color:var(--dsw-alias-border-l3,#3d434d);',
      'background:var(--dsw-alias-interactive-bg-hover,#262a32)}',
      // 宿主无边框壳的标题栏拖拽区/窗口控制条占窗口顶部（实测 ~36px），dock/full 的条
      // 加垫高把按钮挪到拦截区之下；条上按钮显式 no-drag，真实鼠标点击才可达
      '.fdec-bar button{-webkit-app-region:no-drag}',
      '.fdec-mode-dock .fdec-bar,.fdec-mode-full .fdec-bar{height:70px;padding-top:36px;',
      'box-sizing:border-box}',
      '.fdec-bar{display:flex;align-items:center;gap:8px;flex:none;height:34px;padding:0 8px 0 14px;',
      'border-bottom:1px solid var(--dsw-alias-border-l2,#30343c);',
      'background:var(--dsw-specific-sidebar-fill,#16181d);',
      'color:var(--dsw-alias-label-secondary,#9aa0a8);font-family:inherit;font-size:12px}',
      '.fdec-bar-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.fdec-close{display:inline-flex;align-items:center;gap:4px;flex:none;height:24px;padding:0 10px;',
      'border:1px solid var(--dsw-alias-border-l2,#30343c);border-radius:8px;background:transparent;',
      'color:var(--dsw-alias-label-primary,#e8eaed);font-family:inherit;font-size:12px;cursor:pointer}',
      '.fdec-close:hover{background:var(--dsw-alias-interactive-bg-hover,#262a32)}',
      '.fdec-frame{flex:1;width:100%;border:none;background:#0f1216}'
    ].join('')
    if (typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css="' + BUNDLE_ID + '/client.css"]') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = BUNDLE_ID
      tag.dataset.pluginCss = BUNDLE_ID + '/client.css'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ---- overlay 开合状态：两个 slot 条目同 bundle，模块级单例共享 ----
    var overlayOpen = false
    var overlayListeners = new Set()
    function getOverlayOpen() { return overlayOpen }
    function setOverlayOpen(next) {
      next = !!next
      if (next === overlayOpen) return
      overlayOpen = next
      overlayListeners.forEach(function (fn) {
        try { fn() } catch (e) { /* 单个订阅者异常不扩散 */ }
      })
    }
    function subscribeOverlay(fn) {
      overlayListeners.add(fn)
      return function () { overlayListeners.delete(fn) }
    }
    function useOverlayOpen() {
      var pair = React.useState(getOverlayOpen)
      React.useEffect(function () {
        return subscribeOverlay(function () { pair[1](getOverlayOpen()) })
      }, [])
      return pair[0]
    }

    // ---- 显示模式：dock 分栏（默认）/ float 浮窗 / full 全屏；选择持久化 localStorage ----
    function readSavedMode() {
      try {
        var v = localStorage.getItem('fdec-mode')
        return (v === 'full' || v === 'float' || v === 'dock') ? v : 'dock'
      } catch (e) { return 'dock' }
    }
    var overlayMode = readSavedMode()
    var modeListeners = new Set()
    function getOverlayMode() { return overlayMode }
    function setOverlayMode(next) {
      if (next !== 'full' && next !== 'float' && next !== 'dock') return
      if (next === overlayMode) return
      overlayMode = next
      try { localStorage.setItem('fdec-mode', next) } catch (e) { /* 存储不可用时仅不记忆 */ }
      modeListeners.forEach(function (fn) {
        try { fn() } catch (e) { /* 单个订阅者异常不扩散 */ }
      })
    }
    function subscribeOverlayMode(fn) {
      modeListeners.add(fn)
      return function () { modeListeners.delete(fn) }
    }
    function useOverlayMode() {
      var pair = React.useState(getOverlayMode)
      React.useEffect(function () {
        return subscribeOverlayMode(function () { pair[1](getOverlayMode()) })
      }, [])
      return pair[0]
    }

    // ---- 图标：内联 SVG（终端符），不依赖宿主 primitives 的导出名 ----
    function TerminalIcon() {
      return React.createElement('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { flex: 'none' }
      },
        React.createElement('polyline', { points: '4 17 10 11 4 5' }),
        React.createElement('line', { x1: '12', y1: '19', x2: '20', y2: '19' })
      )
    }

    // ---- sidebar.footer.action 条目：收 { wide }（收窄成 rail 时只显图标）----
    function FdeConsoleButton(props) {
      var wide = !!(props && props.wide)
      var open = useOverlayOpen()
      var children = [React.createElement(TerminalIcon, { key: 'icon' })]
      if (wide) {
        children.push(React.createElement('span', { key: 'label', className: 'fdec-btn-label' }, 'FDE 指挥台'))
      }
      return React.createElement('button', {
        type: 'button',
        className: 'fdec-btn',
        'data-rail': wide ? undefined : 'true',
        'aria-pressed': open,
        'aria-label': 'FDE 指挥台',
        title: open ? '关闭 FDE 指挥台' : '打开 FDE 指挥台',
        onClick: function () { setOverlayOpen(!getOverlayOpen()) }
      }, children)
    }

    // ---- 分栏贴边：量壳侧栏右缘，面板从侧栏边铺起（消除右宽定值留下的宿主内容夹缝）----
    function applyDockLeft(el) {
      try {
        if (!el) return
        var layer = el.offsetParent || document.documentElement
        var lr = layer.getBoundingClientRect()
        var cands = document.querySelectorAll('aside,[class*="sidebar"],[class*="Sidebar"]')
        var best = 0
        for (var i = 0; i < cands.length; i++) {
          var r = cands[i].getBoundingClientRect()
          if (r.left - lr.left <= 2 && r.width >= 40 && r.width <= 360 && r.height > window.innerHeight * 0.5) {
            var edge = r.right - lr.left
            if (edge > best) best = edge
          }
        }
        if (best) layer.style.setProperty('--fdec-dock-left', Math.min(best, lr.width * 0.6) + 'px')
      } catch (e) { /* 量测失败吃 CSS 缺省 250px */ }
    }

    // ---- shell.overlay 条目：iframe 首开后常驻（关闭仅 display:none，SPA 状态保留）----
    var frameEverOpened = false
    function FdeOverlay() {
      var open = useOverlayOpen()
      var mode = useOverlayMode()
      var dockRef = React.useRef(null)
      var mountedPair = React.useState(frameEverOpened)
      var mounted = mountedPair[0], setMounted = mountedPair[1]
      React.useEffect(function () {
        if (open && !frameEverOpened) {
          frameEverOpened = true
          setMounted(true)
        }
      }, [open, setMounted])
      React.useEffect(function () {
        if (!open) return undefined
        var onKey = function (e) { if (e && e.key === 'Escape') setOverlayOpen(false) }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [open])
      React.useEffect(function () {
        if (!open || mode !== 'dock') return undefined
        applyDockLeft(dockRef.current)
        var onResize = function () { applyDockLeft(dockRef.current) }
        window.addEventListener('resize', onResize)
        return function () { window.removeEventListener('resize', onResize) }
      }, [open, mode])
      var bar = React.createElement('div', { className: 'fdec-bar' },
        React.createElement('span', { className: 'fdec-bar-title' }, 'FDE 指挥台'),
        React.createElement('button', {
          type: 'button',
          className: 'fdec-close fdec-modebtn',
          'aria-pressed': mode === 'dock',
          title: '分栏显示（右侧，不遮挡宿主界面）',
          onClick: function () { setOverlayMode('dock') }
        }, '分栏'),
        React.createElement('button', {
          type: 'button',
          className: 'fdec-close fdec-modebtn',
          'aria-pressed': mode === 'float',
          title: '浮窗显示（右下角窗体）',
          onClick: function () { setOverlayMode('float') }
        }, '浮窗'),
        React.createElement('button', {
          type: 'button',
          className: 'fdec-close fdec-modebtn',
          'aria-pressed': mode === 'full',
          title: '全屏覆盖',
          onClick: function () { setOverlayMode('full') }
        }, '全屏'),
        React.createElement('button', {
          type: 'button',
          className: 'fdec-close',
          title: '关闭（Esc）',
          onClick: function () { setOverlayOpen(false) }
        }, '✕ 关闭'))
      var frame = mounted ? React.createElement('iframe', {
        className: 'fdec-frame',
        src: '/fde/index.html',
        title: 'FDE 指挥台'
      }) : null
      return React.createElement('div', {
        ref: function (el) { dockRef.current = el },
        className: 'fdec-overlay fdec-mode-' + mode,
        'data-closed': !open,
        'aria-hidden': !open
      }, bar, frame)
    }

    var inject = ['slots']

    function apply(ctx) {
      // slots.inject(key, cb)：等宿主声明该 slot 再注册（声明前/后 apply 均安全）
      ctx.effect(function () {
        return ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register(
            { name: 'shell.overlay', id: BUNDLE_ID + '-overlay', order: 100, label: 'FDE Console' },
            FdeOverlay
          )
        })
      }, 'fde-console: shell.overlay iframe')
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register(
            { name: 'sidebar.footer.action', id: BUNDLE_ID, order: 100, label: 'FDE Console' },
            FdeConsoleButton
          )
        })
      }, 'fde-console: sidebar.footer.action entry')
      // 点外即熄：面板开着时，点宿主任意位置（面板与开关之外）自动收起——
      // 侧栏导航/新会话等宿主交互不应被覆盖层挡住；iframe 内点击不冒泡到宿主
      // 文档，指挥台内的操作天然不受影响
      ctx.effect(function () {
        if (typeof document === 'undefined') return undefined
        var onDocPointerDown = function (e) {
          if (!getOverlayOpen()) return
          var t = e.target
          if (t && t.closest && (t.closest('.fdec-overlay') || t.closest('.fdec-btn'))) return
          setOverlayOpen(false)
        }
        document.addEventListener('pointerdown', onDocPointerDown, true)
        return function () { document.removeEventListener('pointerdown', onDocPointerDown, true) }
      }, 'fde-console: 点外熄灭')
    }

    module.exports.inject = inject
    module.exports.apply = apply
    return module.exports
  }
})
