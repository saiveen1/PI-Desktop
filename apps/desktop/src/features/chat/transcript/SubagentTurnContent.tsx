import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AssistantTurnEntry } from "../../../lib/assistant-turns";
import type { SubagentTranscriptTurn } from "../../../lib/subagent-transcript";
import { subagentTurnEntries } from "../../../lib/subagent-turn-entry";
import { getAssistantTurnSummary } from "../../../lib/transcript-summary";
import { cachedVisibleProcessSteps } from "../../../lib/transcript-activity-summary";
import { resolveShowThinking } from "../../../lib/thinking-visibility";
import type { SubagentOutcome } from "../../../lib/subagent-topology";
import { resolveTranscriptDisplayMode } from "../../../lib/transcript-display-mode";
import { segmentTurnProcess } from "../../../lib/turn-process";
import { reviewChangeFromMessage } from "../../../lib/workspace-review";
import { ReviewChangeCard } from "../../../components/ReviewChangeCard";
import { ToolRow } from "./ToolRow";
import { useAppStore } from "../../../stores/app-store";
import { AssistantTurnParts } from "./AssistantTurnParts";
import { TurnChangesCard } from "./TurnChangesCard";
import { TurnProcess } from "./TurnProcess";
import { TurnToolImages } from "./ToolResultImages";
import { SubagentUserMessage } from "./SubagentUserMessage";

const NO_DELEGATIONS = new Map<string, never>();

/** The shared reading surface, without parent-session edit/retry message actions. */
export function SubagentTurnContent({ id, rows, active, outcome }: {
  id: string;
  rows: readonly SubagentTranscriptTurn["rows"][number][];
  active: boolean;
  outcome?: SubagentOutcome;
}) {
  const entries = useMemo(() => subagentTurnEntries(id, rows), [id, rows]);
  return <>{entries.map((entry, index) => entry.kind === "message"
    ? <SubagentUserMessage key={entry.message.id} message={entry.message} />
    : <SubagentAssistantContent key={entry.id} entry={entry} active={active && index === entries.length - 1}
        outcome={index === entries.length - 1 ? outcome : undefined} />)}</>;
}

function SubagentAssistantContent({ entry, active, outcome }: { entry: AssistantTurnEntry; active: boolean; outcome?: SubagentOutcome }) {
  const showThinking = useAppStore((state) => resolveShowThinking(state.settings));
  const { t } = useTranslation();
  const displayMode = useAppStore((state) => resolveTranscriptDisplayMode(state.settings));
  const summary = getAssistantTurnSummary(entry);
  const segments = useMemo(() => segmentTurnProcess(summary.process, displayMode), [summary.process, displayMode]);
  const context = {
    isActive: active,
    activePart: active ? entry.parts.at(-1) : undefined,
    turnDelegationStatuses: NO_DELEGATIONS,
    turnDelegationTimings: NO_DELEGATIONS,
  };
  return <div className="message-row assistant assistant-turn" role="article" aria-label={t("chat.assistantMessage")}><div className="message-col">
    {summary.process.length > 0 ? <TurnProcess
      turnId={entry.id} processParts={summary.process} turnParts={entry.parts}
      visibleSteps={cachedVisibleProcessSteps(summary.process, !showThinking, active)}
      isActive={active} failed={summary.hasError || outcome === "failed" || outcome === "timed_out" || outcome === "denied"}
      stopped={outcome === "stopped" || outcome === "aborted"}
    >
      {segments.map(segment => segment.kind === "run"
        ? <div className="turn-run-row" data-run-row="true" key={`run-${segment.key}`}>
            {reviewChangeFromMessage(segment.item.message) !== null
              ? <ReviewChangeCard message={segment.item.message} asToolRow />
              : <ToolRow imagesInTurn message={segment.item.message} />}
          </div>
        : <AssistantTurnParts key={`process-${segment.key}`} parts={segment.parts} {...context} />)}
    </TurnProcess> : null}
    <AssistantTurnParts parts={summary.responses} {...context} />
    <TurnToolImages parts={entry.parts} />
    <TurnChangesCard tools={summary.tools} />
  </div></div>;
}
