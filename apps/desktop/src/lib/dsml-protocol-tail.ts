import { isTopLevelProseOffset } from "./markdown-blocks";

const end = "</｜DSML｜ calls>";
// A scalar parameter and/or unmatched closing tags, never a full call envelope.
const orphan = /^(?:<\/｜DSML｜ parameter>\s*)?(?:<｜DSML｜ parameter name="[\w.-]+" string="(?:true|false)">[^\r\n]*?<\/｜DSML｜ parameter>\s*)?(?:<\/｜DSML｜ invoke>\s*)?<\/｜DSML｜ calls>$/u;

/** Display projection only. Never parse arguments, synthesize calls or alter message content. */
export function splitDsmlProtocolTail(source: string): { prose: string; tail: string } | undefined {
  const trimmed = source.trimEnd();
  if (!trimmed.endsWith(end)) return;
  let start = trimmed.lastIndexOf("\n") + 1;
  // Walk only consecutive protocol lines. If the preceding line mixes prose with a tag,
  // do not peel its closing tags off and misrepresent a literal example as a tool attempt.
  while (start > 0) {
    const prior = trimmed.lastIndexOf("\n", start - 2) + 1;
    if (prior >= start) break;
    const line = trimmed.slice(prior, start - 1);
    if (!/^ {0,3}<\/?｜DSML｜ /.test(line)) {
      if (line.includes("｜DSML｜")) return;
      break;
    }
    start = prior;
  }
  const candidate = trimmed.slice(start);
  const tag = candidate.search(/\S/);
  if (tag < 0 || !/^ {0,3}</.test(candidate) || /(?:^|\n)(?: {4}|\t)/.test(candidate)) return;
  const suffix = candidate.slice(tag);
  if (suffix === end || !orphan.test(suffix) || !isTopLevelProseOffset(source, start + tag)) return;
  const prose = source.slice(0, start);
  // An opening envelope can span multiple parameter lines, including blank lines.
  if (prose.lastIndexOf("<｜DSML｜ calls>") > prose.lastIndexOf(end)) return;
  return { prose, tail: source.slice(start) };
}
