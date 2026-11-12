import assert from "node:assert/strict";
import test from "node:test";
import { foldLowInformationLines } from "../src/lib/fold-low-information-lines.ts";
import {
  createRenderedTextPager,
  isMarkdownSourceTooLarge,
  MAX_SYNC_MARKDOWN_LINES,
  inspectHighlightLimits,
  isWithinHighlightLimits,
  MAX_HIGHLIGHT_CODE_UNITS,
  MAX_HIGHLIGHT_LINES,
  MAX_HIGHLIGHT_LINE_CODE_UNITS,
  MAX_RENDERED_TEXT_PAGE_CODE_UNITS,
  renderedTextPage,
} from "../src/lib/render-content-limits.ts";

test("highlight boundaries are checked in UTF-16 units before splitting", () => {
  const maximumSource = ("x".repeat(999) + "\n").repeat(100);
  assert.equal(maximumSource.length, MAX_HIGHLIGHT_CODE_UNITS);
  assert.equal(isWithinHighlightLimits(maximumSource), true);
  assert.deepEqual(inspectHighlightLimits("x".repeat(MAX_HIGHLIGHT_CODE_UNITS + 1)), {
    within: false,
    lineCount: 0,
    longestLine: 0,
    reason: "code-length",
  });
  assert.equal(isWithinHighlightLimits("x".repeat(MAX_HIGHLIGHT_LINE_CODE_UNITS)), true);
  assert.equal(isWithinHighlightLimits("x".repeat(MAX_HIGHLIGHT_LINE_CODE_UNITS + 1)), false);
  assert.equal(isWithinHighlightLimits(Array.from({ length: MAX_HIGHLIGHT_LINES }, () => "x").join("\n")), true);
  assert.equal(isWithinHighlightLimits(Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, () => "x").join("\n")), false);
});

test("large text pages stay bounded and reconstruct the complete source", () => {
  const source = `start\n${"x".repeat(MAX_RENDERED_TEXT_PAGE_CODE_UNITS * 4)}\nend`;
  const first = renderedTextPage(source, 0);
  const latest = renderedTextPage(source, 0, true);
  assert.equal(first.index, 0);
  assert.equal(first.count, 5);
  assert.ok(first.text.length <= MAX_RENDERED_TEXT_PAGE_CODE_UNITS);
  assert.equal(latest.index, latest.count - 1);
  assert.ok(latest.text.endsWith("\nend"));
  assert.equal(renderedTextPage(source, Number.NaN).index, 0);
  assert.equal(
    Array.from({ length: first.count }, (_, index) => renderedTextPage(source, index).text).join(""),
    source,
  );
  assert.equal(renderedTextPage(source, Number.POSITIVE_INFINITY).index, first.count - 1);
});

test("large text page boundaries never split a surrogate pair", () => {
  const prefix = "x".repeat(MAX_RENDERED_TEXT_PAGE_CODE_UNITS - 1);
  const source = `${prefix}😀${"y".repeat(MAX_RENDERED_TEXT_PAGE_CODE_UNITS)}`;
  const pages = Array.from(
    { length: Math.ceil(source.length / MAX_RENDERED_TEXT_PAGE_CODE_UNITS) },
    (_, index) => renderedTextPage(source, index).text,
  );
  assert.equal(pages.join(""), source);
  assert.ok(pages.every((page) => !/^[\uDC00-\uDFFF]/.test(page)));
  assert.ok(pages.every((page) => !/[\uD800-\uDBFF]$/.test(page)));
});

test("dense newline output is paged by line as well as character count", () => {
  const source = ":\n\n".repeat(12_300);
  const first = renderedTextPage(source, 0);
  assert.ok(first.count > 1);
  assert.ok(first.text.split("\n").length <= 801);
  assert.equal(Array.from({ length: first.count }, (_, i) => renderedTextPage(source, i).text).join(""), source);
});

test("markdown line guard catches both dense reproductions before parsing", () => {
  assert.equal(isMarkdownSourceTooLarge(":\n\n".repeat(12_300)), true);
  assert.equal(isMarkdownSourceTooLarge(":\n\n".repeat(36_000)), true);
  assert.equal(isMarkdownSourceTooLarge("x\n".repeat(MAX_SYNC_MARKDOWN_LINES - 1)), false);
  assert.equal(isMarkdownSourceTooLarge("x\n".repeat(MAX_SYNC_MARKDOWN_LINES)), true);
  assert.equal(isMarkdownSourceTooLarge("x\r".repeat(MAX_SYNC_MARKDOWN_LINES)), true);
  assert.ok(renderedTextPage("x\r".repeat(2_000), 0).count > 1);
});

test("streaming pager follows appends and resets on replacement", () => {
  const page = createRenderedTextPager();
  const first = ":\n\n".repeat(2_000);
  const next = first + "new\n".repeat(2_000);
  assert.equal(page(first, 0, true).text, renderedTextPage(first, 0, true).text);
  assert.equal(page(next, 0, true).text, renderedTextPage(next, 0, true).text);
  assert.equal(page("replacement", 999).text, "replacement");
  assert.equal(page("replacement", 999).count, 1);
});

test("page-local folding preserves normal text and supports all line endings", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const source = `Introduction${newline}${(`:${newline}${newline}`).repeat(100)}Result`;
    assert.equal(foldLowInformationLines(source, (count) => `[${count} folded]`), `Introduction${newline}[200 folded]\nResult`);
  }
  const code = "const x = 1;\n".repeat(100);
  assert.equal(foldLowInformationLines(code, () => "unexpected"), code);
  assert.equal(foldLowInformationLines("-\n".repeat(79), () => "unexpected"), "-\n".repeat(79));
});

test("multi-megabyte repetition is folded only after bounded raw pagination", () => {
  const source = ":\n\n".repeat(500_000);
  const pager = createRenderedTextPager();
  for (const index of [0, 300, 700]) {
    const page = pager(source, index);
    assert.ok(page.text.length <= MAX_RENDERED_TEXT_PAGE_CODE_UNITS);
    assert.ok(page.text.split("\n").length <= 801);
    assert.ok(foldLowInformationLines(page.text, (count) => `${count} folded`).length < 100);
  }
});
