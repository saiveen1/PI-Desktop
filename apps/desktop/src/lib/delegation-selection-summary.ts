type Decision = { model: string; decision: "selected" | "skipped" | "cancelled"; reason: string };
export type DelegationSelectionSummary = {
  requestedModel?: string;
  actualModel?: string;
  modelReason?: string;
  resumedFrom?: string;
  decisions: Decision[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Only recorded facts belong in historical selection details. */
export function delegationSelectionSummary(payload: unknown): DelegationSelectionSummary | undefined {
  const result = record(payload);
  if (!result) return undefined;
  const scheduling = record(result.scheduling);
  const decisions: Decision[] = [];
  if (Array.isArray(scheduling?.decisions)) {
    for (const candidate of scheduling.decisions) {
      const item = record(candidate);
      const model = text(item?.model);
      const reason = text(item?.reason);
      if (model && reason && (item?.decision === "selected" || item?.decision === "skipped" || item?.decision === "cancelled")) {
        decisions.push({ model, reason, decision: item.decision });
      }
    }
  }
  const selected = decisions.findLast(item => item.decision === "selected");
  const modelId = text(result.modelId);
  const providerId = text(result.providerId);
  const actualModel = selected?.model ?? (modelId ? providerId ? `${providerId}/${modelId}` : modelId : undefined);
  const requestedModel = text(scheduling?.requestedModel);
  const modelReason = text(scheduling?.modelReason);
  const resumedFrom = text(result.resumedFrom);
  if (!actualModel && !requestedModel && !modelReason && !resumedFrom && !decisions.length) return undefined;
  return { actualModel, requestedModel, modelReason, resumedFrom, decisions };
}
