// fetch 封装：统一 JSON 错误体 {"error":{"code","message"}} → ApiError；
// ?mock=1 时全部改走 web/mock.json 内存副本（零出网），由 mock.js 注册处理器
//
// WP4 插件化（SPEC-PLUGIN 2.3）：视图层仍写 '/api/...' 字面量（F1-F5 断言锚点不动），
// 出口在此统一改写为宿主前缀路由 API_BASE（/fde-api/*）；独立版回退 = API_BASE 改回 '/api'
// （SPEC-PLUGIN 2.6）。mock 分支不做改写：mock.js 路由表按 '/api/*' 契约匹配，语义不变。

export const API_BASE = '/fde-api';

// '/api' 与 '/api/xxx' → API_BASE 前缀；其余路径（含带 query）原样放行
function toApiUrl(path) {
  if (path === '/api') return API_BASE;
  if (path.startsWith('/api/')) return API_BASE + path.slice(4);
  return path;
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || '请求失败');
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'UNKNOWN';
  }
}

export const isMock = (() => {
  try {
    if (typeof location === 'undefined') return false;
    const sp = new URLSearchParams(location.search);
    return sp.has('mock') && sp.get('mock') !== '0';
  } catch { return false; }
})();

let mockHandler = null;
export function registerMock(fn) { mockHandler = fn; }
export function getMockHandler() { return mockHandler; }

async function request(path, { method = 'GET', body } = {}) {
  if (isMock) {
    if (!mockHandler) {
      // 动态加载 mock 后端，避免非 mock 模式下的多余请求
      const mod = await import('./mock.js');
      if (!mockHandler) throw new ApiError(0, 'MOCK_INIT', 'mock 处理器未注册');
      void mod;
    }
    return mockHandler(path, { method, body });
  }
  let res;
  try {
    res = await fetch(toApiUrl(path), {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '无法连接服务：请确认 DSH 宿主已启动且插件已启用');
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* 空体或非 JSON */ }
  if (!res.ok) {
    const err = (data && data.error) || {};
    throw new ApiError(res.status, err.code || `HTTP_${res.status}`, err.message || `请求失败（HTTP ${res.status}）`);
  }
  return data;
}

export function api(path, opts) { return request(path, opts); }
export const apiGet = (path) => request(path);
export const apiPost = (path, body) => request(path, { method: 'POST', body });
export const apiPatch = (path, body) => request(path, { method: 'PATCH', body });
export const apiDel = (path) => request(path, { method: 'DELETE' });
