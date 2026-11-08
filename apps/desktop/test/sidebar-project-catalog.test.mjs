import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as react from "./helpers/react-hook-stub.mjs";
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const source = readFileSync(new URL("../src/features/sessions/useSidebarProjectCatalog.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture() {
  const requests = []; const updates = []; const errors = [];
  const state = { sidebarProjectGroups: [], openProjects: [{ path: "/a", name: "A" }], workspace: { path: "/a", name: "A" }, page: "chat",
    setSidebarProjectGroups: groups => { updates.push(groups); state.sidebarProjectGroups = groups; }, showToast: error => errors.push(error) };
  const useAppStore = selector => selector(state);
  useAppStore.getState = () => state;
  const api = { listProjectGroups: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) };
  const module = { exports: {} };
  const mockRequire = id => {
    if (id === "react") return react;
    if (id === "../../lib/api") return { api };
    if (id === "../../stores/app-store") return { useAppStore };
    throw new Error(`Unexpected dependency ${id}`);
  };
  vm.runInNewContext(compiled, { exports: module.exports, module, require: mockRequire, Error });
  const hook = module.exports.useSidebarProjectCatalog;
  const mount = () => react.__mount(hook);
  const render = () => react.__render(hook);
  return { state, requests, updates, errors, mount, render };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("sidebar project refresh ignores a stale response after project/navigation changes", async () => {
  const f = fixture(); f.mount();
  f.state.workspace = { path: "/b", name: "B" }; f.render();
  f.requests[0].resolve({ groups: ["old"] }); await settle();
  assert.equal(f.updates.length, 0);
  f.requests[1].resolve({ groups: ["new"] }); await settle();
  assert.deepEqual(f.updates, [["new"]]);
  f.state.page = "settings"; f.render();
  f.state.page = "chat"; const current = f.render();
  f.requests[2].reject(new Error("stale error")); await settle();
  assert.equal(f.errors.length, 0);
  f.requests[3].resolve({ groups: ["edited in archive"] }); await settle();
  current.refresh(); f.render();
  assert.equal(f.requests.length, 5);
  f.requests[4].reject(new Error("catalog unavailable")); await settle();
  assert.deepEqual(f.errors, ["catalog unavailable"]);
});
