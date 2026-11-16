import type { ResolvedAgentOutputGuardSettings } from "@pi-desktop/shared";

/** A bounded comparison sample, not an output limit. Longer paragraphs are ignored. */
const MAX_PARAGRAPH_CHARS = 8192;
const STRUCTURED_LINE = /^(?: {4}|\t|\s*(?:[>|#]|[-*+]\s|\d+[.)]\s|[\[\]{}]|(?:const|let|var|return|import|export|function|class|def|SELECT|INSERT)\b|\d{4}-\d{2}-\d{2}[T ]))/;

type Repetition = { repeatedChars: number; repeatedLines: number; repetitionKind: "paragraph" };

/** Exact consecutive narrative paragraphs only; no semantic quality judgement. */
export class RepeatedParagraphDetector {
  private line = "";
  private lineOverflow = false;
  private paragraph = "";
  private paragraphLines = 0;
  private excluded = false;
  private fence: { marker: string; length: number } | undefined;
  private previous = "";
  private repeats = 0;
  private repeatedLines = 0;

  constructor(private readonly settings: ResolvedAgentOutputGuardSettings) {}

  push(delta: string, terminal = false): Repetition | undefined {
    for (const char of delta) {
      if (char === "\n") {
        const result = this.consumeLine();
        if (result) return result;
      } else if (this.line.length < MAX_PARAGRAPH_CHARS) this.line += char;
      else this.lineOverflow = true;
    }
    if (terminal) {
      const result = this.consumeLine();
      if (result) return result;
      return this.finishParagraph();
    }
    return undefined;
  }

  private consumeLine(): Repetition | undefined {
    const line = this.line.replace(/\r$/, "");
    const overflow = this.lineOverflow;
    this.line = "";
    this.lineOverflow = false;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!this.fence) this.fence = { marker: delimiter[1][0], length: delimiter[1].length };
      else if (delimiter[1][0] === this.fence.marker && delimiter[1].length >= this.fence.length && !delimiter[2].trim()) this.fence = undefined;
      this.clearParagraph();
      this.resetStreak();
      return;
    }
    if (this.fence) return;
    if (!line.trim() && !overflow) return this.finishParagraph();
    this.paragraphLines++;
    if (overflow || STRUCTURED_LINE.test(line) || /[{};]|\|.*\|/.test(line) || this.paragraph.length + line.length + 1 > MAX_PARAGRAPH_CHARS) {
      this.excluded = true;
      this.paragraph = "";
    }
    if (!this.excluded) this.paragraph += (this.paragraph ? "\n" : "") + line;
    return undefined;
  }

  private finishParagraph(): Repetition | undefined {
    if (!this.paragraphLines) return;
    const text = this.paragraph.replace(/\s+/gu, " ").trim();
    const lines = this.paragraphLines;
    // Short items and machine-oriented data are deliberately outside this guard.
    const narrative = !this.excluded && /[.!?。！？]/u.test(text) &&
      (text.match(/\p{L}/gu)?.length ?? 0) >= 32;
    this.clearParagraph();
    if (!narrative) { this.resetStreak(); return; }
    if (text === this.previous) { this.repeats++; this.repeatedLines += lines; }
    else { this.previous = text; this.repeats = 1; this.repeatedLines = lines; }
    const repeatedChars = text.length * this.repeats;
    if (this.repeats >= this.settings.repeatedParagraphMinRepeats && repeatedChars >= this.settings.repeatedParagraphMinChars) {
      return { repeatedChars, repeatedLines: this.repeatedLines, repetitionKind: "paragraph" };
    }
    return undefined;
  }

  private clearParagraph(): void {
    this.paragraph = "";
    this.paragraphLines = 0;
    this.excluded = false;
  }

  private resetStreak(): void {
    this.previous = "";
    this.repeats = 0;
    this.repeatedLines = 0;
  }
}
