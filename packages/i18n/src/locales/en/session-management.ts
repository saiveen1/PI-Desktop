export const sessionLabels = {
  customColor: "Custom color", hexColor: "HEX color", hue: "Hue", saturation: "Saturation", brightness: "Brightness",
  colorPreview: "Color preview", invalidColor: "Enter a valid HEX color (#RGB or #RRGGBB).",
  "title": "Labels",
  "add": "Add label",
  "name": "Label name",
  "color": "Color",
  "delete": "Delete label",
  "deleteConfirm": "Delete \"{{name}}\" and remove it from {{count}} conversations? Conversations will be kept.",
  "moveUp": "Move up",
  "moveDown": "Move down",
  "save": "Save",
  "cancel": "Cancel",
  "none": "No labels",
  "unclassified": "Unclassified",
  "manage": "Manage labels",
  "filter": "Filter conversations",
  "clearFilters": "Clear filters",
  "allColors": "All colors",
  "colorMark": "Color mark",
  "clearColor": "No color mark",
  "overflow": "{{count}} more labels",
  "reorderBefore": "Move before {{title}}",
  "reorderAfter": "Move after {{title}}",
  "activityOrder": "Activity order",
  "investigation": "Investigation",
  "feature": "Feature",
  "fix": "Fix",
  "colors": {
    "red": "Red",
    "amber": "Amber",
    "green": "Green",
    "blue": "Blue",
    "violet": "Violet",
    "pink": "Pink"
  }
};

export const sessionGroups = {
  title: "Groups", manage: "Manage…", name: "Group name", add: "Add group", delete: "Delete group",
  deleteConfirm: "Delete \"{{name}}\" and move {{count}} conversations to Ungrouped? Conversations will be kept.",
  ungrouped: "Ungrouped", moveTo: "Move to group",
  description: "Each conversation belongs to one group in this project. Deleting a group keeps its conversations.",
  labelsDescription: "Labels describe conversations; they do not group or filter them. Changes apply only to this project.",
  usage: "{{count}} conversations", folders: "{{count}} folders", primary: "Primary",
};

export const sessionDelegation = {
  "title": "Subagent models",
  "customCount": "Subagent models: {{count}} selected",
  "scope": "Model pool",
  "inherit": "Follow global",
  "custom": "Custom",
  "inheritHint": "Uses the global delegation settings.",
  "taskFitHint": "Choose models and approval rules for this conversation only; global settings stay unchanged. Tasks match model descriptions.",
  "search": "Search models",
  "models": "Available subagent models",
  "unavailable": "Unavailable",
  "approvalRequired": "Approval required",
  "autoAllowed": "Automatically allowed",
  "approvalFor": "Approval for {{model}}",
  "noModels": "No matching models.",
  "selectedCount": "{{count}} models selected",
  "disabled": "Delegation is disabled for this conversation.",
  "busy": "Model selection can be saved when the conversation is idle.",
  "invalidSelection": "Remove unavailable models before saving.",
  "cancel": "Cancel",
  "save": "Save",
  "saving": "Saving..."
};

export const delegationDetails = {
  "title": "Model selection",
  "requested": "Requested model",
  "reason": "Selection reason",
  "actual": "Actual model",
  "scheduling": "Scheduling decisions",
  "resumedFrom": "Resumed from",
  "selected": "Selected",
  "skipped": "Skipped",
  "cancelled": "Cancelled"
};
