export const sessionLabels = {
  customColor: "自定义颜色", hexColor: "HEX 色值", hue: "色相", saturation: "饱和度", brightness: "明度",
  colorPreview: "颜色预览", invalidColor: "请输入有效的 HEX 色值（#RGB 或 #RRGGBB）。",
  "title": "标签",
  "add": "添加标签",
  "name": "标签名称",
  "color": "颜色",
  "delete": "删除标签",
  "deleteConfirm": "删除“{{name}}”并移除 {{count}} 个会话的关联？会话会被保留。",
  "moveUp": "上移",
  "moveDown": "下移",
  "save": "保存",
  "cancel": "取消",
  "none": "无标签",
  "unclassified": "未分类",
  "manage": "管理标签",
  "filter": "筛选会话",
  "clearFilters": "清除筛选",
  "allColors": "全部颜色",
  "colorMark": "颜色标记",
  "clearColor": "无颜色标记",
  "overflow": "另有 {{count}} 个标签",
  "reorderBefore": "移至 {{title}} 前",
  "reorderAfter": "移至 {{title}} 后",
  "activityOrder": "活动顺序",
  "investigation": "排查",
  "feature": "功能",
  "fix": "修复",
  "colors": {
    "red": "红色",
    "amber": "琥珀色",
    "green": "绿色",
    "blue": "蓝色",
    "violet": "紫色",
    "pink": "粉色"
  }
};

export const sessionGroups = {
  title: "分组", manage: "管理…", name: "分组名称", add: "添加分组", delete: "删除分组",
  deleteConfirm: "删除“{{name}}”并将 {{count}} 个会话移至未分组？会话会被保留。",
  ungrouped: "未分组", moveTo: "移动到分组",
  description: "每个会话只属于当前项目的一个分组。删除分组不会删除会话。",
  labelsDescription: "标签只用于描述会话，不参与分组或筛选。修改仅对当前项目生效。",
  usage: "{{count}} 个会话", folders: "{{count}} 个文件夹", primary: "主要",
};

export const sessionDelegation = {
  "title": "子代理模型",
  "customCount": "子代理模型：已选 {{count}} 个",
  "scope": "模型范围",
  "inherit": "跟随全局",
  "custom": "自定义",
  "inheritHint": "使用全局委派设置。",
  "taskFitHint": "仅为此会话设置可用模型和审批规则，不修改全局设置；子任务按模型描述匹配。",
  "search": "搜索模型",
  "models": "可用子代理模型",
  "unavailable": "不可用",
  "approvalRequired": "需要审批",
  "autoAllowed": "自动允许",
  "approvalFor": "{{model}} 的审批规则",
  "noModels": "没有匹配的模型。",
  "selectedCount": "已选 {{count}} 个模型",
  "disabled": "此会话已禁用委派。",
  "busy": "会话空闲时可保存模型选择。",
  "invalidSelection": "请先移除不可用的模型再保存。",
  "cancel": "取消",
  "save": "保存",
  "saving": "保存中…"
};

export const delegationDetails = {
  "title": "模型选择",
  "requested": "原始选择",
  "reason": "选模理由",
  "actual": "实际模型",
  "scheduling": "调度记录",
  "selected": "已选择",
  "skipped": "已跳过",
  "cancelled": "已取消"
};
