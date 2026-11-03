'use strict';

/**
 * learnSeeds.js — 内置主题知识点（v2.9.52）
 *
 * 为什么需要：知识库只读、且以业务/行业笔记为主，缺工程侧的系统知识。这些主题跟插件一起走，
 * 不联网、不写 vault；和 vault 抽出来的知识点走同一套调度与会话流程。
 *
 * 每条：term（术语）+ definition（≤60 字白话）+ why（≤40 字，为什么重要）。
 * 只放**靠得住、不随时间快速过期**的条目（模型/语言/Agent 工程的基础概念），
 * 版本号、榜单、参数推荐这类会过期的内容一律不进。
 */

const SEEDS = {
  '模型与推理': [
    { term: '上下文窗口', definition: '模型一次能看到的 token 上限，含输入与输出；超出就得截断或压缩', why: '决定长文档/长对话怎么切，以及成本上限' },
    { term: 'KV cache', definition: '把已算过的注意力 Key/Value 缓存下来，后续 token 复用，避免重算', why: '长上下文能跑起来靠它，显存占用也主要吃它' },
    { term: '预填充 vs 解码', definition: '预填充并行处理整段输入、吃算力；解码逐 token 生成、吃显存带宽', why: '两类负载瓶颈不同，优化手段也不同' },
    { term: '温度与 Top-p', definition: '温度缩放概率分布，Top-p 截断候选集合；都为 0/1 时趋近确定性输出', why: '要稳定判分就压低，要发散创意就调高' },
    { term: '量化', definition: '把权重/激活从 FP16 压到 INT8/INT4 等低精度表示，换显存与速度', why: '同样的卡能跑更大模型，代价是精度与长尾能力' },
    { term: 'MoE 稀疏激活', definition: '多个专家子网络，每个 token 只激活其中少数几个，参数总量大但计算量小', why: '解释为什么"参数很多却很便宜"，以及专家负载不均的坑' },
    { term: '注意力复杂度', definition: '标准注意力代价随序列长度平方增长；FlashAttention 靠分块与重算降显存', why: '长上下文成本从哪来、为什么有上限' },
    { term: '投机解码', definition: '小模型先草拟若干 token，大模型一次并行校验，接受的直接采纳', why: '不降质提速的典型工程手段' },
    { term: 'LoRA 微调', definition: '冻结原权重，只训练低秩旁路矩阵，用极少参数改变行为', why: '个人/小团队做领域适配的默认选择' },
    { term: 'RLHF 与 DPO', definition: '用人类偏好把模型往"更有用更安全"对齐；DPO 省掉显式奖励模型', why: '理解对齐训练与"为什么模型话术这么像"的来源' },
    { term: '幻觉的成因', definition: '模型优化的是下一个 token 的似然，不是事实性；缺知识时会生成流畅的错', why: '决定要不要检索、要不要让它"不确定就说不确定"' },
    { term: '评测集污染', definition: '训练数据里混进了评测题，分数虚高但真实能力没提升', why: '看到"某模型某项 90 分"先问污染' },
    { term: '提示注入', definition: '把恶意指令藏在被检索的内容里，模型把它当成指令执行', why: '凡是读外部内容的 Agent 都必须防' },
    { term: '结构化输出约束', definition: '用 JSON schema / 语法解码限制输出形态，而不是靠提示词"请输出 JSON"', why: '下游要解析就必须上硬约束，别赌模型听话' },
  ],
  'Java': [
    { term: 'JMM 与 happens-before', definition: 'Java 内存模型规定线程间可见性规则；happens-before 是判断"能否看到写入"的依据', why: '并发 bug 的根因几乎都在这' },
    { term: 'volatile 语义', definition: '保证可见性与禁止重排序，但**不保证**复合操作原子性', why: '别拿它当锁用（i++ 仍会丢更新）' },
    { term: 'CAS 与 ABA', definition: '比较并交换实现无锁更新；值被改回原样时可能漏判，需版本号', why: '原子类的底层，也是无锁栈的经典坑' },
    { term: '锁升级', definition: '偏向锁→轻量级锁（自旋）→重量级锁，按竞争程度升级', why: '解释"synchronized 为什么没想象中慢"' },
    { term: '垃圾回收分代', definition: '按对象存活时间分年轻代/老年代，各自用不同算法回收', why: '调优参数与停顿来源都从这里推' },
    { term: 'G1 与 ZGC', definition: 'G1 按 Region 增量回收、可预测停顿；ZGC 靠染色指针与并发整理做到毫秒级停顿', why: '大堆低延迟场景怎么选' },
    { term: '类加载双亲委派', definition: '加载类时先交给父加载器，父加载器找不到才自己加载', why: '解释同名类冲突、SPI 为什么需要打破它' },
    { term: '线程池核心参数', definition: '核心/最大线程数、队列、拒绝策略、空闲回收共同决定行为', why: '队列选错会让"扩容"永远不触发，任务堆积' },
    { term: '虚拟线程', definition: '由 JVM 调度的轻量线程，阻塞时自动让出载体线程', why: '把"一请求一线程"重新变得可行' },
    { term: '逃逸分析与 JIT', definition: 'JIT 判断对象不逃逸就栈上分配/标量替换，热点代码编译成本地码', why: '解释"为什么小对象没想象中贵"' },
    { term: '集合 fail-fast', definition: '迭代中结构性修改会抛 ConcurrentModificationException（基于 modCount）', why: '别在 for-each 里删元素' },
    { term: 'HashMap 扩容与树化', definition: '负载因子 0.75 触发扩容翻倍；链表超 8 且容量≥64 转红黑树', why: '预分配容量避免反复 rehash' },
    { term: 'CompletableFuture 组合', definition: '用 thenApply/thenCompose/allOf 表达异步编排与依赖关系', why: '比回调地狱可读，也比并行流可控' },
    { term: 'JPMS 模块化', definition: '用 module-info 声明依赖与导出，强封装内部包', why: '大工程拆分与依赖收敛的手段' },
  ],
  'Agent 开发': [
    { term: '工具调用协议', definition: '模型输出结构化调用（name+arguments），运行时执行后把结果作为消息回灌', why: 'Agent 的手脚全靠它，schema 质量决定成功率' },
    { term: 'ReAct 循环', definition: '思考→行动→观察的循环，每步根据观察结果再决定下一步', why: '最基础的 Agent 骨架，也是"为什么会绕圈"的来源' },
    { term: '上下文工程', definition: '决定每一步把哪些信息放进窗口、以什么顺序放、何时裁剪', why: '比提示词措辞更决定上限' },
    { term: '记忆分层', definition: '短期（对话窗口）/工作（任务清单）/长期（外部存储检索）三层', why: '混在一起就会既忘事又塞满窗口' },
    { term: '规划与反思', definition: '先拆计划再执行，失败后回看轨迹修正，而不是一条路走到黑', why: '长任务成功率主要靠这个' },
    { term: '子代理编排', definition: '主代理把独立子任务派给隔离上下文的子代理，回收结论而非全过程', why: '省上下文、可并行，但要防结论失真' },
    { term: 'MCP', definition: 'Model Context Protocol：把工具/资源以标准协议暴露给任意 Agent 宿主', why: '一次接入、多客户端复用' },
    { term: 'RAG 检索增强', definition: '先检索相关片段再让模型基于片段回答，把"记忆"外置', why: '事实性问题的默认解法，难点在切分与召回' },
    { term: '轨迹回放', definition: '把一次运行的每步输入输出存下来，可重放、可对比、可回归', why: 'Agent 调试与评测的地基' },
    { term: '幂等与重试', definition: '同一请求重发不产生副作用；配合退避与超时才敢重试', why: 'Agent 一定会重试，工具不做幂等就会写脏数据' },
    { term: '沙箱与权限边界', definition: '把文件/网络/命令能力按最小权限授予，并按操作风险分级审批', why: 'Agent 犯错是常态，边界决定损失上限' },
    { term: '成本与延迟预算', definition: '每次调用都有 token 与时间预算，超预算降级（换小模型/裁剪上下文）', why: '没有预算的 Agent 会自己把自己烧死' },
    { term: '可观测性 span', definition: '把一次运行拆成带耗时与状态的 span 树，定位瓶颈与失败点', why: '出问题先看 trace，别靠猜' },
    { term: '评测：判据而非感觉', definition: '用固定用例 + 可判定的通过条件（断言、打分器）衡量改动是否真的更好', why: 'LLM 应用最容易"感觉变好了"' },
  ],
  'Python': [
    { term: 'GIL', definition: 'CPython 全局解释器锁，同一时刻只有一个线程执行字节码', why: '解释为什么多线程吃不满 CPU、要换多进程' },
    { term: 'asyncio 事件循环', definition: '单线程协作式并发：await 处让出控制权，循环调度其他任务', why: 'IO 密集高并发的主力，但阻塞调用会卡死全队' },
    { term: '生成器与协程', definition: 'yield 产出值并暂停；async/await 是其上的协程语法', why: '流式处理与异步的共同底层' },
    { term: '描述符协议', definition: '__get__/__set__ 定义属性访问行为，property/classmethod 都是它的应用', why: '读懂 ORM 与框架魔法' },
    { term: 'MRO 与 C3', definition: '多继承的方法解析顺序，按 C3 线性化保证单调性', why: 'super() 到底调用谁，靠它' },
    { term: '上下文管理器', definition: 'with 语句靠 __enter__/__exit__ 保证资源释放与异常处理', why: '文件/锁/事务的标准写法' },
    { term: '可变默认参数陷阱', definition: 'def f(x=[]) 的默认值在函数定义时只创建一次，会被跨调用共享', why: '经典 bug，改成 None 再判断' },
    { term: '引用计数与循环 GC', definition: '主要靠引用计数回收，循环引用交给分代循环检测器', why: '解释 __del__ 与内存泄漏排查' },
    { term: 'dataclass 与 slots', definition: '@dataclass 生成样板方法；slots=True 用固定槽位省内存', why: '数据类优先用它，而不是手写 __init__' },
    { term: '类型提示与 TypeVar', definition: '注解不参与运行，靠类型检查器校验；TypeVar 表达泛型约束', why: '大项目里 type hint 就是文档与护栏' },
    { term: '打包与依赖解析', definition: 'pyproject.toml 声明构建与依赖，wheel 是预构建分发格式', why: '别再用 setup.py 裸写，锁文件才可复现' },
    { term: 'C 扩展与 Cython', definition: '把热点逻辑用 C/Cython 编译，绕开解释器开销', why: '纯 Python 提速的最后手段' },
    { term: '鸭子类型与 Protocol', definition: '看行为不看类型；typing.Protocol 让静态检查也认这套', why: '写可替换组件时的正确姿势' },
    { term: 'GIL 之外：multiprocessing', definition: '多进程各持独立解释器与内存，靠序列化通信', why: 'CPU 密集任务的常规解法，代价是内存与 IPC' },
  ],
};

// v2.9.53 追加「AI 工程」：来自 aieng-zh.cn 术语表（MIT）的精选，定义由本仓库自写
SEEDS['AI 工程'] = require('./learnSeedsAiEng').CONCEPTS;
const DOMAINS = Object.keys(SEEDS);

/** 主题名 → 条目（带 id 种子用） */
function seedConcepts(domain) {
  const list = SEEDS[domain];
  if (!Array.isArray(list)) return [];
  return list.map((c) => ({
    domain,
    term: c.term,
    definition: c.definition,
    why: c.why || '',
  }));
}

module.exports = { SEEDS, DOMAINS, seedConcepts };
