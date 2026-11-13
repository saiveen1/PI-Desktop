export const delegationObservability = {
  runStarted: "委派计时开始", currentActivity: "当前活动", lastTool: "最近记录的工具",
  completedAt: "完成时间", elapsed: "任务总耗时", seconds: "{{value}} 秒", outputTokens: "输出令牌数",
  throughput: "端到端输出吞吐量（包含工具及等待时间）", tokensPerSecond: "{{value}} 令牌/秒", unavailable: "不可用",
  phases: { "waiting-model": "等待模型响应", retrying: "正在重试模型请求" },
  observation: {
    title: "已记录的观察", selectedModel: "选定模型", state: "观察状态（不是任务结果判定）", observedAt: "状态观察时间", writes: "已确认写入的路径",
    executionStart: "执行开始", executionEnd: "执行结束", reportProduced: "报告生成", reportDelivered: "报告交付给接收方",
    toolCounts: "观察到的工具调用", toolCountValues: "{{completed}} 次完成 · {{failed}} 次失败",
    approvals: "授权记录", attempts: "供应商请求（{{value}} 次）", tools: "工具证据", omitted: "省略了 {{value}} 条较早记录",
    requestThroughput: "请求输出吞吐量（包含网络等待）",
    states: { observing: "观察中", waiting_tool: "等待工具", waiting_model: "等待模型", no_new_evidence: "暂无新证据", approval_pending: "等待授权", ended: "执行结束" },
    approvalStates: { pending: "等待授权", accepted: "授权已接受（不代表执行已开始）", rejected: "授权被拒绝", cancelled: "授权已取消" },
    attemptStates: { running: "供应商请求进行中", completed: "供应商请求完成", failed: "供应商请求失败", aborted: "供应商请求中止", unresolved: "执行结束时供应商结果尚未确认" },
    toolStates: { pending: "待完成", completed: "已完成", failed: "失败" },
    effects: { unknown: "影响未知", read_only: "只读", write_confirmed: "已确认写入" },
  },
};
