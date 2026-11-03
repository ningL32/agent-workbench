// v2.9.26 Onboarding 向导（开源 star 生死线：30 秒看到自己的数据）。
// 首次访问（localStorage fde-onboard-done 缺失）自动弹一次；侧栏「设置」入口可重开（onboardingRedo 事件）。
// 三步：①欢迎与定位一句话 ②本机 agent 源检测（GET /api/agent-activity 的 sources[]，逐源点亮）+
//       Gitea 连接态（GET /api/overview.gitea.ok）③下一步引导（看板建任务 / 智能体页看会话）。
// 全只读：不写任何 config/data，唯一持久化=localStorage 已读标记。
import { apiGet } from '../api.js';
import { esc, icon, openModal } from '../ui.js';

const AGENT_LABEL = { zcode: 'ZCode', claude: 'Claude Code', dsh: 'DSH', workbuddy: 'WorkBuddy', codex: 'Codex / ChatGPT 桌面', opencode: 'OpenCode' };
const DONE_KEY = 'fde-onboard-done';

export function shouldShowOnboarding() {
  try {
    return localStorage.getItem(DONE_KEY) !== '1';
  } catch (e) {
    return false; // 无 localStorage 环境不骚扰
  }
}

export function openOnboarding() {
  const box = document.createElement('div');
  box.className = 'ob-box';
  box.innerHTML = `
    <div class="ob-step" data-step="1">
      <div class="ob-hero">${icon('bot')}</div>
      <h3>你的本地 AI agent 团队，现在有了驾驶舱</h3>
      <p class="muted">看见（谁在干活）→ 理解（干了什么）→ 归因（成果挂任务）→ 验收（时间轴留痕）。<br>
      所有数据只读自本机，不上传任何字节。</p>
      <p class="muted small">检测到的 agent 会话库与团队 Git 动态会自动出现在对应页面，无需任何配置。</p>
    </div>
    <div class="ob-step" data-step="2" hidden>
      <h3>正在扫描本机 agent……</h3>
      <div class="ob-scan" id="ob-scan"><div class="loading">检测中…</div></div>
    </div>
    <div class="ob-step" data-step="3" hidden>
      <h3>一切就绪 🎉</h3>
      <p class="muted">三条最常用的路：</p>
      <div class="ob-next">
        <button type="button" class="btn" data-nav="#/board">${icon('kanban')}看板：建任务、验收成果</button>
        <button type="button" class="btn" data-nav="#/agents">${icon('bot')}智能体：谁在干什么</button>
        <button type="button" class="btn" data-nav="#/overview">${icon('layout-dashboard')}总览：活跃热力图与报告</button>
      </div>
      <p class="muted small">想让 agent 的提交自动挂到任务？看 <b>docs/ATTRIBUTION.md</b> 三条约定。</p>
    </div>
    <div class="ob-foot">
      <button type="button" class="btn ghost" id="ob-skip">跳过</button>
      <span class="spacer"></span>
      <button type="button" class="btn" id="ob-next">下一步</button>
    </div>`;
  const m = openModal({ title: '欢迎使用 FDE 指挥台', body: box, onClose: markDone });
  const steps = [...box.querySelectorAll('.ob-step')];
  let cur = 0;

  function markDone() {
    try { localStorage.setItem(DONE_KEY, '1'); } catch (e) { /* 无 localStorage 忽略 */ }
  }

  function show(i) {
    cur = i;
    steps.forEach((s, k) => { s.hidden = k !== i; });
    const next = box.querySelector('#ob-next');
    next.textContent = i === 2 ? '完成' : '下一步';
    next.hidden = i === 1; // 扫描步无按钮
    box.querySelector('#ob-skip').textContent = i === 2 ? '关闭' : '跳过';
    if (i === 1) scan();
  }

  async function scan() {
    const host = box.querySelector('#ob-scan');
    let sources = [];
    let giteaOk = null;
    try {
      const aa = await apiGet('/api/agent-activity');
      sources = Array.isArray(aa.sources) ? aa.sources : [];
    } catch (e) { /* 检测失败按全未知渲染 */ }
    try {
      const ov = await apiGet('/api/overview');
      giteaOk = !!(ov && ov.gitea && ov.gitea.ok);
    } catch (e) { giteaOk = null; }
    const okCount = sources.filter((s) => s && s.ok === true).length;
    const row = (label, ok, detail) => `
      <div class="ob-src">
        <span class="dot ${ok === true ? '' : ok === false ? 'err' : ''}"></span>
        <span class="ob-src-name">${esc(label)}</span>
        <span class="muted small">${esc(detail || '')}</span>
      </div>`;
    host.innerHTML =
      sources.map((s) => row(AGENT_LABEL[s.id] || s.id, s.ok, s.ok === true ? `${s.detail || '已检测到'}——点智能体页看它的会话` : s.ok === false ? '已安装但读不到会话（路径可配）' : '未检测到（装了就会亮）')).join('') +
      row('团队 Git（Gitea）', giteaOk, giteaOk === true ? '已连接，提交会自动归因到任务' : giteaOk === false ? '未连接——设置页配置组织后生效' : '状态未知');
    host.insertAdjacentHTML('beforeend',
      `<p class="muted small">检测到 ${okCount}/${sources.length} 个 agent 源。没装的不会报错，装了自动亮。</p>`);
  }

  box.querySelector('#ob-next').addEventListener('click', () => {
    if (cur >= 2) { markDone(); m.close(); return; }
    show(cur + 1);
  });
  box.querySelector('#ob-skip').addEventListener('click', () => { markDone(); m.close(); });
  box.querySelectorAll('[data-nav]').forEach((b) => {
    b.addEventListener('click', () => { markDone(); m.close(); location.hash = b.dataset.nav; });
  });
  show(0);
}
