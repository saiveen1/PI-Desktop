/** Bounds for work performed synchronously while rendering transcript content. */
export const MAX_SYNC_MARKDOWN_CODE_UNITS = 128 * 1024;
export const MAX_STREAMING_MARKDOWN_TAIL_CODE_UNITS = 32 * 1024;
export const MAX_SMOOTH_TEXT_CODE_UNITS = 32 * 1024;
export const MAX_HIGHLIGHT_CODE_UNITS = 100_000;
export const MAX_HIGHLIGHT_LINES = 800;
export const MAX_HIGHLIGHT_LINE_CODE_UNITS = 2_000;
export const MAX_RENDERED_TEXT_PAGE_CODE_UNITS = 32 * 1024;
export const MAX_RENDERED_TEXT_PAGE_LINES = 800;
export const MAX_SYNC_MARKDOWN_LINES = 2_000;

/** Stop before normalization or Markdown parsing when the source is too dense. */
export function isMarkdownSourceTooLarge(source: string): boolean {
  if (source.length > MAX_SYNC_MARKDOWN_CODE_UNITS) return true;
  let lines = 1;
  for (let i = 0; i < source.length; i++) {
    const char = source.charCodeAt(i);
    if ((char === 10 || (char === 13 && source.charCodeAt(i + 1) !== 10)) && ++lines > MAX_SYNC_MARKDOWN_LINES) return true;
  }
  return false;
}

/** Retain only completed page boundaries when a live source grows. */
export function createRenderedTextPager() {
  let previous = "";
  let starts = [0];
  return (source: string, requestedIndex: number, followLatest = false): RenderedTextPage => {
    if (source !== previous) {
      if (!source.startsWith(previous)) starts = [0];
      else if (starts.length > 1) starts.pop();
      let start = starts[starts.length - 1];
      while (start < source.length) {
        let end = Math.min(source.length, start + MAX_RENDERED_TEXT_PAGE_CODE_UNITS);
        let lines = 0;
        for (let i = start; i < end; i++) {
          const char = source.charCodeAt(i);
          if ((char === 10 || (char === 13 && source.charCodeAt(i + 1) !== 10)) && ++lines === MAX_RENDERED_TEXT_PAGE_LINES) {
            end = i + 1;
            break;
          }
        }
        if (end < source.length && isHighSurrogate(source.charCodeAt(end - 1)) && isLowSurrogate(source.charCodeAt(end))) end--;
        if (end < source.length) starts.push(end);
        start = end;
      }
      previous = source;
    }
    const count = starts.length;
    const index = followLatest ? count - 1 : Math.max(0, Math.min(count - 1, Number.isNaN(requestedIndex) ? 0 : Math.floor(requestedIndex)));
    return { text: source.slice(starts[index], starts[index + 1] ?? source.length), index, count };
  };
}

export type RenderedTextPage = {
  text: string;
  index: number;
  count: number;
};

/** Return one bounded, UTF-16-safe page from a potentially large output. */
export function renderedTextPage(source: string, requestedIndex: number, followLatest = false): RenderedTextPage {
  return createRenderedTextPager()(source, requestedIndex, followLatest);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

export type HighlightLimitInspection = {
  within: boolean;
  lineCount: number;
  longestLine: number;
  reason?: "code-length" | "line-count" | "line-length";
};

/** Cheap raw-source guard; call before splitting, parsing, or normalizing code. */
export function inspectHighlightLimits(source: string): HighlightLimitInspection {
  if (source.length > MAX_HIGHLIGHT_CODE_UNITS) {
    return { within: false, lineCount: 0, longestLine: 0, reason: "code-length" };
  }

  let lineCount = 1;
  let lineLength = 0;
  let longestLine = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 0x0a) {
      longestLine = Math.max(longestLine, lineLength);
      lineCount += 1;
      if (lineCount > MAX_HIGHLIGHT_LINES) {
        return { within: false, lineCount, longestLine, reason: "line-count" };
      }
      lineLength = 0;
    } else {
      lineLength += 1;
      if (lineLength > MAX_HIGHLIGHT_LINE_CODE_UNITS) {
        return {
          within: false,
          lineCount,
          longestLine: Math.max(longestLine, lineLength),
          reason: "line-length",
        };
      }
    }
  }
  return {
    within: true,
    lineCount,
    longestLine: Math.max(longestLine, lineLength),
  };
}

export function isWithinHighlightLimits(source: string): boolean {
  return inspectHighlightLimits(source).within;
}
