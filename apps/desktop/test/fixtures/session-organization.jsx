import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { Sidebar } from "../../src/components/Sidebar";
import { SessionDelegationModels } from "../../src/features/sessions/SessionDelegationModels";
import { DelegationSelectionSummary } from "../../src/features/chat/transcript/DelegationSelectionSummary";
import { useAppStore } from "../../src/stores/app-store";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/ui-kit.css";
import "../../src/styles/sessions.css";
import "../../src/styles/sidebar-threads.css";

function flatten(value, prefix = "", result = {}) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? prefix + "." + key : key;
    if (typeof child === "string") result[path] = child;
    else flatten(child, path, result);
  }
  return result;
}
await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: Object.fromEntries(Object.entries(catalogs).map(([locale, catalog]) => [locale, { translation: flatten(catalog) }])),
  interpolation: { escapeValue: false },
});
const stamp = "2026-11-04T10:00:00.000Z";
const session = (id, projectPath = null) => ({ id, title: id, projectPath, createdAt: stamp, updatedAt: stamp, messageCount: 2, mode: "agent" });
const database = new Map([
  session("alpha"), session("beta"), session("running"), { ...session("native"), source: "pi-native" },
  ...Array.from({ length: 12 }, (_, index) => session("project-" + String(index).padStart(2, "0"), "D:/fixture")),
  session("folded", "D:/folded"),
].map((item) => [item.id, item]));
const calls = [];
const unhandled = [];
let failTrash = "";
let failDelete = "";
let failList = false;
let failConfigure = false;
window.addEventListener("unhandledrejection", (event) => unhandled.push(String(event.reason)));
window.piDesktop = {
  platform: "win32", on() { return () => {}; },
  async invoke(channel, input, config) {
    const ok = (data) => ({ ok: true, data });
    const failure = (message) => ({ ok: false, error: { code: "INTERNAL", message } });
    if (channel === IPC.invoke.sessionList) return ok({ sessions: [...database.values()].filter((item) => !item.deletedAt) });
    if (channel === IPC.invoke.sessionConfigure) {
      if (failConfigure) { failConfigure = false; return failure("fixture configure denied"); }
      const item = { ...database.get(input) };
      if (config.delegationModelKeys === null) {
        delete item.delegationModelKeys;
        delete item.delegationModelApprovals;
      } else {
        item.delegationModelKeys = [...config.delegationModelKeys];
        item.delegationModelApprovals = { ...config.delegationModelApprovals };
      }
      database.set(input, item);
      return ok({ session: item });
    }
    if (channel === IPC.invoke.sessionTrashList) {
      if (failList) { failList = false; return failure("fixture list unavailable"); }
      return ok({ sessions: [...database.values()].filter((item) => item.deletedAt) });
    }
    if ([IPC.invoke.sessionTrash, IPC.invoke.sessionTrashRestore, IPC.invoke.sessionTrashDelete].includes(channel)) {
      calls.push([channel, input]);
      const item = database.get(input);
      if (channel === IPC.invoke.sessionTrash) {
        if (input === failTrash) { failTrash = ""; return failure("fixture trash denied"); }
        if (!item || item.source === "pi-native" || input === "running") return failure("fixture not trashable");
        database.set(input, { ...item, deletedAt: stamp });
      } else if (channel === IPC.invoke.sessionTrashRestore) {
        if (!item?.deletedAt) return failure("fixture not in trash");
        const { deletedAt, ...restored } = item;
        database.set(input, restored);
      } else {
        if (input === failDelete) { failDelete = ""; return failure("fixture delete denied"); }
        if (!item?.deletedAt) return failure("fixture not in trash");
        database.delete(input);
      }
      return ok({ ok: true });
    }
    if (channel === IPC.invoke.pluginViewClose) return ok(undefined);
    if (channel === IPC.invoke.updatesGetState) return ok(null);
    // Closed worktree menus and notifications must not perform task mutations.
    return failure("Unexpected fixture IPC: " + channel);
  },
};
useAppStore.setState({ sessions: [...database.values()], sessionMeta: { alpha: { pinned: true } },
  settings: { theme: "light", language: "en", scheduledTasksEnabled: false },
  projectMeta: { "D:/folded": { collapsed: true } }, projectCollapsed: {},
  openProjectPaths: ["D:/fixture", "D:/folded"], openProjects: [], workspace: null,
  activeProjectPath: null, activeSessionId: undefined, selectingSessionId: undefined, page: "chat",
  runningSessions: { running: true }, sessionView: { sort: "name", archived: false },
});
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<Sidebar onToggleSidebar={() => {}} sidebarToggleShortcut="" sidebarWidth={300}
  onWidthChange={() => {}} onWidthCommit={() => {}} onResizeCollapse={() => {}} />));
const frame = () => new Promise(requestAnimationFrame);
async function waitFor(predicate, label) {
  console.log("CHECK " + label);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = predicate();
    if (result) return result;
    await frame();
  }
  throw new Error(label);
}
function check(value, label) { if (!value) throw new Error(label); }
function click(node) {
  check(node && !node.disabled, "missing or disabled action");
  flushSync(() => node.click());
}
const button = (text, scope = document) => [...scope.querySelectorAll("button")].find((node) =>
  !node.disabled && (node.textContent.trim() === text || node.getAttribute("aria-label") === text));
const row = (id) => document.querySelector('[data-sidebar-session-row="' + id + '"]');
const toolbar = () => document.querySelector(".session-selection-toolbar");
const dialog = () => document.querySelector(".session-trash-dialog");
const chosen = () => [...new Set([...document.querySelectorAll('.thread-item.selected')].map((node) => node.dataset.sidebarSessionRow))];
const checkbox = (label, scope = document) => [...scope.querySelectorAll("label")].find((node) => node.textContent.includes(label))?.querySelector("input");
function chooseApproval(model, value) {
  const node = document.querySelector('select[aria-label="Approval for fixture/' + model + '"]');
  check(node && !node.disabled, "missing or disabled approval control");
  flushSync(() => { node.value = value; node.dispatchEvent(new Event("change", { bubbles: true })); });
  check(document.querySelector('input[aria-label="fixture/' + model + '"]').checked, "approval change toggled model membership");
}
async function select(ids) {
  if (!toolbar()) click(document.querySelector('[data-action="select-sessions"]'));
  for (const id of ids) click(row(id)?.querySelector(".thread-item-main"));
  check(chosen().length === ids.length, "plain row clicks must select instead of navigating");
  check(!useAppStore.getState().activeSessionId, "selection unexpectedly navigated");
}
async function done() {
  await waitFor(() => button("Done", toolbar()), "selection operation settled");
  click(button("Done", toolbar()));
  await waitFor(() => !toolbar(), "exit selection");
}
async function trash(ids) {
  await select(ids);
  click(button("Move to recycle bin", toolbar()));
  await waitFor(() => ids.every((id) => !row(id)), "selected sessions left ordinary list");
  await waitFor(() => !toolbar().getAttribute("aria-busy") || toolbar().getAttribute("aria-busy") === "false", "batch settled");
  await done();
}
async function openTrash() {
  click(document.querySelector('[data-nav="recycle-bin"]'));
  await waitFor(() => dialog()?.getAttribute("aria-busy") === "false", "recycle bin loaded");
}
window.sidebarLabelGroupingProbe = async () => {
  await waitFor(() => row("project-00"), "project grouping sidebar rendered");
  const original = useAppStore.getState();
  const opened = [];
  const scope = "project:D:/fixture";
  const groups = [{ id: "investigation", name: "排查一个很长但不该挤成细条的会话分组", color: "blue" },
    { id: "fix", name: "Fix", color: "amber" }];
  flushSync(() => useAppStore.setState({
    sessionOrganization: { version: 1, scopes: { ...original.sessionOrganization.scopes,
      [scope]: { groups, labels: original.sessionLabels },
      temporary: { groups, labels: original.sessionLabels },
    } },
    sessionMeta: { ...original.sessionMeta,
      "project-00": { ...original.sessionMeta["project-00"], groupId: "investigation", organizationScope: scope, labelIds: ["investigation", "fix"] },
      "project-01": { ...original.sessionMeta["project-01"], groupId: "investigation", organizationScope: scope, labelIds: ["investigation"] },
      beta: { ...original.sessionMeta.beta, groupId: "investigation", organizationScope: "temporary", labelIds: ["investigation"] },
    },
    selectSession: async id => { opened.push(id); useAppStore.setState({ activeSessionId: id }); },
  }));
  const project = row("project-00").closest("[data-sidebar-project-group]");
  const group = id => project.querySelector('[data-sidebar-session-group="' + id + '"]');
  const rows = () => [...project.querySelectorAll('[data-sidebar-session-row="project-00"]')];
  check(rows().length === 1, "multiple labels duplicated a conversation row");
  check(rows()[0].querySelectorAll(".session-row-labels .session-color-swatch").length === 2, "descriptive labels disappeared");
  check(!document.querySelector("[data-sidebar-label-group]"), "labels still create sidebar groups");
  click(rows()[0].querySelector(".thread-item-main"));
  check(opened.join() === "project-00", "grouped row opened another conversation");
  check(useAppStore.getState().sessions.length === original.sessions.length, "grouping duplicated stored conversations");
  click(document.querySelector('[data-action="select-sessions"]'));
  click(checkbox("Select visible", toolbar()));
  check(document.querySelector(".session-selection-count").textContent.includes("14"), "visible selection duplicated conversations");
  click(group("investigation").querySelector(".sidebar-conversation-group-title"));
  await waitFor(() => !chosen().includes("project-01") && !chosen().includes("project-00"), "folding removes hidden group members from selection");
  check(rows().length === 0 && chosen().length === 12, "folded conversations stayed visible or selected");
  check(document.querySelector('.sidebar-conversation-group[data-group-scope="temporary"][data-sidebar-session-group="investigation"] .thread-item'), "folding leaked into another scope");
  await done();
  click(group("investigation").querySelector(".sidebar-conversation-group-title"));
  check(rows().length === 1 && row("project-01"), "expanding did not restore unique conversation rows");
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    for (const width of [220, 275, 360]) {
      document.getElementById("root").style.width = width + "px";
      flushSync(() => root.render(<Sidebar onToggleSidebar={() => {}} sidebarToggleShortcut="" sidebarWidth={width}
        onWidthChange={() => {}} onWidthCommit={() => {}} onResizeCollapse={() => {}} />));
      const name = group("investigation").querySelector(".sidebar-conversation-group-name");
      const header = name.closest("button");
      const bounds = header.getBoundingClientRect();
      check(name.clientWidth >= 100, "group heading collapsed into a sliver");
      check(bounds.width >= group("investigation").getBoundingClientRect().width - 1, "group heading does not occupy its own row");
      check(!header.querySelector("time"), "timestamp competes with group heading");
      const sessionRow = rows()[0];
      const labels = sessionRow.querySelector(".session-row-labels");
      const title = sessionRow.querySelector(".thread-item-title");
      const date = sessionRow.querySelector(".thread-item-meta");
      check(labels.textContent === "" && labels.title && labels.getAttribute("aria-label"), "color-only labels lost their names");
      check(labels.getBoundingClientRect().right <= title.getBoundingClientRect().left, "labels must precede the title");
      check(labels.getBoundingClientRect().width <= 44, "labels exceeded their compact width");
      check(title.getBoundingClientRect().right <= date.getBoundingClientRect().left, "title overlaps the date");
      check(sessionRow.scrollWidth <= sessionRow.clientWidth, "session row overflows at narrow width");
      header.focus();
      check(document.activeElement === header, "group heading is not keyboard focusable");
    }
  }
  flushSync(() => useAppStore.setState({
    sessionMeta: original.sessionMeta, sessionLabels: original.sessionLabels,
    sessionOrganization: original.sessionOrganization,
    selectSession: original.selectSession, activeSessionId: original.activeSessionId,
  }));
  document.documentElement.dataset.theme = "light";
  document.getElementById("root").style.width = "300px";
  return { passed: true, uniqueRows: 1, uniqueSelected: 14, layouts: 6 };
};

window.organizationProbe = async () => {
  await waitFor(() => row("alpha"), "sidebar rendered");
  click(row("beta").querySelector('[data-action="session-menu"]'));
  click(await waitFor(() => document.querySelector('[data-submenu-trigger="session-labels"]'), "labels menu"));
  click(await waitFor(() => document.querySelector('[data-action="session-label-fix"]'), "assign label"));
  click(document.querySelector('[data-action="session-label-feature"]'));
  check(useAppStore.getState().sessionMeta.beta.labelIds.length === 2, "multiple labels were not retained");
  click(document.querySelector('[data-submenu-trigger="session-color"]'));
  click(await waitFor(() => document.querySelector('[data-action="session-color-blue"]'), "independent color mark"));
  flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  check(!button("Filter conversations"), "display-only labels still expose the retired filter");
  check(row("beta") && row("alpha"), "descriptive labels filtered unrelated conversations");
  check(row("beta").querySelectorAll(".session-row-labels .session-color-swatch").length === 2, "multiple descriptive labels were lost");
  click(row("project-01").querySelector('[data-action="session-menu"]'));
  click(await waitFor(() => document.querySelector('[data-action="session-move-up"]'), "move action"));
  const orderBefore = useAppStore.getState().sessionMeta["project-01"].order;
  check(orderBefore < useAppStore.getState().sessionMeta["project-00"].order, "same-project reorder failed");
  flushSync(() => useAppStore.setState(state => ({ sessions: state.sessions.map(item =>
    item.id === "project-00" ? { ...item, updatedAt: "2099-01-01T00:00:00Z" } : item) })));
  check(useAppStore.getState().sessionMeta["project-01"].order === orderBefore, "assistant update changed activity order");
  flushSync(() => useAppStore.getState().setSessionSort("name"));
  click(document.querySelector('[data-action="select-sessions"]'));
  click(checkbox("Select visible", toolbar()));
  check(!chosen().includes("folded"), "collapsed sessions included by select all");
  check(!chosen().includes("project-10") && !chosen().includes("project-11"), "unloaded history selected");
  check(chosen().length === 14, "visible selection count differs");
  click(checkbox("Select visible", toolbar()));
  const renderedOrder = [...new Set([...document.querySelectorAll("[data-sidebar-session-row]")]
    .map(node => node.dataset.sidebarSessionRow))];
  const anchorIndex = renderedOrder.indexOf("alpha");
  const endIndex = renderedOrder.indexOf("native");
  check(anchorIndex >= 0 && endIndex >= 0, "Shift range endpoints are not rendered");
  const expectedRange = renderedOrder.slice(Math.min(anchorIndex, endIndex), Math.max(anchorIndex, endIndex) + 1).sort();
  check(expectedRange.includes("beta"), "Shift fixture must span an intermediate row");
  click(row("alpha").querySelector(".thread-item-main"));
  flushSync(() => row("native").querySelector(".thread-item-main").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
  check(chosen().sort().join() === expectedRange.join(), "Shift range did not follow rendered order: " + JSON.stringify({ expectedRange, actual: chosen() }));
  flushSync(() => row("beta").querySelector(".thread-item-main").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
  check(chosen().sort().join() === expectedRange.filter(id => id !== "beta").join(), "Ctrl click did not toggle selected row");
  await done();

  // Enter multi-selection through the actual row menu as well as its toolbar.
  click(row("alpha").querySelector('[data-action="session-menu"]'));
  await waitFor(() => document.querySelector('[role="menu"]'), "row menu opened");
  click(button("Select sessions", document.querySelector('[role="menu"]')));
  click(row("beta").querySelector(".thread-item-main"));
  click(button("Archive", toolbar()));
  await waitFor(() => !row("alpha") && !row("beta"), "batch archive hid both sessions");
  check(useAppStore.getState().sessionMeta.alpha.archived && useAppStore.getState().sessionMeta.beta.archived, "archive metadata not saved");
  await done();
  click(document.querySelector('[data-action="session-sort"]'));
  await waitFor(() => button("Show archived"), "archive visibility menu opened");
  click(button("Show archived"));
  await waitFor(() => row("alpha") && row("beta"), "archived rows visible");
  await select(["alpha", "beta"]);
  click(button("Unarchive", toolbar()));
  await waitFor(() => !useAppStore.getState().sessionMeta.alpha.archived && !useAppStore.getState().sessionMeta.beta.archived, "batch unarchive restored rows");
  await waitFor(() => toolbar().getAttribute("aria-busy") === "false", "unarchive settled");
  await done();

  // Preserve original organization and leave only failed targets selected.
  flushSync(() => useAppStore.getState().archiveSession("beta"));
  failTrash = "beta";
  await select(["alpha", "beta"]);
  click(button("Move to recycle bin", toolbar()));
  await waitFor(() => !row("alpha") && row("beta") && toolbar().getAttribute("aria-busy") === "false", "partial trash failure settled");
  check(chosen().join() === "beta", "failed trash target was not retained");
  check(useAppStore.getState().sessionMeta.alpha.pinned, "trash removed pin state");
  check(useAppStore.getState().sessionMeta.beta.archived, "trash removed archive state");
  click(button("Move to recycle bin", toolbar()));
  await waitFor(() => !row("beta") && toolbar().getAttribute("aria-busy") === "false", "retry trash succeeded");
  await done();
  await openTrash();
  check(dialog().querySelectorAll(".session-trash-row").length === 2, "trash listing incorrect");
  click(checkbox("Select visible", dialog()));
  click(button("Restore", dialog()));
  await waitFor(() => dialog().textContent.includes("The recycle bin is empty."), "batch restoration completed");
  check(row("alpha") && row("beta"), "restored sessions absent from catalog");
  check(useAppStore.getState().sessionMeta.alpha.pinned && useAppStore.getState().sessionMeta.beta.archived, "restore lost original metadata");
  click(button("Close", dialog()));

  await trash(["alpha", "beta"]);
  await openTrash();
  click(checkbox("Select visible", dialog()));
  const beforeDelete = calls.filter(([channel]) => channel === IPC.invoke.sessionTrashDelete).length;
  click(button("Delete permanently", dialog()));
  check(dialog().querySelector(".session-trash-confirmation"), "confirmation missing");
  check(calls.filter(([channel]) => channel === IPC.invoke.sessionTrashDelete).length === beforeDelete, "delete ran before confirmation");
  click(button("Cancel", dialog()));
  check(database.has("alpha") && database.has("beta"), "cancel deleted sessions");
  click(button("Delete permanently", dialog()));
  flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  check(!dialog().querySelector(".session-trash-confirmation"), "Escape did not cancel confirmation");
  failDelete = "beta";
  click(button("Delete permanently", dialog()));
  click(button("Delete permanently", dialog().querySelector(".session-trash-confirmation")));
  await waitFor(() => !database.has("alpha") && dialog().getAttribute("aria-busy") === "false", "partial purge completed");
  check(database.has("beta") && dialog().querySelectorAll(".session-trash-row").length === 1, "failed purge was discarded");
  check(dialog().querySelector(".session-trash-row input").checked, "failed purge selection lost");
  click(button("Delete permanently", dialog()));
  click(button("Delete permanently", dialog().querySelector(".session-trash-confirmation")));
  await waitFor(() => !database.has("beta") && dialog().getAttribute("aria-busy") === "false", "permanent deletion completed");
  click(button("Close", dialog()));

  failList = true;
  await openTrash();
  check(dialog().querySelector('[role="alert"]'), "load error not visible");
  click(button("Retry", dialog()));
  await waitFor(() => !dialog().querySelector('[role="alert"]') && dialog().getAttribute("aria-busy") === "false", "list retry completed");
  click(button("Close", dialog()));
  const beforeRejected = calls.length;
  await select(["native", "running"]);
  click(button("Move to recycle bin", toolbar()));
  await waitFor(() => toolbar().getAttribute("aria-busy") === "false", "unsafe targets rejected");
  check(calls.length === beforeRejected, "unsupported/running sessions reached mutation IPC");
  check(chosen().length === 2 && database.has("native") && database.has("running"), "unsafe targets disappeared");
  await done();
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const [key, english] of Object.entries({ ...catalogs.en.sessionOrganization, ...catalogs.en.sessionDelegation })) {
      const text = catalog.sessionOrganization[key] ?? catalog.sessionDelegation[key];
      check(typeof text === "string", locale + " missing " + key);
      const variables = (value) => [...value.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]).sort().join();
      check(variables(text) === variables(english), locale + " variables differ for " + key);
    }
  }
  await frame();
  check(unhandled.length === 0, "unhandled errors: " + unhandled.join());
  flushSync(() => {
    useAppStore.setState({ providers: [{ id: "fixture", name: "Fixture", enabled: true, authKind: "none",
      models: [{ id: "general" }, { id: "specialist" }] }],
      settings: { ...useAppStore.getState().settings, delegation: { version: 1, approvalTimeoutSeconds: 60,
        models: ["general", "specialist"].map((modelId, index) => ({ providerId: "fixture", modelId,
          enabled: true, approval: index ? "ask" : "auto", priority: index + 1, description: modelId + " description" })) } } });
    root.render(<SessionDelegationModels sessionId="running" />);
  });
  click(button("Subagent models"));
  check(button("Save") === undefined, "running conversation unexpectedly permits saving");
  flushSync(() => useAppStore.setState({ runningSessions: {} }));
  click(button("Custom"));
  chooseApproval("general", "ask");
  chooseApproval("specialist", "auto");
  failConfigure = true;
  click(button("Save"));
  await waitFor(() => document.querySelector('.session-delegation-dialog [role="alert"]')?.textContent.includes("fixture configure denied"), "save failure visible");
  check(database.get("running").delegationModelKeys === undefined, "failed save changed durable session");
  click(button("Save"));
  await waitFor(() => !document.querySelector(".session-delegation-dialog"), "approval overrides saved");
  check(JSON.stringify(database.get("running").delegationModelApprovals) === JSON.stringify({ "fixture/general": "ask", "fixture/specialist": "auto" }), "per-model approvals not saved");
  check(useAppStore.getState().settings.delegation.models.map(model => model.approval).join() === "auto,ask", "session consent changed global policy");
  click(button("Subagent models: 2 selected"));
  check(document.querySelector('select[aria-label="Approval for fixture/general"]').value === "ask" &&
    document.querySelector('select[aria-label="Approval for fixture/specialist"]').value === "auto", "saved approvals not restored on reopen");
  chooseApproval("specialist", "ask");
  click(button("Cancel", document.querySelector(".session-delegation-actions")));
  check(database.get("running").delegationModelApprovals["fixture/specialist"] === "auto", "cancel saved approval edits");
  click(button("Subagent models: 2 selected"));
  click(checkbox("general", document.querySelector(".session-delegation-dialog")));
  click(button("Save"));
  await waitFor(() => !document.querySelector(".session-delegation-dialog"), "custom pool saved");
  check(database.get("running").delegationModelKeys.join() === "fixture/specialist", "wrong session model pool");
  click(button("Subagent models: 1 selected"));
  click(checkbox("specialist", document.querySelector(".session-delegation-dialog")));
  click(button("Save"));
  await waitFor(() => !document.querySelector(".session-delegation-dialog"), "empty pool saved");
  check(database.get("running").delegationModelKeys.length === 0, "empty pool became inherited");
  click(button("Subagent models: 0 selected"));
  click(button("Follow global"));
  click(button("Save"));
  await waitFor(() => !document.querySelector(".session-delegation-dialog"), "inheritance restored");
  check(useAppStore.getState().sessions.find(item => item.id === "running").delegationModelKeys === undefined, "old pool survived inheritance");
  check(useAppStore.getState().sessions.find(item => item.id === "running").delegationModelApprovals === undefined, "old approvals survived inheritance");
  flushSync(() => root.render(<DelegationSelectionSummary payload={{ modelId: "general", scheduling: {
    requestedModel: "fixture/specialist", modelReason: "Independent concurrency review",
    decisions: [{ model: "fixture/specialist", decision: "skipped", reason: "Approval expired" },
      { model: "fixture/general", decision: "selected", reason: "Automatic fallback" }],
  } }} />));
  check(document.body.textContent.includes("Independent concurrency review") &&
    document.body.textContent.includes("fixture/general") &&
    document.body.textContent.includes("Approval expired"), "selection rationale or actual fallback missing");
  flushSync(() => root.unmount());
  return { passed: true, locales: Object.keys(catalogs).length, permanentDeletes: calls.filter(([channel]) => channel === IPC.invoke.sessionTrashDelete).length };
};
