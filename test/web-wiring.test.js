'use strict';

/**
 * web-wiring.test.js — 前端接线完备性守卫（v2.9.99）
 *
 * 事故（2026-11-28 业主真机）：调研页「上传附件」按钮点了没反应。考古：v2.9.90 实现时接线齐全，
 * v2.9.92 布局改版重写 renderMain/wireMain 时把 附件/文件选择/语音 三段 addEventListener 整段弄丢——
 * 模板还在、按钮还在、事件没了。语法检查抓不住（代码合法），后端测试更抓不住，直到业主点击。
 *
 * 本守卫的口径：**渲染出的每个交互控件都必须有事件监听**。不模拟真实点击穿透（那需要完整 DOM，
 * 零依赖做不到），而是用最小 DOM 桩把真实视图模块加载进 Node、喂真实形态的 mock 数据、跑完
 * render → 场景点击 → 详情渲染全链路，然后断言已知交互控件清单逐一有监听。以后任何人往模板里
 * 加按钮忘了接线（或改版时弄丢），这条守卫当场红。
 *
 * 零第三方依赖：DOM 桩只实现本视图用到的面（innerHTML 正则登记 id/class/data-id、
 * querySelector(All) 按 id/class 扁平查找、addEventListener 记录）。fetch 桩返回研究模块的
 * 真实形态数据（列表/详情/流程图），不出网。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ------------------------------------------------------------------ DOM 桩

function makeDom() {
  const byId = new Map();
  const byClass = new Map(); // class -> [elements]

  function makeEl(id) {
    const el = {
      id: id || '',
      classes: [],
      dataset: {},
      attrs: {},
      style: {},
      listeners: {}, // type -> [fn]
      hidden: false,
      value: '',
      textContent: '',
      files: [],
      // innerHTML:登记其中出现的每个开标签(扁平,不建树——接线守卫只需要按选择器找到元素)
      set innerHTML(html) {
        const re = /<([a-z]+)((?:\s+[^<>]*?)?)>/g;
        let m;
        while ((m = re.exec(String(html))) !== null) {
          const attrs = m[2] || '';
          const idm = /\bid="([^"]+)"/.exec(attrs);
          const e = makeEl(idm ? idm[1] : '');
          const cls = /class="([^"]*)"/.exec(attrs);
          if (cls) e.classes = cls[1].split(/\s+/).filter(Boolean);
          const did = /data-id="([^"]*)"/.exec(attrs);
          if (did) e.dataset.id = did[1];
          if (e.id) byId.set(e.id, e);
          for (const c of e.classes) {
            if (!byClass.has(c)) byClass.set(c, []);
            if (!byClass.get(c).includes(e)) byClass.get(c).push(e);
          }
        }
      },
      get innerHTML() { return ''; },
      set textContent_(v) { this.textContent = v; },
      querySelector(sel) { return query(sel); },
      querySelectorAll(sel) { return queryAll(sel); },
      addEventListener(type, fn) {
        (this.listeners[type] = this.listeners[type] || []).push(fn);
        (byClass.__events = byClass.__events || []).push({ el: this, type });
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; },
      classList: null, // 下面补
      appendChild() {},
      append() {},
      focus() {},
      closest() { return null; },
      contains() { return false; },
      scrollIntoView() {},
      click() {}, // fileInput.click():测试环境不开文件框,无操作
    };
    el.classList = {
      add: (c) => { if (!el.classes.includes(c)) el.classes.push(c); },
      remove: (c) => { el.classes = el.classes.filter((x) => x !== c); },
      toggle: () => {},
      contains: (c) => el.classes.includes(c),
    };
    return el;
  }

  function query(sel) {
    let m;
    if ((m = /^#([\w-]+)$/.exec(sel))) return byId.get(m[1]) || null;
    if ((m = /^\.([\w-]+)$/.exec(sel))) return (byClass.get(m[1]) || [])[0] || null;
    return null;
  }
  function queryAll(sel) {
    let m;
    if ((m = /^#([\w-]+)$/.exec(sel))) return byId.has(m[1]) ? [byId.get(m[1])] : [];
    if ((m = /^\.([\w-]+)$/.exec(sel))) return byClass.get(m[1]) || [];
    return [];
  }

  const root = makeEl('test-root');
  const document = {
    createElement: (tag) => makeEl(''),
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => (sel === '#test-root' ? root : query(sel)),
    querySelectorAll: (sel) => queryAll(sel),
    body: makeEl('body'),
    addEventListener() {},
  };

  function wiredIds() {
    const out = new Map(); // id -> Set(types)
    for (const [id, el] of byId) {
      const types = Object.keys(el.listeners);
      if (types.length) out.set(id, new Set(types));
    }
    return out;
  }
  return { root, document, wiredIds, byId, byClass };
}

// ------------------------------------------------------------------ 数据桩(真实形态)

const INTERVIEW = { id: 'res_1', sceneTitle: '接线守卫场景', projectDir: 'E:/demo/wiring', status: 'open', createdAt: '2026-11-28T00:00:00Z' };
const DETAIL = {
  interview: {
    ...INTERVIEW,
    attachments: [{ id: 'a1', name: 'sop.txt', bytes: 120, kind: 'text' }],
    contextMeta: { coverage: { v: 1, steps: [], stakeholders: {}, baseline: {}, assumptions: [] } },
  },
  messages: [
    { id: 'm1', interviewId: 'res_1', role: 'client', kind: 'normal', text: '客户发言', ts: '2026-11-28T00:00:01Z' },
  ],
  drafts: [
    { id: 'dr_1', interviewId: 'res_1', status: 'pending', quote: '原话', payload: { title: '草稿一', desc: '目标', priority: 'high' } },
    { id: 'dr_2', interviewId: 'res_1', status: 'accepted', quote: '原话', taskId: 't_1', payload: { title: '已收草稿', desc: '目标', priority: 'medium' } },
  ],
  gate: {
    assessed: true,
    open: [], unavailable: [], answered: [],
    items: [
      { group: 'stakeholder', key: 'owner', label: '业务责任人', status: 'answered', quote: '原话', value: '', estimated: false, text: '' },
      { group: 'baseline', key: 'time', label: '耗时', status: 'missing', quote: '', value: '', estimated: false, text: '' },
    ],
    counts: { total: 2, answered: 1, unavailable: 0, open: 1 },
  },
};

/** fetch 桩:研究模块会用到的全部端点。返回最小 Response 形状(apiGet 只用 ok/status/json)。 */
function installFetchStub() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const j = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (/\/research\/interviews\/res_1\/flow(\.mmd|\.svg)?/.test(u)) return j({ nodes: [], edges: [] });
    if (/\/research\/interviews\/res_1$/.test(u)) return j(DETAIL);
    if (/\/research\/interviews$/.test(u)) return j([INTERVIEW]);
    return { ok: false, status: 404, json: () => Promise.resolve({}) };
  };
  return () => { globalThis.fetch = realFetch; };
}

// ------------------------------------------------------------------ 环境桩 + 用例

/** 调研视图的交互控件 → 期望的监听事件。往模板里加新按钮时,在这里登记。 */
const EXPECTED_WIRED = [
  ['rs-new', 'click'],
  ['rs-send', 'click'],
  ['rs-close', 'click'],
  ['rs-gen-proposal', 'click'],
  ['rs-decompose', 'click'],
  ['rs-exp-report', 'click'],
  ['rs-exp-bpmn', 'click'],
  ['rs-flow-refresh', 'click'],
  ['rs-flow-mmd', 'click'],
  ['rs-mic', 'click'],
  ['rs-paperclip', 'click'],
  ['rs-file', 'change'],
  ['rs-exit-fold', 'click'],
  ['rs-draft-fold', 'click'],
];

test('调研视图:render→打开详情全链路跑通,已知交互控件逐一有事件监听(附件/语音不得再丢)', async () => {
  // Arrange:DOM/window/FileReader 桩先于模块加载(视图模块顶层虽不碰 DOM,但事件回调里会碰)
  const dom = makeDom();
  globalThis.document = dom.document;
  globalThis.window = { SpeechRecognition: class { start() {} stop() {} }, webkitSpeechRecognition: undefined, isSecureContext: true };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  // navigator 在 Node ≥21 是只读全局,不桩(只有未触达的剪贴板回调会用到)
  globalThis.FileReader = class { readAsDataURL() { this.onload && this.onload(); } };
  globalThis.openModal = undefined; // 未触达
  const restoreFetch = installFetchStub();
  let view;
  try {
    view = await import(pathToFileURL(path.join(__dirname, '..', 'web', 'js', 'views', 'research.js')).href);

    // Act:render → invoke 场景按钮监听(与真实点击等价:监听器是普通函数)
    await view.render(dom.root);
    const sceneEls = dom.byClass.get('rs-scene') || [];
    assert.ok(sceneEls.length >= 1 && (sceneEls[0].listeners.click || []).length >= 1, '场景按钮有 click 监听');
    await sceneEls[0].listeners.click[0]();
    await new Promise((r) => setImmediate(r)); // openDetail 内部 Promise 链落定

    // Assert:逐一核对期望的接线
    const wired = dom.wiredIds();
    const missing = EXPECTED_WIRED.filter(([id]) => !wired.has(id)).map(([id]) => id);
    assert.deepEqual(missing, [], `以下交互控件渲染了但没接事件(点击无反应): ${missing.join(', ')}`);
    for (const [id, type] of EXPECTED_WIRED) {
      assert.ok(wired.get(id).has(type), `#${id} 缺 ${type} 监听`);
    }
    // 动态控件:草稿 accept/reject(有 pending 草稿时必须接线)
    const accept = (dom.byClass.get('d-accept') || []).filter((e) => (e.listeners.click || []).length);
    const reject = (dom.byClass.get('d-reject') || []).filter((e) => (e.listeners.click || []).length);
    assert.ok(accept.length >= 1 && reject.length >= 1, '草稿闸门的 accept/reject 按钮已接线');
  } finally {
    restoreFetch();
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.localStorage;
    delete globalThis.FileReader;
  }
});
