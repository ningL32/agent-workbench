// F4 设置：读写 /api/settings（脱敏视图 + deep merge 部分更新）+ 「测试连接」调 /api/gitea/test
// v1.5.1：gateway 节（enabled/timeoutSec 可改；bin/minVersion 只读展示，版本比对见智能体页状态徽标）
// v2 设置页产品化二期：环境体检卡（GET /api/setup/check 六项 + 失败 hint）+ 引导条（allOk=false 时置顶）
//   + 文件级配置搬进 UI（钉钉采集 dwsBin/dwsTimeoutSec/maxMessages、分析引擎 dshBin/timeoutSec、
//   安全 trustedHosts 编辑器，localhost/127.0.0.1 内置不可删）+ Gitea 凭据配置指引卡
//   （凭据本身永不经页面：只展示可复制命令模板 + 测试连接，红线不变）
import { api, apiGet, apiPost } from '../api.js';
import { esc, toast, icon, fmtSec, fmtClock, busyBtn } from '../ui.js';

let rootEl = null;
let current = null;

// 后端内置信任 host（防 SSRF 边界）：只读展示，不可删；存盘的 security.trustedHosts 不含它们
const BUILTIN_HOSTS = ['localhost', '127.0.0.1'];

// busyBtn：提交/点击型操作的 busy 锁（SPEC-UX v2.1 §4-E）——进入即 disabled、finally 恢复、异常必解锁。
// 注意：ui.js 并行岗将导出同名实现，集成时换 ui.js 导出（签名一致）

export async function render(el) {
  rootEl = el;
  el.innerHTML = `
    <div class="settings" id="settings-form">
      <div class="setup-banner" id="setup-banner" hidden>
        ${icon('alert-triangle')}
        <span>环境未就绪：<b id="setup-banner-n">0</b> 项待配置</span>
        <button type="button" class="btn small" id="setup-banner-go">去查看</button>
      </div>

      <div class="set-card" id="setup-check-card">
        <div class="sc-h">
          <h4>${icon('activity')}环境体检</h4>
          <span class="spacer"></span>
          <button type="button" class="btn ghost small" id="btn-onboard" title="重看首次访问引导（源检测三步）">${icon('bot')}新手引导</button>
          <button type="button" class="btn ghost small" id="btn-check">${icon('zap')}一键体检</button>
        </div>
        <div class="desc">一键检查本机运行环境六项依赖；失败项附中文修复指引，按指引处理后点「重新体检」复核。</div>
        <div id="setup-body"><div class="loading">正在加载…</div></div>
      </div>

      <div class="frow"><label>服务地址</label>
        <div><input readonly id="set-addr"><div class="hint">仅回环绑定，host 不可改；port 改动需重启生效</div></div></div>
      <div class="frow"><label>Gitea 地址</label>
        <div><input id="set-base" placeholder="https://gitea.example.com"></div></div>
      <div class="frow"><label>组织</label>
        <div><input id="set-org" placeholder="example-org"></div></div>
      <div class="frow"><label>API 前缀</label>
        <div><input readonly id="set-prefix"></div></div>
      <div class="frow"><label>轮询间隔（秒）</label>
        <div><input id="set-poll" type="number" min="10" max="3600" step="1"></div></div>
      <div class="frow"><label>无更新预警阈值（秒）</label>
        <div><input id="set-warn" type="number" min="60" step="60"><div class="hint" id="set-warn-hint"></div></div></div>
      <div class="frow"><label>无更新危险阈值（秒）</label>
        <div><input id="set-danger" type="number" min="60" step="60"><div class="hint" id="set-danger-hint"></div></div></div>
      <div class="frow"><label>host 白名单</label>
        <div><input readonly id="set-whitelist" class="mono"></div></div>
      <div class="frow"><label>凭据来源</label>
        <div class="note" id="set-cred">${icon('lock')}加载中…</div></div>

      <div class="set-card" id="cred-card">
        <div class="sc-h">
          <h4>${icon('terminal')}Gitea 凭据配置指引</h4>
        </div>
        <div class="desc">预授权头 = base64(用户名:令牌)，由你在 Gitea 个人设置生成；凭据本身不经过本页面、不落盘（红线），只在下方命令中自行替换后于你的终端执行一次。</div>
        <div class="cred-cmd">
          <pre class="mono" id="cred-cmd-text"></pre>
          <button type="button" class="btn ghost xs" id="cred-copy">${icon('copy')}复制命令</button>
        </div>
        <div class="cred-actions">
          <button type="button" class="btn ghost small" id="cred-test">${icon('zap')}测试连接</button>
          <span class="note" id="cred-test-result"></span>
        </div>
      </div>

      <div class="set-card" id="card-ignore">
        <div class="sc-h"><h4>${icon('users')}成员册过滤</h4></div>
        <div class="desc">Gitea 组织成员派生成员册时的忽略名单（管理员/机器账号等非干活账号）；名单内 login 不入成员册，大小写不敏感。保存设置时一并提交。</div>
        <div class="frow"><label>忽略账号列表</label>
          <div>
            <div id="ignore-list" class="host-list"></div>
            <div class="col-row host-add">
              <input id="ignore-new" class="mono" placeholder="新增忽略账号，如 admin">
              <button type="button" class="btn ghost xs add" id="ignore-add">${icon('plus')}添加</button>
            </div>
          </div></div>
      </div>

      <div class="set-card" id="card-github">
        <div class="sc-h"><h4>${icon('git-branch')}GitHub 动态源</h4></div>
        <div class="desc">接入 GitHub 组织事件流（commit/PR），与 Gitea 动态合流到同一活动词表——成果自动归因、日报预填、团队动态自动吃到。仅支持组织（org events 端点），个人账号拉不到；保存即生效（随下个轮询周期），仅手改 config.json 才需重启。</div>
        <div class="frow"><label>启用</label>
          <div><span class="switch-line">
            <button type="button" class="switch" id="gh-enabled" aria-pressed="false" aria-label="GitHub 动态源开关"></button>
            <span class="muted small" id="gh-enabled-tip">…</span>
          </span><div class="hint">关闭 = 零出网零写盘；未配凭据时公共组织匿名拉取（限流 60 次/时/IP），私库需 PAT</div></div></div>
        <div class="frow"><label>组织名</label>
          <div><input id="gh-org" placeholder="GitHub 组织名，如 my-org（启用时必填）"></div></div>
        <div class="frow"><label>API 地址</label>
          <div><input id="gh-baseurl" class="mono" placeholder="https://api.github.com"><div class="hint">GitHub Enterprise 换成自建地址——host 须先在 config.json 的 github.hostWhitelist 白名单内（白名单仅手改）</div></div></div>
        <div class="frow"><label>凭据命令</label>
          <div>
            <div class="cred-cmd">
              <pre class="mono" id="gh-cred-cmd"></pre>
              <button type="button" class="btn ghost xs" id="gh-cred-copy">${icon('copy')}复制命令</button>
            </div>
            <div class="hint">私库才需要（值形如 "Authorization: Bearer ghp_xxx"）；令牌不进页面、不落盘</div>
          </div></div>
        <div class="frow"><label></label>
          <div>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <button type="button" class="btn ghost xs" id="gh-test">${icon('zap')}测试连接</button>
              <span class="note" id="gh-test-result"></span>
            </div>
            <div class="hint">按上方组织名/API 地址当前值探测（保存前可先试），拉 1 条最新事件验证链路</div>
          </div></div>
      </div>

      <div class="set-card" id="card-gitee">
        <div class="sc-h"><h4>${icon('git-merge')}Gitee 动态源</h4></div>
        <div class="desc">接入 Gitee（gitee.com）组织事件流（commit/PR），与 Gitea/GitHub 动态合流到同一活动词表。仅支持组织；公开组织匿名可拉（令牌只对私库必要）。保存即生效（随下个轮询周期），仅手改 config.json 才需重启。</div>
        <div class="frow"><label>启用</label>
          <div><span class="switch-line">
            <button type="button" class="switch" id="ge-enabled" aria-pressed="false" aria-label="Gitee 动态源开关"></button>
            <span class="muted small" id="ge-enabled-tip">…</span>
          </span><div class="hint">关闭 = 零出网零写盘；私库内容需私人令牌，公开组织匿名即可</div></div></div>
        <div class="frow"><label>组织名</label>
          <div><input id="ge-org" placeholder="Gitee 组织路径，如 example-org（启用时必填）"></div></div>
        <div class="frow"><label>API 地址</label>
          <div><input id="ge-baseurl" class="mono" placeholder="https://gitee.com"><div class="hint">自建/企业实例换地址——host 须先在 config.json 的 gitee.hostWhitelist 白名单内（白名单仅手改）</div></div></div>
        <div class="frow"><label>凭据命令</label>
          <div>
            <div class="cred-cmd">
              <pre class="mono" id="ge-cred-cmd"></pre>
              <button type="button" class="btn ghost xs" id="ge-cred-copy">${icon('copy')}复制命令</button>
            </div>
            <div class="hint">私库才需要（值 = 私人令牌原文，Gitee「设置 → 安全设置 → 私人令牌」生成）；令牌不进页面、不落盘</div>
          </div></div>
        <div class="frow"><label></label>
          <div>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <button type="button" class="btn ghost xs" id="ge-test">${icon('zap')}测试连接</button>
              <span class="note" id="ge-test-result"></span>
            </div>
            <div class="hint">按上方组织名/API 地址当前值探测（保存前可先试），拉 1 条最新事件验证链路</div>
          </div></div>
      </div>
      <div class="frow"><label>钉钉听记通道</label>
        <div><span class="switch-line">
          <button type="button" class="switch" id="radar-enabled" aria-pressed="false" aria-label="钉钉听记通道开关"></button>
          <span class="muted small" id="radar-enabled-tip">…</span>
        </span><div class="hint">开启后「任务雷达」可同步钉钉听记进池（凭据由 dws CLI 内部管理，本服务零凭据接触）</div></div></div>
      <div class="frow"><label>飞书妙记通道</label>
        <div><span class="switch-line">
          <button type="button" class="switch" id="feishu-enabled" aria-pressed="false" aria-label="飞书妙记通道开关"></button>
          <span class="muted small" id="feishu-enabled-tip">…</span>
        </span><div class="hint">开启后「任务雷达」可同步飞书妙记进池（凭据由 lark-cli 内部管理，本服务零凭据接触；需先 npm i -g @larksuite/cli 并完成 lark-cli config init + auth login）</div></div></div>
      <div class="set-card" id="integrations-card">
        <div class="sc-h"><h4>${icon('link')}集成出口（只读状态）</h4></div>
        <div class="frow"><label>Webhook 事件推送</label>
          <div><span class="note" id="wo-status">${icon('zap')}加载中…</span>
          <div class="hint">config.json 手改 <span class="mono">webhookOut:{enabled,url}</span>（60s 内生效）；任务事件 POST 到你配的 Slack/Discord/飞书机器人；url 仅显示 host，令牌不进页面</div></div></div>
        <div class="frow"><label>Agent 上下文注入</label>
          <div><span class="note" id="ac-status">${icon('zap')}加载中…</span>
          <div class="hint">config.json 手改 <span class="mono">agentContext:{enabled,dirs:[项目目录]}</span>（白名单目录才写 <span class="mono">.fde/daily.md</span>）；跑 scripts/write-agent-context.js 生成</div></div></div>
      </div>
      <div class="set-card" id="card-im">
        <div class="sc-h"><h4>${icon('radio')}IM 通知（飞书 / 钉钉）</h4></div>
        <div class="desc">把「待验收 / 已完成」与每日待办摘要推到群机器人。URL 含机器人令牌，页面只显示 host 与尾号；新 URL 需整条粘贴（留空 = 保持现状）。加签密钥只进配置文件，不回显。</div>
        <div class="frow"><label>总开关</label>
          <div><span class="switch-line">
            <button type="button" class="switch" id="im-enabled" aria-pressed="false" aria-label="IM 通知总开关"></button>
            <span class="muted small" id="im-enabled-tip">…</span>
          </span><div class="hint">关闭后事件与摘要都不出网（配置保留）；开关随「保存设置」生效</div></div></div>
        <div class="frow"><label>飞书机器人</label>
          <div>
            <div class="note" id="im-feishu-status">—</div>
            <input id="im-feishu-url" class="mono" placeholder="粘贴新的飞书 Webhook URL（留空 = 保持现状）">
            <input id="im-feishu-secret" class="mono" type="password" autocomplete="off" placeholder="加签密钥（可选；留空 = 沿用旧值）">
          </div></div>
        <div class="frow"><label>钉钉机器人</label>
          <div>
            <div class="note" id="im-dingtalk-status">—</div>
            <input id="im-dingtalk-url" class="mono" placeholder="粘贴新的钉钉 Webhook URL（留空 = 保持现状）">
            <input id="im-dingtalk-secret" class="mono" type="password" autocomplete="off" placeholder="加签密钥（可选；留空 = 沿用旧值）">
          </div></div>
        <div class="frow"><label>每日摘要</label>
          <div><span class="switch-line">
            <button type="button" class="switch" id="im-digest-enabled" aria-pressed="false" aria-label="每日摘要开关"></button>
            <input id="im-digest-at" class="mono" style="width:88px" maxlength="5" placeholder="09:10">
            <span class="muted small">（本地时间 HH:MM）</span>
          </span><div class="hint">到点推一次：逾期 / 待验收 / 收件箱待确认 / 昨日完成；一天最多 3 次尝试，失败不刷屏</div></div></div>
        <div class="frow"><label>即时事件</label>
          <div><span class="act-chips" role="group" aria-label="即时事件开关">
            <button type="button" class="chip" id="im-events-review" aria-pressed="false">待验收</button>
            <button type="button" class="chip" id="im-events-completed" aria-pressed="false">已完成</button>
          </span><div class="hint">任务进入待验收 / 被标记完成时即时推送；默认关（避免噪音）。这两个是开关按钮：点亮=开启，随「保存设置」生效</div></div></div>
        <div class="frow"><label></label>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button type="button" class="btn ghost" id="im-test">${icon('zap')}发送测试消息</button>
            <span class="note" id="im-test-result"></span>
          </div><div class="hint">测的是「已保存」的配置：改了 URL 请先保存再测</div></div>
      </div>
      <div class="set-card" id="card-learn">
        <div class="sc-h"><h4>${icon('book-open')}知识库学习</h4></div>
        <div class="desc">配置本地 LLM Wiki 知识库（<b>只读</b>）：每天用一个概念走「先测 → 费曼讲解 → 五问 → 迁移题」，按遗忘曲线排复习。未配置时左侧导航<b>不会出现</b>「学习」；本功能不会写你的知识库一个字节。</div>
        <div class="frow"><label>总开关</label>
          <div><span class="switch-line">
            <button type="button" class="switch" id="learn-enabled" aria-pressed="false" aria-label="学习模式开关"></button>
            <span class="muted small" id="learn-enabled-tip">…</span>
          </span><div class="hint">随「保存设置」生效；保存后 30 秒内左侧出现「学习」</div></div></div>
        <div class="frow"><label>知识库根路径</label>
          <div><input id="learn-root" class="mono" placeholder="D:\\knowledge\\my-vault">
            <div class="hint" id="learn-root-state">未校验（点「测试根路径」）</div></div></div>
        <div class="frow"><label>扫描范围</label>
          <div><input id="learn-scope" class="mono" placeholder="wiki（默认，多个用逗号分隔）">
            <input id="learn-exclude" class="mono" placeholder="排除子路径（逗号分隔，可留空）">
            <div class="hint">只扫这些目录下的 .md；排除项用于剔掉不适合当教材的项目文档</div></div></div>
        <div class="frow"><label>内置主题</label>
          <div><input id="learn-seeds" class="mono" placeholder="模型与推理,Java,Agent 开发,Python">
            <div class="hint">知识库之外的工程基础概念（随插件走、不联网）。可选：模型与推理 / Java / Agent 开发 / Python；留空 = 只用知识库。与知识库知识点按单双日交替出题</div></div></div>
        <div class="frow"><label>导入资料</label>
          <div><input id="learn-import-path" class="mono" placeholder="C:\\资料\\某本书.pdf  或  某个目录">
            <div class="hint">支持 md / txt / html / docx / pdf。导入只落本地 <span class="mono">data/learn/imports/</span>，<b>不动你的知识库</b>；PDF 扫描件抽不出字会明确报错而不是塞垃圾</div></div></div>
        <div class="frow"><label></label>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button type="button" class="btn ghost" id="learn-import">导入并加入学习库</button>
            <span class="note" id="learn-import-result"></span>
          </div></div>
        <div class="frow"><label>每日题量</label>
          <div><span class="switch-line">
            <input id="learn-daily-new" type="number" min="0" max="10" step="1" style="width:72px"><span class="muted small">新题</span>
            <input id="learn-daily-review" type="number" min="0" max="10" step="1" style="width:72px"><span class="muted small">复习</span>
          </span><div class="hint">到期复习优先；到期为空才补新题（对齐知识库题库的「复习优先于新题」）</div></div></div>
        <div class="frow"><label></label>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button type="button" class="btn ghost" id="learn-test">${icon('zap')}测试根路径</button>
            <button type="button" class="btn ghost" id="learn-scan">${icon('refresh-cw')}重建索引</button>
            <span class="note" id="learn-result"></span>
          </div><div class="hint">「测试根路径」只读校验（存在 + AGENTS.md + LLM Wiki 标记）；「重建索引」只读扫描，产出落在本地 data/learn/</div></div>
      </div>
      <div class="frow"><label>雷达引擎状态</label>
        <div class="note" id="radar-engine-note">${icon('zap')}加载中…</div></div>
      <div class="frow"><label></label>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button type="button" class="btn ghost" id="radar-sync-btn">${icon('refresh-cw')}手动同步钉钉听记</button>
          <button type="button" class="btn ghost" id="radar-feishu-sync-btn">${icon('refresh-cw')}手动同步飞书妙记</button>
          <button type="button" class="btn ghost" id="radar-engine-test">${icon('zap')}引擎测试</button>
          <span class="note" id="radar-result"></span>
        </div></div>

      <div class="set-card" id="card-dingtalk">
        <div class="sc-h"><h4>${icon('mic')}钉钉采集</h4></div>
        <div class="desc">配置钉钉听记采集 CLI（dws）的路径与拉取量；不配或路径错误则「任务雷达」无法同步钉钉听记，其余功能不受影响。</div>
        <div class="frow"><label>dws 程序路径</label>
          <div><input id="dt-dwsbin" placeholder="留空则按 PATH 与默认安装位置探测，如 C:\\Tools\\dws.exe"></div></div>
        <div class="frow"><label>单次拉取超时（秒）</label>
          <div><input id="dt-dwsTimeoutSec" type="number" min="10" max="600" step="10"><div class="hint">单次调用 dws 拉取听记的最长等待</div></div></div>
        <div class="frow"><label>单次拉取上限（条）</label>
          <div><input id="dt-maxMessages" type="number" min="1" max="1000" step="1"><div class="hint">每次同步最多拉取的听记条数，防止首次同步过久</div></div></div>
      </div>

      <div class="set-card" id="card-feishu">
        <div class="sc-h"><h4>${icon('mic')}飞书采集</h4></div>
        <div class="desc">配置飞书妙记采集 CLI（lark-cli）的路径与拉取量；需先安装 lark-cli 并完成飞书应用配置与用户授权，凭据由 CLI 内部管理。不配或路径错误则「任务雷达」无法同步飞书妙记，其余功能不受影响。</div>
        <div class="frow"><label>lark-cli 程序路径</label>
          <div><input id="fx-larkbin" placeholder="留空则按 PATH 与默认安装位置探测，如 C:\\Tools\\lark-cli.exe"></div></div>
        <div class="frow"><label>单次调用超时（秒）</label>
          <div><input id="fx-larkTimeoutSec" type="number" min="10" max="600" step="10"><div class="hint">单次调用 lark-cli 的最长等待</div></div></div>
        <div class="frow"><label>单次拉取上限（条）</label>
          <div><input id="fx-maxMessages" type="number" min="1" max="1000" step="1"><div class="hint">每次同步最多拉取的妙记条数，防止首次同步过久</div></div></div>
        <div class="frow"><label>回溯窗口（天）</label>
          <div><input id="fx-lookbackDays" type="number" min="1" max="365" step="1"><div class="hint">向前追溯多少天内的妙记；飞书官方限制单次搜索窗最长 1 个月，服务端会自动分窗查询</div></div></div>
      </div>

      <div class="set-card" id="card-analyze">
        <div class="sc-h"><h4>${icon('zap')}分析引擎</h4></div>
        <div class="desc">配置纪要分析引擎（dsh）的路径与超时；不配则听记分析全部失败，超时过短会把慢会话误判为失败（失败可重试且自动升压）。</div>
        <div class="frow"><label>dsh 程序路径</label>
          <div><input id="az-dshbin" placeholder="留空则按 PATH 与默认安装位置探测，如 C:\\Tools\\dsh-bin.js"></div></div>
        <div class="frow"><label>分析超时（秒）</label>
          <div><input id="az-timeoutSec" type="number" min="60" step="30"><div class="hint">长会话建议 ≥600，避免长会话分析被超时误杀</div></div></div>
      </div>

      <div class="set-card" id="card-observe">
        <div class="sc-h"><h4>${icon('bot')}智能体观测</h4></div>
        <div class="desc">只读扫描本机各 AI 智能体的会话库，支撑「智能体动态 / 成员进度 / 数字员工报告」。关掉的源立即退出观测与报告养料（已生成的报告不受影响）；默认全开。路径被挪过位置的源仍需在 config.json 的 agentActivity.sources 里覆盖 root/dbPath。</div>
        <div class="frow"><label>观测总开关</label>
          <div><span class="switch-line">
            <button type="button" class="switch" id="aa-enabled" aria-pressed="false" aria-label="智能体观测总开关"></button>
            <span class="muted small" id="aa-enabled-tip">…</span>
          </span><div class="hint">总开关关闭 = 六源全部停止读取，成员册/动态/报告养料随之缺席（数据不删，重新开启即恢复）</div></div></div>
        <div class="frow"><label>分源开关</label>
          <div id="aa-sources" class="host-list"></div></div>
      </div>

      <div class="set-card" id="card-security">
        <div class="sc-h"><h4>${icon('lock')}安全</h4></div>
        <div class="desc">出站请求只允许访问下列 host（精确匹配防 SSRF）；localhost / 127.0.0.1 为后端内置信任。加错 host 会导致对应请求被 400 拒绝。注意：修改本节后需重启 DSH profile 生效（Host 防线为启动期快照）。</div>
        <div class="frow"><label>信任 host 列表</label>
          <div>
            <div id="host-list" class="host-list"></div>
            <div class="col-row host-add">
              <input id="host-new" class="mono" placeholder="新增信任 host，如 gitea.example.com">
              <button type="button" class="btn ghost xs add" id="host-add">${icon('plus')}添加</button>
            </div>
          </div></div>
      </div>

      <div class="frow"><label></label>
        <div style="display:flex;gap:10px;align-items:center">
          <button type="button" class="btn" id="btn-save">保存设置</button>
          <span class="muted small">保存即 PATCH /api/settings（按节 deep merge，含新三卡字段）</span>
        </div></div>
    </div>`;

  // 环境体检：一键/重新体检 + 引导条锚点滚动
  el.querySelector('#btn-check').addEventListener('click', runCheck);
  // v2.9.26 新手引导重开入口：派发自定义事件，app.js 的监听开弹层（避免跨页直接 import 造成的循环依赖）
  el.querySelector('#btn-onboard').addEventListener('click', () => window.dispatchEvent(new CustomEvent('onboardingRedo')));
  el.querySelector('#setup-banner-go').addEventListener('click', scrollToCheckCard);
  // 凭据指引卡：复制命令 + 测试连接（复用同一测试逻辑）
  el.querySelector('#cred-copy').addEventListener('click', copyCredCmd);
  wireTestPair('cred-test', 'cred-test-result');
  // GitHub 动态源（v2.9.17 页面化）：开关即时 PATCH / 凭据命令随 API 地址联动 / 复制
  el.querySelector('#gh-enabled').addEventListener('click', toggleGithub);
  el.querySelector('#gh-baseurl').addEventListener('input', drawGithubCmd);
  el.querySelector('#gh-cred-copy').addEventListener('click', copyGhCredCmd);
  // Gitee 动态源（v2.9.18 页面化）：开关即时 PATCH / 凭据命令随 API 地址联动 / 复制
  el.querySelector('#ge-enabled').addEventListener('click', toggleGitee);
  el.querySelector('#ge-baseurl').addEventListener('input', drawGiteeCmd);
  el.querySelector('#ge-cred-copy').addEventListener('click', copyGeCredCmd);
  el.querySelector('#gh-test').addEventListener('click', () => testSource('github', 'gh-test', 'gh-test-result'));
  el.querySelector('#ge-test').addEventListener('click', () => testSource('gitee', 'ge-test', 'ge-test-result'));
  // 任务雷达：通道开关 / 手动同步 / 引擎测试
  el.querySelector('#radar-enabled').addEventListener('click', toggleRadar);
  el.querySelector('#feishu-enabled').addEventListener('click', toggleFeishu);
  el.querySelector('#radar-sync-btn').addEventListener('click', () => radarSync('sync'));
  el.querySelector('#radar-feishu-sync-btn').addEventListener('click', () => radarSync('sync-feishu'));
  el.querySelector('#radar-engine-test').addEventListener('click', radarEngineTest);
  ['set-warn', 'set-danger'].forEach((id) => {
    el.querySelector('#' + id).addEventListener('input', updateHints);
  });
  // 信任 host 编辑器：行内删除（事件委托）+ 添加（按钮 / 回车）
  el.querySelector('#host-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    const idx = Number(del.dataset.del);
    drawHosts(editableHostValues().filter((_, i) => i !== idx));
  });
  el.querySelector('#host-add').addEventListener('click', addHost);
  el.querySelector('#host-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') addHost(); });

  // busy 锁（§4-E）：save 的 PATCH 期间「保存设置」disabled，防连点重复提交
  const saveBtn = el.querySelector('#btn-save');
  saveBtn.addEventListener('click', () => { busyBtn(saveBtn, save); });

  // 智能体观测：总开关 + 分源开关（即时 PATCH，同雷达开关口径）
  el.querySelector('#aa-enabled').addEventListener('click', toggleAa);
  // 忽略账号编辑器：行内删除（事件委托）+ 添加（按钮 / 回车）
  el.querySelector('#ignore-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    const idx = Number(del.dataset.del);
    drawIgnoreLogins(editableIgnoreValues().filter((_, i) => i !== idx));
  });
  el.querySelector('#ignore-add').addEventListener('click', addIgnore);
  el.querySelector('#ignore-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') addIgnore(); });

  // v2.9.39 IM 通知：四个开关只改本地态（随「保存设置」一起 PATCH）；测试消息即时发
  for (const id of ['im-enabled', 'im-digest-enabled', 'im-events-review', 'im-events-completed']) {
    const btn = el.querySelector('#' + id);
    if (!btn) continue;
    btn.addEventListener('click', () => {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(on));
      // .switch 是拨动开关（配 .off 表示关）；.chip 是文字开关（配 .on 表示开）
      if (btn.classList.contains('chip')) btn.classList.toggle('on', on);
      else btn.classList.toggle('off', !on);
      if (id === 'im-enabled') {
        const tip = el.querySelector('#im-enabled-tip');
        if (tip) tip.textContent = on ? '已开启（保存后生效）' : '已关闭';
      }
    });
  }
  const imTestBtn = el.querySelector('#im-test');
  if (imTestBtn) imTestBtn.addEventListener('click', testIm);

  // v2.9.45 知识库学习：开关随保存提交；测试根路径 / 重建索引即时打
  const learnSw = el.querySelector('#learn-enabled');
  if (learnSw) {
    learnSw.addEventListener('click', () => {
      const on = learnSw.getAttribute('aria-pressed') !== 'true';
      learnSw.setAttribute('aria-pressed', String(on));
      learnSw.classList.toggle('off', !on);
      const tip = el.querySelector('#learn-enabled-tip');
      if (tip) tip.textContent = on ? '已开启（保存后生效）' : '已关闭';
    });
  }
  const learnTestBtn = el.querySelector('#learn-test');
  if (learnTestBtn) learnTestBtn.addEventListener('click', testLearnRoot);
  const learnScanBtn = el.querySelector('#learn-scan');
  if (learnScanBtn) learnScanBtn.addEventListener('click', scanLearn);
  const learnImportBtn = el.querySelector('#learn-import');
  if (learnImportBtn) learnImportBtn.addEventListener('click', importLearn);

  await load();
}

export function destroy() { rootEl = null; }

async function load() {
  const root = rootEl;
  if (!root) return;
  try {
    const s = await apiGet('/api/settings');
    if (!rootEl) return;
    current = s || {};
    const g = current.gitea || {};
    root.querySelector('#set-addr').value = `${current.host || '127.0.0.1'}:${current.port || 7788}（仅回环绑定）`;
    root.querySelector('#set-base').value = g.baseUrl || '';
    root.querySelector('#set-org').value = g.org || '';
    root.querySelector('#set-prefix').value = g.apiPrefix || '/api/v1';
    root.querySelector('#set-poll').value = g.pollIntervalSec != null ? g.pollIntervalSec : 60;
    root.querySelector('#set-warn').value = g.staleWarnSec != null ? g.staleWarnSec : 14400;
    root.querySelector('#set-danger').value = g.staleDangerSec != null ? g.staleDangerSec : 86400;
    root.querySelector('#set-whitelist').value = (g.hostWhitelist || []).join(', ');
    root.querySelector('#set-cred').innerHTML =
      `${icon('lock')}${esc(current.credential || '未知')} · 运行时读取 · 不落盘 · 不进日志`;
    updateHints();
    // 钉钉采集 / 分析引擎 / 安全（二期新三卡）回读
    const dt = current.dingtalk || {};
    root.querySelector('#dt-dwsbin').value = dt.dwsBin || '';
    root.querySelector('#dt-dwsTimeoutSec').value = dt.dwsTimeoutSec != null ? dt.dwsTimeoutSec : 60;
    root.querySelector('#dt-maxMessages').value = dt.maxMessages != null ? dt.maxMessages : 200;
    // 飞书采集卡回读 + 通道开关
    const fx = current.feishu || {};
    root.querySelector('#fx-larkbin').value = fx.larkBin || '';
    root.querySelector('#fx-larkTimeoutSec').value = fx.larkTimeoutSec != null ? fx.larkTimeoutSec : 60;
    root.querySelector('#fx-maxMessages').value = fx.maxMessages != null ? fx.maxMessages : 200;
    root.querySelector('#fx-lookbackDays').value = fx.lookbackDays != null ? fx.lookbackDays : 90;
    drawFeishu(fx.enabled === true);
    const az = current.analyze || {};
    root.querySelector('#az-dshbin').value = az.dshBin || '';
    root.querySelector('#az-timeoutSec').value = az.timeoutSec != null ? az.timeoutSec : 300;
    drawHosts((current.security && current.security.trustedHosts) || []);
    // v2.9.7 成员册过滤（ignoreLogins）+ 智能体观测开关 + GitHub 源指引回读
    drawIgnoreLogins((g && g.ignoreLogins) || []);
    drawAa(current.agentActivity || {});
    drawGithub(current.github || null);
    drawGitee(current.gitee || null);
    drawIm(current.im || {});
    drawLearn(current.learn || {});
    // 凭据命令模板：随 Gitea 地址代入（命令经 textContent 写入，防注入）
    root.querySelector('#cred-cmd-text').textContent =
      `git config --global http.${g.baseUrl || '<Gitea 地址>'}/.extraheader "<你的预授权头>"`;
    drawRadar(current.dingtalk && current.dingtalk.enabled !== false);
    // v2.9.29 D4：集成出口只读状态
    const wo = current.webhookOut || {};
    root.querySelector('#wo-status').innerHTML = wo.enabled
      ? `${icon('check-circle')}已开启 → <span class="mono">${esc(wo.urlHost || '(url 未配置)')}</span>`
      : '未开启';
    const ac = current.agentContext || {};
    root.querySelector('#ac-status').innerHTML = ac.enabled
      ? `${icon('check-circle')}已开启 · 白名单 ${ac.dirsCount} 个目录`
      : '未开启';
    refreshEngineNote();
    runCheck(); // 进页即体检一次：引导条显隐依赖 allOk，骨架态由 runCheck 自绘
  } catch (e) {
    toast(e.message);
    root.querySelector('#settings-form').insertAdjacentHTML('afterbegin',
      `<div class="form-err show">${esc(e.message)}</div>`);
  }
}

// ---- 环境体检（v2）：GET /api/setup/check 六项 + 失败 hint + 引导条 ----

async function runCheck() {
  const root = rootEl;
  if (!root) return;
  const body = root.querySelector('#setup-body');
  const btn = root.querySelector('#btn-check');
  if (!body) return;
  if (btn) btn.disabled = true;
  // 体检中骨架态：6 格脉冲占位（reduced-motion 下全局动效开关自动静止）
  body.innerHTML = `<div class="setup-skel">${'<div class="skel-cell"></div>'.repeat(6)}</div>`;
  try {
    const r = await apiGet('/api/setup/check');
    if (!rootEl) return;
    drawCheckResult(r || {});
  } catch (e) {
    if (!rootEl) return;
    body.innerHTML = `<div class="empty-state">${icon('alert-triangle')}体检失败：${esc(e.message)}</div>`;
    toast(e.message);
  }
  if (btn && btn.isConnected) btn.disabled = false;
}

function drawCheckResult(r) {
  const root = rootEl;
  if (!root) return;
  const body = root.querySelector('#setup-body');
  if (!body) return;
  const items = Array.isArray(r.items) ? r.items : [];
  const failItems = items.filter((i) => i && i.ok === false);
  const when = r.checkedAt ? fmtClock(r.checkedAt) : '';
  const sum = r.allOk
    ? `<div class="setup-sum ok">${icon('check-circle')}<b>环境就绪</b><span class="muted small">${items.length}/${items.length} 项通过${when ? ` · 检查于 ${esc(when)}` : ''}</span></div>`
    : `<div class="setup-sum bad">${icon('alert-triangle')}<b>${failItems.length} 项待配置</b><span class="muted small">${items.length - failItems.length}/${items.length} 项通过${when ? ` · 检查于 ${esc(when)}` : ''}</span></div>`;
  body.innerHTML = sum + `<div class="setup-grid">${items.map((it) => {
    const ok = it && it.ok !== false;
    // 可选组件（评审 P2：optional 字段前端消费）——未安装渲染中性「可选」徽标，不再假绿
    const optionalBadge = ok && it && it.optional
      ? '<span class="badge b-ro" title="可选组件：未安装只影响任务雷达对应源，其余功能不受影响">可选</span>'
      : '';
    return `<div class="setup-item${ok ? '' : ' bad'}">
      <div class="si-h">
        <span class="si-name">${esc((it && it.name) || (it && it.id) || '未知项')}</span>
        <span class="badge ${ok ? 'st-working' : 'st-danger'}">${ok ? icon('check') + '通过' : icon('x') + '未通过'}</span>
        ${optionalBadge}
      </div>
      <div class="si-detail">${esc((it && it.detail) || '—')}</div>
      ${(!ok && it && it.hint) ? `<div class="setup-hint">${icon('alert-triangle')}<span>${esc(it.hint)}</span></div>` : ''}
    </div>`;
  }).join('')}</div>`;
  const btn = root.querySelector('#btn-check');
  if (btn) btn.innerHTML = `${icon('refresh-cw')}重新体检`;
  drawBanner(r);
}

// 新人引导条：allOk=false 时置顶 amber 条 + 锚点滚动；总览页不加载本视图，天然不出现（保持克制）
function drawBanner(r) {
  const root = rootEl;
  if (!root) return;
  const banner = root.querySelector('#setup-banner');
  if (!banner) return;
  const n = r && Array.isArray(r.items) ? r.items.filter((i) => i && i.ok === false).length : 0;
  if (r && r.allOk === false && n > 0) {
    banner.hidden = false;
    const num = banner.querySelector('#setup-banner-n');
    if (num) num.textContent = String(n);
  } else {
    banner.hidden = true;
  }
}

function scrollToCheckCard() {
  const card = rootEl && rootEl.querySelector('#setup-check-card');
  if (!card) return;
  const reduce = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

// ---- Gitea 凭据配置指引（v2）：命令模板可复制 + 测试连接（复用既有测试逻辑）；凭据零经页面 ----

function credCommandText() {
  const root = rootEl;
  const pre = root && root.querySelector('#cred-cmd-text');
  return pre ? pre.textContent : '';
}

async function copyCredCmd() {
  const text = credCommandText();
  if (!text) { toast('命令模板尚未加载', 'error'); return; }
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { ok = false; }
  if (!ok) {
    // 无剪贴板权限（非安全上下文/无头环境）时的兜底：临时 textarea + execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch { ok = false; }
  }
  toast(ok ? '命令已复制：替换 <你的预授权头> 后在本机终端执行' : '复制失败，请手动选择命令文本复制', ok ? 'success' : 'error');
}

// ---- 信任 host 编辑器（v2 security.trustedHosts）：内置行只读 + 自定义行可删可增 ----

function drawHosts(list) {
  const root = rootEl;
  if (!root) return;
  const box = root.querySelector('#host-list');
  if (!box) return;
  const norm = (s) => String(s || '').trim().toLowerCase();
  const users = (list || []).filter((h) => h && !BUILTIN_HOSTS.some((b) => norm(b) === norm(h)));
  box.innerHTML = BUILTIN_HOSTS.map((h) => `
    <div class="host-row">
      <input readonly class="mono" value="${esc(h)}" aria-label="内置信任 host">
      <span class="badge b-ro" title="后端内置信任，无需配置">内置，不可删</span>
    </div>`).join('')
    + users.map((h, i) => `
    <div class="host-row">
      <input class="mono" value="${esc(h)}" data-host-idx="${i}" aria-label="信任 host">
      <button type="button" class="icon-btn" data-del="${i}" aria-label="删除该 host">${icon('trash')}</button>
    </div>`).join('')
    + (users.length ? '' : '<div class="hint">暂无自定义信任 host，仅内置项生效</div>');
}

function editableHostValues() {
  const root = rootEl;
  if (!root) return [];
  return Array.from(root.querySelectorAll('#host-list input:not([readonly])'))
    .map((i) => i.value.trim()).filter(Boolean);
}

function collectHosts() {
  const out = [];
  const seen = new Set();
  for (const h of editableHostValues()) {
    const key = h.toLowerCase();
    if (seen.has(key) || BUILTIN_HOSTS.some((b) => b.toLowerCase() === key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

function addHost() {
  const root = rootEl;
  if (!root) return;
  const inp = root.querySelector('#host-new');
  const v = (inp.value || '').trim();
  if (!v) { toast('请先输入要信任的 host', 'info'); return; }
  const exists = BUILTIN_HOSTS.concat(editableHostValues())
    .some((h) => h.toLowerCase() === v.toLowerCase());
  if (exists) { toast('该 host 已在列表中', 'info'); return; }
  drawHosts(editableHostValues().concat(v));
  inp.value = '';
  inp.focus();
}

// ---- v2.9.7 智能体观测开关（agentActivity）：总开关 + 六源分开关，即时 PATCH（同雷达开关口径）----

const AA_SOURCES = [
  { id: 'workbuddy', name: 'WorkBuddy', loc: '~/.workbuddy/workbuddy.db' },
  { id: 'zcode', name: 'ZCode', loc: '~/.zcode/cli' },
  { id: 'claude', name: 'Claude', loc: '~/.claude/projects' },
  { id: 'dsh', name: 'DSH', loc: '~/.dsh/sessions' },
  { id: 'codex', name: 'Codex（ChatGPT 桌面）', loc: '~/.codex/sessions' },
  { id: 'opencode', name: 'OpenCode', loc: '~/.local/share/opencode/opencode.db' },
];

function drawAa(sec) {
  const root = rootEl;
  if (!root) return;
  const enabled = sec && sec.enabled !== false;
  const sw = root.querySelector('#aa-enabled');
  const tip = root.querySelector('#aa-enabled-tip');
  if (sw) {
    sw.setAttribute('aria-pressed', String(enabled));
    sw.classList.toggle('off', !enabled);
  }
  if (tip) tip.textContent = enabled ? '已开启' : '已关闭';
  const box = root.querySelector('#aa-sources');
  if (!box) return;
  const sources = (sec && sec.sources) || {};
  box.innerHTML = AA_SOURCES.map((s) => {
    const on = enabled && !(sources[s.id] && sources[s.id].enabled === false);
    return `<div class="host-row">
      <span style="flex:1;min-width:0"><b>${esc(s.name)}</b> <span class="muted small mono">${esc(s.loc)}</span></span>
      <button type="button" class="switch${on ? '' : ' off'}" data-aa="${s.id}" aria-pressed="${on}" aria-label="${esc(s.name)} 观测开关"></button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-aa]').forEach((swEl) => {
    swEl.addEventListener('click', async () => {
      const id = swEl.dataset.aa;
      const next = swEl.getAttribute('aria-pressed') !== 'true';
      try {
        await api('/api/settings', { method: 'PATCH', body: { agentActivity: { sources: { [id]: { enabled: next } } } } });
        swEl.setAttribute('aria-pressed', String(next));
        swEl.classList.toggle('off', !next);
        toast(`${AA_SOURCES.find((x) => x.id === id).name} 观测已${next ? '开启' : '关闭'}`, 'success');
      } catch (e) {
        toast(e.message);
      }
    });
  });
}

async function toggleAa() {
  const root = rootEl;
  if (!root) return;
  const sw = root.querySelector('#aa-enabled');
  const next = sw.getAttribute('aria-pressed') !== 'true';
  try {
    const r = await api('/api/settings', { method: 'PATCH', body: { agentActivity: { enabled: next } } });
    drawAa(r && r.agentActivity ? r.agentActivity : { enabled: next });
    toast(next ? '智能体观测已开启' : '智能体观测已关闭（六源停止读取）', 'success');
  } catch (e) {
    toast(e.message);
  }
}

// ---- v2.9.7 成员册过滤编辑器（gitea.ignoreLogins）：随「保存设置」一并提交（同 trustedHosts 模式）----

function drawIgnoreLogins(list) {
  const root = rootEl;
  if (!root) return;
  const box = root.querySelector('#ignore-list');
  if (!box) return;
  const users = list || [];
  box.innerHTML = users.map((h, i) => `
    <div class="host-row">
      <input class="mono" value="${esc(h)}" data-ig-idx="${i}" aria-label="忽略账号">
      <button type="button" class="icon-btn" data-ig-del="${i}" aria-label="删除该忽略账号">${icon('trash')}</button>
    </div>`).join('')
    + (users.length ? '' : '<div class="hint">暂无忽略账号——默认名单（admin）已随安装写入，如需调整请在此编辑后保存</div>');
}

function editableIgnoreValues() {
  const root = rootEl;
  if (!root) return [];
  return Array.from(root.querySelectorAll('#ignore-list input'))
    .map((i) => i.value.trim()).filter(Boolean);
}

function collectIgnoreLogins() {
  const out = [];
  const seen = new Set();
  for (const v of editableIgnoreValues()) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function addIgnore() {
  const root = rootEl;
  if (!root) return;
  const inp = root.querySelector('#ignore-new');
  const v = (inp.value || '').trim();
  if (!v) { toast('请先输入要忽略的账号', 'info'); return; }
  if (editableIgnoreValues().some((h) => h.toLowerCase() === v.toLowerCase())) {
    toast('该账号已在列表中', 'info'); return;
  }
  drawIgnoreLogins(editableIgnoreValues().concat(v));
  inp.value = '';
  inp.focus();
}

// ---- v2.9.17 GitHub 源页面化（enabled/org/baseUrl 可经 PATCH 热生效；凭据仍 git config 零落盘）----

function ghCredCommand(baseUrl) {
  const b = String(baseUrl || '').trim() || 'https://api.github.com';
  return `git config --global http.${b}/.extraheader "Authorization: Bearer <PAT>"`;
}

function drawGithubCmd() {
  const root = rootEl;
  if (!root) return;
  const el = root.querySelector('#gh-cred-cmd');
  if (el) el.textContent = ghCredCommand(root.querySelector('#gh-baseurl').value);
}

function drawGithub(gh) {
  const root = rootEl;
  if (!root) return;
  const on = !!(gh && gh.enabled);
  const sw = root.querySelector('#gh-enabled');
  sw.setAttribute('aria-pressed', String(on));
  sw.classList.toggle('off', !on);
  root.querySelector('#gh-enabled-tip').textContent = on ? '已启用' : '未启用';
  root.querySelector('#gh-org').value = (gh && gh.org) || '';
  root.querySelector('#gh-baseurl').value = (gh && gh.baseUrl) || '';
  drawGithubCmd();
}

async function toggleGithub() {
  const root = rootEl;
  if (!root) return;
  const sw = root.querySelector('#gh-enabled');
  const next = sw.getAttribute('aria-pressed') !== 'true';
  const org = root.querySelector('#gh-org').value.trim();
  if (next && !org) { toast('启用前先填组织名（仅支持组织，不支持个人账号）', 'error'); return; }
  try {
    // 开关即时 PATCH（同雷达开关口径）：热生效随下个轮询周期，无需重启
    const r = await api('/api/settings', { method: 'PATCH', body: { github: { enabled: next } } });
    drawGithub(r.github || {});
    toast(next ? 'GitHub 动态源已启用（下个轮询周期生效）' : 'GitHub 动态源已关闭', 'success');
  } catch (e) {
    toast(e.message);
  }
}

async function copyGhCredCmd() {
  const root = rootEl;
  if (!root) return;
  const text = ghCredCommand(root.querySelector('#gh-baseurl').value);
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { ok = false; }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch { ok = false; }
  }
  toast(ok ? '凭据命令已复制——替换 <PAT> 后在终端执行' : '复制失败，请手动复制命令', ok ? 'success' : 'error');
}

// ---- v2.9.18 Gitee 源页面化（镜像 GitHub 卡：开关即时 PATCH；org/baseUrl 随保存提交）----

function geCredCommand(baseUrl) {
  const b = String(baseUrl || '').trim() || 'https://gitee.com';
  return `git config --global http.${b}/.extraheader "<私人令牌>"`;
}

function drawGiteeCmd() {
  const root = rootEl;
  if (!root) return;
  const el = root.querySelector('#ge-cred-cmd');
  if (el) el.textContent = geCredCommand(root.querySelector('#ge-baseurl').value);
}

function drawGitee(ge) {
  const root = rootEl;
  if (!root) return;
  const on = !!(ge && ge.enabled);
  const sw = root.querySelector('#ge-enabled');
  sw.setAttribute('aria-pressed', String(on));
  sw.classList.toggle('off', !on);
  root.querySelector('#ge-enabled-tip').textContent = on ? '已启用' : '未启用';
  root.querySelector('#ge-org').value = (ge && ge.org) || '';
  root.querySelector('#ge-baseurl').value = (ge && ge.baseUrl) || '';
  drawGiteeCmd();
}

async function toggleGitee() {
  const root = rootEl;
  if (!root) return;
  const sw = root.querySelector('#ge-enabled');
  const next = sw.getAttribute('aria-pressed') !== 'true';
  const org = root.querySelector('#ge-org').value.trim();
  if (next && !org) { toast('启用前先填组织名（仅支持组织）', 'error'); return; }
  try {
    const r = await api('/api/settings', { method: 'PATCH', body: { gitee: { enabled: next } } });
    drawGitee(r.gitee || {});
    toast(next ? 'Gitee 动态源已启用（下个轮询周期生效）' : 'Gitee 动态源已关闭', 'success');
  } catch (e) {
    toast(e.message);
  }
}

async function copyGeCredCmd() {
  const root = rootEl;
  if (!root) return;
  const text = geCredCommand(root.querySelector('#ge-baseurl').value);
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { ok = false; }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch { ok = false; }
  }
  toast(ok ? '凭据命令已复制——替换 <私人令牌> 后在终端执行' : '复制失败，请手动复制命令', ok ? 'success' : 'error');
}

// v2.9.19 源探测：按表单当前值（org/baseUrl 未保存也可测）调 /api/sources/test，结果行内展示
async function testSource(source, btnId, outId) {
  const root = rootEl;
  if (!root) return;
  const btn = root.querySelector('#' + btnId);
  const out = root.querySelector('#' + outId);
  if (!btn || !out) return;
  btn.disabled = true;
  out.textContent = '测试中…';
  out.style.color = 'var(--muted)';
  try {
    const r = await apiPost('/api/sources/test', {
      source,
      org: root.querySelector(source === 'github' ? '#gh-org' : '#ge-org').value.trim(),
      baseUrl: root.querySelector(source === 'github' ? '#gh-baseurl' : '#ge-baseurl').value.trim()
    });
    if (r.ok) {
      const mode = r.hasToken ? '令牌' : '匿名';
      const latest = r.latest ? ` · 最新 ${r.latest.type} ${r.latest.repo}` : ' · 窗内暂无事件';
      out.textContent = `✓ ok · ${r.latencyMs}ms · ${mode}${latest}`;
      out.style.color = 'var(--green)';
    } else {
      out.textContent = `✗ ${r.error || '探测失败'}`;
      out.style.color = 'var(--red)';
    }
  } catch (e) {
    out.textContent = `✗ ${e.message}`;
    out.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
  }
}

// ---- 设置保存：既有 gitea/gateway 节 + 二期新键（dingtalk 采集 / analyze 引擎 / security.trustedHosts）----

function updateHints() {
  const root = rootEl;
  if (!root) return;
  const w = Number(root.querySelector('#set-warn').value);
  const d = Number(root.querySelector('#set-danger').value);
  root.querySelector('#set-warn-hint').textContent = isFinite(w) && w > 0 ? `= ${fmtSec(w)}` : '';
  root.querySelector('#set-danger-hint').textContent = isFinite(d) && d > 0 ? `= ${fmtSec(d)}` : '';
}

// 测试连接（既有逻辑参数化）：凭据指引卡入口复用（原独立表单行已并入该卡，避免同页双按钮）
function wireTestPair(btnId, outId) {
  const root = rootEl;
  const btn = root && root.querySelector('#' + btnId);
  if (!btn) return;
  btn.addEventListener('click', () => testConnection(btnId, outId));
}

async function testConnection(btnId, outId) {
  const root = rootEl;
  if (!root) return;
  const out = root.querySelector('#' + outId);
  const btn = root.querySelector('#' + btnId);
  if (!out || !btn) return;
  btn.disabled = true;
  out.textContent = '测试中…';
  out.style.color = 'var(--muted)';
  try {
    const baseUrl = root.querySelector('#set-base').value.trim();
    const r = await apiPost('/api/gitea/test', baseUrl ? { baseUrl } : {});
    out.textContent = `✓ ok · ${r.latencyMs}ms · API ${r.apiVersion}`;
    out.style.color = 'var(--green)';
  } catch (e) {
    out.textContent = `✗ ${e.code || 'ERROR'}: ${e.message}`;
    out.style.color = 'var(--red)';
    toast(e.message);
  }
  if (btn.isConnected) btn.disabled = false;
}

async function save() {
  const root = rootEl;
  if (!root) return;
  const num = (id, fallback) => {
    const v = Number(root.querySelector('#' + id).value);
    return isFinite(v) && v > 0 ? v : fallback;
  };
  const g = (current && current.gitea) || {};
  const dt = (current && current.dingtalk) || {};
  const az = (current && current.analyze) || {};
  // GitHub 源：开关即时 PATCH 不走保存；这里只随保存提交 org/baseUrl。启用时 org 必填（org events 仅支持组织）
  const ghEnabled = root.querySelector('#gh-enabled').getAttribute('aria-pressed') === 'true';
  const ghOrg = root.querySelector('#gh-org').value.trim();
  if (ghEnabled && !ghOrg) { toast('GitHub 已启用：组织名必填（仅支持组织，不支持个人账号）', 'error'); return; }
  const geEnabled = root.querySelector('#ge-enabled').getAttribute('aria-pressed') === 'true';
  const geOrg = root.querySelector('#ge-org').value.trim();
  if (geEnabled && !geOrg) { toast('Gitee 已启用：组织名必填（仅支持组织）', 'error'); return; }
  // v2.9.39 IM：URL 输入框留空 = 保持现状（令牌原文不下发页面）；只提交填了新 URL 的平台，
  // 服务端按平台合并，另一个平台的配置不会被冲掉
  const imAt = (root.querySelector('#im-digest-at').value || '').trim();
  if (imAt && !/^([01]\d|2[0-3]):[0-5]\d$/.test(imAt)) { toast('每日摘要时间需为 HH:MM（24 小时制）', 'error'); return; }
  const imTargets = [];
  for (const [platform, prefix] of [['feishu', 'im-feishu'], ['dingtalk', 'im-dingtalk']]) {
    const url = (root.querySelector('#' + prefix + '-url').value || '').trim();
    const secret = (root.querySelector('#' + prefix + '-secret').value || '').trim();
    if (!url) continue;
    imTargets.push(secret ? { platform, url, secret } : { platform, url });
  }
  const im = {
    enabled: root.querySelector('#im-enabled').getAttribute('aria-pressed') === 'true',
    digest: { enabled: root.querySelector('#im-digest-enabled').getAttribute('aria-pressed') === 'true', at: imAt || '09:10' },
    events: {
      review: root.querySelector('#im-events-review').getAttribute('aria-pressed') === 'true',
      completed: root.querySelector('#im-events-completed').getAttribute('aria-pressed') === 'true'
    }
  };
  if (imTargets.length) im.targets = imTargets;

  // v2.9.45 知识库学习：路径必须是绝对路径（服务端也校验，这里先拦一下省一次往返）
  const learnRoot = (root.querySelector('#learn-root').value || '').trim();
  if (learnRoot && !/^[A-Za-z]:[\\/]|^\//.test(learnRoot)) {
    toast('知识库根路径必须是绝对路径（如 D:\\knowledge\\my-vault）', 'error');
    return;
  }
  const numOr = (sel, fallback, min, max) => {
    const v = Number(root.querySelector(sel).value);
    return Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  };
  const learn = {
    enabled: root.querySelector('#learn-enabled').getAttribute('aria-pressed') === 'true',
    root: learnRoot,
    scope: splitList(root.querySelector('#learn-scope').value),
    exclude: splitList(root.querySelector('#learn-exclude').value),
    seeds: splitList(root.querySelector('#learn-seeds').value),
    dailyNew: numOr('#learn-daily-new', 1, 0, 10),
    dailyReview: numOr('#learn-daily-review', 3, 0, 10)
  };
  const payload = {
    gitea: {
      baseUrl: root.querySelector('#set-base').value.trim() || g.baseUrl,
      org: root.querySelector('#set-org').value.trim(),
      pollIntervalSec: num('set-poll', g.pollIntervalSec || 60),
      staleWarnSec: num('set-warn', g.staleWarnSec || 14400),
      staleDangerSec: num('set-danger', g.staleDangerSec || 86400),
      ignoreLogins: collectIgnoreLogins() // v2.9.7 成员册过滤名单（编辑器随保存一并提交）
    },
    github: {
      org: ghOrg,
      baseUrl: root.querySelector('#gh-baseurl').value.trim()
    },    gitee: {
      org: geOrg,
      baseUrl: root.querySelector('#ge-baseurl').value.trim()
    },
    dingtalk: {
      dwsBin: root.querySelector('#dt-dwsbin').value.trim(),
      dwsTimeoutSec: num('dt-dwsTimeoutSec', dt.dwsTimeoutSec || 60),
      maxMessages: num('dt-maxMessages', dt.maxMessages || 200)
    },
    feishu: {
      larkBin: root.querySelector('#fx-larkbin').value.trim(),
      larkTimeoutSec: num('fx-larkTimeoutSec', (current.feishu && current.feishu.larkTimeoutSec) || 60),
      maxMessages: num('fx-maxMessages', (current.feishu && current.feishu.maxMessages) || 200),
      lookbackDays: num('fx-lookbackDays', (current.feishu && current.feishu.lookbackDays) || 90)
    },
    analyze: {
      dshBin: root.querySelector('#az-dshbin').value.trim(),
      timeoutSec: num('az-timeoutSec', az.timeoutSec || 300)
    },
    security: {
      trustedHosts: collectHosts()
    },
    im,
    learn
  };
  try {
    await api('/api/settings', { method: "PATCH", body: payload });
    toast('设置已保存', 'success');
    await load();
  } catch (e) {
    toast(e.message); // 400 HOST_FORBIDDEN 等文案直出
  }
}

// ---- 任务雷达（PRD §6 设置页）：通道开关 + 手动同步 + 引擎健康 ----

function drawRadar(on) {
  const root = rootEl;
  if (!root) return;
  const sw = root.querySelector('#radar-enabled');
  const tip = root.querySelector('#radar-enabled-tip');
  if (!sw) return;
  sw.setAttribute('aria-pressed', String(on));
  sw.classList.toggle('off', !on);
  if (tip) tip.textContent = on ? '已开启' : '已关闭';
}

// 飞书妙记通道开关（与 drawRadar 同构）
function drawFeishu(on) {
  const root = rootEl;
  if (!root) return;
  const sw = root.querySelector('#feishu-enabled');
  const tip = root.querySelector('#feishu-enabled-tip');
  if (!sw) return;
  sw.setAttribute('aria-pressed', String(on));
  sw.classList.toggle('off', !on);
  if (tip) tip.textContent = on ? '已开启' : '已关闭';
}

// ---- v2.9.39 IM 通知（飞书/钉钉）：回读与测试 ----
// 契约（GET /api/settings 的 im 视图）：targets 只出 platform/urlHost/tokenTail/hasSecret —
// 令牌原文与加签密钥永不下发页面，故 URL 输入框是「留空 = 保持现状」的追加语义。

function drawIm(im) {
  const root = rootEl;
  if (!root) return;
  const v = im || {};
  const setSwitch = (id, on) => {
    const b = root.querySelector('#' + id);
    if (!b) return;
    b.setAttribute('aria-pressed', String(!!on));
    if (b.classList.contains('chip')) b.classList.toggle('on', !!on);
    else b.classList.toggle('off', !on);
  };
  setSwitch('im-enabled', v.enabled === true);
  setSwitch('im-digest-enabled', !!(v.digest && v.digest.enabled));
  setSwitch('im-events-review', !!(v.events && v.events.review));
  setSwitch('im-events-completed', !!(v.events && v.events.completed));

  const tip = root.querySelector('#im-enabled-tip');
  if (tip) tip.textContent = v.enabled ? '已开启' : '已关闭';
  const at = root.querySelector('#im-digest-at');
  if (at) at.value = (v.digest && v.digest.at) || '09:10';

  const describe = (t) => (t && t.platform
    ? `${icon('check-circle')}已配置 → <span class="mono">${esc(t.urlHost || '')}…${esc(t.tokenTail || '')}</span>${t.hasSecret ? ' · 已加签' : ''}`
    : '未配置');
  const list = Array.isArray(v.targets) ? v.targets : [];
  const f = root.querySelector('#im-feishu-status');
  if (f) f.innerHTML = describe(list.find((t) => t && t.platform === 'feishu'));
  const d = root.querySelector('#im-dingtalk-status');
  if (d) d.innerHTML = describe(list.find((t) => t && t.platform === 'dingtalk'));
}

async function testIm() {
  const root = rootEl;
  const out = root && root.querySelector('#im-test-result');
  if (out) out.innerHTML = `${icon('refresh-cw')}发送中…`;
  try {
    const r = await api('/api/im/test', { method: 'POST', body: {} });
    const parts = (r.results || []).map((x) => {
      const name = x.platform === 'feishu' ? '飞书' : '钉钉';
      return x.ok ? `${name} ✓` : `${name} ✗ ${x.error || x.status || ''}`;
    });
    if (out) out.innerHTML = `${r.ok ? icon('check-circle') : icon('alert-triangle')}${esc(parts.join(' · ') || '无可用目标')}`;
    toast(r.ok ? '测试消息已发送' : '发送失败，看结果行', r.ok ? 'success' : 'error');
  } catch (e) {
    if (out) out.innerHTML = `${icon('alert-triangle')}${esc(e.message)}`;
    toast(e.message, 'error');
  }
}

// ---- v2.9.45 知识库学习（只读 vault）----
function splitList(v) {
  return String(v || '')
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function drawLearn(l) {
  const root = rootEl;
  if (!root) return;
  const v = l || {};
  const sw = root.querySelector('#learn-enabled');
  if (sw) {
    sw.setAttribute('aria-pressed', String(v.enabled === true));
    sw.classList.toggle('off', v.enabled !== true);
  }
  const tip = root.querySelector('#learn-enabled-tip');
  if (tip) tip.textContent = v.enabled ? '已开启' : '已关闭';
  const set = (id, val) => {
    const el = root.querySelector('#' + id);
    if (el) el.value = val == null ? '' : String(val);
  };
  set('learn-root', v.root || '');
  set('learn-scope', (Array.isArray(v.scope) ? v.scope : []).join(','));
  set('learn-exclude', (Array.isArray(v.exclude) ? v.exclude : []).join(','));
  set('learn-seeds', (Array.isArray(v.seeds) ? v.seeds : []).join(','));
  set('learn-daily-new', v.dailyNew == null ? 1 : v.dailyNew);
  set('learn-daily-review', v.dailyReview == null ? 3 : v.dailyReview);
  const st = root.querySelector('#learn-root-state');
  if (st) st.textContent = v.root ? '已保存路径——点「测试根路径」做只读校验' : '未配置（功能不会出现）';
}

async function testLearnRoot() {
  const root = rootEl;
  if (!root) return;
  const out = root.querySelector('#learn-result');
  if (out) out.innerHTML = `${icon('refresh-cw')}校验中…（基于已保存配置）`;
  try {
    const st = await api('/api/learn/status');
    const ok = st.rootOk === true;
    const txt = ok
      ? `✓ 可读 · 条目 ${st.counts.items}（未学 ${st.counts.fresh} / 到期 ${st.counts.due}）`
      : `✗ ${st.rootError || '未通过'}`;
    if (out) out.innerHTML = `${ok ? icon('check-circle') : icon('alert-triangle')}${esc(txt)}`;
    const state = root.querySelector('#learn-root-state');
    if (state) state.textContent = ok ? '✓ 已通过只读校验' : `✗ ${st.rootError || ''}`;
  } catch (e) {
    if (out) out.innerHTML = `${icon('alert-triangle')}${esc(e.message)}`;
  }
}

async function scanLearn() {
  const root = rootEl;
  const out = root && root.querySelector('#learn-result');
  if (out) out.innerHTML = `${icon('refresh-cw')}只读扫描中…`;
  try {
    const r = await api('/api/learn/scan', { method: 'POST', body: {} });
    if (out) out.innerHTML = `${icon('check-circle')}索引已重建：${r.scanned} 条`;
    toast(`索引已重建：${r.scanned} 条`, 'success');
  } catch (e) {
    if (out) out.innerHTML = `${icon('alert-triangle')}${esc(e.message)}`;
    toast(e.message, 'error');
  }
}

async function toggleRadar() {
  const root = rootEl;
  if (!root) return;
  const sw = root.querySelector('#radar-enabled');
  const next = sw.getAttribute('aria-pressed') !== 'true';
  try {
    const r = await api('/api/settings', { method: 'PATCH', body: { dingtalk: { enabled: next } } });
    drawRadar(r.dingtalk && r.dingtalk.enabled !== false);
    toast(next ? '钉钉听记通道已开启' : '钉钉听记通道已关闭', 'success');
  } catch (e) {
    toast(e.message);
  }
}

async function toggleFeishu() {
  const root = rootEl;
  if (!root) return;
  const sw = root.querySelector('#feishu-enabled');
  const next = sw.getAttribute('aria-pressed') !== 'true';
  try {
    const r = await api('/api/settings', { method: 'PATCH', body: { feishu: { enabled: next } } });
    drawFeishu(r.feishu && r.feishu.enabled === true);
    toast(next ? '飞书妙记通道已开启' : '飞书妙记通道已关闭', 'success');
  } catch (e) {
    toast(e.message);
  }
}

async function refreshEngineNote() {
  const root = rootEl;
  if (!root) return;
  const note = root.querySelector('#radar-engine-note');
  if (!note) return;
  try {
    const e = await apiGet('/api/radar/engine');
    if (!rootEl) return;
    const dshOk = e.dsh.found || e.dsh.fixtureMode;
    note.innerHTML = `${icon('zap')}分析引擎 ${dshOk ? '<span style="color:var(--green)">可达</span>' : '<span style="color:var(--red)">未找到（检查 config.analyze.dshBin）</span>'}` +
      `${e.dsh.fixtureMode ? ' · DSH_FIXTURE' : ''} · 超时 ${e.dsh.timeoutSec}s` +
      `${e.dingtalk.fixtureMode ? ' · DINGTALK_FIXTURE' : ''}` +
      `${e.feishu && e.feishu.fixtureMode ? ' · LARK_FIXTURE' : ''}` +
      `${e.feishu && e.feishu.enabled ? ' · 飞书采集开' : ' · 飞书采集关'}`;
  } catch (err) {
    note.innerHTML = `${icon('zap')}引擎状态未知：${esc(err.message)}`;
  }
}

async function radarSync(kind) {
  const root = rootEl;
  if (!root) return;
  const out = root.querySelector('#radar-result');
  const btn = root.querySelector(kind === 'sync-feishu' ? '#radar-feishu-sync-btn' : '#radar-sync-btn');
  btn.disabled = true;
  out.textContent = '同步中…';
  out.style.color = 'var(--muted)';
  try {
    const r = await apiPost(kind === 'sync-feishu' ? '/api/radar/sync/feishu' : '/api/radar/sync', {});
    // 轮询 job 至终态（首次同步含逐字稿拉取，可能数十秒）
    const deadline = Date.now() + 300000;
    let job = null;
    while (Date.now() < deadline) {
      job = await apiGet(`/api/radar/jobs/${encodeURIComponent(r.jobId)}`);
      if (job.state !== 'running') break;
      out.textContent = `同步中 ${job.done ?? 0}/${job.total ?? '…'}…`;
      await new Promise((res) => setTimeout(res, 1200));
    }
    // 轮询超时但 job 仍在跑：保持按钮禁用（评审 P1——同步全程持有消息池快照，再点一次会并发覆写）；
    // 提示用户稍后刷新查看结果
    if (job && job.state === 'running') {
      out.textContent = '⏳ 同步仍在后台进行（首轮拉逐字稿较慢），请稍后刷新页面查看结果，勿重复点击';
      out.style.color = 'var(--yellow)';
      return;
    }
    const res = job && job.results && job.results[0];
    if (job && job.state === 'failed') {
      out.textContent = `✗ ${job.error || '同步失败'}`;
      out.style.color = 'var(--red)';
    } else {
      const bits = [`新增 ${res ? res.added : 0}`, `已存在 ${res ? res.skippedExisting : 0}`];
      if (res && res.failed && res.failed.length) bits.push(`失败 ${res.failed.length}`);
      out.textContent = `✓ 同步完成：${bits.join(' · ')}`;
      out.style.color = res && res.failed && res.failed.length ? 'var(--yellow)' : 'var(--green)';
    }
  } catch (e) {
    out.textContent = `✗ ${e.message}`;
    out.style.color = 'var(--red)';
  }
  if (btn.isConnected) btn.disabled = false;
}

async function radarEngineTest() {
  const root = rootEl;
  if (!root) return;
  const out = root.querySelector('#radar-result');
  const btn = root.querySelector('#radar-engine-test');
  btn.disabled = true;
  out.textContent = '引擎测试中（真实调用，约 10s）…';
  out.style.color = 'var(--muted)';
  try {
    const r = await apiPost('/api/radar/engine/test', {});
    if (r.ok) {
      out.textContent = `✓ 引擎往返 ${r.latencyMs}ms · 回复「${r.reply}」`;
      out.style.color = 'var(--green)';
    } else {
      out.textContent = `✗ ${r.error}`;
      out.style.color = 'var(--red)';
    }
  } catch (e) {
    out.textContent = `✗ ${e.message}`;
    out.style.color = 'var(--red)';
  }
  if (btn.isConnected) btn.disabled = false;
}

async function importLearn() {
  const root = rootEl;
  if (!root) return;
  const input = root.querySelector('#learn-import-path');
  const out = root.querySelector('#learn-import-result');
  const p = ((input && input.value) || '').trim();
  if (!p) { toast('先填要导入的文件或目录', 'error'); return; }
  if (out) out.innerHTML = `${icon('refresh-cw')}导入中（抽取文本 + 建索引）…`;
  try {
    const r = await api('/api/learn/import', { method: 'POST', body: { path: p } });
    const ok = (r.imported || []).length;
    const bad = (r.skipped || []).length;
    const firstBad = bad ? String((r.skipped || [])[0].reason || '') : '';
    if (out) {
      out.innerHTML = `${ok ? icon('check-circle') : icon('alert-triangle')}成功 ${ok} 个${bad ? `，跳过 ${bad} 个（${esc(firstBad)}）` : ''}`;
    }
    toast(`导入完成：${ok} 个文件进了学习库`, ok ? 'success' : 'error');
  } catch (e) {
    if (out) out.innerHTML = `${icon('alert-triangle')}${esc(e.message)}`;
    toast(e.message, 'error');
  }
}
