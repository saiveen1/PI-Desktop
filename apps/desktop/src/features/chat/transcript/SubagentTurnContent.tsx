import { useMemo } from "react";
import type { SubagentRunItem } from "../../../lib/assistant-turns";
import { subagentTurnEntry } from "../../../lib/subagent-turn-entry";
import { getAssistantTurnSummary } from "../../../lib/transcript-summary";
import { cachedVisibleProcessSteps } from "../../../lib/transcript-activity-summary";
import { resolveShowThinking } from "../../../lib/thinking-visibility";
import { useAppStore } from "../../../stores/app-store";
import { AssistantTurnParts } from "./AssistantTurnParts";
import { TurnChangesCard } from "./TurnChangesCard";
import { TurnProcess } from "./TurnProcess";
import { GeneratedImages } from "./GeneratedImages";

const NO_DELEGATIONS = new Map<string, never>();

/** The shared reading surface, without parent-session edit/retry message actions. */
export function SubagentTurnContent({ id, rows, active }: {
  id: string;
  rows: readonly SubagentRunItem[];
  active: boolean;
}) {
  const showThinking = useAppStore((state) => resolveShowThinking(state.settings));
  const entry = useMemo(() => subagentTurnEntry(id, rows), [id, rows]);
  const summary = getAssistantTurnSummary(entry);
  const context = {
    isActive: active,
    activePart: active ? entry.parts.at(-1) : undefined,
    turnDelegationStatuses: NO_DELEGATIONS,
    turnDelegationTimings: NO_DELEGATIONS,
  };
  return <>
    {summary.process.length > 0 ? <TurnProcess
      turnId={id} processParts={summary.process} turnParts={entry.parts}
      visibleSteps={cachedVisibleProcessSteps(summary.process, !showThinking, active)}
      isActive={active} failed={summary.hasError}
    >
      <AssistantTurnParts parts={summary.process} {...context} />
    </TurnProcess> : null}
    <AssistantTurnParts parts={summary.responses} {...context} />
    {summary.generatedImages.map((message) => <GeneratedImages key={message.id} message={message} />)}
    <TurnChangesCard tools={summary.tools} />
  </>;
}
