'use strict';

/**
 * lib/researchRoutes.js — 调研模块路由挂载（SPEC-RESEARCH §6 契约）
 *
 * 独立顶层文件的原因：docs-sync D 组对路由注册面做 lib/ 顶层+plugin+appAssembler 的
 * 扫描对账——注册面必须留在被扫描的层级，域逻辑在 lib/research/*（与 routes-gitea.js 同构分工）。
 */

const interviews = require('./research/interviews');
const kb = require('./research/kb');

function registerResearchRoutes(router, ctx) {
  const guard = (fn) => (c) => {
    try {
      return fn(c);
    } catch (e) {
      const { sendJSON } = require('./router');
      const code = e && e.code === 'INTERVIEW_CLOSED' ? 409 : e && e.code === 'LLM_BUSY' ? 429 : 500;
      sendJSON(c.res, code, { error: { code: e && e.code ? e.code : 'INTERNAL', message: (e && e.message) || String(e) } });
    }
  };

  router.add('POST', '/api/research/interviews', (c) => {
    const it = interviews.createInterview(ctx, c.body || {});
    const { sendJSON } = require('./router');
    sendJSON(c.res, 201, it);
  });

  router.add('GET', '/api/research/interviews', (c) => {
    const { sendJSON } = require('./router');
    sendJSON(c.res, 200, interviews.listInterviews(ctx));
  });

  router.add('GET', '/api/research/interviews/:id', (c) => {
    const r = interviews.getInterview(ctx, c.params.id);
    const { sendJSON } = require('./router');
    if (!r.interview) return sendJSON(c.res, 404, { error: { code: 'INTERVIEW_NOT_FOUND', message: '访谈不存在' } });
    sendJSON(c.res, 200, r);
  });

  router.add('POST', '/api/research/interviews/:id/messages', guard((c) => {
    const { sendJSON } = require('./router');
    const text = c.body && typeof c.body.text === 'string' ? c.body.text : '';
    if (!text.trim()) return sendJSON(c.res, 400, { error: { code: 'FIELD_INVALID', message: 'text 必填' } });
    return Promise.resolve(interviews.postFdeMessage(ctx, ctx.config, c.params.id, text))
      .then((r) => {
        if (!r) return sendJSON(c.res, 404, { error: { code: 'INTERVIEW_NOT_FOUND', message: '访谈不存在' } });
        sendJSON(c.res, 201, r);
      })
      .catch((e) => sendJSON(c.res, e && (e.code === 'INTERVIEW_CLOSED' || e.code === 'INTERVIEW_BUSY') ? 409 : 500, { error: { code: e && e.code ? e.code : 'INTERNAL', message: (e && e.message) || String(e) } }));
  }));

  router.add('POST', '/api/research/interviews/:id/close', (c) => {
    const it = interviews.closeInterview(ctx, c.params.id);
    const { sendJSON } = require('./router');
    if (!it) return sendJSON(c.res, 404, { error: { code: 'INTERVIEW_NOT_FOUND', message: '访谈不存在' } });
    sendJSON(c.res, 200, it);
  });

  router.add('POST', '/api/research/drafts/:id/accept', (c) => {
    const r = interviews.acceptDraft(ctx, c.params.id, c.body && c.body.payload, c.body && c.body.decidedBy);
    const { sendJSON } = require('./router');
    if (r.error === 'DRAFT_NOT_FOUND') return sendJSON(c.res, 404, { error: { code: r.error, message: '草稿不存在' } });
    if (r.error === 'ALREADY_DECIDED') return sendJSON(c.res, 409, { error: { code: r.error, message: '草稿已处置(pending 守卫)' } });
    if (r.error === 'FIELD_INVALID') return sendJSON(c.res, 400, { error: { code: r.error, message: r.detail } });
    sendJSON(c.res, 200, r.draft);
  });

  router.add('POST', '/api/research/drafts/:id/reject', (c) => {
    const r = interviews.rejectDraft(ctx, c.params.id, c.body && c.body.reason, c.body && c.body.decidedBy);
    const { sendJSON } = require('./router');
    if (r.error === 'DRAFT_NOT_FOUND') return sendJSON(c.res, 404, { error: { code: r.error, message: '草稿不存在' } });
    if (r.error === 'ALREADY_DECIDED') return sendJSON(c.res, 409, { error: { code: r.error, message: '草稿已处置(pending 守卫)' } });
    sendJSON(c.res, 200, r.draft);
  });

  router.add('POST', '/api/research/drafts/:id/link', (c) => {
    const r = interviews.linkDraft(ctx, c.params.id, c.body && c.body.taskId);
    const { sendJSON } = require('./router');
    if (r.error === 'DRAFT_NOT_FOUND') return sendJSON(c.res, 404, { error: { code: r.error, message: '草稿不存在' } });
    if (r.error === 'NOT_ACCEPTED') return sendJSON(c.res, 409, { error: { code: r.error, message: '草稿未 accept' } });
    if (r.error === 'ALREADY_LINKED') return sendJSON(c.res, 409, { error: { code: r.error, message: '草稿已绑定任务' } });
    sendJSON(c.res, 200, r.draft);
  });

  router.add('POST', '/api/research/kb/documents', (c) => {
    const { sendJSON } = require('./router');
    const b = c.body || {};
    const r = kb.sediment(ctx, b);
    if (!r.ok) return sendJSON(c.res, 400, { error: { code: r.error, message: r.detail } });
    sendJSON(c.res, 201, r.document);
  });

  router.add('POST', '/api/research/kb/bootstrap', (c) => {
    const { sendJSON } = require('./router');
    const r2 = kb.bootstrapImport(ctx);
    if (!r2.ok) return sendJSON(c.res, 409, { error: { code: r2.error, message: '冷启动已执行过(重置 research.json.bootstrapAt 可重跑)' }, imported: 0 });
    sendJSON(c.res, 201, { imported: r2.imported });
  });

  router.add('GET', '/api/research/health', (c) => {
    const { sendJSON } = require('./router');
    sendJSON(c.res, 200, require('./research/health').sceneHealth(ctx));
  });

  router.add('GET', '/api/research/kb/search', (c) => {
    const { sendJSON } = require('./router');
    sendJSON(c.res, 200, kb.search(ctx, c.query.get('q')));
  });

  router.add('GET', '/api/research/export', (c) => {
    // 闭环 C(审计决议⑦):输入仅人工确认面(tasks/diary);格式 bpmn|report
    const { sendJSON } = require('./router');
    const format = c.query.get('format') === 'bpmn' ? 'bpmn' : 'report';
    const projectDir = String(c.query.get('scene') || '');
    const out = require('./research/render').exportScene(ctx, projectDir, format);
    c.res.writeHead(200, { 'Content-Type': out.contentType });
    c.res.end(out.body);
  });

  router.add('GET', '/api/research/kb/eligible', (c) => {
    const { sendJSON } = require('./router');
    sendJSON(c.res, 200, kb.eligible(ctx));
  });

  router.add('GET', '/api/research/acceptance/:taskId', (c) => {
    const { sendJSON } = require('./router');
    try {
      const pack = require('./research/acceptance').buildAcceptancePack(ctx, c.params.taskId);
      sendJSON(c.res, 200, pack);
    } catch (e) {
      if (e && e.code === 'TASK_NOT_FOUND') return sendJSON(c.res, 404, { error: { code: 'TASK_NOT_FOUND', message: '任务不存在' } });
      throw e;
    }
  });

  router.add('GET', '/api/research/scene-progress', (c) => {
    // Tier2-② 客户只读进度页:静态自包含 HTML(内联样式,零外链);输入仅人工确认面(决议⑦)
    const { sendJSON } = require('./router');
    const projectDir = String(c.query.get('scene') || '');
    const html = require('./research/progress').renderProgressPage(ctx, projectDir);
    c.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    c.res.end(html);
  });

  router.add('POST', '/api/research/interviews/:id/proposal', guard((c) => {
    const { sendJSON } = require('./router');
    return Promise.resolve(interviews.generateProposal(ctx, ctx.config, c.params.id, { force: !!(c.body && c.body.force === true) }))
      .then((r) => {
        if (!r) return sendJSON(c.res, 404, { error: { code: 'INTERVIEW_NOT_FOUND', message: '访谈不存在' } });
        // v2.9.94 访谈出口闸门:缺口清单随 409 一起返回,前端据此弹确认;确认后带 {force:true} 重发
        if (r.error === 'GAPS_OPEN') return sendJSON(c.res, 409, { error: { code: r.error, message: r.message }, gate: r.gate });
        if (r.error) return sendJSON(c.res, 502, { error: { code: r.error, message: r.message } });
        sendJSON(c.res, 201, r.proposal);
      })
      .catch((e) => sendJSON(c.res, 500, { error: { code: 'INTERNAL', message: (e && e.message) || String(e) } }));
  }));

  router.add('POST', '/api/research/interviews/:id/decompose', guard((c) => {
    const { sendJSON } = require('./router');
    return Promise.resolve(interviews.decomposeProposal(ctx, ctx.config, c.params.id))
      .then((r) => {
        if (!r) return sendJSON(c.res, 404, { error: { code: 'INTERVIEW_NOT_FOUND', message: '访谈不存在' } });
        if (r.error) return sendJSON(c.res, r.error === 'NO_PROPOSAL' ? 409 : 502, { error: { code: r.error, message: r.message } });
        sendJSON(c.res, 201, { drafts: r.drafts, channel: r.channel, modelId: r.modelId });
      })
      .catch((e) => sendJSON(c.res, 500, { error: { code: 'INTERNAL', message: (e && e.message) || String(e) } }));
  }));

  router.add('POST', '/api/research/interviews/:id/attachments', guard((c) => {
    const { sendJSON } = require('./router');
    const b = c.body || {};
    let buf = null;
    if (b.dataBase64) {
      try { buf = Buffer.from(b.dataBase64, 'base64'); } catch (e) { buf = null; }
    }
    const r = interviews.addAttachment(ctx, c.params.id, b.name, buf);
    if (r.error === 'INTERVIEW_NOT_FOUND') return sendJSON(c.res, 404, { error: { code: r.error, message: '访谈不存在' } });
    if (r.error) return sendJSON(c.res, r.error === 'TOO_MANY' || r.error === 'TOO_LARGE' ? 413 : 400, { error: { code: r.error, message: r.message } });
    sendJSON(c.res, 201, r.attachment);
  }));

  router.add('GET', '/api/research/interviews/:id/attachments', (c) => {
    const { sendJSON } = require('./router');
    const list = interviews.listAttachments(ctx, c.params.id);
    if (list === null) return sendJSON(c.res, 404, { error: { code: 'INTERVIEW_NOT_FOUND', message: '访谈不存在' } });
    sendJSON(c.res, 200, list);
  });

  router.add('GET', '/api/research/interviews/:id/attachments/:attId', (c) => {
    const { sendJSON } = require('./router');
    const r = interviews.readAttachment(ctx, c.params.id, c.params.attId);
    if (r.error === 'INTERVIEW_NOT_FOUND' || r.error === 'ATTACHMENT_NOT_FOUND') return sendJSON(c.res, 404, { error: { code: r.error, message: '附件不存在' } });
    const ext = (r.att.name.match(/\.(\w+)$/) || [])[1] || '';
    const ctype = { txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json', log: 'text/plain; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf' }[ext.toLowerCase()] || 'application/octet-stream';
    c.res.writeHead(200, { 'Content-Type': ctype, 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(r.att.name) + '"' });
    c.res.end(r.buf);
  });

  // v2.9.94 调研任务流程图:草稿依赖 → {nodes,edges} / Mermaid 文本 / SVG(零依赖,服务端渲染)
  const flowOf = (id) => {
    const r = interviews.getInterview(ctx, id);
    if (!r.interview) return null;
    return require('./research/flow').buildFlow(r.drafts);
  };
  router.add('GET', '/api/research/interviews/:id/flow', (c) => {
    const { sendJSON } = require('./router');
    const flow = flowOf(c.params.id);
    if (!flow) return sendJSON(c.res, 404, { error: { code: 'INTERVIEW_NOT_FOUND', message: '访谈不存在' } });
    sendJSON(c.res, 200, flow);
  });
  router.add('GET', '/api/research/interviews/:id/flow.mmd', (c) => {
    const { sendJSON } = require('./router');
    const flow = flowOf(c.params.id);
    if (!flow) return sendJSON(c.res, 404, { error: { code: 'INTERVIEW_NOT_FOUND', message: '访谈不存在' } });
    c.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
    c.res.end(require('./research/flow').toMermaid(flow));
  });
  router.add('GET', '/api/research/interviews/:id/flow.svg', (c) => {
    const { sendJSON } = require('./router');
    const flow = flowOf(c.params.id);
    if (!flow) return sendJSON(c.res, 404, { error: { code: 'INTERVIEW_NOT_FOUND', message: '访谈不存在' } });
    c.res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache' });
    c.res.end(require('./research/flow').toSvg(flow));
  });
  router.add('GET', '/api/digest', (c) => {
    const { sendJSON } = require('./router');
    sendJSON(c.res, 200, require('./digest').buildDigest(ctx));
  });
}

module.exports = { registerResearchRoutes };
