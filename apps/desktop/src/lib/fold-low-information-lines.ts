/** Display-only folding on one bounded text page; raw source is never changed. */
export function foldLowInformationLines(source: string, label: (count: number) => string): string {
  const lines = source.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const result: string[] = [];
  for (let i = 0; i < lines.length;) {
    let end = i;
    while (end < lines.length && lines[end].length <= 18 && /^[\s\p{P}\p{S}\u200B-\u200F\u2060\uFEFF]*$/u.test(lines[end])) end++;
    if (end - i >= 80) {
      result.push(`${label(end - i)}\n`);
      i = end;
    } else {
      result.push(lines[i]);
      i++;
    }
  }
  return result.join("");
}
