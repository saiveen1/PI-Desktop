import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import * as jsx from "react/jsx-runtime";
import ts from "typescript";
import * as hooks from "./helpers/react-hook-stub.mjs";
import { sessionAllows } from "../src/lib/remote-session-safety.ts";
import { drawOverviewThumbnail } from "../src/lib/overview-thumbnail-crop.ts";

// Drive the production component and both production hooks without starting Desktop.
function load(path, imports) {
  const file = new URL(`../src/${path}`, import.meta.url);
  const code = ts.transpileModule(readFileSync(file, "utf8"), { fileName: file.pathname,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function("exports", "require", code)(exports, (id) => {
    assert.ok(Object.hasOwn(imports, id), `Unexpected dependency ${id}`);
    return imports[id];
  });
  return exports;
}
function fixture() {
  const react = { ...hooks, Fragment: jsx.Fragment, useMemo: (fn) => fn() };
  const requests = [];
  const store = { workspace: { path: "workspace-a" }, activeSessionId: "other-pane", sessions: [] };
  const pane = { id: "pane-a" };
  const preview = load("lib/use-referenced-image-data-url.ts", { react,
    "./remote-session-safety": { sessionAllows }, "../plugins/renderer-slots/use-slots": { useSlotSessionId: () => pane.id },
    "../stores/app-store": { useAppStore: select => select(store) },
    "./api": { api: { fsReadImageDataUrl: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })) } },
  });
  const near = load("lib/use-image-near-viewport.ts", { react });
  const { GeneratedImageThumbnail } = load("features/chat/transcript/GeneratedImageThumbnail.tsx", {
    react, "react/jsx-runtime": jsx, "react-i18next": { useTranslation: () => ({ t: key => key }) },
    "../../../components/icons": { IconCircleAlert: "svg", IconClock: "svg" }, "../../../components/ui": { TooltipButton: "button" },
    "../../../lib/overview-thumbnail-crop": { drawOverviewThumbnail }, "../../../lib/use-image-near-viewport": near,
    "../../../lib/use-referenced-image-data-url": preview, "../../../styles/image-thumbnail-state.css": {},
  });
  return { preview, GeneratedImageThumbnail, store, pane, requests };
}
const red = "data:image/png;base64,cmVk", blue = "data:image/png;base64,Ymx1ZQ==";
const ready = (dataUrl, isThumbnail) => ({ kind: "image", dataUrl, isThumbnail });
const loading = { status: "loading" };
function childOfType(element, type) {
  if (!element || typeof element !== "object") return undefined;
  if (element.type === type) return element;
  return [element.props?.children].flat().map(child => childOfType(child, type)).find(Boolean);
}

test("pending and successful shared reads stay scoped to the pane, workspace, MIME and thumbnail policy", async () => {
  const { preview, store, pane, requests } = fixture();
  let ref = "images/result.png", mime = "image/png", thumbnail = true;
  const render = () => [preview.useReferencedImagePreviewState(ref, mime, thumbnail),
    preview.useReferencedImagePreview(ref, mime, thumbnail), preview.useReferencedImageDataUrl(ref, mime)];
  assert.deepEqual(hooks.__mount(render), [loading, null, null]);
  assert.deepEqual(requests.map(r => r.args), [[ref, mime, "pane-a", true], [ref, mime, "pane-a", undefined]]);
  pane.id = "pane-b";
  assert.deepEqual(hooks.__render(render), [loading, null, null]);
  requests[0].resolve(ready(red, true)); requests[1].resolve(ready(red)); await settle();
  assert.deepEqual(hooks.__render(render), [loading, null, null]);
  requests[2].resolve(ready(blue, true)); requests[3].resolve(ready(blue)); await settle();
  assert.deepEqual(hooks.__render(render), [{ status: "ready", dataUrl: blue, isThumbnail: true }, { dataUrl: blue, isThumbnail: true }, blue]);
  pane.id = "pane-a";
  assert.equal(hooks.__render(render)[0].dataUrl, red);
  assert.equal(requests.length, 4, "returning to an existing key should use its cache");
  store.workspace.path = "workspace-b";
  assert.deepEqual(hooks.__render(render), [loading, null, null]);
  assert.equal(requests.length, 6);
  mime = "image/webp"; thumbnail = undefined;
  assert.deepEqual(hooks.__render(render), [loading, null, null]);
  assert.equal(requests.length, 7, "all three consumers should share the ordinary read");
  pane.id = "remote:restricted";
  assert.deepEqual(hooks.__render(render), [{ status: "unavailable", reason: "restricted" }, null, null]);
  pane.id = "pane-a"; ref = "https://invalid.test/no-network";
  assert.deepEqual(hooks.__render(render), [{ status: "unavailable", reason: "restricted" }, null, null]);
  assert.equal(requests.length, 7);
});

test("a selected historical thumbnail waits for intersection; focus and activation do not wait", async (t) => {
  let observed, emit, disconnected = false;
  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(callback) { emit = (target, isIntersecting) => callback([{ target, isIntersecting }]); }
    observe(node) { observed = node; }
    unobserve(node) { assert.equal(node, observed); observed = null; }
    disconnect() { disconnected = true; }
  };
  t.after(() => { if (original) globalThis.IntersectionObserver = original; else delete globalThis.IntersectionObserver; });
  const { GeneratedImageThumbnail, requests } = fixture();
  let trigger;
  const image = { path: "offscreen.png", index: 0, mimeType: "image/png", allowThumbnail: true };
  const props = { image, selected: true, className: "generated-image-thumb", onSelect: (node) => { trigger = node; } };
  const render = () => GeneratedImageThumbnail(props);
  const button = {};
  hooks.__mount(render).props.ref(button); hooks.__render(render);
  assert.equal(observed, button);
  emit(button, false);
  let view = hooks.__render(render);
  assert.equal(requests.length, 0); assert.equal(view.props["aria-busy"], true);
  assert.match(view.props.tooltip, /imagePreviewState\.loading/);
  view.props.onClick({ currentTarget: button }); assert.equal(trigger, button);
  view.props.onFocus(); hooks.__render(render);
  assert.equal(requests.length, 1); requests[0].resolve(ready(red)); await settle();
  view = hooks.__render(render); assert.equal(childOfType(view, "img").props.src, red);
  view.props.onBlur(); image.path = "new-offscreen.png"; hooks.__render(render);
  assert.equal(requests.length, 1);
  emit(button, true); view = hooks.__render(render);
  assert.equal(requests.length, 2); assert.equal(childOfType(view, "img"), undefined);
  requests[1].resolve(ready(blue)); await settle(); view = hooks.__render(render);
  assert.equal(childOfType(view, "img").props.src, blue);
  assert.equal(childOfType(view, "canvas"), undefined);
  view.props.ref(null); hooks.__render(render); assert.equal(observed, null); assert.ok(disconnected);
});

test("without IntersectionObserver, attached generated thumbnails load and only the overview uses a crop", () => {
  assert.equal(typeof IntersectionObserver, "undefined");
  const { GeneratedImageThumbnail, requests } = fixture();
  const props = { image: { index: 0, path: "retained.png", dataUrl: red, allowThumbnail: true },
    className: "generated-overview-thumb", selected: false, onSelect() {} };
  const render = () => GeneratedImageThumbnail(props);
  hooks.__mount(render).props.ref({});
  for (const className of ["generated-overview-thumb", "generated-image-thumb", "generated-image-viewer-thumb"]) {
    props.className = className;
    const view = hooks.__render(render);
    assert.equal(childOfType(view, "img").props.src, red);
    assert.equal(Boolean(childOfType(view, "canvas")), className === "generated-overview-thumb");
  }
  assert.equal(requests.length, 0, "inline data must not cause a host read");
});

test("ordinary Read/MCP does not wait for visibility; failures name the reason, not the forbidden path", async () => {
  const { GeneratedImageThumbnail, requests } = fixture();
  const privatePath = "/private/root/secret.png";
  const image = { index: 1, path: privatePath, label: "Result", mimeType: "image/png" };
  const render = () => GeneratedImageThumbnail({ image, selected: false, className: "tool-result-image-thumb", source: privatePath, onSelect() {} });
  let view = hooks.__mount(render);
  for (const [index, [result, reason]] of [
    [{ kind: "missing", errorCode: "PATH_OUTSIDE_ALLOWED_ROOT" }, "restricted"], [{ kind: "missing" }, "missing"],
    [{ kind: "tooLarge" }, "tooLarge"], [{ kind: "notImage" }, "invalid"], [null, "unavailable"],
  ].entries()) {
    assert.equal(view.props["aria-busy"], true); assert.equal(childOfType(view, "img"), undefined);
    if (result) requests[index].resolve(result); else requests[index].reject(new Error(privatePath));
    await settle(); view = hooks.__render(render);
    assert.ok(view.props.tooltip.includes(`imagePreviewState.${reason}`)); assert.ok(!view.props.tooltip.includes(privatePath));
    assert.equal(view.props["aria-busy"], undefined); assert.equal(childOfType(view, "img"), undefined);
    image.path = `result-${index}.png`; view = hooks.__render(render);
  }
  image.dataUrl = red; view = hooks.__render(render);
  const old = childOfType(view, "img"); const oldNode = {}; old.props.ref.current = oldNode;
  image.dataUrl = blue; view = hooks.__render(render);
  const current = childOfType(view, "img"); const currentNode = {}; current.props.ref.current = currentNode;
  old.props.onError({ currentTarget: oldNode }); assert.equal(childOfType(hooks.__render(render), "img").props.src, blue);
  current.props.onError({ currentTarget: currentNode }); view = hooks.__render(render);
  assert.ok(view.props.tooltip.includes("imagePreviewState.invalid")); assert.equal(childOfType(view, "img"), undefined);
});

test("overview alpha trim retains even faint pixels and falls back safely with a bounded readback", () => {
  const image = Object.freeze({ src: red, naturalWidth: 800, naturalHeight: 400 });
  let mode = "padded", sample, offset;
  const canvas = { width: 0, height: 0, getContext: () => ({
    drawImage(input, x, y, w, h) { assert.equal(input, image); sample = [w, h]; },
    getImageData(x, y, width, height) {
      const data = new Uint8ClampedArray(width * height * 4);
      if (mode === "opaque") data.fill(255);
      if (mode === "denied") throw new Error("readback denied");
      if (mode === "padded") { data[(7 * width + 20) * 4 + 3] = 1; data[(28 * width + 34) * 4 + 3] = 255; }
      return { data };
    },
    putImageData(_pixels, x, y) { offset = [x, y]; },
  }) };
  assert.equal(drawOverviewThumbnail(image, canvas), true);
  assert.deepEqual(sample, [128, 64]); assert.deepEqual(offset, [-20, -7]); assert.deepEqual([canvas.width, canvas.height], [15, 22]);
  for (mode of ["transparent", "opaque", "denied"]) {
    assert.equal(drawOverviewThumbnail(image, canvas), false); assert.equal(canvas.width * canvas.height, 0);
  }
  for (const odd of [{ naturalWidth: Infinity }, { naturalHeight: 0 }, { naturalHeight: 100_000 }, { src: "data:image/gif;base64,AAAA" }]) {
    assert.equal(drawOverviewThumbnail({ ...image, ...odd }, canvas), false);
  }
});
