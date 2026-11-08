import {
  readStoreModule,
  readStoreSource,
  readTranscriptSource,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const transcriptSource = await readTranscriptSource();
const tabSource = await readFile(new URL("../src/components/workpanel/SubagentTranscriptTab.tsx", import.meta.url), "utf8");
const runtimeSource = await readFile(
  new URL("../../../packages/agent-runtime/src/runtime.ts", import.meta.url),
  "utf8",
);
const toolPresentationSource = await readFile(
  new URL("../src/lib/tool-presentation.ts", import.meta.url),
  "utf8",
);
const followScrollSource = await readFile(
  new URL("../src/hooks/use-follow-scroll.ts", import.meta.url),
  "utf8",
);
const storeSource = await readStoreSource();
const eventsSource = await readStoreModule("slices/events-slice.ts");
const sessionRuntimeSource = await readStoreModule("runtime/session-runtime.ts");
const messagesCss = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);
const topologySource = await readFile(
  new URL("../src/lib/subagent-topology.ts", import.meta.url),
  "utf8",
);
const toolDisplaySource = await readFile(
  new URL("../src/lib/tool-display.ts", import.meta.url),
  "utf8",
);
const englishCatalogSource = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);
const chineseCatalogSource = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);
const turkishCatalogSource = await readFile(
  new URL("../../../packages/i18n/src/locales/tr/index.ts", import.meta.url),
  "utf8",
);

test("a delegation card reads its outcome from the lifecycle rows", () => {
  // `Task` returns as soon as the delegate starts, so its own payload says
  // `running` forever. Treating that as "no status" made every card claim
  // `completed` the moment the fan-out began.
  assert.match(topologySource, /const DELEGATION_STATUSES = new Set<SubagentOutcome>\(\[\s*\n\s*"running",/);
  assert.match(topologySource, /export function collectDelegationStatuses\(/);
  // TaskWait/TaskList report `details.delegations[]`; TaskStop reports
  // `details.stopped[]`. Later rows settle what earlier ones reported as running.
  assert.match(topologySource, /payload\.delegations/);
  assert.match(topologySource, /payload\.stopped/);
  assert.match(topologySource, /statuses\.set\(id, status\)/);
  assert.match(topologySource, /turnLive/);
  assert.match(
    topologySource,
    /const settled = statuses\?\.get\(delegationId\);\s*\n\s*if \(settled\) return settled;/,
  );
  // The lifecycle rows are still excluded from the topology's node count.
  assert.match(topologySource, /if \(isDelegationActivityItem\(item\)\) continue;/);
  assert.match(
    transcriptSource,
    /const delegationStatuses = useMemo\(\(\) => turnDelegationStatuses \?\? collectDelegationStatuses\(items\)/,
  );
  // Delegates remain live across replies split by steering in the same runtime turn.
  assert.match(
    transcriptSource,
    /collectDelegationStatuses\(delegationItems, \{ turnLive: isActive \|\| delegationsLive === true \}\)/,
  );
  assert.match(transcriptSource, /const tools = reuseReferences\(toolsRef\.current, summary\.tools\)/);
  assert.match(transcriptSource, /delegationItems = useMemo\(\(\) => tools\.map/);
});

test("a lifecycle row summarizes by agent name, never by delegation id", () => {
  // Superseded the `delegationIds` summary (D268): the ids a lifecycle row is
  // called with are bare UUIDs, so the row reads the roster the runtime
  // returned and names the subagents instead.
  assert.match(toolDisplaySource, /delegate: \["description", "agent"\]/);
  assert.doesNotMatch(toolDisplaySource, /"delegationIds"/);
  assert.doesNotMatch(toolDisplaySource, /"delegationids"/);
  assert.match(toolDisplaySource, /function summaryText\(value: unknown\): string/);
  assert.match(toolDisplaySource, /Array\.isArray\(value\) && value\.every\(/);
  assert.doesNotMatch(toolDisplaySource, /record\[key\] as string/);
  // The roster is read from both payload shapes the lifecycle tools return.
  assert.match(topologySource, /export function delegationRoster\(/);
  assert.match(topologySource, /Array\.isArray\(payload\.stopped\)/);
  // A repeated definition is counted rather than listed twice.
  assert.match(topologySource, /count > 1 \? `\$\{name\} ×\$\{count\}` : name/);
  // The row's badge rolls the roster up with the shared status vocabulary.
  assert.match(
    transcriptSource,
    /rosterOutcome\s*\n?\s*\? t\(`chat\.subagentStatus\.\$\{rosterOutcome\}`\)/,
  );
  // A lifecycle row is presented as a subagent row, not as "Delegated".
  assert.match(transcriptSource, /LIFECYCLE_RUNNING_KEYS\s*\n?\s*: LIFECYCLE_LABEL_KEYS\)\[lifecycle\]/);
  // It never falls back to its own arguments, so a pending wait shows no ids.
  assert.match(transcriptSource, /: lifecycle \? rosterSummary : argSummary;/);
  // ...and it is still not a topology node.
  assert.match(topologySource, /if \(isDelegationActivityItem\(item\)\) continue;/);
});

test("a live delegate row keeps the attribution its stream carried", () => {
  // Without these the row would render as a top-level tool call until the
  // session was reloaded from host-core.
  assert.match(
    storeSource,
    /envelope\.parentToolCallId\n\s+\? \{ parentToolCallId: envelope\.parentToolCallId \}/,
  );
  assert.match(storeSource, /envelope\.agentName \? \{ agentName: envelope\.agentName \}/);
});

test("a terminal tool event repairs a row lost during renderer reload", () => {
  assert.match(sessionRuntimeSource, /const toolStartsByCallId = new Map/);
  assert.match(eventsSource, /const existing = state\.messages\.some\(/);
  assert.match(
    eventsSource,
    /messages: existing\s*\? state\.messages\.map\([\s\S]*?: \[\.\.\.state\.messages, completed\]/,
  );
  assert.match(eventsSource, /toolDurationMs: toolStart\s*\n\s*\? Math\.max/);
  assert.match(eventsSource, /toolName: message\.toolName \?\? completed\.toolName/);
});

test("inline delegate runs keep the live conversation process", () => {
  assert.match(transcriptSource, /delegate\?: SubagentRun/);
  assert.match(transcriptSource, /<SubagentRunRows/);
  assert.match(transcriptSource, /open && hasDetails && disclosure.parentVisible/);
  assert.match(transcriptSource, /className=\{`subagent-run-rows\$\{scrollable \? "" : " is-panel-flow"\}`\}/);
  assert.match(transcriptSource, /onScroll=\{scrollable \? handleScroll : undefined\}/);
  assert.match(transcriptSource, /\{scrollable && showJump \?/);
});

test("a Task row is expandable and names the delegate it used", () => {
  assert.match(
    transcriptSource,
    /hasToolDetails\(message\) \|\| Boolean\(delegate\)/,
  );
  assert.match(transcriptSource, /TOOL_ACTION_KEYS.*delegate: "chat\.toolDelegated"/s);
  assert.match(transcriptSource, /TOOL_RUNNING_KEYS.*delegate: "chat\.toolDelegating"/s);
  assert.match(transcriptSource, /className="tool-row-agent"/);
  assert.match(transcriptSource, /case "delegate":\n\s+return <IconBot/);
});

test("effective model metadata stays recorded and is presented in task details", () => {
  assert.match(runtimeSource, /const record: DelegationRecord = \{[^}]*modelId: provider\.modelId,/);
  assert.match(tabSource, /delegateModelId\(selected.message\)/);
  assert.match(tabSource, /className="subagent-transcript-model"/);
  assert.doesNotMatch(transcriptSource, /subagent-topology-node-model/);
  assert.match(toolPresentationSource, /key !== "agent" &&[\s\S]*?key !== "error" &&[\s\S]*?key !== "modelId" &&[\s\S]*?key !== "thinkingLevel"/);
});

test("the task detail shows the effective thinking level, not a disabled picker", () => {
  assert.match(runtimeSource, /modelId: provider\.modelId,\s*\n\s*thinkingLevel,/);
  assert.match(runtimeSource, /modelId: record\.modelId,\s*\n\s*thinkingLevel: record\.thinkingLevel,/);
  assert.match(transcriptSource, /function delegateThinkingLevel\(message: UiMessage\)/);
  assert.match(tabSource, /delegateThinkingLevel\(selected.message\)/);
  assert.doesNotMatch(tabSource, /aria-haspopup="listbox"/);
});

test("the report is printed once: in the body, or as the nested answer", () => {
  assert.match(
    transcriptSource,
    /const nestedReport = delegate\?\.items\.some\(\(item\) => item\.kind === "answer"\)/,
  );
  assert.match(
    transcriptSource,
    /\.\.\.\(nestedReport \? \{ hideDelegateReport: true \} : \{\}\)/,
  );
});

test("memoized activity rows compare delegate runs by their rows", () => {
  // Runs are rebuilt on every message change, so an identity check would
  // freeze a streaming delegate's rows.
  assert.match(
    transcriptSource,
    /function activityItemsEqual\([\s\S]*?subagentRunsEqual\(previous\.delegate, next\.delegate\)/,
  );
  assert.equal(transcriptSource.match(/activityItemsEqual\(/g)?.length, 3);
});

test("the nested run is visibly one level inside the call", () => {
  // D297: the run is a soft tile; the collapse rail draws nothing at rest and
  // only shows its bar as a hover/focus affordance.
  assert.match(messagesCss, /\.subagent-run \{[^}]*background: var\(--ds-tile\)/);
  assert.match(
    messagesCss,
    /\.disclosure-collapse-rail::before \{[^}]*background: transparent/,
  );
  assert.doesNotMatch(messagesCss, /\.subagent-run > \.disclosure-collapse-rail::before/);
  assert.match(messagesCss, /\.subagent-run \{[^}]*margin: 2px 0 8px 24px/);
  assert.match(messagesCss, /\.subagent-run-count \{[^}]*margin-inline-start: auto/);
  assert.match(messagesCss, /\.tool-row-agent \{/);
});

test("every task uses the same accessible list rather than a coordinator graph", () => {
  assert.match(transcriptSource, /<SubagentTaskList/);
  assert.match(transcriptSource, /className="subagent-task-row" role="listitem"/);
  assert.match(transcriptSource, /role="list"/);
  assert.match(transcriptSource, /className="subagent-task-open"/);
  assert.match(transcriptSource, /openTabForSession\(sessionId, subagentWorkPanelTab\(id, title\)\)/);
  assert.doesNotMatch(transcriptSource, /subagent-topology-root|variant="topology"/);
});

test("legacy lifecycle labels retain correct singular and plural wording", () => {
  for (const [locale, source] of [
    ["en", englishCatalogSource],
    ["zh-CN", chineseCatalogSource],
    ["tr", turkishCatalogSource],
  ]) {
    for (const key of [
      "subagentsWorking",
      "subagentsFinished",
      "subagentsFinishedWithIssues",
      "subagentsFinishedWithWarnings",
    ]) {
      assert.match(source, new RegExp(`\\n\\s*${key}_one: "`), `${locale} ${key}_one`);
      assert.match(
        source,
        new RegExp(`\\n\\s*${key}_other: "`),
        `${locale} ${key}_other`,
      );
      // A bare key would win over the plural forms and bring the plural copy
      // back for a single delegation.
      assert.doesNotMatch(source, new RegExp(`\\n\\s*${key}: "`), `${locale} ${key}`);
    }
  }
  assert.match(englishCatalogSource, /subagentsWorking_one: "Subagent working"/);
  assert.match(englishCatalogSource, /subagentsWorking_other: "Subagents working"/);
});

test("task lists use identity colors, outcome text, and visible keyboard focus", () => {
  assert.match(messagesCss, /\.subagent-task-open:focus-visible/);
  assert.match(messagesCss, /--task-identity: var\(--ds-task-lavender\)/);
  assert.match(messagesCss, /data-outcome="failed"/);
  assert.match(messagesCss, /@container subagent-tasks/);
  assert.doesNotMatch(messagesCss, /\.subagent-topology/);
});

test("a delegate's rows scroll in place instead of growing the page (D271)", () => {
  // The rows live in their own scroll container, not on `.subagent-run`: the
  // collapse rail is absolutely positioned outside that element's padding box,
  // so an overflow there would clip the rail away.
  assert.match(transcriptSource, /subagent-run-rows/);
  // The scroll area is named by the run heading beside it rather than by a
  // duplicated label string.
  assert.match(
    transcriptSource,
    /className=\{`subagent-run-rows\$\{scrollable \? "" : " is-panel-flow"\}`\}[\s\S]*?role="group"[\s\S]*?tabIndex=\{scrollable \? 0 : undefined\}[\s\S]*?aria-labelledby=\{headingId\}/,
  );
  assert.match(
    transcriptSource,
    /className=\{dock \? "subagent-run-heading is-dock" : "subagent-run-heading"\}[\s\S]*?id=\{headingId\}/,
  );
  assert.match(
    messagesCss,
    /\.subagent-run-rows \{[^}]*max-height: min\(420px, 48dvh\)/,
  );
  assert.match(messagesCss, /\.subagent-run-rows \{[^}]*overflow-y: auto/);
  assert.match(
    messagesCss,
    /\.subagent-run-rows \{[^}]*overscroll-behavior-y: contain/,
  );
  assert.match(
    messagesCss,
    /\.subagent-run-rows \{[^}]*overflow-anchor: none/,
  );
  // A keyboard user can reach the scroll area the pointer already can.
  assert.match(messagesCss, /\.subagent-run-rows:focus-visible \{/);
  // `.subagent-run` itself must stay unclipped so the rail survives.
  assert.doesNotMatch(messagesCss, /\.subagent-run \{[^}]*overflow/);
  // Every field table is bounded too, so a long roster scrolls as well.
  assert.match(messagesCss, /\.tool-fields \{[^}]*max-height: 260px/);
  assert.match(messagesCss, /\.tool-fields \{[^}]*overflow: auto/);
});

test("an expanded delegate run follows the latest output while pinned (D302)", () => {
  // Nested follow is a dedicated hook so the main transcript's history,
  // veil, and pane-visibility machinery stay out of the run scroller.
  assert.match(transcriptSource, /function SubagentRunFollow\(/);
  assert.match(transcriptSource, /const \{[^}]*scrollRef,[^}]*\} = useFollowScroll\(\)/);
  assert.match(
    transcriptSource,
    /<SubagentRunFollow[\s\S]*?headingId=\{headingId\}[\s\S]*?items=\{run\.items\}/,
  );
  assert.match(
    transcriptSource,
    /className=\{`subagent-run-rows\$\{scrollable \? "" : " is-panel-flow"\}`\}[\s\S]*?onScroll=\{scrollable \? handleScroll : undefined\}/,
  );
  assert.match(transcriptSource, /className="subagent-run-follow"/);
  assert.match(
    transcriptSource,
    /className="jump-latest-btn"[\s\S]*?onClick=\{jumpToLatest\}/,
  );

  assert.match(followScrollSource, /export function useFollowScroll\(/);
  assert.match(followScrollSource, /reduceTranscriptScroll\(/);
  assert.match(followScrollSource, /isRecentScrollGesture\(/);
  assert.match(
    followScrollSource,
    /const followScrollNow = useCallback\(\(\) => \{[\s\S]{0,400}?if \(!pinnedRef\.current\) return;\s*cancelFollowScroll\(\);\s*scrollToBottom\(\);/,
  );
  assert.match(followScrollSource, /new ResizeObserver\(followScrollNow\)/);
  assert.doesNotMatch(
    followScrollSource,
    /new ResizeObserver\(scheduleFollowScroll\)/,
  );

  // The jump control overlays the bounded scroller; overflow stays off
  // `.subagent-run` so the collapse rail is not clipped.
  assert.match(messagesCss, /\.subagent-run-follow \{[^}]*position: relative/);
  assert.match(
    messagesCss,
    /\.subagent-run-follow > \.jump-latest-btn \{[^}]*bottom: 8px/,
  );
  assert.doesNotMatch(messagesCss, /\.subagent-run \{[^}]*overflow/);
});

test("task status remains live even when the parent executes another activity", () => {
  assert.match(transcriptSource, /const live = isActive \|\| subagentSummary.running > 0/);
  assert.match(transcriptSource, /subagentTaskOutcome\(message, statuses\)/);
  assert.match(transcriptSource, /delegateItems.length > 0\) return <>\{renderedItems\}/);
});
