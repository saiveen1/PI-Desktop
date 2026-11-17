import type {
  ContextCompactionRecord,
  SessionDetail,
  SessionSummary,
  UiMessage,
} from "@pi-desktop/shared";
import {
  contextCompactionMark,
  initialThinkingLevelForBinding,
  initialThinkingLevelForUnmatchedModel,
  normalizeMode,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { sameComposerModelId } from "../../lib/composer-models";
import { scheduleHomeDraftAdopt } from "../../lib/composer-draft-cache";
import {
  commitForkedSessionState,
  forkedSessionMessages,
  FORKED_SESSION_WINDOW,
} from "../../lib/session-fork";
import { EMPTY_SESSION_WINDOW, type SessionCreationGroup } from "../../lib/session-create";
import { inheritedSessionModelBinding } from "../../lib/session-model";
import { sessionOrganizationScope } from "../../lib/session-organization";
import {
  clearSessionPanes,
  retainSessionPane,
} from "../../lib/session-panes";
import {
  sessionIsArchived,
  sessionIsPinned,
} from "../../lib/sidebar-preferences";
import type { AppState, DraftSessionConfiguration } from "../app-state";
import type { SessionRuntime } from "./session-runtime";
import type { StoreAccess } from "../slices/types";
import { persistCreatedSessionGroup } from "../helpers/store-helpers";
import { switchWorkPanelSession } from "../slices/work-panel-slice";

export type PersistSessionOptions = {
  intent?: number;
  projectPath?: string | null;
  draftConfiguration?: DraftSessionConfiguration | null;
  /** Run the new session in its own git worktree (ADR 0329). */
  isolated?: boolean;
  group?: SessionCreationGroup;
};

type ForkOptions = { source: SessionSummary; activate: boolean; clearError?: boolean };

export type SessionCoordination = {
  flushPendingSessionConfiguration: (sessionId: string) => Promise<void>;
  rememberSessionCompactions: (
    sessionId: string,
    session:
      | {
          compaction?: ContextCompactionRecord;
          compactions?: ContextCompactionRecord[];
        }
      | null
      | undefined,
  ) => void;
  commitForkedSession: (
    session: SessionDetail,
    options: ForkOptions,
  ) => void;
  persistSessionAndSelect: (
    options?: PersistSessionOptions,
  ) => Promise<string | null>;
  materializeDraftSession: (intent?: number) => Promise<string | null>;
};

export type SessionCoordinationDependencies = StoreAccess & {
  runtime: SessionRuntime;
  decorateSessions: (
    sessions: SessionSummary[],
    meta: AppState["sessionMeta"],
  ) => SessionSummary[];
  withoutRecordKey: <T>(record: Record<string, T>, key: string) => Record<string, T>;
  untitledTaskTitle: () => string;
};

export function createSessionCoordination({
  get,
  set,
  runtime,
  decorateSessions,
  withoutRecordKey,
  untitledTaskTitle,
}: SessionCoordinationDependencies): SessionCoordination {
  let pendingGroupedDraft: { intent: number; result: () => Promise<string | null> } | undefined;

  function flushPendingSessionConfiguration(sessionId: string): Promise<void> {
    const active = runtime.sessionConfigurationFlushes.get(sessionId);
    if (active) return active;
    if (get().runningSessions[sessionId]) return Promise.resolve();

    const flush = (async () => {
      let failed = false;
      while (!get().runningSessions[sessionId]) {
        const config = runtime.pendingSessionConfigurations.get(sessionId);
        if (!config) break;
        try {
          const result = await api.configureSession(sessionId, config);
          if (runtime.pendingSessionConfigurations.get(sessionId) === config) {
            runtime.pendingSessionConfigurations.delete(sessionId);
          }
          set((state) => ({
            sessions: state.sessions.map((session) =>
              session.id === sessionId
                ? {
                    ...result.session,
                    pinned: sessionIsPinned(sessionId, state.sessionMeta),
                    archived: sessionIsArchived(sessionId, state.sessionMeta),
                  }
                : session,
            ),
            planningStates: {
              ...state.planningStates,
              [sessionId]:
                result.session.mode === "plan" ? "planning" : "inactive",
            },
          }));
        } catch (error) {
          get().showToast(
            error instanceof Error ? error.message : String(error),
            { variant: "error" },
          );
          void get().refreshSessions();
          if (runtime.pendingSessionConfigurations.get(sessionId) !== config) {
            continue;
          }
          failed = true;
          break;
        }
      }
      return failed;
    })();
    const settled = flush.then(() => undefined);
    runtime.sessionConfigurationFlushes.set(sessionId, settled);
    void flush.then((failed) => {
      if (runtime.sessionConfigurationFlushes.get(sessionId) === settled) {
        runtime.sessionConfigurationFlushes.delete(sessionId);
      }
      if (
        !failed &&
        runtime.pendingSessionConfigurations.has(sessionId) &&
        !get().runningSessions[sessionId]
      ) {
        void flushPendingSessionConfiguration(sessionId);
      }
    });
    return settled;
  }

  function rememberSessionCompactions(
    sessionId: string,
    session:
      | {
          compaction?: ContextCompactionRecord;
          compactions?: ContextCompactionRecord[];
        }
      | null
      | undefined,
  ): void {
    const records =
      session?.compactions ??
      (session?.compaction ? [session.compaction] : []);
    const marks = records.map((record) => ({ ...contextCompactionMark(record), summary: record.summary }));
    set((state) => ({
      sessionCompactions:
        marks.length > 0
          ? { ...state.sessionCompactions, [sessionId]: marks }
          : withoutRecordKey(state.sessionCompactions, sessionId),
    }));
  }

  function commitForkedSession(
    session: SessionDetail,
    options: ForkOptions,
  ): void {
    const { messages: _forkedMessages, ...summary } = session;
    const messages = forkedSessionMessages(session);
    const historyWindow = { ...FORKED_SESSION_WINDOW };
    runtime.cacheSessionTranscript(summary.id, messages, historyWindow);
    const state = get();
    const groupId = state.sessionMeta[options.source.id]?.groupId;
    const sessionMeta = persistCreatedSessionGroup(state, summary, groupId ? {
      scope: sessionOrganizationScope(options.source, state.sidebarProjectGroups ?? []), id: groupId,
    } : undefined);
    set((current) => {
      const commit = commitForkedSessionState(current, summary, {
        activate: options.activate,
      });
      const shared: Partial<AppState> = {
        sessionMeta,
        sessions: decorateSessions(commit.sessions, sessionMeta),
        sessionHistory: {
          ...current.sessionHistory,
          [summary.id]: historyWindow,
        },
        planningStates: {
          ...current.planningStates,
          [summary.id]: summary.mode === "plan" ? "planning" : "inactive",
        },
        ...(options.clearError ? { error: null, errorCode: null } : {}),
      };
      if (!commit.activated) return shared;
      return {
        ...switchWorkPanelSession(current, summary.id),
        ...shared,
        ...retainSessionPane(current, summary.id, messages),
        activeSessionId: summary.id,
        selectingSessionId: undefined,
        messages,
        page: "chat" as const,
        isRunning: false,
        navStack: commit.navStack as AppState["navStack"],
        navIndex: commit.navIndex,
      };
    });
    rememberSessionCompactions(summary.id, session);
    void get().restorePendingPlan(summary.id);
    void get().restorePendingInteractive(summary.id);
  }

  function revealEmptyCreatingSession(intent: number): void {
    if (!runtime.navigationIntentIsCurrent(intent)) return;
    set((state) => {
      if (
        !state.activeSessionId &&
        state.page === "chat" &&
        state.messages.length === 0 &&
        state.retainedSessionIds.length === 0
      ) {
        return {};
      }
      return {
        ...switchWorkPanelSession(state, undefined),
        ...clearSessionPanes(),
        activeSessionId: undefined,
        selectingSessionId: undefined,
        messages: [],
        page: "chat" as const,
        isRunning: false,
      };
    });
  }

  function commitCreatedEmptySession(
    summary: SessionSummary,
    options: { activate: boolean; group?: SessionCreationGroup },
  ): void {
    const messages: UiMessage[] = [];
    runtime.cacheSessionTranscript(summary.id, messages, EMPTY_SESSION_WINDOW);
    if (options.activate) scheduleHomeDraftAdopt(summary.id);
    const sessionMeta = persistCreatedSessionGroup(get(), summary, options.group);
    set((current) => {
      const commit = commitForkedSessionState(current, summary, {
        activate: options.activate,
      });
      const shared: Partial<AppState> = {
        sessionMeta,
        sessions: decorateSessions(commit.sessions, sessionMeta),
        sessionHistory: {
          ...current.sessionHistory,
          [summary.id]: EMPTY_SESSION_WINDOW,
        },
        planningStates: {
          ...current.planningStates,
          [summary.id]: summary.mode === "plan" ? "planning" : "inactive",
        },
      };
      if (!commit.activated) return shared;
      return {
        ...switchWorkPanelSession(current, summary.id),
        ...shared,
        ...retainSessionPane(current, summary.id, messages),
        activeSessionId: summary.id,
        selectingSessionId: undefined,
        draftConfiguration: null,
        messages,
        page: "chat" as const,
        isRunning: current.runningSessions[summary.id] ?? false,
        navStack: commit.navStack as AppState["navStack"],
        navIndex: commit.navIndex,
      };
    });
  }

  async function persistGroupedSessionAndSelect(options: PersistSessionOptions & { intent: number }): Promise<string | null> {
    // Own the empty home draft before revealing it, including synchronous store listeners.
    const pending = { intent: options.intent, result: () => Promise.resolve().then(() => request) };
    pendingGroupedDraft = pending;
    const request = persistSessionAndSelect(options);
    try {
      return await request;
    } finally {
      if (pendingGroupedDraft === pending) pendingGroupedDraft = undefined;
    }
  }

  async function persistSessionAndSelect(
    options: PersistSessionOptions = {},
  ): Promise<string | null> {
    const active = options.intent ?? runtime.beginNavigationIntent();
    const state = get();
    const settings = state.settings;
    const projectPath =
      options && "projectPath" in options
        ? options.projectPath
        : state.workspace?.path ?? null;
    const draftConfig =
      options && "draftConfiguration" in options
        ? options.draftConfiguration
        : state.draftConfiguration;
    const inherited = inheritedSessionModelBinding({
      draft: draftConfig,
      settings,
      providers: state.providers,
      recentModels: state.recentModels,
      discovered: state.providers.flatMap((candidate) => state.providerModels[candidate.id] ?? []),
    });
    const defaultProvider = state.providers.find(
      (provider) => provider.id === inherited.providerId,
    );
    const inheritedBinding = defaultProvider?.models.find((candidate) =>
      sameComposerModelId(candidate.id, inherited.modelId ?? ""),
    );
    const catalogModel = inherited.providerId && inherited.modelId
      ? state.providerModels[inherited.providerId]?.find((candidate) =>
          sameComposerModelId(candidate.modelId, inherited.modelId ?? ""),
        )
      : undefined;
    const defaultThinkingLevel = catalogModel?.catalogSource === "models.dev"
      ? initialThinkingLevelForBinding(
          inheritedBinding,
          defaultProvider?.supportedThinkingLevels,
        )
      : initialThinkingLevelForUnmatchedModel(
          inheritedBinding,
          defaultProvider?.supportedThinkingLevels,
        );
    const previousSessionId = state.activeSessionId;
    revealEmptyCreatingSession(active);
    let created: Awaited<ReturnType<typeof api.createSession>>;
    try {
      created = await api.createSession({
        title: untitledTaskTitle(),
        mode: draftConfig?.mode ?? normalizeMode(settings?.defaultMode),
        thinkingLevel: draftConfig?.thinkingLevel ?? defaultThinkingLevel,
        permissionMode: draftConfig?.permissionMode,
        ...(draftConfig?.fastMode ? { fastMode: true } : {}),
        providerId: inherited.providerId,
        modelId: inherited.modelId,
        projectPath: projectPath ?? undefined,
        ...(options.isolated ? { isolated: true } : {}),
      });
    } catch (error) {
      if (previousSessionId && runtime.navigationIntentIsCurrent(active)) {
        void get().selectSession(previousSessionId, {
          navigationIntent: active,
        });
      }
      throw error;
    }
    const sessionId = created.session.id;
    if (!runtime.navigationIntentIsCurrent(active)) {
      commitCreatedEmptySession(created.session, { activate: false, group: options.group });
      return null;
    }
    commitCreatedEmptySession(created.session, { activate: true, group: options.group });
    return sessionId;
  }

  async function materializeDraftSession(
    intent?: number,
  ): Promise<string | null> {
    const grouped = pendingGroupedDraft;
    if (grouped && (intent === undefined || intent === grouped.intent) && runtime.navigationIntentIsCurrent(grouped.intent)) {
      return grouped.result();
    }
    const state = get();
    const scopeKey = runtime.newSessionScopeKey(state.workspace?.path ?? null);
    const pending = runtime.pendingNewSessionRequests.get(scopeKey);
    if (pending) {
      return await pending;
    }
    const request = persistSessionAndSelect({ intent });
    runtime.pendingNewSessionRequests.set(scopeKey, request);
    try {
      return await request;
    } finally {
      if (runtime.pendingNewSessionRequests.get(scopeKey) === request) {
        runtime.pendingNewSessionRequests.delete(scopeKey);
      }
    }
  }

  return {
    flushPendingSessionConfiguration,
    rememberSessionCompactions,
    commitForkedSession,
    persistSessionAndSelect: (options) => options?.group && options.intent !== undefined
      ? persistGroupedSessionAndSelect({ ...options, intent: options.intent })
      : persistSessionAndSelect(options),
    materializeDraftSession,
  };
}
