import type { SessionThinkingLevel } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";

/** The index and detail describe the same recorded execution, not current settings. */
export function SubagentModelInfo({ modelId, thinkingLevel }: {
  modelId: string;
  thinkingLevel?: SessionThinkingLevel;
}) {
  const { t } = useTranslation();
  const model = modelId || t("subagentControls.modelUnrecorded");
  const effort = t("subagentControls.effort", { level: thinkingLevel ?? t("subagentControls.notRecorded") });
  return <span className="subagent-model-info">
    <span className="subagent-model-name" title={model}>{model}</span>
    <span className="subagent-model-effort">{effort}</span>
  </span>;
}
