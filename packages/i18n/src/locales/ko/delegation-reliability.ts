export const delegationReliabilitySettings = {
  "delegationRunReportRecovery": "누락된 최종 보고서 복구",
  "delegationRunReportRecoveryDesc": "하위 작업이 보고서 없이 끝나면 도구 없이 보고서를 한 번 요청합니다. 설정된 보고 기한이 적용되며 API 사용량이 추가될 수 있습니다.",
  "delegationRunReportRecoveryOnce": "한 번",
  "delegationRunReportRecoveryOff": "끔",
  "unknownUpstreamRetryLimit": "알 수 없는 업스트림 오류 재시도",
  "unknownUpstreamRetryLimitDesc": "일반 업스트림 400/422 오류를 응답당 이 횟수까지 재시도합니다. 0은 복구를 끄며, 무제한 재시도 설정도 이 한도를 늘리지 않습니다."
};

export const delegationDiagnostics = {
  "title": "위임 세부 정보",
  "requestedModel": "요청 모델",
  "actualModel": "실제 모델",
  "activity": "활동",
  "activityCounts": "{{turns}}턴 · 도구 호출 {{tools}}회",
  "stopReason": "종료 이유",
  "reportOutcome": "보고 결과",
  "responseStructure": "응답 구조",
  "responseCounts": "텍스트 {{text}} · 사고 {{thinking}} · 도구 {{tools}}",
  "recoveryAttempts": "보고 복구 시도",
  "failure": "실패",
  "selection": "모델 선택",
  "modelFailures": "모델 실패",
  "selected": "선택됨",
  "skipped": "건너뜀",
  "cancelled": "취소됨",
  "retry": "복구",
  "retryAttempt": "시도 {{attempt}} / {{limit}}",
  "stopReasons": {
    "stop": "정상 종료",
    "tool_calls": "도구 요청",
    "length": "출력 한도",
    "error": "오류",
    "aborted": "취소됨",
    "unknown": "기록 없음"
  },
  "reportOutcomes": {
    "delivered": "보고서 전달됨",
    "missing": "최종 보고서 없음",
    "truncated": "보고서 잘림",
    "invalid_tool_ending": "잘못된 도구 종료",
    "error": "실패",
    "cancelled": "취소됨"
  }
};
