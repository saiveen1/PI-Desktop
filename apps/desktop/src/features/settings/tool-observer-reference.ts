import type { ToolObservation, ToolObservationGroup, ToolObservationReport } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import type { AppState } from "../../stores/app-state";
import { markComposerDraftEdited, readComposerDraft, writeComposerDraft } from "../../lib/composer-draft-cache";
import { TOOL_OBSERVER_OUTCOMES } from "./tool-observer-report";

export const TOOL_OBSERVER_REFERENCE_LIMIT = 12_000;
export const TOOL_OBSERVER_EXAMPLE_LIMIT = 3;

/** Telemetry labels are data, not Markdown or instructions. */
export function toolObserverLabel(value: string | undefined): string | undefined {
  return value?.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 160);
}

/** Explicit allowlist: never serialize a report or example object wholesale. */
export function toolObserverExample(example: ToolObservation) {
  return {
    id: toolObserverLabel(example.id), timestamp: toolObserverLabel(example.timestamp),
    toolName: toolObserverLabel(example.toolName), outcome: example.outcome,
    desktopPlatform: toolObserverLabel(example.desktopPlatform), appVersion: toolObserverLabel(example.appVersion),
    shellId: toolObserverLabel(example.shellId), errorCode: toolObserverLabel(example.errorCode),
    exitCode: example.exitCode, durationMs: example.durationMs,
    sessionId: toolObserverLabel(example.sessionId), turnId: toolObserverLabel(example.turnId),
    toolCallId: toolObserverLabel(example.toolCallId), backgroundTaskId: toolObserverLabel(example.backgroundTaskId),
    truncated: example.truncated,
  };
}

export function buildToolObservationReference(
  report: ToolObservationReport,
  group: ToolObservationGroup,
  copy: { title: string; request: string },
): { text: string; marker: string } | null {
  if (group.outcome === "success" || !report.groups.includes(group)) return null;
  const referenceId = `tool-observer:${toolObserverLabel(group.id)}`;
  const safeJson = (value: unknown) => JSON.stringify(value, null, 2).replace(/`/g, "\\u0060");
  const marker = `"referenceId": ${safeJson(referenceId)}`;
  const examples = group.examples.slice(0, TOOL_OBSERVER_EXAMPLE_LIMIT).map(toolObserverExample);
  const telemetry = {
    schemaVersion: 1, referenceId, generatedAt: toolObserverLabel(report.generatedAt),
    since: toolObserverLabel(report.since), days: report.days,
    total: report.total,
    counts: Object.fromEntries(TOOL_OBSERVER_OUTCOMES.map((outcome) => [outcome, report.counts[outcome]])),
    coverage: {
      filesRead: report.coverage.filesRead, malformedLines: report.coverage.malformedLines,
      ignoredLegacyRecords: report.coverage.ignoredLegacyRecords, limited: report.coverage.limited,
      readErrors: report.coverage.readErrors,
    },
    group: {
      id: toolObserverLabel(group.id), toolName: toolObserverLabel(group.toolName), outcome: group.outcome,
      desktopPlatform: toolObserverLabel(group.desktopPlatform), appVersion: toolObserverLabel(group.appVersion),
      shellId: toolObserverLabel(group.shellId), errorCode: toolObserverLabel(group.errorCode), exitCode: group.exitCode,
      count: group.count, sessionCount: group.sessionCount,
      firstSeen: toolObserverLabel(group.firstSeen), lastSeen: toolObserverLabel(group.lastSeen),
      examples,
    },
    examplesOmitted: group.examples.length - examples.length,
  };
  for (;;) {
    telemetry.examplesOmitted = group.examples.length - examples.length;
    const text = `${copy.title.slice(0, 240)}\n\n${copy.request.slice(0, 2_000)}\n\n\`\`\`json\n${safeJson(telemetry)}\n\`\`\``;
    if (new TextEncoder().encode(text).byteLength <= TOOL_OBSERVER_REFERENCE_LIMIT) return { text, marker };
    if (examples.length === 0) return null;
    examples.pop();
  }
}

type TargetState = Pick<AppState, "activeSessionId" | "activeProjectPath" | "workspace">;

export function toolObserverTarget(state: TargetState): string {
  return JSON.stringify([state.activeSessionId, state.activeProjectPath, state.workspace?.path, state.workspace?.remote]);
}

export function canReferenceToolObservations(state: AppState, target: string): boolean {
  const session = state.sessions.find((item) => item.id === state.activeSessionId);
  return state.settings?.developerMode === true && state.page === "settings"
    && toolObserverTarget(state) === target && !state.selectingSessionId && !state.composerPrefill
    && !state.workspace?.remote
    && Boolean(session && (!session.source || session.source === "desktop")
      && !session.remoteHostKey && !session.remoteWorkspace && !session.scheduledRun && !session.readOnlyReason
      && (!session.projectPath || session.projectPath === state.activeProjectPath));
}

/** Settings has unmounted Composer: its layout cleanup has cached text and chips. No send path is involved. */
export function referenceToolObservationGroup(
  target: string,
  report: ToolObservationReport,
  group: ToolObservationGroup,
  copy: { title: string; request: string },
): boolean {
  const reference = buildToolObservationReference(report, group, copy);
  if (!reference) return false;
  let added = false;
  useAppStore.setState((state) => {
    if (!canReferenceToolObservations(state, target) || !state.activeSessionId) return {};
    const sessionId = state.activeSessionId;
    const draft = readComposerDraft(sessionId);
    if (draft?.workspacePath !== undefined && draft.workspacePath !== state.workspace?.path) return {};
    if (draft?.text.includes(reference.marker)) return {};
    const next = {
      text: draft?.text ? `${draft.text}\n\n${reference.text}` : reference.text,
      fileReferences: (draft?.fileReferences ?? []).map((item) => ({ ...item })),
    };
    writeComposerDraft(sessionId, next, state.workspace?.path);
    markComposerDraftEdited(sessionId);
    added = true;
    return { composerPrefill: { ...next, sessionId } };
  });
  if (added) useAppStore.getState().setPage("chat");
  return added;
}
