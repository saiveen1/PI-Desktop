export const delegationReliabilitySettings = {
  providerStreamIdleTimeout: "模型连接空闲超时",
  providerStreamIdleTimeoutDesc: "仅在选定时间内没有收到响应数据时取消。长时间思考本身不会重启请求。从下一轮生效；关闭时若请求卡住需手动停止。",
  providerStreamIdleTimeoutDisabled: "关闭",
  providerStreamIdleTimeoutMinutes: "{{count}} 分钟",
  "delegationRunReportRecovery": "补全缺失的最终报告",
  "delegationRunReportRecoveryDesc": "子任务结束却没有交付报告时，追加一次无工具报告请求，受报告时限约束，可能增加 API 用量。",
  "delegationRunReportRecoveryOnce": "一次",
  "delegationRunReportRecoveryOff": "关闭",
  "unknownUpstreamRetryLimit": "未知上游错误重试次数",
  "unknownUpstreamRetryLimitDesc": "每次回复遇到通用上游 400/422 错误时，最多重试此次数。0 表示关闭；无尽重试不会扩大此上限。"
};

export const delegationDiagnostics = {
  "title": "委派详情",
  "requestedModel": "请求模型",
  "actualModel": "实际模型",
  "activity": "活动",
  "activityCounts": "{{turns}} 轮 · {{tools}} 次工具调用",
  "stopReason": "结束原因",
  "reportOutcome": "报告结果",
  "responseStructure": "响应结构",
  "responseCounts": "{{text}} 段正文 · {{thinking}} 段思考 · {{tools}} 个工具",
  "recoveryAttempts": "补报次数",
  "failure": "失败原因",
  "selection": "模型选择",
  "modelFailures": "模型失败记录",
  "selected": "已选用",
  "skipped": "已跳过",
  "cancelled": "已取消",
  "retry": "恢复进度",
  "retryAttempt": "第 {{attempt}} / {{limit}} 次",
  "stopReasons": {
    "stop": "正常结束",
    "tool_calls": "工具请求",
    "length": "输出达到上限",
    "error": "错误",
    "aborted": "已取消",
    "unknown": "未记录"
  },
  "reportOutcomes": {
    "delivered": "已交付报告",
    "missing": "没有最终报告",
    "truncated": "报告被截断",
    "invalid_tool_ending": "异常工具终止",
    "error": "失败",
    "cancelled": "已取消"
  }
};
