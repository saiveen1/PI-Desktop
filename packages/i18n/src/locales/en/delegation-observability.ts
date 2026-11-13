export const delegationObservability = {
  runStarted: "Delegation timing began", currentActivity: "Current activity", lastTool: "Last tool observed",
  completedAt: "Completed at", elapsed: "Run elapsed time", seconds: "{{value}} s", outputTokens: "Output tokens",
  throughput: "End-to-end output throughput (includes tools and waits)", tokensPerSecond: "{{value}} tokens/s", unavailable: "Unavailable",
  phases: { "waiting-model": "Waiting for model response", retrying: "Retrying model request" },
  observation: {
    title: "Recorded observations", selectedModel: "Selected model", state: "Observed state (not a task verdict)", observedAt: "State observed at", writes: "Confirmed written paths",
    executionStart: "Execution started", executionEnd: "Execution ended", reportProduced: "Report produced", reportDelivered: "Report delivered to consumer",
    toolCounts: "Observed tool calls", toolCountValues: "{{completed}} completed · {{failed}} failed",
    approvals: "Authorization observations", attempts: "Provider attempts ({{value}})", tools: "Tool evidence", omitted: "{{value}} earlier records omitted",
    requestThroughput: "Request output throughput (includes network wait)",
    states: { observing: "Observing", waiting_tool: "Waiting for tool", waiting_model: "Waiting for model", no_new_evidence: "No new evidence", approval_pending: "Approval pending", ended: "Execution ended" },
    approvalStates: { pending: "Approval pending", accepted: "Approval accepted (not execution start)", rejected: "Approval rejected", cancelled: "Approval cancelled" },
    attemptStates: { running: "Provider request running", completed: "Provider request completed", failed: "Provider request failed", aborted: "Provider request aborted", unresolved: "Provider outcome unconfirmed at execution end" },
    toolStates: { pending: "Pending", completed: "Completed", failed: "Failed" },
    effects: { unknown: "Effects unknown", read_only: "Read-only", write_confirmed: "Write confirmed" },
  },
};
