'use strict';

/**
 * routes-setup.js — 环境体检聚合端点（分发部署自检；探测实现唯一见 lib/setupCheck.js）
 * - GET /api/setup/check → {allOk, items:[{id,name,ok,detail,hint}], checkedAt}
 *   五项（node/dws/dsh/llmRoute/gitea）互不阻塞（v2.2 起 cliGateway 项随网关集成移除）；
 *   detail 过 redact，hint 为静态中文修复指引（前端直出）；凭据永不回显。
 * - GET /api/repos → 配置 Gitea 组织下全部仓库 [{fullName,name,private,updatedAt}]
 *   （只读：任务表单仓库下拉数据源；拉取实现唯一见 lib/giteaClient.js listOrgRepos）。
 */

const { sendJSON, sendError } = require('./router');
const { runSetupCheck } = require('./setupCheck');
const { redact } = require('./redact');
const { listOrgRepos } = require('./giteaClient');

function registerSetupRoutes(router, ctx) {
  router.add('GET', '/api/setup/check', async (c) => {
    sendJSON(c.res, 200, await runSetupCheck(ctx.config));
  });

  // GET /api/repos（只读端点：绝不写 data/ 任何文件、不写 config）
  // 守卫码（HOST_NOT_ALLOWED/DANGEROUS_WHITELIST_ENTRY）→ 400；其余失败 → 502 GITEA_ERROR
  //（message 必经 redact，映射风格与 routes-gitea.js guardErrorResponse 一致）
  router.add('GET', '/api/repos', async (c) => {
    try {
      sendJSON(c.res, 200, await listOrgRepos(c.config || ctx.config));
    } catch (err) {
      if (err && err.code === 'HOST_NOT_ALLOWED') {
        return sendError(c.res, 400, 'HOST_NOT_ALLOWED', err.message || 'host 不在白名单');
      }
      if (err && err.code === 'DANGEROUS_WHITELIST_ENTRY') {
        return sendError(c.res, 400, 'HOST_NOT_ALLOWED', 'host 不在白名单（白名单配置含禁止地址）');
      }
      return sendError(c.res, 502, 'GITEA_ERROR', redact((err && err.message) || String(err)));
    }
  });
}

module.exports = { registerSetupRoutes };
