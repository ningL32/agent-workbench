'use strict';

/**
 * learnSeedsAiEng.js — 「AI 工程从零开始」(aieng-zh.cn) 术语表精选（v2.9.53）
 *
 * 来源：https://aieng-zh.cn/glossary.html（开源 · MIT）。这里**只取术语名**，
 * 定义与"为什么重要"由本仓库自行撰写（不逐字复制原站文案），便于二次分发。
 * 选材原则：补 `lib/learnSeeds.js` 里没覆盖的维度——检索/RAG、服务与基础设施、
 * 评估方法论、可靠性、AI-native 工程实践；已有条目（KV cache、量化、MoE、上下文工程…）不重复收。
 */

const CONCEPTS = [
  // —— 检索与生成 ——
  { term: '分块 Chunking', definition: '把长文档切成检索单元，按语义边界切比按固定字数切好', why: '切坏了，再好的向量模型也救不回来' },
  { term: '稠密检索 Dense Retrieval', definition: '用向量相似度找语义相近的片段，不依赖关键词命中', why: '能召回"换了说法"的内容，也会召回"看起来像"的错东西' },
  { term: '混合检索 Hybrid Retrieval', definition: '关键词（BM25）与向量检索并用，再融合两路结果', why: '专有名词靠关键词、同义表达靠向量，单路总有盲区' },
  { term: 'RRF 倒数排名融合', definition: '按各路的排名取倒数求和来合并结果，不需要分数可比', why: '两路检索分数量纲不同，用它最省事也最稳' },
  { term: '重排 Reranker', definition: '对初筛出的 Top-N 用交叉编码器精排，代价高但准', why: '召回靠便宜模型，精度靠这一步' },
  { term: 'HNSW', definition: '分层可导航小世界图，近似最近邻索引的常用结构', why: '向量库的性能与召回率主要取决于它和参数' },
  { term: 'Recall@K', definition: '前 K 个结果里命中正确条目的比例', why: 'RAG 的上限由召回决定，先量它再谈生成' },
  { term: 'Grounding 落地性', definition: '回答能否追溯到给定材料，而不是模型自己编的', why: '没有落地性就没有可审计性' },
  { term: '语义缓存', definition: '按语义相似度命中历史答案，避免重复调用模型', why: '客服/FAQ 场景最省钱的优化，但要防答错题被复用' },

  // —— 服务与基础设施 ——
  { term: 'TTFT 首字延迟', definition: '从请求发出到收到第一个 token 的时间', why: '用户体感主要由它决定，而不是总时长' },
  { term: 'TPOT 每 token 时间', definition: '首字之后平均每个输出 token 的耗时', why: '决定"读起来顺不顺"' },
  { term: '持续批处理', definition: '不等整批结束，边跑边把新请求插进批次', why: '吞吐提升的关键，也是延迟抖动的来源' },
  { term: '分页 KV Cache', definition: '把 KV 缓存按页管理，像虚拟内存一样按需分配', why: '解决长上下文下显存碎片与浪费' },
  { term: '前缀缓存', definition: '相同前缀（系统提示、长文档）的 KV 直接复用', why: '同一份长材料反复问，成本能差好几倍' },
  { term: '张量并行', definition: '把单层权重切到多卡上算，卡间频繁通信', why: '大模型单卡放不下时的第一选择' },
  { term: '分离式服务', definition: '预填充与解码跑在不同实例上，各自按瓶颈选硬件', why: '两类负载瓶颈不同，混跑谁都跑不好' },
  { term: 'Goodput 有效吞吐', definition: '满足延迟目标的那部分吞吐，而非总吞吐', why: '总吞吐漂亮但超时一堆，等于没服务' },

  // —— 评估方法论 ——
  { term: '评测集 Eval Set', definition: '固定、可复现、带判据的样本集合，用来对比改动', why: '没有它，所有"感觉变好了"都不算数' },
  { term: 'LLM 当裁判', definition: '用强模型按 rubric 给输出打分，代替人工评', why: '规模化评估的现实手段，但要防位置/长度偏见' },
  { term: '判定口径 Calibration', definition: '模型自报的置信度与实际正确率是否一致', why: '自评 90% 实际 30% 的系统不能自动放行' },
  { term: 'Pass@k', definition: '采样 k 次至少有一次通过的比例', why: '衡量"能不能做对"，而不是"一次就对"' },
  { term: '精确率与召回率', definition: '精确率=报对的占报出的比例；召回率=报出的占该报的比例', why: '二者互斥，先定业务更要哪个' },
  { term: '验证门 Verification Gate', definition: '产出必须通过可判定检查（测试/断言）才算完成', why: '把"看似完成"挡在门外' },
  { term: '护栏 Guardrails', definition: '对输入输出做规则/模型双重拦截：越权、敏感、格式', why: '模型不可信，护栏是最后一道闸' },

  // —— 可靠性 ——
  { term: 'SLI 与 SLO', definition: 'SLI 是可测指标（成功率/延迟分位），SLO 是它的目标值', why: '没有 SLO 就没法判断"该不该回滚"' },
  { term: '错误预算', definition: '允许失败的那部分额度，用完就冻结变更', why: '把可靠性变成可协商的资源，而不是口号' },
  { term: '尾延迟', definition: 'P95/P99 这类长尾延迟，而不是平均值', why: '用户感知的是最慢的那几次' },
  { term: '优雅降级', definition: '依赖挂了时退到更弱但仍可用的路径', why: '大模型不可用不等于功能不可用' },
  { term: '熔断 Circuit Breaker', definition: '连续失败达到阈值就快速失败，不再打下游', why: '防止雪崩，给下游恢复时间' },
  { term: '退避重试', definition: '失败后按指数退避加抖动重试，并设总预算', why: '无节制重试会把小故障放大成事故' },
  { term: '幂等性', definition: '同一请求重复执行，结果与副作用只发生一次', why: 'Agent 一定会重试，工具不幂等就会写脏数据' },
  { term: '读就绪探针', definition: '启动完成、依赖可用才接流量', why: '避免把请求打给还没准备好的实例' },
  { term: '灰度发布', definition: '先给一小部分流量，观察指标再扩大', why: '模型/提示词改动的爆炸半径要可控' },
  { term: '复盘 Postmortem', definition: '事故后写清时间线、根因、改进项与责任人', why: '不写复盘，同样的坑会再踩' },

  // —— Agent 与工具 ——
  { term: '工具契约 Tool Contract', definition: '工具的入参、出参、错误码与副作用必须写死并被校验', why: '模型靠描述猜用法，描述含糊就会乱调' },
  { term: '结构化输出', definition: '用 schema/语法约束模型输出形态，而不是"请返回 JSON"', why: '下游要解析就必须上硬约束' },
  { term: 'Agent 宿主 Harness', definition: '包在模型外面的运行时：工具、权限、循环、持久化', why: '同一模型换个 harness，能力差一个档' },
  { term: '终止条件', definition: '明确何时停：达成目标、超预算、连续失败、需人工', why: '没有终止条件的 agent 会烧钱到天亮' },
  { term: '人工介入 HITL', definition: '高风险动作前挂审批，由人放行', why: '不可逆操作的唯一保险' },
  { term: '委派 Delegation', definition: '把独立子任务交给隔离子代理，只回收结论', why: '省上下文、可并行，但结论会失真' },
  { term: '持久执行 Durable Execution', definition: '每步状态落盘，进程崩了能从断点续跑', why: '长任务不能因为一次重启全丢' },
  { term: '补偿动作', definition: '已发生的副作用用反向操作抵消，而不是假装没发生', why: '分布式里没有事务，只有补偿' },
  { term: '权限最小化', definition: '只授予完成任务所需的最小能力与范围', why: 'Agent 犯错是常态，边界决定损失上限' },

  // —— AI-native 工程 ——
  { term: '模型路由', definition: '按任务难度/成本把请求分给不同模型', why: '80% 简单请求不该用最贵的模型' },
  { term: '可观测性', definition: '日志/指标/追踪三者齐备，能回答"刚才那步为什么慢/错"', why: '出问题先看数据，别靠猜' },
  { term: '任务成功成本', definition: '完成一个任务的平均花费（含重试与人工），不是单次调用价', why: '便宜模型但重试 5 次，可能更贵' },
  { term: '回归测试', definition: '改一处后重跑固定用例集，确认没把别处改坏', why: '提示词的改动最容易"这边好那边崩"' },
  { term: '抖动测试 Flaky Test', definition: '同一输入时过时不过的用例', why: '它让整个测试集失去公信力，必须隔离' },
  { term: '范围契约 Scope Contract', definition: '明确本次任务做什么、不做什么、可改哪些文件', why: '防 agent 顺手改一堆无关代码' },
  { term: '渐进披露', definition: '先给最小必要信息，需要时再展开细节', why: '上下文有限，一次灌满反而更笨' },
  { term: '仓储地图 Repository Map', definition: '给 agent 一张"哪个文件负责什么"的索引', why: '省掉盲目搜索的几十次工具调用' },
];

module.exports = { CONCEPTS, SOURCE: 'https://aieng-zh.cn/glossary.html（MIT）' };
