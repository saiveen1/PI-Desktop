import { readAppSource, readStoreSource, readTranscriptSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const tabSource = await readFile(
  new URL("../src/components/workpanel/SubagentTranscriptTab.tsx", import.meta.url),
  "utf8",
);
const composerSource = await readFile(
  new URL("../src/components/workpanel/SubagentChildComposer.tsx", import.meta.url), "utf8",
);
const toolRowSource = await readFile(
  new URL("../src/features/chat/transcript/SubagentTaskList.tsx", import.meta.url),
  "utf8",
);
const retryButtonSource = await readFile(
  new URL("../src/features/chat/transcript/SubagentRetryButton.tsx", import.meta.url),
  "utf8",
);
const workPanelSource = await readFile(
  new URL("../src/components/workpanel/WorkPanel.tsx", import.meta.url),
  "utf8",
);
const tabsSource = await readFile(
  new URL("../src/lib/work-panel-tabs.ts", import.meta.url),
  "utf8",
);
const appSource = await readAppSource();
const transcriptSource = await readTranscriptSource();
const storeSource = await readStoreSource();
const workPanelCss = await readFile(
  new URL("../src/styles/work-panel.css", import.meta.url),
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


test("a task list row opens the originating session's subagent tab", () => {
  assert.match(toolRowSource, /openTabForSession\(sessionId, subagentWorkPanelTab\(id, title\)\)/);
  assert.match(toolRowSource, /useChatSessionCapability\("canUseLocalTools"\)/);
  assert.match(toolRowSource, /if \(!localToolsAllowed\) return/);
  assert.match(storeSource, /openSubagentTab: \(delegationId, agentName\) => \{/);
  assert.match(
    storeSource,
    /openWorkPanelTab\(subagentWorkPanelTab\(id, agentName \|\| undefined\)\)/,
  );
  // The overlay state and its actions are gone: closing happens per tab.
  assert.doesNotMatch(storeSource, /subagentPanel/);
  assert.doesNotMatch(storeSource, /toggleSubagentPanel|closeSubagentPanel/);
  assert.match(tabsSource, /\| "plugin"\s*\|\s*"subagent";/);
  assert.match(
    tabsSource,
    /export function subagentWorkPanelTab\(\s*delegationId: string,\s*agentName\?: string,\s*\): WorkPanelTab \{/,
  );
  assert.match(tabsSource, /id: `subagent:\$\{delegationId\}`/);
  assert.match(tabsSource, /tab\.kind === "subagent"\)/);
  // Retained runtime state must survive the session-switch sanitizer.
  assert.match(tabsSource, /export function subagentTabDisplayLabels\(/);
  assert.match(tabsSource, /tab\.kind === "subagent"\)/);
  // Retained runtime state must survive the session-switch sanitizer.
  assert.match(tabsSource, /export function subagentTabDisplayLabels\(/);
});
test("failed task rows expose a direct local subagent retry", () => {
  assert.match(toolRowSource, /SubagentRetryButton/);
  assert.match(toolRowSource, /failed=\{outcome === "failed"\}/);
  assert.match(retryButtonSource, /api\.retrySubagent\(\{ sessionId, delegationId \}\)/);
  assert.match(retryButtonSource, /source === "remote" \|\| source === "pi-native"/);
});


test("the work panel renders the delegation tab like every other resource", () => {
  assert.match(workPanelSource, /subagent: IconBot/);
  assert.match(workPanelSource, /if \(tab\.kind === "subagent"\) return tab\.label \?\? t\("panel\.tabs\.subagent"\);/);
  assert.match(workPanelSource, /const subagentTabsInOrder = tabs\.filter\(\(tab\) => tab\.kind === "subagent"\)/);
  assert.match(workPanelSource, /subagentTabDisplayLabels\(/);
  assert.match(workPanelSource, /\{activeTab\?\.kind === "subagent" && \(/);
  assert.match(
    workPanelSource,
    /<SubagentTranscriptTab delegationId=\{activeTab\.resource \?\? ""\} \/>/,
  );
  // The tab strip is never replaced by a dock heading or a back control.
  assert.doesNotMatch(workPanelSource, /work-panel-subagent-heading|work-panel-subagent-back/);
  assert.doesNotMatch(workPanelSource, /subagentPanel\?: SubagentPanelSelection/);
  assert.doesNotMatch(workPanelSource, /!subagentPanel &&/);
  // The shell no longer overrides visibility for a dock-only surface.
  assert.match(appSource, /const workPanelVisible = workPanelOpen;/);
  assert.doesNotMatch(appSource, /subagentPanelOpen/);
});

test("the detail combines shared reading components with explicit child input", () => {
  assert.match(tabSource, /data-testid="subagent-transcript-tab"/);
  assert.match(tabSource, /buildSubagentTranscript\(messages, delegationId\)/);
  assert.match(tabSource, /<SubagentTurnContent/);
  assert.match(tabSource, /<SubagentTaskList/);
  assert.match(tabSource, /className="subagent-transcript-model"/);
  assert.match(tabSource, /<SubagentStopButton/);
  assert.match(tabSource, /<SubagentRetryButton/);
  assert.match(tabSource, /TranscriptSearchContext.Provider/);
  assert.match(tabSource, /<SubagentChildComposer sessionId=\{sessionId\} chainId=\{transcriptResult\?\.chainId \?\? delegationId\}/);
  assert.match(tabSource, /delegationId=\{recordedId\} outcome=\{outcome\}/);
  assert.match(composerSource, /<Textarea rows=\{2\}/);
  assert.match(composerSource, /api\.sendSubagentMessage/);
  assert.match(composerSource, /<Button variant="primary"/);
  assert.doesNotMatch(composerSource, /onKeyDown|onKeyPress/);
  assert.doesNotMatch(tabSource, /<Textarea|aria-haspopup="listbox"|onSubmit|onSend|api\.send/);
  assert.match(workPanelCss, /\.subagent-transcript-composer-controls \{/);
});

test("the task policy snapshot is wired into the actual transcript tab", () => {
  assert.match(tabSource, /<SubagentRunPolicySummary payload=\{payload\} \/>/);
  assert.match(tabSource, /<SubagentFailurePolicySummary payload=\{payload\} \/>/);
  assert.match(tabSource, /toolResultPayload\(selected.message\)/);
  assert.match(tabSource, /transcriptResult\?\.latestCall/);
  assert.doesNotMatch(tabSource, /state\.settings|resolveDelegationRunPolicy/);
});

test("the tab owns one scroll surface and pins to the latest output", () => {
  assert.match(workPanelCss, /\.subagent-transcript-tab \{[^}]*flex-direction: column/);
  assert.match(workPanelCss, /\.subagent-transcript-scroll \{[^}]*overflow-y: auto/);
  assert.match(tabSource, /useFollowScroll\(\)/);
  assert.match(tabSource, /ref=\{scrollRef\}/);
  assert.match(tabSource, /onScroll=\{handleScroll\}/);
  assert.match(tabSource, /onClick=\{jumpToLatest\}/);
  assert.match(tabSource, /role="log"/);
  assert.match(tabSource, /aria-live="polite"/);
  assert.match(tabSource, /tabIndex=\{0\}/);
  assert.match(tabSource, /useTranscriptSearchFocus\(\{/);
});

test("child composer localization is wired into both primary catalogs", () => {
  for (const [locale, source] of [
    ["en", englishCatalogSource],
    ["zh-CN", chineseCatalogSource],
  ]) {
    assert.match(source, /import \{ subagentControls \} from "\.\/subagent-controls\.js"/);
    assert.match(source, /tabs: \{[^}]*subagent: "/s);
    assert.doesNotMatch(source, /subagentClose/);
  }
});
