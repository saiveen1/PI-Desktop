export const sessionLabels = {
  customColor: "自訂顏色", hexColor: "HEX 色碼", hue: "色相", saturation: "飽和度", brightness: "明度",
  colorPreview: "顏色預覽", invalidColor: "請輸入有效的 HEX 色碼（#RGB 或 #RRGGBB）。",
  "title": "標籤",
  "add": "新增標籤",
  "name": "標籤名稱",
  "color": "顏色",
  "delete": "刪除標籤",
  "deleteConfirm": "刪除「{{name}}」並移除 {{count}} 個對話的關聯？對話會被保留。",
  "moveUp": "上移",
  "moveDown": "下移",
  "save": "儲存",
  "cancel": "取消",
  "none": "無標籤",
  "unclassified": "未分類",
  "manage": "管理標籤",
  "filter": "篩選對話",
  "clearFilters": "清除篩選",
  "allColors": "全部顏色",
  "colorMark": "顏色標記",
  "clearColor": "無顏色標記",
  "overflow": "另有 {{count}} 個標籤",
  "reorderBefore": "移至 {{title}} 前",
  "reorderAfter": "移至 {{title}} 後",
  "activityOrder": "活動順序",
  "investigation": "排查",
  "feature": "功能",
  "fix": "修復",
  "colors": {
    "red": "紅色",
    "amber": "琥珀色",
    "green": "綠色",
    "blue": "藍色",
    "violet": "紫色",
    "pink": "粉紅色"
  }
};

export const sessionGroups = {
  title: "群組", manage: "管理…", name: "群組名稱", add: "新增群組", delete: "刪除群組",
  deleteConfirm: "刪除「{{name}}」並將 {{count}} 個對話移至未分組？對話將會保留。",
  ungrouped: "未分組", moveTo: "移動到群組",
  description: "每個對話只屬於目前專案的一個群組。刪除群組不會刪除對話。",
  labelsDescription: "標籤僅用於描述對話，不參與分組或篩選。變更僅套用至目前專案。",
  usage: "{{count}} 個對話", folders: "{{count}} 個資料夾", primary: "主要",
};

export const sessionDelegation = {
  "title": "子代理模型",
  "customCount": "子代理模型：已選 {{count}} 個",
  "scope": "模型範圍",
  "inherit": "跟隨全域",
  "custom": "自訂",
  "inheritHint": "使用全域委派設定。",
  "taskFitHint": "僅為此對話設定可用模型與審批規則，不修改全域設定；子任務依模型描述匹配。",
  "search": "搜尋模型",
  "models": "可用子代理模型",
  "unavailable": "無法使用",
  "approvalRequired": "需要審批",
  "autoAllowed": "自動允許",
  "approvalFor": "{{model}} 的審批規則",
  "noModels": "沒有符合的模型。",
  "selectedCount": "已選 {{count}} 個模型",
  "disabled": "此對話已停用委派。",
  "busy": "對話閒置時可儲存模型選擇。",
  "invalidSelection": "請先移除無法使用的模型再儲存。",
  "cancel": "取消",
  "save": "儲存",
  "saving": "儲存中…"
};

export const delegationDetails = {
  "title": "模型選擇",
  "requested": "原始選擇",
  "reason": "選模理由",
  "actual": "實際模型",
  "scheduling": "調度記錄",
  "selected": "已選擇",
  "skipped": "已略過",
  "cancelled": "已取消"
};
