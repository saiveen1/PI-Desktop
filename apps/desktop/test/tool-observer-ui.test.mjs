import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { toolObserver } from "../../../packages/i18n/src/locales/en/tool-observer.ts";
import { slotSsr } from "./helpers/slot-ssr.mjs";

function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree.props ? [tree, ...nodes(tree.props.children)] : [];
}
const observation = { id: "example-id", timestamp: "2026-11-16T10:00:00Z", toolName: "Bash", outcome: "command_nonzero",
  desktopPlatform: "win32", appVersion: "0.23.1", shellId: "git-bash", errorCode: "SYNTHETIC_CODE", exitCode: 1,
  durationMs: 42, sessionId: "observed", turnId: "turn-id", toolCallId: "call-id", backgroundTaskId: "bg-id", truncated: true };
const report = { schemaVersion: 1, generatedAt: observation.timestamp, since: observation.timestamp, days: 7, total: 3,
  counts: { success: 1, command_nonzero: 1, cancelled: 1, tool_error: 0, timeout: 0, interrupted: 0, background_started: 0, unknown: 0 },
  groups: [{ id: "group", toolName: "Bash", outcome: "command_nonzero", desktopPlatform: "win32", appVersion: "0.23.1", count: 1,
    sessionCount: 1, firstSeen: observation.timestamp, lastSeen: observation.timestamp, examples: Array.from({ length: 5 }, (_, i) => ({ ...observation, id: `example-${i}` })) },
    { id: "cancel-group", toolName: "Read", outcome: "cancelled", desktopPlatform: "win32", appVersion: "0.23.1", count: 1,
      sessionCount: 1, firstSeen: observation.timestamp, lastSeen: observation.timestamp, examples: [] }],
  recent: [], coverage: { filesRead: 2, malformedLines: 3, ignoredLegacyRecords: 4, readErrors: 1, limited: true } };

// Real React SSR expands shared primitives; capture the production JSX to invoke
// actual event handlers. Effects are tested at their cancellable read boundary,
// not claimed as browser DOM/lifecycle coverage.
test("observer React results selection, reference action, loading/error/empty and developer gating", async (t) => {
  const h = await slotSsr(t, { translationOverrides: { toolObserver } });
  const { ToolObserverResults } = await h.load("/src/features/settings/ToolObserverSection.tsx");
  const { DeveloperSection } = await h.load("/src/features/settings/developer-sections.tsx");
  const model = await h.load("/src/features/settings/tool-observer-report.ts");
  const refs = await h.load("/src/features/settings/tool-observer-reference.ts");
  const { useAppStore } = await h.load("/src/stores/app-store.ts");
  const cache = await h.load("/src/lib/composer-draft-cache.ts");
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { invoke() { assert.fail("Rendering and referencing must not send or call tools/providers"); } } };
  t.after(() => { globalThis.window = previousWindow; cache.resetComposerDraftCache(); });
  useAppStore.setState({ settings: { developerMode: true }, page: "chat", settingsOpen: true, activeSessionId: "local",
    activeProjectPath: "/synthetic", workspace: { path: "/synthetic", name: "Synthetic" },
    sessions: [{ id: "local", source: "desktop", projectPath: "/synthetic" }], composerPrefill: null });
  const target = refs.toolObserverTarget(useAppStore.getState());
  cache.writeComposerDraft("local", { text: "Keep this \ue001", fileReferences: [{ path: "/outside/image.png", name: "image.png", kind: "image", token: "\ue001", mimeType: "image/png" }] }, "/synthetic");
  let state = model.initialToolObserverState("scope");
  const dispatch = action => { state = model.toolObserverReducer(state, action); };
  let clicked = 0;
  function render() {
    let tree;
    function Probe() {
      tree = ToolObserverResults({ state, dispatch, canReference: refs.canReferenceToolObservations(useAppStore.getState(), target),
        onReference: group => { clicked++; refs.referenceToolObservationGroup(target, state.report, group,
          { title: toolObserver.referenceTitle, request: toolObserver.referenceRequest }); } });
      return tree;
    }
    const html = h.render(createElement(Probe));
    return { html, elements: nodes(tree) };
  }
  const picker = view => view.elements.find(item => item.props.label === toolObserver.groups);
  const reference = view => view.elements.find(item => item.props.children === toolObserver.reference);

  await t.test("loading and sanitized error are accessible; old-log empty state is actionable", () => {
    assert.match(render().html, /role="status".*Reading local observations/);
    dispatch({ type: "error", scope: "scope" });
    assert.match(render().html, /role="alert".*Could not read local observations/);
    dispatch({ type: "loaded", scope: "scope", report: { ...report, total: 0, groups: [] } });
    assert.match(render().html, /Older logs may not contain this telemetry/);
    assert.equal(picker(render()), undefined);
    assert.equal(reference(render()), undefined);
    dispatch({ type: "loaded", scope: "scope", report: { ...report, total: 1, groups: [] } });
    assert.match(render().html, /No non-success groups/);
  });

  await t.test("selects only non-success facts, shows bounded metadata and resets on refresh", () => {
    dispatch({ type: "loaded", scope: "scope", report });
    const initial = render();
    assert.equal(reference(initial), undefined);
    assert.match(initial.html, /Success: 1/);
    assert.match(initial.html, /Cancelled: 1/);
    assert.match(initial.html, /3 malformed lines; 4 legacy records skipped; 1 read failures/);
    assert.match(initial.html, /not confirmed defects/);
    assert.match(initial.html, /scan reached a limit/);
    picker(initial).props.onChange("group");
    const selected = render();
    assert.equal(reference(selected).props.disabled, false);
    for (const value of ["win32", "git-bash", "SYNTHETIC_CODE", "42", "turn-id", "call-id", "bg-id"]) assert.ok(selected.html.includes(value), value);
    assert.ok(selected.html.includes("example-2"));
    assert.ok(!selected.html.includes("example-3"));
    assert.match(selected.html, /not the operating system of a remote execution host/);
    picker(selected).props.onChange("cancel-group");
    assert.equal(state.selectedId, "cancel-group");
    assert.doesNotMatch(render().html, /SYNTHETIC_CODE/);
    dispatch({ type: "loading", scope: "refresh" });
    assert.equal(state.selectedId, "");
    assert.equal(reference(render()), undefined);
    dispatch({ type: "loaded", scope: "refresh", report });
    assert.equal(picker(render()).props.value, "");
  });

  await t.test("disabled/no-session button and stale captured actions cannot change another draft", () => {
    picker(render()).props.onChange("group");
    const oldAction = reference(render()).props.onClick;
    useAppStore.setState({ activeSessionId: undefined });
    assert.equal(reference(render()).props.disabled, true);
    assert.match(render().html, /Open a local editable conversation/);
    oldAction();
    assert.equal(cache.readComposerDraft("local").text, "Keep this \ue001");
    assert.equal(useAppStore.getState().composerPrefill, null);
    useAppStore.setState({ activeSessionId: "local", settings: { developerMode: false } });
    assert.equal(reference(render()).props.disabled, true);
    useAppStore.setState({ settings: { developerMode: true }, composerPrefill: { sessionId: "local", text: "Pending", fileReferences: [] } });
    assert.equal(reference(render()).props.disabled, true);
    useAppStore.setState({ composerPrefill: null });
    const before = clicked;
    reference(render()).props.onClick();
    assert.equal(clicked, before + 1);
    const prefill = useAppStore.getState().composerPrefill;
    assert.equal(prefill.sessionId, "local");
    assert.ok(prefill.text.startsWith("Keep this \ue001\n\n"));
    assert.equal(prefill.fileReferences[0].path, "/outside/image.png");
    assert.equal(useAppStore.getState().page, "chat");
    assert.equal(useAppStore.getState().settingsOpen, false);
  });

  await t.test("Developer section hides the observer when disabled and uses the existing day selector when enabled", () => {
    Object.assign(useAppStore.getInitialState(), { settings: { developerMode: false } });
    assert.doesNotMatch(h.render(createElement(DeveloperSection, { settings: { developerMode: false }, saveSettings: assert.fail })), /Local tool observer/);
    Object.assign(useAppStore.getInitialState(), { settings: { developerMode: true } });
    const html = h.render(createElement(DeveloperSection, { settings: { developerMode: true }, saveSettings: assert.fail }));
    assert.match(html, /Local tool observer/);
    assert.match(html, /never added to model context unless you reference it/);
    assert.match(html, /1 day/); assert.match(html, /7 days/); assert.match(html, /30 days/);
    assert.match(html, /Refresh/);
  });
});
