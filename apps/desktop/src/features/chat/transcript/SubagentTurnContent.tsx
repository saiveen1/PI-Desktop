import { useMemo } from "react";
import type { AssistantTurnEntry } from "../../../lib/assistant-turns";
import type { SubagentTranscriptTurn } from "../../../lib/subagent-transcript";
import { subagentTurnEntries } from "../../../lib/subagent-turn-entry";
import { getAssistantTurnSummary } from "../../../lib/transcript-summary";
import { cachedVisibleProcessSteps } from "../../../lib/transcript-activity-summary";
import { resolveShowThinking } from "../../../lib/thinking-visibility";
import { useAppStore } from "../../../stores/app-store";
import { AssistantTurnParts } from "./AssistantTurnParts";
import { TurnChangesCard } from "./TurnChangesCard";
import { TurnProcess } from "./TurnProcess";
import { TurnToolImages } from "./ToolResultImages";
import { SubagentUserMessage } from "./SubagentUserMessage";

const NO_DELEGATIONS = new Map<string, never>();

/** The shared reading surface, without parent-session edit/retry message actions. */
export function SubagentTurnContent({ id, rows, active }: {
  id: string;
  rows: readonly SubagentTranscriptTurn["rows"][number][];
  active: boolean;
}) {
  const entries = useMemo(() => subagentTurnEntries(id, rows), [id, rows]);
  return <>{entries.map((entry, index) => entry.kind === "message"
    ? <SubagentUserMessage key={entry.message.id} message={entry.message} />
    : <SubagentAssistantContent key={entry.id} entry={entry} active={active && index === entries.length - 1} />)}</>;
}

function SubagentAssistantContent({ entry, active }: { entry: AssistantTurnEntry; active: boolean }) {
  const showThinking = useAppStore((state) => resolveShowThinking(state.settings));
  const summary = getAssistantTurnSummary(entry);
  const context = {
    isActive: active,
    activePart: active ? entry.parts.at(-1) : undefined,
    turnDelegationStatuses: NO_DELEGATIONS,
    turnDelegationTimings: NO_DELEGATIONS,
  };
  return <>
    {summary.process.length > 0 ? <TurnProcess
      turnId={entry.id} processParts={summary.process} turnParts={entry.parts}
      visibleSteps={cachedVisibleProcessSteps(summary.process, !showThinking, active)}
      isActive={active} failed={summary.hasError}
    >
      <AssistantTurnParts parts={summary.process} {...context} />
    </TurnProcess> : null}
    <AssistantTurnParts parts={summary.responses} {...context} />
    <TurnToolImages parts={entry.parts} />
    <TurnChangesCard tools={summary.tools} />
  </>;
}
