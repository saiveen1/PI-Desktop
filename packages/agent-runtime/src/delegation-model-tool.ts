import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describeDelegationModels } from "@pi-desktop/shared";
import type { CurrentDelegationPolicy } from "./delegation-policy-state.js";

export function buildDelegationModelTool(options: {
  policy: () => Promise<CurrentDelegationPolicy>;
  legacyKeys: () => string[];
}): AgentTool {
  return {
    name: "TaskModels", label: "Task models",
    description: "Read this conversation's available delegation models and descriptions when preparing a Task. Reuse the result for a batch; refresh after a policy change or unavailable-model response.",
    parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      const policy = await options.policy();
      signal?.throwIfAborted();
      const keys = policy.modelKeys ?? options.legacyKeys();
      const allowed = new Set(keys);
      const settings = policy.settings && {
        ...policy.settings, models: policy.settings.models.filter(row => allowed.has(`${row.providerId}/${row.modelId}`)),
      };
      const guidance = policy.selectionMode === "task-fit"
        ? "Match each task to model descriptions first. Choose an explicit model and a concise modelReason for each new Task. Priority is only a tie-breaker or fallback. An empty pool disables delegation."
        : "For a new Task with multiple available models, supply model and a concise modelReason. With at most one candidate, model selection is optional.";
      return {
        content: [{ type: "text", text: [guidance, settings ? describeDelegationModels(settings, policy.selectionMode) :
          JSON.stringify({ modelKeys: keys })].join("\n\n") }],
        details: { modelKeys: keys, selectionMode: policy.selectionMode ?? "legacy" },
      };
    },
  };
}
