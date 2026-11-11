import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { seedRunningSessionApi } from "./helpers/session-running-fixture.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "pi-running-state-"));
const entry = join(temp, "store.cjs");
await build({
  stdin: {
    contents: `
      export { useAppStore } from "./src/stores/app-store";
      export { api } from "./src/lib/api";
      export { sidebarSessionStatus } from "./src/lib/sidebar-session-status";
      export { PROTOCOL_VERSION } from "@pi-desktop/shared";
    `,
    resolveDir: join(root, "apps/desktop"),
    loader: "ts",
  },
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  define: { "import.meta.env.DEV": "false" },
});
after(() => rm(temp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
function harness(activeSessionId = "running") {
  delete require.cache[entry];
  const h = require(entry);
  const snapshot = seedRunningSessionApi(h.api, h.PROTOCOL_VERSION);
  h.useAppStore.setState({
    sessions: snapshot.sessions,
    activeSessionId,
    isRunning: activeSessionId === "running",
    runningSessions: { running: true },
  });
  const emit = (event, extra = {}) => h.useAppStore.getState().handleAgentEvent({
    sessionId: "running", turnId: "turn-1", ts: 1, event, ...extra,
  });
  const status = (isRunning, extra = {}) => emit({
    type: "status",
    status: {
      sessionId: "running", currentTurnId: "turn-1", isRunning,
      pendingToolConfirmations: 0,
      ...extra,
    },
  });
  const indicator = () => {
    const state = h.useAppStore.getState();
    return h.sidebarSessionStatus({
      running: state.runningSessions.running === true,
      selected: state.activeSessionId === "running",
      outcome: state.sessionOutcomes.running,
      hasPendingPermission: Boolean(state.pendingPermissions.running?.length),
    });
  };
  return { ...h, emit, status, indicator };
}

test("an idle runtime status clears a stale running marker without inventing an outcome", () => {
  const h = harness("idle");
  h.useAppStore.setState({ isRunning: true, runningSessions: { running: true, idle: true } });
  h.status(false);
  assert.equal(h.useAppStore.getState().runningSessions.running, false);
  assert.equal(h.useAppStore.getState().runningSessions.idle, true);
  assert.equal(h.useAppStore.getState().isRunning, true);
  assert.equal(h.indicator(), null);
  assert.deepEqual(h.useAppStore.getState().latestTurnResults, {});
  assert.deepEqual(h.useAppStore.getState().sessionOutcomes, {});
});

test("runtime status keeps the active composer and sidebar on the same run state", () => {
  const h = harness();
  h.status(false);
  assert.equal(h.useAppStore.getState().isRunning, false);
  assert.equal(h.indicator(), "selected");
  h.status(true);
  assert.equal(h.useAppStore.getState().isRunning, true);
  assert.equal(h.indicator(), "running");
});

test("idle status removes stale decision cards only for its owning session", () => {
  const h = harness("idle");
  h.useAppStore.setState({
    pendingPermissions: { running: [{ requestId: "p1" }], idle: [{ requestId: "p2" }] },
    pendingAsks: { running: [{ requestId: "a1" }], idle: [{ requestId: "a2" }] },
    askDrafts: { a1: { answers: [] }, a2: { answers: [] } },
  });
  h.status(false);
  const state = h.useAppStore.getState();
  assert.equal(state.pendingPermissions.running, undefined);
  assert.equal(state.pendingAsks.running, undefined);
  assert.equal(state.askDrafts.a1, undefined);
  assert.equal(state.pendingPermissions.idle.length, 1);
  assert.equal(state.pendingAsks.idle.length, 1);
  assert.ok(state.askDrafts.a2);
  assert.equal(h.indicator(), null);
});

test("a child status cannot change the parent run or its activity", () => {
  const h = harness();
  h.status(true, { activity: { phase: "waiting-subagents", since: 1 } });
  h.emit({ type: "status", status: {
    sessionId: "running", currentTurnId: "child-turn", isRunning: false,
    pendingToolConfirmations: 0,
  } }, { parentToolCallId: "task-1" });
  const state = h.useAppStore.getState();
  assert.equal(state.runningSessions.running, true);
  assert.equal(state.isRunning, true);
  assert.equal(state.agentStatuses.running.activity.phase, "waiting-subagents");
});

test("a delayed running status cannot relight a completed turn", () => {
  const h = harness();
  h.emit({ type: "agent_end", messageIds: [] });
  h.status(true);
  assert.equal(h.useAppStore.getState().isRunning, false);
  assert.equal(h.indicator(), "selected");
});

test("a stale idle status cannot stop a newer turn", () => {
  const h = harness();
  h.status(true);
  h.emit({ type: "agent_start" }, { turnId: "turn-2", ts: 2 });
  h.status(false);
  assert.equal(h.useAppStore.getState().isRunning, true);
  assert.equal(h.indicator(), "running");
});

test("backend loss clears local and native activity without clearing a remote session", () => {
  const h = harness();
  h.useAppStore.setState((state) => ({
    sessions: [...state.sessions,
      { id: "native-pi:one", source: "pi-native" },
      { id: "remote:one", source: "remote", remoteHostId: "host-1" },
    ],
    runningSessions: { running: true, "native-pi:one": true, "remote:one": true },
    pendingPermissions: { running: [{ requestId: "p1" }], "remote:one": [{ requestId: "p2" }] },
    pendingAsks: { running: [{ requestId: "a1" }] },
    askDrafts: { a1: { answers: [] } },
  }));
  h.status(true);
  h.useAppStore.getState().handleRuntimeUnavailable();
  const state = h.useAppStore.getState();
  assert.equal(state.isRunning, false);
  assert.equal(state.runningSessions.running, false);
  assert.equal(state.runningSessions["native-pi:one"], false);
  assert.equal(state.runningSessions["remote:one"], true);
  assert.equal(state.agentStatuses.running, undefined);
  assert.equal(state.pendingPermissions.running, undefined);
  assert.equal(state.pendingAsks.running, undefined);
  assert.equal(state.askDrafts.a1, undefined);
  assert.equal(state.pendingPermissions["remote:one"].length, 1);
  assert.equal(h.indicator(), "selected");
  assert.deepEqual(state.latestTurnResults, {});
});

test("backend loss does not unstick a still-running remote composer", () => {
  const h = harness("remote:one");
  h.useAppStore.setState((state) => ({
    sessions: [...state.sessions, { id: "remote:one", source: "remote" }],
    runningSessions: { running: true, "remote:one": true }, isRunning: true,
  }));
  h.useAppStore.getState().handleRuntimeUnavailable();
  assert.equal(h.useAppStore.getState().isRunning, true);
  assert.equal(h.useAppStore.getState().runningSessions.running, false);
});

test("a new turn can run after completion or backend recovery", () => {
  const h = harness();
  h.emit({ type: "agent_end", messageIds: [] });
  h.useAppStore.getState().handleRuntimeUnavailable();
  h.emit({ type: "agent_start" }, { turnId: "turn-2", ts: 2 });
  h.emit({ type: "status", status: {
    sessionId: "running", currentTurnId: "turn-2", isRunning: true,
    pendingToolConfirmations: 0, activity: { phase: "waiting-model", since: 2 },
  } }, { turnId: "turn-2", ts: 2 });
  assert.equal(h.indicator(), "running");
  assert.equal(h.useAppStore.getState().agentStatuses.running.activity.phase, "waiting-model");
  assert.deepEqual(h.useAppStore.getState().latestTurnResults, {});
});

test("manual compaction can publish activity after a completed turn", () => {
  const h = harness();
  h.emit({ type: "agent_end", messageIds: [] });
  h.emit({ type: "compaction_start", reason: "manual" }, { turnId: "compact-2", ts: 2 });
  h.emit({ type: "status", status: {
    sessionId: "running", currentTurnId: "compact-2", isRunning: true,
    pendingToolConfirmations: 0, activity: { phase: "compacting", since: 2, reason: "manual" },
  } }, { turnId: "compact-2", ts: 2 });
  assert.equal(h.useAppStore.getState().agentStatuses.running.activity.phase, "compacting");
  h.emit({ type: "compaction_end", reason: "manual", ok: false }, { turnId: "compact-2", ts: 3 });
  assert.equal(h.useAppStore.getState().isRunning, false);
  assert.equal(h.indicator(), "selected");
});

test("an idle runtime does not clear an approved plan's queued execution", () => {
  const h = harness();
  h.useAppStore.setState({
    planCheckpoints: { running: { status: "approved", executionState: "queued" } },
  });
  h.status(false);
  assert.equal(h.useAppStore.getState().isRunning, true);
  assert.equal(h.indicator(), "running");
});
