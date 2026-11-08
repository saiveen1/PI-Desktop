export const sessionLabels = {
  customColor: "사용자 지정 색상", hexColor: "HEX 색상", hue: "색조", saturation: "채도", brightness: "명도",
  colorPreview: "색상 미리 보기", invalidColor: "올바른 HEX 색상을 입력하세요(#RGB 또는 #RRGGBB).",
  "title": "라벨",
  "add": "라벨 추가",
  "name": "라벨 이름",
  "color": "색상",
  "delete": "라벨 삭제",
  "deleteConfirm": "“{{name}}”을 삭제하고 대화 {{count}}개의 연결을 제거할까요? 대화는 유지됩니다.",
  "moveUp": "위로 이동",
  "moveDown": "아래로 이동",
  "save": "저장",
  "cancel": "취소",
  "none": "라벨 없음",
  "unclassified": "미분류",
  "manage": "라벨 관리",
  "filter": "대화 필터",
  "clearFilters": "필터 지우기",
  "allColors": "모든 색상",
  "colorMark": "색상 표시",
  "clearColor": "색상 표시 없음",
  "overflow": "라벨 {{count}}개 더 보기",
  "reorderBefore": "{{title}} 앞으로 이동",
  "reorderAfter": "{{title}} 뒤로 이동",
  "activityOrder": "활동 순서",
  "investigation": "조사",
  "feature": "기능",
  "fix": "수정",
  "colors": {
    "red": "빨강",
    "amber": "호박색",
    "green": "초록",
    "blue": "파랑",
    "violet": "보라",
    "pink": "분홍"
  }
};

export const sessionGroups = {
  title: "그룹", manage: "관리…", name: "그룹 이름", add: "그룹 추가", delete: "그룹 삭제",
  deleteConfirm: "\"{{name}}\"을 삭제하고 대화 {{count}}개를 미분류로 옮길까요? 대화는 유지됩니다.",
  ungrouped: "미분류", moveTo: "그룹으로 이동",
  description: "각 대화는 이 프로젝트의 한 그룹에 속합니다. 그룹을 삭제해도 대화는 유지됩니다.",
  labelsDescription: "라벨은 대화를 설명하며 그룹화하거나 필터링하지 않습니다. 변경 사항은 이 프로젝트에만 적용됩니다.",
  usage: "대화 {{count}}개", folders: "폴더 {{count}}개", primary: "기본",
};

export const sessionDelegation = {
  "title": "하위 에이전트 모델",
  "customCount": "하위 에이전트 모델: {{count}}개 선택됨",
  "scope": "모델 범위",
  "inherit": "전역 설정 따르기",
  "custom": "사용자 지정",
  "inheritHint": "전역 위임 설정을 사용합니다.",
  "taskFitHint": "이 대화에만 적용할 모델과 승인 규칙을 선택합니다. 전역 설정은 변경되지 않으며 하위 작업은 모델 설명에 따라 배정됩니다.",
  "search": "모델 검색",
  "models": "사용 가능한 하위 에이전트 모델",
  "unavailable": "사용 불가",
  "approvalRequired": "승인 필요",
  "autoAllowed": "자동 허용",
  "approvalFor": "{{model}} 승인 규칙",
  "noModels": "일치하는 모델이 없습니다.",
  "selectedCount": "모델 {{count}}개 선택됨",
  "disabled": "이 대화에서는 위임이 비활성화됩니다.",
  "busy": "대화가 유휴 상태일 때 모델 선택을 저장할 수 있습니다.",
  "invalidSelection": "저장하기 전에 사용할 수 없는 모델을 제거하세요.",
  "cancel": "취소",
  "save": "저장",
  "saving": "저장 중…"
};

export const delegationDetails = {
  "title": "모델 선택",
  "requested": "요청한 모델",
  "reason": "선택 이유",
  "actual": "실제 모델",
  "scheduling": "일정 결정",
  "selected": "선택됨",
  "skipped": "건너뜀",
  "cancelled": "취소됨"
};
