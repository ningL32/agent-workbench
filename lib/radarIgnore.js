'use strict';

/**
 * radarIgnore.js — 任务雷达的"别再回来"名单（v2.9.63）
 *
 * 背景：钉钉听记同步是**拉取式**的——删掉一条纪要后本地没了记录，下次同步会当成新纪要
 * 重新拉回来并重新分析，收件箱候选于是"删了又出现"。这里给两条闸：
 *   ① 墓碑（tombstone）：删除纪要时记下 id，同步时直接跳过；
 *   ② 规则（rules）：关键词 / 标题片段匹配就跳过，管"以后同类也别进来"。
 *
 * 数据：`<base>/data/radar-ignore.json` —— { messages: {id:{title,at}}, rules:{keywords[],titles[]} }
 * 只在拉取/分析入口判一次；不参与脱敏（内容只有标题与用户自己填的词）。
 */

const path = require('node:path');
const store = require('./store');
const { HttpError, sendJSON } = require('./router');

const MAX_RULES = 50;
const MAX_RULE_LEN = 60;

function fileOf(ctx) {
  return path.join(ctx.dataDir, 'radar-ignore.json');
}

function load(ctx) {
  const d = store.readJSON(fileOf(ctx), null);
  const o = store.isPlainObject(d) ? d : {};
  const rules = store.isPlainObject(o.rules) ? o.rules : {};
  const clean = (arr) => (Array.isArray(arr) ? arr.map((x) => String(x).trim()).filter(Boolean).slice(0, MAX_RULES) : []);
  return {
    messages: store.isPlainObject(o.messages) ? o.messages : {},
    rules: { keywords: clean(rules.keywords), titles: clean(rules.titles) },
  };
}

function save(ctx, data) {
  store.writeJSON(fileOf(ctx), data);
}

/** 规则命中判定：标题/正文前 2000 字里包含即算（大小写不敏感） */
function matchRule(msg, rules) {
  if (!msg || !rules) return null;
  const title = String(msg.title || '');
  const hay = `${title}\n${String(msg.content || '').slice(0, 2000)}`.toLowerCase();
  for (const k of rules.keywords || []) {
    if (k && hay.includes(String(k).toLowerCase())) return `关键词「${k}」`;
  }
  for (const k of rules.titles || []) {
    if (k && title.includes(String(k))) return `标题包含「${k}」`;
  }
  return null;
}

/** 是否该跳过：返回原因字符串（跳过）或 null（正常处理） */
function ignoredReason(ctx, input) {
  const data = load(ctx);
  const id = input && input.id;
  const msg = input && input.msg;
  if (id && data.messages[id]) return '已删除过的纪要（忽略名单）';
  const hit = matchRule(msg, data.rules);
  return hit || null;
}

function addTombstone(ctx, id, title) {
  const data = load(ctx);
  if (!id) return data;
  data.messages[String(id)] = { title: String(title || '').slice(0, 120), at: new Date().toISOString() };
  save(ctx, data);
  return data;
}

function removeTombstone(ctx, id) {
  const data = load(ctx);
  delete data.messages[String(id)];
  save(ctx, data);
  return data;
}

/** 设置规则（整体替换；逐条裁剪长度与数量） */
function setRules(ctx, rules) {
  const data = load(ctx);
  const clamp = (arr) => (Array.isArray(arr)
    ? arr.map((x) => String(x).trim().slice(0, MAX_RULE_LEN)).filter(Boolean).slice(0, MAX_RULES)
    : []);
  data.rules = { keywords: clamp(rules && rules.keywords), titles: clamp(rules && rules.titles) };
  save(ctx, data);
  return data;
}

function view(ctx) {
  const data = load(ctx);
  const messages = Object.entries(data.messages)
    .map(([id, v]) => ({ id, title: (v && v.title) || '', at: (v && v.at) || null }))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, 200);
  return { messages, messageCount: Object.keys(data.messages).length, rules: data.rules };
}

function registerRadarIgnoreRoutes(router, ctx) {
  router.add('GET', '/api/radar/ignore', (c) => {
    sendJSON(c.res, 200, view(ctx));
  });

  router.add('POST', '/api/radar/ignore', (c) => {
    const body = c.body || {};
    if (!store.isPlainObject(body.rules)) throw new HttpError(400, 'RADAR_IGNORE_INVALID', 'rules 必须为对象');
    for (const k of ['keywords', 'titles']) {
      const v = body.rules[k];
      if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
        throw new HttpError(400, 'RADAR_IGNORE_INVALID', `rules.${k} 必须为字符串数组`);
      }
    }
    setRules(ctx, body.rules);
    sendJSON(c.res, 200, view(ctx));
  });

  router.add('DELETE', '/api/radar/ignore/messages/:id', (c) => {
    const data = removeTombstone(ctx, c.params.id);
    sendJSON(c.res, 200, { ok: true, remaining: Object.keys(data.messages).length });
  });
}

module.exports = {
  load,
  save,
  matchRule,
  ignoredReason,
  addTombstone,
  removeTombstone,
  setRules,
  view,
  registerRadarIgnoreRoutes,
};
