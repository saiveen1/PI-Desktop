import { readStoreSource, readTranscriptSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [store, transcript, messagesStyles, chatShellStyles, proseStyles, en, zh] =
  await Promise.all([
    readStoreSource(),
    readTranscriptSource(),
    read("../src/styles/messages.css"),
    read("../src/styles/chat-shell.css"),
    read("../src/styles/prose.css"),
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
  ]);

test("active turns show immediate and phase-specific feedback without a progress card", () => {
  assert.match(transcript, /function WorkingIndicator\(/);
  assert.match(transcript, /"working-indicator"/);
  assert.match(transcript, /role="status"/);
  assert.match(transcript, /className="working-indicator-mark" aria-hidden="true"/);
  assert.match(transcript, /className="working-indicator-label"/);
  assert.match(transcript, /function RunActivityIndicator\(/);
  assert.match(transcript, /"run-activity-indicator"/);
  assert.doesNotMatch(transcript, /tool-activity-current|currentStatus|activityItemStatus/);
  assert.match(transcript, /waiting-model/);
  assert.match(transcript, /waitingForSubagents/);
  assert.match(transcript, /waitingForSubagentNamed/);
  assert.match(transcript, /startingTurn/);
  assert.match(transcript, /preparingNextRequest/);
  assert.match(transcript, /compactingContext/);
  assert.match(transcript, /recoveringTurn/);
  assert.match(transcript, /retryingModel/);
  assert.match(transcript, /function runActivityLabel\(/);
  assert.match(transcript, /activity\?\.phase === "retrying" \? activity\.error/);
  assert.match(transcript, /run-status-error/);
  assert.match(transcript, /role="dialog"/);
  assert.match(transcript, /aria-controls=\{open \? panelId : undefined\}/);
  assert.match(transcript, /state\.agentStatuses\[sessionId\]\?\.activity/);
  assert.match(transcript, /const specializedActivity = agentActivity/);
  assert.match(transcript, /!hasSpecializedActivity/);
  assert.match(transcript, /const showWorking =/);
  assert.match(transcript, /\{showWorking \? <WorkingIndicator diagnostics=\{runDiagnostics\}/);
  assert.match(transcript, /function PlanningIndicator\(/);
  assert.match(transcript, /data-testid="planning-indicator"/);
  assert.match(transcript, /const showPlanning =/);
  assert.match(transcript, /\{showPlanning \? <PlanningIndicator kind=\{planningKind\} \/> : null\}/);
  assert.match(
    transcript,
    /planningState === "planning"[\s\S]*!hasSpecializedActivity/,
  );
  const planningBlock =
    transcript.match(/function PlanningIndicator\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(planningBlock, /working-indicator-mark/);
  assert.doesNotMatch(planningBlock, /IconListChecks|IconTarget/);
  assert.match(messagesStyles, /\.planning-state-indicator\s*\{/);
  assert.match(
    messagesStyles,
    /\.planning-state-indicator[\s\S]*?animation:\s*planning-state-in/,
  );
  assert.match(
    messagesStyles,
    /\.planning-state-indicator \.working-indicator-mark > span\s*\{[\s\S]*?background:\s*var\(--ds-purple\)/,
  );
  assert.doesNotMatch(transcript, /AgentProgressTimeline|agent-progress/);
  assert.match(transcript, /<PermissionCard/);
  assert.doesNotMatch(store, /AgentProgress|agentProgress|updateAgentProgress/);
  assert.match(messagesStyles, /\.working-indicator\s*\{/);
  assert.doesNotMatch(messagesStyles, /\.tool-activity-current/);
  assert.match(messagesStyles, /\.working-indicator-mark\s*\{/);
  assert.match(messagesStyles, /\.run-activity-indicator\[data-phase="waiting-model"\]/);
  assert.match(messagesStyles, /\.run-activity-indicator\[data-phase="compacting"\]/);
  assert.match(messagesStyles, /\.run-activity-indicator\[data-phase="recovering"\]/);
  assert.match(messagesStyles, /\.run-activity-indicator\[data-phase="retrying"\]/);
  // The shared details portal escapes the transcript scrollport and uses
  // measured placement; pointer/keyboard behavior is covered by the real fixture.
  const popoverRule = messagesStyles.match(/\.run-status-popover \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(popoverRule, /position: fixed;/);
  assert.match(popoverRule, /background: var\(--ds-bg-elevated-opaque\);/);
  assert.match(popoverRule, /max-height: calc\(100dvh - 32px\);/);
  assert.match(popoverRule, /overflow-y: auto;/);
  assert.match(transcript, /portalToBody\(/);
  assert.match(transcript, /placeContextInspector\(/);
  assert.match(transcript, /new ResizeObserver\(updatePosition\)/);
  assert.match(transcript, /window.addEventListener\("scroll", updatePosition, true\)/);
  assert.match(messagesStyles, /\.run-activity-indicator\[data-phase="waiting-subagents"\]/);
  assert.match(messagesStyles, /\.working-indicator-mark > span\s*\{[\s\S]*?animation:\s*working-indicator-dot\s+1s/);
  assert.doesNotMatch(proseStyles, /\.working-indicator\s*\{|\.shimmer-text\s*\{/);
  assert.doesNotMatch(messagesStyles, /\.shimmer-text\s*\{|animation:\s*shimmer\b/);
  // The live marker is a real flex sibling of the label, so the header's
  // alignment centres it; the old generated inline box drifted off centre.
  assert.match(transcript, /<span className="activity-marker" aria-hidden \/>/);
  assert.match(
    messagesStyles,
    /\.activity-marker \{[\s\S]*?flex:\s*none;[\s\S]*?animation:\s*activity-marker-pulse\s+1s/,
  );
  assert.doesNotMatch(
    messagesStyles,
    /\.(tool-activity-label|tool-row-name)\.running::after/,
  );
  assert.doesNotMatch(
    en,
    /progressUnderstanding|progressWorking|progressChecking|progressFinalizing|progressWaiting/,
  );
  assert.doesNotMatch(
    zh,
    /progressUnderstanding|progressWorking|progressChecking|progressFinalizing|progressWaiting/,
  );
  for (const catalog of [en, zh]) {
    assert.match(catalog, /waitingForModel:/);
    assert.match(catalog, /startingTurn:/);
    assert.match(catalog, /preparingNextRequest:/);
    assert.match(catalog, /compactingContext:/);
    assert.match(catalog, /recoveringTurn:/);
    assert.match(catalog, /retryingModel:/);
    assert.match(catalog, /waitingForSubagentNamed:/);
    assert.match(catalog, /waitingForSubagents_one:/);
    assert.match(catalog, /waitingForSubagents_other:/);
  }
  assert.match(store, /agentStatuses: Record<string, AgentStatus>/);
  assert.match(store, /event\.type === "status"/);
  // The tail status lane is part of the layout for the whole running turn, so
  // the indicators coming and going cannot resize the transcript (issue #323).
  assert.match(transcript, /const runtimeStatusLane = transcriptRunning;/);
  assert.match(transcript, /\{runtimeStatusLane \? \(/);
  assert.match(transcript, /className="transcript-runtime-status"/);
  assert.match(
    chatShellStyles,
    /\.transcript-runtime-status \{[\s\S]*?display: flow-root;[\s\S]*?min-height: calc\(var\(--text-sm-plus\) \* var\(--leading-body\) \+ 22px\);/,
  );
  // An empty lane must read as nothing at all: the reserve is geometry only,
  // so the rule may not paint a surface of its own.
  const laneRule =
    chatShellStyles.match(/\.transcript-runtime-status \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(laneRule, /min-height:/);
  assert.doesNotMatch(laneRule, /background|box-shadow|border-style|border-width|border:/);
  // The reserve is sized from the indicator's own box, so the two must be
  // changed together or the row starts moving again.
  assert.match(
    messagesStyles,
    /\.working-indicator \{[\s\S]*?margin: 2px 0 8px;[\s\S]*?padding: 8px 0 4px 16px;/,
  );
  assert.match(
    messagesStyles,
    /\.planning-state-indicator \{[\s\S]*?margin: 2px 0 8px;[\s\S]*?padding: 8px 0 4px 16px;/,
  );
});
