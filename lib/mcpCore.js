'use strict';

/**
 * mcpCore.js — v2.9.27 MCP 协议核心（JSON-RPC 2.0 消息分发，纯函数可直测）
 *
 * scripts/mcp-server.mjs 是 stdio 壳（stdin/stdout 接线）；本模块是无副作用的消息处理器：
 * handle(msg, configLoader) → 响应对象 | null（通知不回包）。
 * 三工具全只读：fde_list_tasks / fde_search_work / fde_agent_status——复用 lib 层纯函数，
 * config 由 configLoader() 注入（测试注入合成配置，绝不触真实 ~/.dsh）。
 */

const at = require('./agentTranscript');
const { workSearch } = require('./workSearch');
const { buildHeatmap } = require('./heatmap');
const store = require('./store');

const SERVER_INFO = { name: 'fde-console', version: require('../package.json').version };

const TOOLS = [
  {
    name: 'fde_list_tasks',
    description: '列出 FDE 指挥台任务看板的任务（可按状态过滤：todo/doing/review/done）',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '可选状态过滤', enum: ['todo', 'doing', 'review', 'done'] },
      },
    },
  },
  {
    name: 'fde_search_work',
    description: '跨任务标题/派工词/会话标题/提交说明/日报全文的统一搜索（多词 AND）',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: '查询词，空格分隔多词' } },
      required: ['q'],
    },
  },
  {
    name: 'fde_agent_status',
    description: '六源 agent 观测状态（健康 + 近 28 天会话数与活跃分钟）',
    inputSchema: { type: 'object', properties: {} },
  },
];

function dataPath(cfg, name) {
  const path = require('node:path');
  const root = require('node:path').resolve(__dirname, '..');
  const dir = path.isAbsolute(cfg.dataDir) ? cfg.dataDir : path.join(root, cfg.dataDir);
  return path.join(dir, name);
}

function toolListTasks(configLoader, args) {
  const cfg = configLoader();
  const data = store.loadTasks({ tasksPath: dataPath(cfg, 'tasks.json') });
  const want = typeof args.status === 'string' ? args.status : null;
  const tasks = (data.tasks || [])
    .filter((t) => t && (!want || t.status === want))
    .map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate, projectDir: t.projectDir || null }));
  return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
}

function toolSearchWork(configLoader, args) {
  const r = workSearch(configLoader(), String(args.q || ''), {});
  return { content: [{ type: 'text', text: JSON.stringify(r.groups, null, 2) }] };
}

function toolAgentStatus(configLoader) {
  const cfg = configLoader();
  const hm = buildHeatmap(cfg, { days: 28 });
  const health = {};
  for (const agent of at.SOURCE_IDS) {
    try {
      const page = at.listAgentSessions(cfg, { agent, limit: 1 });
      const it = (page.items || [])[0];
      health[agent] = { ok: true, lastActiveAt: it ? it.lastActiveAt : null };
    } catch (e) {
      health[agent] = { ok: false };
    }
  }
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ health, heatmap: { totalSessions: hm.totalSessions, totalMinutes: hm.totalMinutes, agents: hm.agents } }, null, 2),
    }],
  };
}

const TOOL_HANDLERS = {
  fde_list_tasks: toolListTasks,
  fde_search_work: toolSearchWork,
  fde_agent_status: toolAgentStatus,
};

/**
 * handle(msg, configLoader) → 响应对象 | null（通知不回包）
 * @param {{jsonrpc?:string, id?:number|string, method:string, params?:object}} msg
 * @param {() => object} configLoader
 */
function handle(msg, configLoader) {
  const { id, method, params } = msg || {};
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = params && params.name;
    const fn = TOOL_HANDLERS[name];
    if (!fn) return { jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具: ${name}` } };
    try {
      const result = fn(configLoader, (params && params.arguments) || {});
      return { jsonrpc: '2.0', id, result };
    } catch (e) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `工具执行失败: ${e.message}` }], isError: true },
      };
    }
  }
  if (id !== undefined && id !== null) return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法: ${method}` } };
  return null;
}

module.exports = { handle, TOOLS, SERVER_INFO };
