import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { parseMarkdownBlocks } from "../src/lib/markdown-blocks.ts";
import { markdownFileDirectories } from "../src/lib/markdown-file-directory.ts";
import { remarkChatFileLinks } from "../src/lib/chat-links.ts";

function links(source, baseDir) {
  const blocks = parseMarkdownBlocks(source).blocks;
  const directories = baseDir !== undefined ? [] : markdownFileDirectories(blocks);
  return blocks.flatMap((raw, i) => {
    const html = renderToStaticMarkup(createElement(ReactMarkdown, {
      remarkPlugins: [remarkChatFileLinks("D:/project", baseDir, directories[i])],
      children: raw,
    }));
    return [...html.matchAll(/href="([^"]*)"/g)].map((match) => decodeURIComponent(match[1]));
  });
}

test("explicit directory scopes qualify later inline filenames across Markdown blocks", () => {
  for (const directory of ["F:/export files/中文/", "F:\\export files\\中文\\", "/tmp/export files/中文/"]) {
    const expected = directory.replaceAll("\\", "/");
    assert.deepEqual(links("Directory: `" + directory + "`\n\n`report.json:12:3`\n\nBackup: `F:/backup/`"), [expected + "report.json:12:3"]);
  }
});

test("directory scopes end at headings and ambiguous declarations, not at later directories", () => {
  assert.deepEqual(links("Output: `F:/out/`\n\n`first.json`\n\n## Other\n\n`second.json`"), ["F:/out/first.json", "second.json"]);
  assert.deepEqual(links("Output: `F:/out/`\n\n`F:/a/` or `F:/b/`\n\n`report.json`"), ["report.json"]);
  assert.deepEqual(links("`before.json`\n\nOutput: `F:/out/`\n\n`after.json`"), ["before.json", "F:/out/after.json"]);
});

test("examples, explicit links, relative paths and Markdown preview retain their meaning", () => {
  assert.deepEqual(links("```txt\nOutput: `F:/out/`\n```\n\n`report.json`"), ["report.json"]);
  assert.deepEqual(links("Output: `F:/out/`\n\n`D:/exact/report.json` and [authored](report.json) and `src/report.json` and `./local.json`"), ["D:/exact/report.json", "report.json", "src/report.json", "local.json"]);
  assert.deepEqual(links("Output: `F:/out/`\n\n`report.json`", "docs"), ["report.json"]);
  assert.deepEqual(links("Output: `F:/out/`\n\n`report.json`", ""), ["report.json"]);
});

test("unsplit documents with reference definitions keep the same directory context", () => {
  assert.deepEqual(links("Output: `F:/out/`\n\n`report.json`\n\n[unused]: https://example.test"), ["F:/out/report.json"]);
});
