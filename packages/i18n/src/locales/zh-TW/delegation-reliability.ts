import { delegationObservability } from "../en/delegation-observability.js";

export const delegationReliabilitySettings = {
  providerStreamIdleTimeout: "模型連線閒置逾時",
  providerStreamIdleTimeoutDesc: "只有在所選時間內沒有收到回應資料才取消。長時間思考本身不會重新啟動請求。下一輪生效；關閉時若請求卡住須手動停止。",
  providerStreamIdleTimeoutDisabled: "關閉",
  providerStreamIdleTimeoutMinutes: "{{count}} 分鐘",
  "delegationRunReportRecovery": "補全缺失的最終報告",
  "delegationRunReportRecoveryDesc": "子任務結束卻沒有交付報告時，追加一次無工具報告請求，受報告時限約束，可能增加 API 用量。",
  "delegationRunReportRecoveryOnce": "一次",
  "delegationRunReportRecoveryOff": "關閉",
  "unknownUpstreamRetryLimit": "未知上游錯誤重試次數",
  "unknownUpstreamRetryLimitDesc": "每次回覆遇到通用上游 400/422 錯誤時，最多重試此次數。0 表示關閉；無盡重試不會擴大此上限。"
};

export const delegationDiagnostics = {
  ...delegationObservability,
  "title": "委派詳情",
  "requestedModel": "請求模型",
  "actualModel": "實際模型",
  "activity": "活動",
  "activityCounts": "{{turns}} 輪 · {{tools}} 次工具呼叫",
  "stopReason": "結束原因",
  "reportOutcome": "報告結果",
  "responseStructure": "回應結構",
  "responseCounts": "{{text}} 段正文 · {{thinking}} 段思考 · {{tools}} 個工具",
  "recoveryAttempts": "補報次數",
  "failure": "失敗原因",
  "selection": "模型選擇",
  "modelFailures": "模型失敗紀錄",
  "selected": "已選用",
  "skipped": "已略過",
  "cancelled": "已取消",
  "retry": "恢復進度",
  "retryAttempt": "第 {{attempt}} / {{limit}} 次",
  "stopReasons": {
    "stop": "正常結束",
    "tool_calls": "工具請求",
    "length": "輸出達到上限",
    "error": "錯誤",
    "aborted": "已取消",
    "unknown": "未記錄"
  },
  "reportOutcomes": {
    "delivered": "已交付報告",
    "missing": "沒有最終報告",
    "truncated": "報告被截斷",
    "invalid_tool_ending": "異常工具終止",
    "error": "失敗",
    "cancelled": "已取消"
  }
};
