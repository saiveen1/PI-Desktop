import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { Sidebar } from "../../src/components/Sidebar";
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
window.addEventListener("unhandledrejection", (event) => unhandled.push(String(event.reason)));
window.piDesktop = {
  platform: "win32", on() { return () => {}; },
  async invoke(channel, input) {
    const ok = (data) => ({ ok: true, data });
    const failure = (message) => ({ ok: false, error: { code: "INTERNAL", message } });
    if (channel === IPC.invoke.sessionList) return ok({ sessions: [...database.values()].filter((item) => !item.deletedAt) });
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
const chosen = () => [...document.querySelectorAll('.thread-item.selected')].map((node) => node.dataset.sidebarSessionRow);
const checkbox = (label, scope = document) => [...scope.querySelectorAll("label")].find((node) => node.textContent.includes(label))?.querySelector("input");
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
window.organizationProbe = async () => {
  await waitFor(() => row("alpha"), "sidebar rendered");
  click(document.querySelector('[data-action="select-sessions"]'));
  click(checkbox("Select visible", toolbar()));
  check(!chosen().includes("folded"), "collapsed sessions included by select all");
  check(!chosen().includes("project-10") && !chosen().includes("project-11"), "unloaded history selected");
  check(chosen().length === 14, "visible selection count differs");
  click(checkbox("Select visible", toolbar()));
  click(row("alpha").querySelector(".thread-item-main"));
  flushSync(() => row("native").querySelector(".thread-item-main").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
  check(chosen().sort().join() === "alpha,beta,native", "Shift range did not follow rendered order");
  flushSync(() => row("beta").querySelector(".thread-item-main").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
  check(chosen().sort().join() === "alpha,native", "Ctrl click did not toggle selected row");
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
    for (const [key, english] of Object.entries(catalogs.en.sessionOrganization)) {
      const text = catalog.sessionOrganization[key];
      check(typeof text === "string", locale + " missing " + key);
      const variables = (value) => [...value.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]).sort().join();
      check(variables(text) === variables(english), locale + " variables differ for " + key);
    }
  }
  await frame();
  check(unhandled.length === 0, "unhandled errors: " + unhandled.join());
  flushSync(() => root.unmount());
  return { passed: true, locales: Object.keys(catalogs).length, permanentDeletes: calls.filter(([channel]) => channel === IPC.invoke.sessionTrashDelete).length };
};
