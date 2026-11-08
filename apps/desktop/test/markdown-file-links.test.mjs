import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { readFile } from "node:fs/promises";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("production Markdown renders document links and preserves click/menu targets", async (t) => {
  const ssr = await slotSsr(t, { plugins: [{
    name: "file-link-interaction-probe",
    transform(source, id) {
      if (id.endsWith("/components/Markdown.tsx")) {
        return source + "\nexport { Anchor as ProbeAnchor, MarkdownFileMenuContext as ProbeMenuContext };";
      }
    },
  }] });
  const calls = [];
  globalThis.window = { piDesktop: {
    platform: "win32",
    async invoke(channel, input) {
      calls.push([channel, input]);
      assert.equal(channel, "pi-desktop/fs/resolveRef");
      return { ok: true, data: { match: {
        root: "scratch", relativePath: "复盘.prg", absolutePath: "D:/scratch/复盘.prg",
        matchedBy: "exact-absolute", sessionScratch: true,
      } } };
    },
  }, matchMedia: () => ({ matches: false }) };
  t.after(() => { delete globalThis.window; });
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const opened = [];
  const state = {
    sessions: [{ id: "session-1", title: "Local" }], activeSessionId: "session-1",
    workspace: { path: "D:/project" },
    openFileInWorkPanel: (...args) => opened.push(args),
  };
  useAppStore.setState(state);
  Object.assign(useAppStore.getInitialState(), state);
  const { Markdown, ProbeAnchor, ProbeMenuContext } = await ssr.load("/src/components/Markdown.tsx");
  const html = ssr.render(createElement(Markdown, {
    source: "已生成 [PRG 复盘画布](<D:/scratch/复盘.prg>)；[Website](https://example.test/report.txt)",
  }));
  assert.match(html, /<a[^>]*class="chat-file-link"[^>]*>/);
  assert.match(html, /<span class="chat-file-link-icon" aria-hidden="true"><svg/);
  assert.match(html, /PRG 复盘画布<\/a>/);
  const webLink = html.match(/<a[^>]*href="https:\/\/example.test\/report.txt"[^>]*>Website<\/a>/)?.[0];
  assert.ok(webLink);
  assert.doesNotMatch(webLink, /chat-file-link|<svg/);
  assert.doesNotMatch(html, /\sdownload=/);
  assert.deepEqual(calls, [], "rendering file links does not read files");

  let anchor;
  const menus = [];
  function Probe() {
    const element = ProbeAnchor({ href: "D%3A%2Fscratch%2F%E5%A4%8D%E7%9B%98.prg%3A12%3A3", children: "PRG 复盘画布" });
    anchor = element.props.children[0];
    return element;
  }
  ssr.render(createElement(ProbeMenuContext.Provider, {
    value: (_event, target) => menus.push(target),
  }, createElement(Probe)));
  let prevented = false;
  anchor.props.onClick({ preventDefault() { prevented = true; } });
  await flush();
  assert.equal(prevented, true);
  assert.deepEqual(opened, [["D:/scratch/复盘.prg", undefined, { line: 12, column: 3 }]]);
  anchor.props.onContextMenu({});
  assert.deepEqual(menus, [{ path: "D:/scratch/复盘.prg", baseDir: "", line: 12, column: 3 }]);
  assert.equal(calls.length, 1);

  function ExtensionlessProbe() {
    const element = ProbeAnchor({ href: "D:/scratch/Makefile:4", children: "Makefile" });
    anchor = element.props.children[0];
    return element;
  }
  ssr.render(createElement(ProbeMenuContext.Provider, {
    value: (_event, target) => menus.push(target),
  }, createElement(ExtensionlessProbe)));
  anchor.props.onContextMenu({});
  assert.deepEqual(menus.at(-1), { path: "D:/scratch/Makefile", baseDir: "", line: 4, column: undefined });
});

test("file link presentation has theme tokens, wrapping and a keyboard focus affordance", async () => {
  const css = await readFile(new URL("../src/styles/chat-links.css", import.meta.url), "utf8");
  const tokens = await readFile(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  assert.match(css, /\.prose-chat a\.chat-file-link\s*\{[^}]*color: var\(--ds-file-link\)/);
  assert.match(css, /\.prose-chat a\.chat-file-link\s*\{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.prose-chat a\.chat-file-link:focus-visible\s*\{[^}]*text-decoration-line: underline/);
  assert.equal((tokens.match(/--ds-file-link:/g) ?? []).length, 2);
});

test("production Markdown qualifies a table filename with its explicit export directory", async (t) => {
  const calls = [];
  const ssr = await slotSsr(t, { plugins: [{
    name: "export-file-interaction-probe",
    transform(source, id) {
      if (!id.endsWith("/components/Markdown.tsx")) return;
      source = source.replace("function Anchor({", "function RealAnchor({")
        .replace("openFileMenu(event, { items: fileMenuItems(target) })", "void (globalThis.exportFileMenuProbe = fileMenuItems(target))");
      return source + `
        function Anchor(props) {
          const element = RealAnchor(props);
          if (decodeURIComponent(props.href ?? "").endsWith("accounts_2fa.json")) {
            globalThis.exportFileProbe.push(element.props.children[0]);
          }
          return element;
        }
      `;
    },
  }] });
  globalThis.exportFileProbe = [];
  globalThis.window = { piDesktop: {
    platform: "win32",
    async invoke(channel, input) {
      calls.push([channel, input]);
      if (channel === "pi-desktop/fs/resolveRef") return { ok: true, data: { match: {
        root: "external", relativePath: "accounts_2fa.json",
        absolutePath: input.ref, matchedBy: "exact-absolute",
      } } };
      assert.equal(channel, "pi-desktop/fs/reveal");
      return { ok: true, data: {} };
    },
  }, matchMedia: () => ({ matches: false }), getSelection: () => null };
  t.after(() => { delete globalThis.window; delete globalThis.exportFileProbe; delete globalThis.exportFileMenuProbe; });
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const opened = [];
  const state = {
    sessions: [{ id: "session-1", title: "Local" }], activeSessionId: "session-1",
    workspace: { path: "D:/unrelated-project" },
    openFileInWorkPanel: (...args) => opened.push(args),
    showToast: () => {},
  };
  useAppStore.setState(state);
  Object.assign(useAppStore.getInitialState(), state);
  const { Markdown } = await ssr.load("/src/components/Markdown.tsx");
  const directory = "F:/export files/中文导出/";
  const html = ssr.render(createElement(Markdown, {
    source: "已完成。\n\n目录：`" + directory + "`\n\n| 文件 | 内容 |\n| --- | --- |\n| `accounts_2fa.json` | Synthetic fixture |\n\nBackup: `F:/backup/`",
  }));
  const path = directory + "accounts_2fa.json";
  assert.ok(html.includes(encodeURIComponent(path)), "table link must retain the explicit directory across Markdown blocks");
  assert.equal(calls.length, 0, "rendering must not query local files");
  assert.equal(globalThis.exportFileProbe.length, 1);
  const anchor = globalThis.exportFileProbe[0];
  anchor.props.onClick({ preventDefault() {} });
  await flush();
  assert.deepEqual(opened.map(([file]) => file), [path]);
  anchor.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 1 });
  globalThis.exportFileMenuProbe.find((item) => item.id === "reveal-in-folder").onSelect();
  await flush();
  assert.deepEqual(calls.filter(([channel]) => channel.endsWith("resolveRef")).map(([, input]) => input.ref), [path, path]);
  assert.equal(calls.at(-1)[0], "pi-desktop/fs/reveal");
  assert.equal(calls.at(-1)[1].path, path);
});
