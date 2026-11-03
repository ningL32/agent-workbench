'use strict';

/**
 * members.js — v1.2 手工名册 CRUD（POST / PATCH / DELETE /api/members）
 * - 存储为项目根 members.json 配置文件（tmp+rename 原子写，人可手改）
 * - GET /api/members 聚合视图（含 manual 字段与 giteaLogin 活动归因）在 overview.js，本模块只管写路径
 * - 只允许增删改手工名册条目；智能体与 Gitea 派生成员不可经此删除（409 MEMBER_IMMUTABLE）
 */

const store = require('./store');
const { HttpError, sendJSON, noContent } = require('./router');

/** id 规则：小写字母开头，可含小写字母/数字/点/连字符，总长 1..32 */
const MEMBER_ID_RE = /^[a-z][a-z0-9.-]{0,31}$/;

function memberView(m) {
  return {
    id: m.id,
    name: m.name,
    role: typeof m.role === 'string' ? m.role : '',
    giteaLogin: typeof m.giteaLogin === 'string' ? m.giteaLogin : '',
    // v2.9：GitHub 组织动态源归因用（动态流 actor 的 githubLogin 匹配链）
    githubLogin: typeof m.githubLogin === 'string' ? m.githubLogin : '',
    // 任务雷达（PRD §6）：钉钉昵称别名数组；历史数据缺字段回退 []
    aliases: Array.isArray(m.aliases) ? m.aliases.filter((a) => typeof a === 'string') : [],
    enabled: m.enabled !== false,
  };
}

/** name 必填，去首尾空白后 1..50 字 */
function requireName(v) {
  if (typeof v !== 'string' || v.trim().length < 1 || v.trim().length > 50) {
    throw new HttpError(400, 'MEMBER_INVALID', 'name 必填且为 1..50 字符');
  }
  return v.trim();
}

/** role/giteaLogin 可选字符串 ≤50 字；缺省 ''；null 视为未填 */
function optionalField(v, label) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.trim().length > 50) {
    throw new HttpError(400, 'MEMBER_INVALID', `${label} 可省略，提供时必须为 ≤50 字符的字符串`);
  }
  return v.trim();
}

function requireEnabled(v) {
  if (typeof v !== 'boolean') throw new HttpError(400, 'MEMBER_INVALID', 'enabled 必须为布尔值');
  return v;
}

/**
 * 别名写入目标的统一解析（v1.5 goose 验收 P1-C）——确认弹层下拉展示的是聚合名册
 * （含 Gitea 派生成员），「记住映射」必须能挂到任何派生 id 上，否则该组合必 404。
 * 本函数不落盘（调用方完成别名追加后一次性 saveMembers）：
 * - 手工名册命中 → 原样返回（created:false）
 * - 未命中但命中 Gitea 成员缓存（id=login）→ 在 members 数组就地创建关联手工条目
 *   {id:login, name:full_name, giteaLogin:login, enabled:true}（created:true）
 * - 两边都不沾（含 agents.json 智能体）→ member:null（调用方 404）
 * @returns {{members:Array, member:object|null, created:boolean}}
 */
function resolveAliasTarget(ctx, id) {
  const members = store.loadMembers(ctx.membersPath);
  const hit = members.find((m) => m.id === id);
  if (hit) return { members, member: hit, created: false };
  const g = store.loadGiteaMembers(ctx).find((h) => h.id === id);
  if (!g) return { members, member: null, created: false };
  const member = { id: g.id, name: g.name || g.id, role: '', giteaLogin: g.id, enabled: true };
  members.push(member);
  return { members, member, created: true };
}

function registerMemberRoutes(router, ctx) {
  router.add('POST', '/api/members', (c) => {
    const members = store.loadMembers(ctx.membersPath);
    const body = c.body || {};
    if (typeof body.id !== 'string' || !MEMBER_ID_RE.test(body.id)) {
      throw new HttpError(400, 'MEMBER_INVALID', 'id 必填且须匹配 ^[a-z][a-z0-9.-]{0,31}$');
    }
    if (members.some((m) => m.id === body.id)) {
      throw new HttpError(409, 'MEMBER_EXISTS', '该 id 已存在于手工名册');
    }
    const member = {
      id: body.id,
      name: requireName(body.name),
      role: optionalField(body.role, 'role'),
      giteaLogin: optionalField(body.giteaLogin, 'giteaLogin'),
      githubLogin: optionalField(body.githubLogin, 'githubLogin'),
      enabled: body.enabled === undefined ? true : requireEnabled(body.enabled),
    };
    members.push(member);
    store.saveMembers(ctx.membersPath, members);
    sendJSON(c.res, 201, memberView(member));
  });

  router.add('PATCH', '/api/members/:id', (c) => {
    const members = store.loadMembers(ctx.membersPath);
    const member = members.find((m) => m.id === c.params.id);
    if (!member) {
      throw new HttpError(404, 'MEMBER_NOT_FOUND', '手工名册中不存在该成员（智能体与 Gitea 派生成员不经此接口修改）');
    }
    const body = c.body || {};
    if (body.name !== undefined) member.name = requireName(body.name);
    if (body.role !== undefined) member.role = optionalField(body.role, 'role');
    if (body.giteaLogin !== undefined) member.giteaLogin = optionalField(body.giteaLogin, 'giteaLogin');
    if (body.githubLogin !== undefined) member.githubLogin = optionalField(body.githubLogin, 'githubLogin');
    if (body.enabled !== undefined) member.enabled = requireEnabled(body.enabled);
    store.saveMembers(ctx.membersPath, members);
    sendJSON(c.res, 200, memberView(member));
  });

  router.add('DELETE', '/api/members/:id', (c) => {
    const id = c.params.id;
    const members = store.loadMembers(ctx.membersPath);
    const idx = members.findIndex((m) => m.id === id);
    if (idx !== -1) {
      members.splice(idx, 1);
      store.saveMembers(ctx.membersPath, members);
      return noContent(c.res);
    }
    // 手工名册之外的派生成员一律拒删：智能体与 Gitea 派生（缓存 ∪ 动态 actor）只读
    const isAgent = store.loadAgents(ctx.agentsPath).some((a) => a.id === id);
    const isGiteaDerived =
      store.loadGiteaMembers(ctx).some((h) => h.id === id) ||
      store.loadActivities(ctx).some((a) => a && a.actor === id);
    if (isAgent || isGiteaDerived) {
      throw new HttpError(409, 'MEMBER_IMMUTABLE', '该成员非手工名册条目，不可删除（智能体走 /api/agents，Gitea 成员为派生只读）');
    }
    throw new HttpError(404, 'MEMBER_NOT_FOUND', '成员不存在');
  });

  // 任务雷达（PRD §6）：确认候选卡「记住此映射」→ 说话人昵称入别名表，下次分析自动归人。
  // v1.5（P1-C）：目标 id 不在手工名册但命中 Gitea 缓存时，自动创建关联手工条目再写别名
  //（响应 201 + created:true）；映射知识可挂到聚合名册的任何成员上
  router.add('POST', '/api/members/:id/aliases', (c) => {
    const raw = (c.body || {}).alias;
    if (typeof raw !== 'string' || raw.trim().length < 1 || raw.trim().length > 50) {
      throw new HttpError(400, 'MEMBER_INVALID', 'alias 必填且为 1..50 字符');
    }
    const alias = raw.trim();
    const { members, member, created } = resolveAliasTarget(ctx, c.params.id);
    if (!member) {
      throw new HttpError(404, 'MEMBER_NOT_FOUND', '成员不存在于手工名册，且不在 Gitea 成员缓存（智能体不参与说话人映射）');
    }
    if (!Array.isArray(member.aliases)) member.aliases = [];
    // 大小写不敏感去重（分析时的匹配同样是大小写不敏感）
    const dup = member.aliases.some((a) => typeof a === 'string' && a.trim().toLowerCase() === alias.toLowerCase());
    if (!dup) member.aliases.push(alias);
    store.saveMembers(ctx.membersPath, members);
    const view = memberView(member);
    if (created) {
      view.created = true;
      sendJSON(c.res, 201, view);
    } else {
      sendJSON(c.res, 200, view);
    }
  });
}

module.exports = { registerMemberRoutes, MEMBER_ID_RE, memberView, resolveAliasTarget };
