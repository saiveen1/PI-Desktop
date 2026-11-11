export const delegationReliabilitySettings = {
  providerStreamIdleTimeout: "Model connection idle timeout",
  providerStreamIdleTimeoutDesc: "Cancels only if no response data arrives for the selected duration. Long thinking alone does not restart the request. Applies from the next turn; when disabled, stop a stuck request manually.",
  providerStreamIdleTimeoutDisabled: "Disabled",
  providerStreamIdleTimeoutMinutes: "{{count}} minutes",
  "delegationRunReportRecovery": "Recover a missing final report",
  "delegationRunReportRecoveryDesc": "Request one tool-free final report if a delegate ends without a deliverable. Uses the configured report deadline and may add API usage.",
  "delegationRunReportRecoveryOnce": "Once",
  "delegationRunReportRecoveryOff": "Off",
  "unknownUpstreamRetryLimit": "Unknown upstream error retries",
  "unknownUpstreamRetryLimitDesc": "Retry generic upstream 400/422 failures up to this limit per response. 0 disables recovery; unlimited transient retry does not change this limit."
};

export const delegationDiagnostics = {
  "title": "Delegation details",
  "requestedModel": "Requested model",
  "actualModel": "Actual model",
  "activity": "Activity",
  "activityCounts": "{{turns}} turns · {{tools}} tool calls",
  "stopReason": "Finish reason",
  "reportOutcome": "Report outcome",
  "responseStructure": "Response structure",
  "responseCounts": "{{text}} text · {{thinking}} thinking · {{tools}} tools",
  "recoveryAttempts": "Report recovery attempts",
  "failure": "Failure",
  "selection": "Model selection",
  "modelFailures": "Model failures",
  "selected": "Selected",
  "skipped": "Skipped",
  "cancelled": "Cancelled",
  "retry": "Recovery",
  "retryAttempt": "Attempt {{attempt}} / {{limit}}",
  "stopReasons": {
    "stop": "Normal stop",
    "tool_calls": "Tool request",
    "length": "Output limit",
    "error": "Error",
    "aborted": "Cancelled",
    "unknown": "Not recorded"
  },
  "reportOutcomes": {
    "delivered": "Report delivered",
    "missing": "No final report",
    "truncated": "Truncated report",
    "invalid_tool_ending": "Invalid tool ending",
    "error": "Failed",
    "cancelled": "Cancelled"
  }
};
