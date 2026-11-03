// 跨视图一次性状态（避免 app.js 与视图循环依赖）
export const state = {
  // 动态流/总览点击「匹配任务」后 → 看板挂载时消费并高亮
  pendingTaskFocus: null,
  // 顶栏「新建任务」→ 看板挂载时消费并打开新建弹层
  pendingNewTask: false
};
