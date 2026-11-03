'use strict';

/**
 * appAssembler.js — WP3 测试装配器：server.js 装配逻辑的单一真相（可注入 config 的纯装配）
 *
 * buildApp({configPath, configDir, rootDir, env, persistentEnv, poller})
 *   → { ctx, router, config, configPath, version,
 *       handle,       // 边界管线：Host 头校验(403) → Sec-Fetch-Site 校验(403) → /api/* 分发 | 其余静态
 *       handleApi,    // router.dispatch 直通（插件态 adapter 在自己防线内直委，见 plugin/adapter.js）
 *       handleStatic, // 静态托管直通（plugin/static.js）
 *       fetch,        // 进程内 mock 客户端：createMockReq/createMockRes + handle，fetch 形响应答
 *       pollTick,     // Gitea 轮询单飞 tick（插件态由宿主 ctx.interval 驱动）
 *       close }       // 收尾：停轮询定时器、还原 persistentEnv
 *
 * 与旧 server.js 的唯一语义差异：
 *   1. 启动期校验失败由 process.exit(2) 改为 throw（独立版 server.js catch 后仍打印 [config] 并 exit 2，
 *      消息文本一致——radar 启动期体检用例因此平移为 assert.throws 断言装配器）；
 *   2. host 校验放宽为 127.0.0.1|0.0.0.0（SPEC-PLUGIN 2.1：与宿主 webServer schema 同源，业主拍板允许
 *      显式配置 LAN 绑定）；监听权在独立版仍属 server.js、插件态属宿主，本模块从不 listen。
 *
 * mock 传输层（真端口用例 → router.handle(mockReq, mockRes) 的迁移底座）：
 *   - createMockReq/createMockRes 实现 router.dispatch/readBody/静态/adapter 所需的
 *     IncomingMessage/ServerResponse 最小面（on/destroy/url/headers/method、writeHead/setHeader/end/headersSent）；
 *   - app.fetch(method, p, {headers, body}) 走与 http 层完全相同的 app.handle 管线；
 *   - env 注入：独立版按子进程 env 注 fixture（DINGTALK_FIXTURE/GITEA_FIXTURE/...）；
 *     进程内改为分发期间临时注入（persistentEnv 时在 build 即写入、close 还原，供 radar 后台 job 在
 *     响应之后继续读 env 的场景）。（v2.2：网关 fixture 型 env 键特判随网关集成移除，不再特判）
 *   - 并发约定：同进程多 app 的 env 注入依赖 node:test 同文件内用例串行执行（现状即如此）。
 */

const path = require('path');

const {
  Router,
  sendJSON,
  sendError,
  noContent,
  HttpError,
  mountGiteaRoutes,
} = require('../../lib/router');
const store = require('../../lib/store');
const settingsMod = require('../../lib/settings');
const overviewMod = require('../../lib/overview');
const membersMod = require('../../lib/members');
const setupRoutesMod = require('../../lib/routes-setup');
const taskEvents = require('../../lib/taskEvents');
const diaryMod = require('../../lib/diary');
const agentTranscriptMod = require('../../lib/agentTranscript');
const sessionRefMod = require('../../lib/sessionRef');
const attributeMod = require('../../lib/attribute');
const workSearchMod = require('../../lib/workSearch');
const sessionSuggestMod = require('../../lib/sessionSuggest');
const { serveStatic } = require('../../plugin/static');

// 应用版本：直接取根 package.json，避免「发版改了 package.json、这里忘了同步」的漂移
// （曾出现 ping 仍报 2.9.13 而实际已跑 2.9.15 的假象）。
const VERSION = require('../../package.json').version;

// ---------- ID 生成 ----------

/** t-<base36 时间戳>-<4 位随机> */
function genTaskId(existing) {
  const taken = new Set(existing.map((t) => t.id));
  let id;
  do {
    id = `t-${Date.now().toString(36)}-${store.randomToken(4)}`;
  } while (taken.has(id));
  return id;
}

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------- B2：任务 / 列 ----------

function registerTaskRoutes(router, ctx) {
  const TASK_WRITABLE = ['title', 'status', 'agentId', 'repo', 'branch', 'prUrl', 'notes'];

  function validateTitle(v) {
    if (typeof v !== 'string' || v.trim().length < 1 || v.trim().length > 200) {
      throw new HttpError(400, 'TITLE_INVALID', 'title 必填且为 1..200 字符');
    }
    return v.trim();
  }

  function requireColumn(columns, status) {
    if (!columns.some((c) => c.id === status)) {
      throw new HttpError(400, 'COLUMN_NOT_FOUND', `列 "${status}" 不存在`);
    }
  }

  function nullableString(v) {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new HttpError(400, 'FIELD_INVALID', '字段必须为字符串或 null');
    return v;
  }

  // v1.2：任务负责成员（人类成员 id，≤64 字符；不强制存在于名册，可与 agentId 同设）
  // v2.0：泛化为 nullableMemberId(v, label)，复用于验收签字人 acceptorId（同一校验语义与 64 字符上限）
  function nullableMemberId(v, label) {
    const key = label || 'memberId';
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new HttpError(400, 'FIELD_INVALID', `${key} 必须为字符串或 null`);
    if (v.length > 64) throw new HttpError(400, 'FIELD_INVALID', `${key} 长度不能超过 64 字符`);
    return v;
  }

  // v1.2：任务多行描述（≤2000 字符，允许空串与多行，缺省 ""）
  function validateDesc(v) {
    if (v === undefined) return '';
    if (typeof v !== 'string') throw new HttpError(400, 'FIELD_INVALID', 'desc 必须为字符串');
    if (v.length > 2000) throw new HttpError(400, 'FIELD_INVALID', 'desc 长度不能超过 2000 字符');
    return v;
  }

  // #7：URL 字段仅接受 http(s)，杜绝 javascript: 等伪协议落库被前端当链接渲染
  const HTTP_URL_RE = /^https?:\/\/\S+$/i;
  function nullableUrl(v, label) {
    const s = nullableString(v);
    if (s === null || s.trim() === '') return null;
    const t = s.trim();
    if (!HTTP_URL_RE.test(t)) throw new HttpError(400, 'URL_INVALID', `${label} 必须为 http(s):// 开头的 URL`);
    return t;
  }

  // v1.4：任务截止时间（YYYY-MM-DD 字符串或 null）。正则通过后还需本地日历回读校验，
  // 拦住 2026-13-99、2026-02-30 这类正则通过但日历不存在/溢出的日期——
  // 注意 V8 的 new Date('2026-02-30') 会滚动到 3 月 2 日所以不能只判 NaN。
  // 允许过去日期，不做逾期拦截。
  const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function nullableDueDate(v) {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || !DUE_DATE_RE.test(v)) {
      throw new HttpError(400, 'FIELD_INVALID', 'dueDate 必须为 YYYY-MM-DD 格式字符串或 null');
    }
    const parts = v.split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
      throw new HttpError(400, 'FIELD_INVALID', 'dueDate 不是有效日期');
    }
    return v;
  }

  // v1.4：任务优先级（high/medium/low；undefined/null/'' 缺省 medium，非法值 400）
  const PRIORITIES = ['high', 'medium', 'low'];
  function normalizePriority(v) {
    if (v === undefined || v === null || v === '') return 'medium';
    if (!PRIORITIES.includes(v)) {
      throw new HttpError(400, 'FIELD_INVALID', 'priority 必须为 high/medium/low 之一');
    }
    return v;
  }

  router.add('GET', '/api/tasks', (c) => {
    const { tasks } = store.loadTasks(ctx);
    let out = tasks;
    const status = c.query.get('status');
    if (status) out = out.filter((t) => t.status === status);
    const memberId = c.query.get('memberId');
    if (memberId) out = out.filter((t) => t.memberId === memberId);
    // v1.4：priority 查询过滤，与既有 status/q/memberId 完全叠加；取值非法时自然过滤为空数组，不额外报错
    const priority = c.query.get('priority');
    if (priority) out = out.filter((t) => t.priority === priority);
    const q = (c.query.get('q') || '').trim().toLowerCase();
    if (q) {
      out = out.filter((t) =>
        [t.title, t.branch, t.notes, t.desc].some((f) => typeof f === 'string' && f.toLowerCase().includes(q))
      );
    }
    // v2.9.7：projectDir 过滤（归一口径与项目绑定/会话钻取一致：去尾分隔符+分隔符统一+小写）
    const projectDir = (c.query.get('projectDir') || '').trim();
    if (projectDir) {
      const want = agentTranscriptMod.normalizeProjectKey(projectDir);
      out = out.filter((t) => agentTranscriptMod.normalizeProjectKey(t.projectDir) === want);
    }
    // v2.9.15：成果提交说明读取时回填（url ↔ activities.json 映射，仅响应不落盘；
    // 存量任务/手动挂接的成果在活动窗口内自动带出 title/messageBody）
    attributeMod.backfillArtifactMeta(out, store.loadActivities(ctx));
    sendJSON(c.res, 200, store.clone(out));
  });

  router.add('POST', '/api/tasks', (c) => {
    const data = store.loadTasks(ctx);
    const body = c.body || {};
    const title = validateTitle(body.title);
    const status = body.status === undefined || body.status === null || body.status === '' ? 'todo' : body.status;
    requireColumn(data.columns, status);

    const now = new Date().toISOString();
    const task = {
      id: genTaskId(data.tasks),
      title,
      status,
      agentId: nullableString(body.agentId),
      memberId: nullableMemberId(body.memberId),
      // v2.0：验收签字人 acceptorId（完成工作的验收签字，与 memberId 负责人、agentId 执行者三方独立；
      // 不校验存在于名册）
      acceptorId: nullableMemberId(body.acceptorId, 'acceptorId'),
      repo: nullableString(body.repo),
      branch: nullableString(body.branch),
      // v2.9.4：项目级绑定——任务关联一个项目目录（ambient 关联，不自动产生 artifacts；
      // null=未绑定。语义口径见 SPEC「项目绑定」）
      projectDir: nullableString(body.projectDir),
      prUrl: nullableUrl(body.prUrl, 'prUrl'),
      notes: typeof body.notes === 'string' ? body.notes : '',
      desc: validateDesc(body.desc),
      dueDate: nullableDueDate(body.dueDate), // v1.4：截止时间（YYYY-MM-DD 或 null）
      priority: normalizePriority(body.priority), // v1.4：优先级（缺省 medium）
      artifacts: [], // v1.9（Q3-L1）：Gitea 成果手动挂接；存量任务无字段容错（读写两端均容忍缺失）
      // v1.7：完成日期——创建即落在内置 done 列时记当前时间，否则 null
      completedAt: status === 'done' ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    data.tasks.push(task);
    store.saveTasks(ctx, data);
    // v1.7：created 事件（detail 含 origin 来源描述，如有）
    taskEvents.appendEvents(ctx, [taskEvents.createdEvent(task, now)]);
    sendJSON(c.res, 201, store.clone(task));
  });

  router.add('GET', '/api/tasks/:id', (c) => {
    const { tasks } = store.loadTasks(ctx);
    const task = tasks.find((t) => t.id === c.params.id);
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    // v1.7：详情带事件流（倒序最近 100 条）；存量老任务无事件自然为空数组，不回填
    const events = taskEvents.eventsForTask(ctx, task.id);
    // v2.9.15：成果提交说明读取时回填（同 GET 列表口径，仅响应不落盘）
    attributeMod.backfillArtifactMeta([task], store.loadActivities(ctx));
    sendJSON(c.res, 200, Object.assign(store.clone(task), { events }));
  });

  router.add('PATCH', '/api/tasks/:id', (c) => {
    const data = store.loadTasks(ctx);
    const task = data.tasks.find((t) => t.id === c.params.id);
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    const body = c.body || {};
    // v1.7：事件流需要变更前快照（每字段类型最多一条，防噪合并）
    const before = taskEvents.snapshotOf(task);
    if (body.title !== undefined) task.title = validateTitle(body.title);
    if (body.status !== undefined) {
      requireColumn(data.columns, body.status);
      task.status = body.status;
    }
    if (body.agentId !== undefined) task.agentId = nullableString(body.agentId);
    if (body.memberId !== undefined) task.memberId = nullableMemberId(body.memberId);
    // v2.0：验收签字人——PATCH 传 null 即清除
    if (body.acceptorId !== undefined) task.acceptorId = nullableMemberId(body.acceptorId, 'acceptorId');
    if (body.repo !== undefined) task.repo = nullableString(body.repo);
    if (body.branch !== undefined) task.branch = nullableString(body.branch);
    // v2.9.4：项目级绑定——PATCH 传 null 即解绑
    if (body.projectDir !== undefined) task.projectDir = nullableString(body.projectDir);
    if (body.prUrl !== undefined) task.prUrl = nullableUrl(body.prUrl, 'prUrl');
    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string') throw new HttpError(400, 'FIELD_INVALID', 'notes 必须为字符串');
      task.notes = body.notes;
    }
    if (body.desc !== undefined) task.desc = validateDesc(body.desc);
    // v1.4：dueDate——PATCH 传 null 即清空
    if (body.dueDate !== undefined) task.dueDate = nullableDueDate(body.dueDate);
    // v1.4：priority——PATCH 时必须严格属于 PRIORITIES（null/数字/其他值一律非法，不同于 POST 的缺省 medium）
    if (body.priority !== undefined) {
      if (!PRIORITIES.includes(body.priority)) {
        throw new HttpError(400, 'FIELD_INVALID', 'priority 必须为 high/medium/low 之一');
      }
      task.priority = body.priority;
    }
    // v1.7：completedAt 完成日期——PATCH 带 status 才处置：进内置 done 列记当前时间
    //（已设则刷新为最新，重进 done 亦然）；移出 done 清为 null；不带 status 不 touch
    const now = new Date().toISOString();
    if (body.status !== undefined) {
      task.completedAt = task.status === 'done' ? now : null;
    }
    task.updatedAt = now;
    store.saveTasks(ctx, data);
    // v1.7：PATCH 差异事件（在任务落盘成功后追加；每字段类型最多一条）
    taskEvents.appendEvents(ctx, taskEvents.patchEvents(task.id, before, taskEvents.snapshotOf(task), now));
    sendJSON(c.res, 200, store.clone(task));
  });

  router.add('DELETE', '/api/tasks/:id', (c) => {
    const data = store.loadTasks(ctx);
    const idx = data.tasks.findIndex((t) => t.id === c.params.id);
    if (idx === -1) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    data.tasks.splice(idx, 1);
    store.saveTasks(ctx, data);
    // v1.7：删任务顺带清理其事件（文件本就无该任务事件时不写盘）
    taskEvents.removeTaskEvents(ctx, c.params.id);
    // v2.7：删任务顺带清理其全部日报（同纪律：文件本就无该任务日报时不写盘）
    diaryMod.removeTaskDiaries(ctx, c.params.id);
    noContent(c.res);
  });

  // ---------- v1.9（任务叙事线第一批 · Q3-L1）：Gitea 成果手动挂接 ----------

  // v2.3 D3（SMOKE v2.3 回归 P0-A）：kind 增 'session'——会话阅读器「挂到任务成果区」闭环，
  // 该类成果无 http(s) url，以 sessionRef（不透明引用）+ title 独立字段承载（见下方 POST 分支）
  const ARTIFACT_KINDS = ['commit', 'pr', 'session'];

  // 可选字符串字段（repo/ref）：缺省 null；提供时必须为 ≤200 字符字符串
  function optionalArtifactField(v, label) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || v.trim().length > 200) {
      throw new HttpError(400, 'FIELD_INVALID', `${label} 必须为不超过 200 字符的字符串`);
    }
    return v.trim();
  }

  // 挂接成果：{url 必填 http(s)，kind 必填枚举，repo?/ref?} → 追加进 task.artifacts
  // + 事件流 type:"artifact"（时间轴「成果节点」）+ updatedAt 刷新
  // v2.3 D3（SMOKE v2.3 回归 P0-A）：kind='session' 字段语义切换——url/repo/ref 一律不入库置
  // null，不复用 ref 字段（board.js 按 PR 序号/commit 哈希渲染，双义会漏 base64 串进成果区）；
  // 改由 sessionRef（必填 ≤512 字符，过 sessionRef §3.3 校验）+ title（必填 1..200）独立承载。
  // kind 判别必须先于 url 校验（否则 kind=session 无 url 会误吃「url 必填」——即本轮回归根因）
  router.add('POST', '/api/tasks/:id/artifacts', (c) => {
    const data = store.loadTasks(ctx);
    const task = data.tasks.find((t) => t.id === c.params.id);
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    const body = c.body || {};
    if (!ARTIFACT_KINDS.includes(body.kind)) {
      throw new HttpError(400, 'FIELD_INVALID', 'kind 必须为 commit/pr/session 之一');
    }
    const now = new Date().toISOString();
    let artifact;
    let detail;
    if (body.kind === 'session') {
      const ref = typeof body.sessionRef === 'string' ? body.sessionRef : '';
      if (!ref) throw new HttpError(400, 'FIELD_INVALID', 'sessionRef 必填（kind=session）');
      if (ref.length > 512) {
        throw new HttpError(400, 'FIELD_INVALID', 'sessionRef 长度不能超过 512 字符');
      }
      sessionRefMod.validateRef(ref, ctx.config); // 格式闸（§3.3）：非法 throw 400 BAD_REF，零路径回显
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (title.length < 1 || title.length > 200) {
        throw new HttpError(400, 'FIELD_INVALID', 'title 必填且为 1..200 字符');
      }
      artifact = {
        url: null,
        kind: 'session',
        repo: null,
        ref: null,
        sessionRef: ref,
        title,
        at: now,
      };
      detail = `挂接成果：session ${title.slice(0, 40)}`;
    } else {
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      if (!url || !HTTP_URL_RE.test(url)) {
        throw new HttpError(400, 'FIELD_INVALID', 'url 必填且为 http(s):// 开头的 URL');
      }
      artifact = {
        url,
        kind: body.kind,
        repo: optionalArtifactField(body.repo, 'repo'),
        ref: optionalArtifactField(body.ref, 'ref'),
        at: now,
      };
      // 事件 detail：kind + repo（repo 缺省时不留空洞，如「挂接成果：pr」）
      detail = `挂接成果：${artifact.kind}${artifact.repo ? ` ${artifact.repo}` : ''}`;
    }
    if (!Array.isArray(task.artifacts)) task.artifacts = []; // 存量任务无字段容错：首次挂接时初始化
    task.artifacts.push(artifact);
    task.updatedAt = now;
    store.saveTasks(ctx, data);
    taskEvents.appendEvents(ctx, [taskEvents.makeEvent(task.id, 'artifact', null, null, detail, now)]);
    sendJSON(c.res, 201, store.clone(artifact));
  });

  // 解除挂接：按数组下标移除；不记事件（列表即真相）；越界/非法下标/任务缺失均 404
  router.add('DELETE', '/api/tasks/:id/artifacts/:idx', (c) => {
    const data = store.loadTasks(ctx);
    const task = data.tasks.find((t) => t.id === c.params.id);
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    const arr = Array.isArray(task.artifacts) ? task.artifacts : [];
    const i = Number(c.params.idx);
    if (!Number.isInteger(i) || i < 0 || i >= arr.length) {
      throw new HttpError(404, 'ARTIFACT_NOT_FOUND', '成果不存在（下标越界）');
    }
    arr.splice(i, 1);
    store.saveTasks(ctx, data);
    noContent(c.res);
  });
}

function registerColumnRoutes(router, ctx) {
  router.add('GET', '/api/columns', (c) => {
    const { columns } = store.loadTasks(ctx);
    const out = [...columns]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((col) => ({ id: col.id, name: col.name, order: col.order }));
    sendJSON(c.res, 200, out);
  });

  router.add('POST', '/api/columns', (c) => {
    const data = store.loadTasks(ctx);
    const body = c.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 50) throw new HttpError(400, 'INVALID_NAME', '列名必填且不超过 50 字符');

    let id = slugify(name);
    if (!id || data.columns.some((col) => col.id === id)) {
      const taken = new Set(data.columns.map((col) => col.id));
      do {
        id = `col-${store.randomToken(4)}`;
      } while (taken.has(id));
    }
    const order = data.columns.reduce((m, col) => Math.max(m, col.order || 0), 0) + 1;
    const col = { id, name, order };
    data.columns.push(col);
    store.saveTasks(ctx, data);
    sendJSON(c.res, 201, store.clone(col));
  });

  router.add('PATCH', '/api/columns/:id', (c) => {
    const data = store.loadTasks(ctx);
    const col = data.columns.find((x) => x.id === c.params.id);
    if (!col) throw new HttpError(404, 'COLUMN_NOT_FOUND', '列不存在');
    const body = c.body || {};
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 50) throw new HttpError(400, 'INVALID_NAME', '列名必填且不超过 50 字符');
      col.name = name;
    }
    let orderSet = false;
    if (body.order !== undefined) {
      if (!Number.isInteger(body.order) || body.order < 1) {
        throw new HttpError(400, 'ORDER_INVALID', 'order 必须为 ≥1 的正整数');
      }
      col.order = body.order; // 先记绝对序号，下方统一归一化
      orderSet = true;
    }
    // v1.2：order 语义——被移列取请求的绝对序号（收敛到 1..n，超界取末位），其余列按原有
    // 相对顺序填充剩余序号位。该语义天然对 ←/→ 两个方向对称：target 位被被移列独占，
    // 其余列依次绕过该位，因此响应 order === 请求值（1..n 内）且全列归一化为 1..n 连续序列。
    // （旧实现「全列按序排序 + 并列时被移列优先」只在向左移动方向成立，向右会被并列对象
    //  抢走目标位静默偏移——goose 真机验收 P1-1，勿回退。）
    if (orderSet) {
      const n = data.columns.length;
      const target = Math.min(Math.max(col.order, 1), n);
      const others = data.columns
        .filter((x) => x !== col)
        .sort((a, b) => (a.order || 0) - (b.order || 0)); // Node sort 稳定 = 原有相对顺序
      let slot = 1;
      for (const x of others) {
        if (slot === target) slot += 1; // 跳过被移列占用的目标位
        x.order = slot;
        slot += 1;
      }
      col.order = target;
    }
    store.saveTasks(ctx, data);
    sendJSON(c.res, 200, { id: col.id, name: col.name, order: col.order });
  });

  router.add('DELETE', '/api/columns/:id', (c) => {
    const data = store.loadTasks(ctx);
    const idx = data.columns.findIndex((x) => x.id === c.params.id);
    if (idx === -1) throw new HttpError(404, 'COLUMN_NOT_FOUND', '列不存在');
    const n = data.tasks.filter((t) => t.status === c.params.id).length;
    if (n > 0) throw new HttpError(409, 'COLUMN_NOT_EMPTY', `先移走该列的 ${n} 个任务`);
    data.columns.splice(idx, 1);
    store.saveTasks(ctx, data);
    noContent(c.res);
  });
}

// ---------- B2：智能体只读注册表（GET：任务表单执行者下拉 + overview 排除清单的数据源） ----------

function agentView(a) {
  return {
    id: a.id,
    name: a.name,
    command: a.command,
    commandTemplate: a.commandTemplate,
    builtin: !!a.builtin,
    enabled: a.enabled !== false,
  };
}

function registerAgentRoutes(router, ctx) {
  router.add('GET', '/api/agents', (c) => {
    sendJSON(c.res, 200, store.loadAgents(ctx.agentsPath).map(agentView));
  });
}

// ---------- #3/#4：Gitea 轮询器（单飞）+ 组织成员缓存 ----------

/** #4：拉取 /orgs/{org}/members 写 data/gitea-members.json（login/full_name/name）。
 * 凭据按 giteaClient 同款模式内存使用、绝不落盘不进日志；GITEA_FIXTURE 模式零出网直接跳过。 */
async function refreshMembersCache(ctx, giteaClient, ssrf) {
  try {
    if (process.env.GITEA_FIXTURE) return; // fixture 模式不出网
    const g = ctx.config.gitea;
    const url = `${String(g.baseUrl).replace(/\/+$/, '')}${g.apiPrefix || '/api/v1'}/orgs/${encodeURIComponent(g.org)}/members`;
    if (ssrf && typeof ssrf.assertSafeUrl === 'function') {
      ssrf.assertSafeUrl(url, ctx.config); // 白名单复检，违规即抛（零出站）
    }
    let credential = null;
    try {
      credential = giteaClient.readCredential(ctx.config);
    } catch (e) {
      credential = null; // 无凭据时尝试匿名拉取（公开组织可读）
    }
    // 与 giteaClient.authHeaders 同款拆分：extraheader 原值 "Name: value"；无冒号则作 Authorization 值。
    // 凭据仅存内存用于本次请求头，绝不落盘、不进日志。
    const headers = { Accept: 'application/json' };
    if (credential) {
      const idx = credential.indexOf(':');
      if (idx > 0) headers[credential.slice(0, idx).trim()] = credential.slice(idx + 1).trim();
      else headers.Authorization = credential;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let list;
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      list = await res.json();
    } finally {
      clearTimeout(timer);
    }
    if (!Array.isArray(list)) throw new Error('members 响应不是数组');
    const members = list
      .filter((m) => m && typeof m.login === 'string')
      .map((m) => ({ login: m.login, full_name: m.full_name || '', name: m.full_name || m.login }));
    store.writeJSON(ctx.giteaMembersPath, members);
  } catch (err) {
    console.error('[poller] 成员缓存更新失败（不影响活动流）:', (err && err.message) || err);
  }
}

/**
 * #3：按 pollIntervalSec 定时调 giteaClient.pollActivities（写 activities.json + gitea-status.json），
 * 单飞（上一轮未完成不重入）；PATCH settings 改 pollIntervalSec 后经 ctx.reschedulePoller 重排。
 * GITEA_FIXTURE 模式同样生效（fixture 模式 pollActivities 零网络）。
 * poller 模式：'auto' = 独立版行为（自起定时器 + ctx.reschedulePoller 可重排）；
 *             'manual' = 插件态（只暴露 pollTick，由宿主 ctx.interval 驱动，SPEC-PLUGIN 1.4）。
 */
function setupPoller(ctx, mode) {
  let giteaClient;
  let ssrf = null;
  try {
    giteaClient = require('../../lib/giteaClient.js');
  } catch (e) {
    console.warn('[poller] giteaClient.js 缺位，轮询器未启动');
    return { pollOnce: async () => {}, stop() {}, reschedule() {} };
  }
  try {
    ssrf = require('../../lib/ssrfGuard.js');
  } catch (e) {
    ssrf = null;
  }
  // v2.9 GitHub 组织动态源（可选，enabled 时随同一轮 pollTick 拉取）
  let githubClient = null;
  try {
    githubClient = require('../../lib/githubClient.js');
  } catch (e) {
    githubClient = null;
  }
  // v2.9.18 Gitee 组织动态源（可选，enabled 时随同一轮 pollTick 拉取）
  let giteeClient = null;
  try {
    giteeClient = require('../../lib/giteeClient.js');
  } catch (e) {
    giteeClient = null;
  }
  // v2.9.6 数字员工日报自动档（每天 ≥08:00 首个 tick 生成昨日窗口，失败每小时重试）
  let weeklyMod = null;
  try {
    weeklyMod = require('../../lib/weekly.js');
  } catch (e) {
    weeklyMod = null;
  }
  if (typeof giteaClient.pollActivities !== 'function') {
    console.warn('[poller] giteaClient.pollActivities 不可用，轮询器未启动');
    return { pollOnce: async () => {}, stop() {}, reschedule() {} };
  }

  let timer = null;
  let polling = false;

  async function pollOnce() {
    if (polling) return; // 单飞
    polling = true;
    try {
      await giteaClient.pollActivities(ctx.config);
      // v2.9.6 日报自动档：守卫在 maybeAutoDaily 内（今日已有/未到 08:00/失败 1h 内均跳过），
      // 引擎调用失败只记日志，绝不影响 Gitea 源与成员缓存
      if (weeklyMod && typeof weeklyMod.maybeAutoDaily === 'function') {
        try {
          const r = weeklyMod.maybeAutoDaily(ctx);
          if (r && typeof r.catch === 'function') {
            r.catch((err) => console.error('[poller] 日报自动生成失败（下小时重试）:', (err && err.message) || err));
          }
        } catch (err) {
          console.error('[poller] 日报自动档异常:', (err && err.message) || err);
        }
      }
      // v2.9 GitHub 源：独立 try/catch——单源失败不拖垮 Gitea 源与成员缓存（状态各落各的文件）
      if (githubClient && ctx.config.github && ctx.config.github.enabled === true) {
        try {
          await githubClient.pollActivities(ctx.config);
        } catch (err) {
          console.error('[poller] GitHub 轮询失败（不影响 Gitea 源）:', (err && err.message) || err);
        }
      }
      // v2.9.18 Gitee 源：独立 try/catch——单源失败不拖垮其他源（状态落 data/gitee-status.json）
      if (giteeClient && ctx.config.gitee && ctx.config.gitee.enabled === true) {
        try {
          await giteeClient.pollActivities(ctx.config);
        } catch (err) {
          console.error('[poller] gitee 源拉取失败（不拖垮其他源）:', (err && err.message) || String(err));
        }
      }
      await refreshMembersCache(ctx, giteaClient, ssrf);
      // v2.9.39 IM 每日摘要：到点/已发/次数用尽都在 maybeRunDigest 内部短路，失败只记日志
      try {
        const r = require('../../lib/imNotify.js').maybeRunDigest(ctx);
        if (r && typeof r.catch === 'function') {
          r.catch((err) => console.error('[poller] IM 摘要失败（不影响其他源）:', (err && err.message) || err));
        }
      } catch (err) {
        console.error('[poller] IM 摘要异常:', (err && err.message) || err);
      }
      // v2.9.41 每日自动备份（默认开启，纯本地拷贝；到点且当日未跑才跑，失败只记日志）
      try {
        const bk = require('../../lib/backup.js').maybeDailyBackup(ctx);
        if (bk && bk.ran) console.log(`[backup] 自动备份完成：${path.basename(bk.dir)}（清理 ${bk.pruned} 份）`);
      } catch (err) {
        console.error('[poller] 自动备份失败（数据未改动）:', (err && err.message) || err);
      }
    } catch (err) {
      // pollActivities 失败时已自行写 gitea-status.json（ok:false），这里只记日志
      console.error('[poller] 轮询失败:', (err && err.message) || err);
    } finally {
      polling = false;
    }
  }

  function reschedule(intervalSec) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    const sec = Number(intervalSec);
    if (!Number.isFinite(sec) || sec <= 0) {
      console.warn('[poller] pollIntervalSec 非法，轮询器停止');
      return;
    }
    timer = setInterval(() => {
      pollOnce().catch(() => {});
    }, sec * 1000);
    timer.unref();
    console.log(`[poller] 已启动：间隔 ${sec}s，GITEA_FIXTURE=${process.env.GITEA_FIXTURE ? 'on' : 'off'}`);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  if (mode === 'auto') {
    ctx.reschedulePoller = reschedule;
    const initialSec = Number(ctx.config.gitea.pollIntervalSec);
    if (Number.isFinite(initialSec) && initialSec > 0) {
      reschedule(initialSec);
      pollOnce().catch(() => {}); // 首轮立即拉取（不阻塞监听）
    } else {
      console.log('[poller] pollIntervalSec<=0，轮询器未启动（可经 PATCH /api/settings 开启）');
    }
  }
  return { pollOnce, stop, reschedule };
}

// ---------- mock 传输层（真端口用例的进程内迁移底座） ----------

/** IncomingMessage 最小面：router.readBody / rawBody handler / adapter 够用 */
function createMockReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v !== undefined && v !== null) h[String(k).toLowerCase()] = String(v);
  }
  const chunks = [];
  if (body !== undefined && body !== null && body !== '') {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    chunks.push(buf);
    // 真实 fetch/http 客户端自动携带 Content-Length；router 的「有体才校验 Content-Type」
    // CSRF 防线依赖该头判定 hasBody，mock 必须同形
    if (h['content-length'] === undefined) h['content-length'] = String(buf.length);
  }
  let ended = false;
  const endCbs = [];
  const errorCbs = [];
  const req = {
    method: String(method).toUpperCase(),
    url,
    headers: h,
    statusCode: null,
    aborted: false,
    destroyed: false,
    socket: { remoteAddress: '127.0.0.1', remotePort: 0 },
    _isMockReq: true,
    on(ev, cb) {
      const e = String(ev);
      if (e === 'data') {
        if (!ended) {
          for (const ch of chunks.splice(0)) cb(ch);
        }
      } else if (e === 'end') {
        if (ended) queueMicrotask(cb);
        else endCbs.push(cb);
      } else if (e === 'error') {
        errorCbs.push(cb);
      }
      return req;
    },
    once(ev, cb) {
      return req.on(ev, cb);
    },
    destroy(err) {
      req.destroyed = true;
      req.aborted = true;
      if (err) {
        for (const cb of errorCbs.splice(0)) cb(err);
      }
      return req;
    },
    resume() {},
  };
  process.nextTick(() => {
    ended = true;
    for (const cb of endCbs.splice(0)) cb();
  });
  return req;
}

/** ServerResponse 最小面：writeHead/setHeader/end/statusCode/headersSent/finish */
function createMockRes() {
  const headers = Object.create(null);
  const chunks = [];
  const res = {
    statusCode: 200,
    headersSent: false,
    finished: false,
    _isMockRes: true,
    setHeader(k, v) {
      headers[String(k).toLowerCase()] = String(v);
    },
    getHeader(k) {
      return headers[String(k).toLowerCase()];
    },
    removeHeader(k) {
      delete headers[String(k).toLowerCase()];
    },
    writeHead(status, head) {
      if (res.headersSent) throw new Error('Cannot set headers after they are sent to the client');
      res.statusCode = status;
      if (head) {
        for (const [k, v] of Object.entries(head)) headers[String(k).toLowerCase()] = String(v);
      }
      res.headersSent = true;
      return res;
    },
    write(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(body) {
      if (body) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
      if (!res.headersSent) res.headersSent = true;
      if (!res.finished) {
        res.finished = true;
        for (const cb of finishCbs.splice(0)) cb();
      }
      return res;
    },
    destroy() {},
    on(ev, cb) {
      if (String(ev) === 'finish' && res.finished) cb();
      else if (String(ev) === 'finish') finishCbs.push(cb);
      return res;
    },
    once(ev, cb) {
      return res.on(ev, cb);
    },
    get raw() {
      return { headers, chunks };
    },
    get text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
  const finishCbs = [];
  return res;
}

// ---------- buildApp ----------

function buildApp(options) {
  const opts = options || {};
  const rootDir = opts.rootDir ? path.resolve(opts.rootDir) : path.resolve(__dirname, '..', '..');
  let configPath = opts.configPath ? path.resolve(opts.configPath) : null;
  const configDir = opts.configDir ? path.resolve(opts.configDir) : configPath ? path.dirname(configPath) : rootDir;
  if (!configPath) configPath = path.join(configDir, 'config.json');

  // ---- 启动期校验（§5）：与旧 server.js 逐条同构，以 throw 代替 process.exit(2) ----
  // 配置一律经 configPath 从磁盘加载（与 server.js --config 同路径，PATCH 写回落同一文件）
  const config = store.loadOrCreateConfig(configPath);
  if (config.host !== '127.0.0.1' && config.host !== '0.0.0.0') {
    throw new Error(`host 仅接受 127.0.0.1/0.0.0.0（与宿主 webServer 配置同源），当前为 "${config.host}"（独立版退出码 2 语义）`);
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`port 非法: ${config.port}`);
  }
  for (const entry of config.gitea.hostWhitelist || []) {
    const bad = settingsMod.forbiddenWhitelistEntry(entry);
    if (bad) {
      throw new Error(`hostWhitelist 含禁止项 "${entry}"（${bad}），启动即拒绝`);
    }
  }
  // 任务雷达：钉钉域白名单同一红线（localhost/IP 字面量启动即拒，PRD §4 + SPEC §5-②）
  try {
    require('../../lib/ssrfGuard.js').validateWhitelistEntries(config.dingtalk.hostWhitelist || []);
  } catch (e) {
    throw new Error(`dingtalk.hostWhitelist 体检失败: ${e.message}`);
  }
  // 飞书妙记通道：hostWhitelist 同一红线（与 dingtalk 同款启动即拒）
  try {
    require('../../lib/ssrfGuard.js').validateWhitelistEntries(config.feishu.hostWhitelist || []);
  } catch (e) {
    throw new Error(`feishu.hostWhitelist 体检失败: ${e.message}`);
  }
  // security.trustedHosts（插件态 Host 防线 allowlist 扩展，SPEC-PLUGIN 2.5）：字符串数组
  const trustedHosts = (config.security && config.security.trustedHosts) || [];
  if (!Array.isArray(trustedHosts) || trustedHosts.some((x) => typeof x !== 'string')) {
    throw new Error('security.trustedHosts 必须为字符串数组');
  }

  const absDir = (d) => (path.isAbsolute(d) ? d : path.join(configDir, d));
  // #6：dataDir/webDir 在装配侧归一化为绝对路径后整体注入（含传给 gitea 模块的 config provider），
  // 使 giteaClient/routes-gitea 的路径解析与主服务完全一致，PROJECT_ROOT 兜底不再触发
  //（v2.2：gateway.logDir 归一化已随 网关集成移除）
  config.dataDir = absDir(config.dataDir);
  config.webDir = absDir(config.webDir);
  const dataDir = config.dataDir;

  const ctx = {
    config,
    configPath,
    rootDir,
    dataDir,
    webDir: config.webDir,
    agentsPath: path.join(configDir, 'agents.json'),
    membersPath: path.join(configDir, 'members.json'),
    tasksPath: path.join(dataDir, 'tasks.json'),
    // v2.3：sessionsPath 已随会话登记表退役移除（数据层收口，规格 §6）
    activitiesPath: path.join(dataDir, 'activities.json'),
    giteaStatusPath: path.join(dataDir, 'gitea-status.json'),
    giteaMembersPath: path.join(dataDir, 'gitea-members.json'),
    messagesPath: path.join(dataDir, 'messages.json'),
    inboxPath: path.join(dataDir, 'inbox.json'),
    taskEventsPath: path.join(dataDir, 'task_events.json'),
    diaryPath: path.join(dataDir, 'diary.json'), // v2.7 任务日报（唯一键 taskId+date）
    version: VERSION,
    startedAt: Date.now(),
    adapters: opts.adapters, // 测试注入缝（v2.9.14）：桌面源适配器覆盖 { id: fn }，prod 恒 undefined
    // v2.9.47 宿主 LLM 服务（插件态由 plugin/index.mjs 注入；测试可注入假实现）：
    // 有它就用宿主默认模型（桌面端正在用的那个），没有则 lib/learn 回落 spawn 引擎
    llm: opts.llm || null,
    agentDefaultModel: opts.agentDefaultModel || null,
  };

  store.loadOrCreateAgentsFile(ctx.agentsPath);

  // #10：把 config.security.redactKeys 同步给 redact 层，日志/错误出口统一脱敏
  try {
    require('../../lib/redact.js').setRedactKeys(config.security.redactKeys || []);
  } catch (e) {
    console.warn('[security] redact.js 缺位，redactKeys 同步跳过');
  }

  // 路由装配
  const router = new Router();
  router.add('GET', '/api/health', (c) => {
    sendJSON(c.res, 200, {
      ok: true,
      version: VERSION,
      uptimeSec: Math.floor((Date.now() - ctx.startedAt) / 1000),
    });
  });
  registerTaskRoutes(router, ctx);
  // v2.9.24 会话归因建议：GET /api/tasks/:id/session-suggestions（排序候选，人工确认挂接）
  sessionSuggestMod.registerSessionSuggestRoute(router, ctx);
  // v2.7 任务日报：GET/PUT /api/tasks/:id/diary、DELETE :date、GET prefill（内部先注册 prefill 再注册 :date）
  diaryMod.registerDiaryRoutes(router, ctx);
  registerColumnRoutes(router, ctx);
  registerAgentRoutes(router, ctx);
  membersMod.registerMemberRoutes(router, ctx);
  // v2.3：会话登记表退役（GET /api/sessions + POST /api/sessions/:id/stop 已删，规格 §6）
  overviewMod.registerOverviewRoutes(router, ctx);
  settingsMod.registerSettingsRoutes(router, ctx);
  // 智能体工作观测（v2.2）：四源适配器聚合端点，GET /api/agent-activity（?agent= 过滤）
  require('../../lib/agentActivity').registerAgentActivityRoutes(router, ctx);
  // v2.3 会话阅读器：GET /api/agent-sessions + GET /api/agent-session（六源归一化）
  agentTranscriptMod.registerAgentSessionRoutes(router, ctx);
  // v2.9.23 工作搜索：GET /api/work-search?q=（任务/会话/提交/日报四组聚合，Ctrl+K 后端）
  workSearchMod.registerWorkSearchRoute(router, ctx);
  // v2.9.26 Agent 时间线热力图：GET /api/agent-heatmap（六源会话 日×agent 聚合）
  require('../../lib/heatmap.js').registerHeatmapRoute(router, ctx);
  // v2.9.27 Scorecard 传播卡：GET /api/scorecard/<agent>.svg（image/svg+xml）
  require('../../lib/scorecard.js').registerScorecardRoute(router, ctx);
  // v2.9.28 任务复盘：GET /api/tasks/:id/postmortem（done 时刻确定性蒸馏）
  require('../../lib/postmortem.js').registerPostmortemRoute(router, ctx);
  // v2.9.5 数字员工周报：会话数据聚合 → harness 引擎蒸馏（POST generate / GET job / GET weekly）
  require('../../lib/weekly.js').registerWeeklyRoutes(router, ctx);
  // v2.2：会话网关可观测端点（/api/gateway/*）已随 网关集成整体移除
  // 环境体检聚合端点（分发部署自检）：GET /api/setup/check 五项（node/dws/dsh/llmRoute/gitea）
  setupRoutesMod.registerSetupRoutes(router, ctx);
  // v2.9.39 IM 通知（飞书/钉钉自定义机器人）：POST /api/im/test 通道测试（保存前先验）
  require('../../lib/imNotify.js').registerImRoutes(router, ctx);
  // v2.9.41 数据备份：GET /api/backup/list · POST /api/backup/now · POST /api/backup/restore
  require('../../lib/backup.js').registerBackupRoutes(router, ctx);
  // v2.9.44 知识库学习（只读 vault）：status/today/scan/items/session 系列
  require('../../lib/learn.js').registerLearnRoutes(router, ctx);
  mountGiteaRoutes(router, ctx);
  // 任务雷达（PRD-task-inbox）：采集器 + AI 拆解 + 收件箱
  try {
    require('../../lib/dingtalk.js').registerRadarRoutes(router, ctx);
    require('../../lib/feishu.js').registerFeishuRoutes(router, ctx);
    require('../../lib/analyze.js').registerAnalyzeRoutes(router, ctx);
    require('../../lib/inbox.js').registerInboxRoutes(router, ctx);
  } catch (e) {
    console.error('[radar] 雷达路由挂载失败:', e.message);
  }

  // ---- env 注入（独立版「子进程 env」的进程内等价物） ----
  const envMap = opts.env && typeof opts.env === 'object' ? opts.env : null;
  const envKeys = envMap ? Object.keys(envMap) : [];
  const savedEnv = new Map();

  function applyEnv() {
    if (!envMap) return;
    for (const k of envKeys) {
      if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
      const v = envMap[k];
      if (v === null || v === undefined) delete process.env[k];
      else process.env[k] = String(v);
    }
  }

  function restoreEnv() {
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    savedEnv.clear();
  }

  // persistentEnv（radar 系/轮询器子实例）：后台 job 与定时器在响应之后继续执行并读 env，
  // 分发期临时注入不够——必须在 setupPoller（首轮 pollOnce）之前写入，close 还原
  //（node --test 每文件独立进程，泄露面=本文件）
  if (envMap && opts.persistentEnv) applyEnv();

  const pollerMode = opts.poller === 'manual' ? 'manual' : 'auto';
  const poller = setupPoller(ctx, pollerMode);

  // ---- 边界管线（与旧 server.js http 层逐行同构） ----
  function handle(req, res) {
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${config.port}`) {
      return sendError(res, 403, 'HOST_FORBIDDEN', `Host 头必须为 127.0.0.1:${config.port}`);
    }
    // CSRF 防线②：浏览器发出的跨站请求自带 Sec-Fetch-Site，非 same-origin/none 一律 403；
    // curl 等非浏览器客户端无此头，不受影响
    const sfs = req.headers['sec-fetch-site'];
    if (sfs !== undefined) {
      const v = String(sfs).trim().toLowerCase();
      if (v !== 'same-origin' && v !== 'none') {
        return sendError(res, 403, 'CSRF_REJECTED', `跨站请求被拒绝（Sec-Fetch-Site: ${v}）`);
      }
    }
    const pathname = (req.url || '/').split('?')[0];
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return router.dispatch(ctx, req, res);
    }
    return serveStatic(ctx, req, res, req.url || '/');
  }

  function handleApi(req, res) {
    return router.dispatch(ctx, req, res);
  }

  function handleStatic(req, res) {
    return serveStatic(ctx, req, res, req.url || '/');
  }

  // ---- 进程内 fetch：与 http 层同一条 handle 管线 ----
  async function appFetch(method, p, requestOptions) {
    const o = requestOptions || {};
    const headers = Object.assign({}, o.headers || {});
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'host')) {
      headers.host = `127.0.0.1:${config.port}`;
    }
    const res = createMockRes();
    const req = createMockReq({ method, url: p, headers, body: o.body });
    const dispatch = () => handle(req, res);
    if (envMap && !opts.persistentEnv && envKeys.length > 0) {
      applyEnv();
      try {
        await dispatch();
      } finally {
        restoreEnv();
      }
    } else {
      await dispatch();
    }
    const text = res.text;
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      json = null;
    }
    return {
      status: res.statusCode,
      ok: res.statusCode >= 200 && res.statusCode < 300,
      headers: {
        get(name) {
          const got = res.raw.headers[String(name).toLowerCase()];
          return got === undefined ? null : got;
        },
      },
      text,
      body: json,
      json: () => Promise.resolve(json),
    };
  }

  const app = {
    ctx,
    router,
    config,
    configPath,
    version: VERSION,
    handle,
    handleApi,
    handleStatic,
    fetch: appFetch,
    pollTick: () => poller.pollOnce(),
    reschedulePoller: (sec) => poller.reschedule(sec),
    close() {
      poller.stop();
      if (envMap && opts.persistentEnv) restoreEnv();
    },
  };
  return app;
}

module.exports = {
  VERSION,
  buildApp,
  createMockReq,
  createMockRes,
  registerTaskRoutes,
  registerColumnRoutes,
  registerAgentRoutes,
};
