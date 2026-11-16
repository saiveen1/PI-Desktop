import type { AssistantMessage } from "@earendil-works/pi-ai";
import { DEFAULT_AGENT_OUTPUT_GUARD_SETTINGS, resolveAgentOutputGuardSettings, type AgentOutputGuardSettings, type ResolvedAgentOutputGuardSettings } from "@pi-desktop/shared";
import { RepeatedParagraphDetector } from "./model-output-paragraph.js";

export const REPETITIVE_OUTPUT_MIN_CHARS = DEFAULT_AGENT_OUTPUT_GUARD_SETTINGS.symbolMinChars;
export const REPETITIVE_OUTPUT_MIN_LINES = DEFAULT_AGENT_OUTPUT_GUARD_SETTINGS.symbolMinLines;
export const REPETITIVE_OUTPUT_SINGLE_LINE_CHARS = DEFAULT_AGENT_OUTPUT_GUARD_SETTINGS.symbolSingleLineChars;

export type OutputRepetitionDetails = {
  channel: "text" | "thinking";
  repeatedChars: number;
  repeatedLines: number;
  repetitionKind?: "paragraph";
};

// Error provenance is local, never inferred from provider-supplied prose.
const failures = new WeakMap<object, OutputRepetitionDetails>();
export function markOutputRepetition(message: AssistantMessage, details: OutputRepetitionDetails): AssistantMessage {
  failures.set(message, details);
  return message;
}
export function readOutputRepetition(value: unknown): OutputRepetitionDetails | undefined {
  return value !== null && typeof value === "object" ? failures.get(value) : undefined;
}

/** Incremental whitespace/symbol protection plus bounded exact-prose detection. */
export class RepetitiveOutputDetector {
  private chars = 0;
  private lines = 0;
  private linePrefix = "";
  private fence: { marker: string; length: number } | undefined;
  private readonly settings: ResolvedAgentOutputGuardSettings;
  private readonly paragraphs: RepeatedParagraphDetector;

  constructor(settings?: AgentOutputGuardSettings) {
    this.settings = resolveAgentOutputGuardSettings(settings);
    this.paragraphs = new RepeatedParagraphDetector(this.settings);
  }

  push(delta: string, terminal = false): Omit<OutputRepetitionDetails, "channel"> | undefined {
    if (!this.settings.repetitiveOutputEnabled) return;
    for (const char of delta) {
      if (char === "\n") {
        const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(this.linePrefix);
        if (delimiter) {
          if (!this.fence) this.fence = { marker: delimiter[1][0], length: delimiter[1].length };
          else if (delimiter[1][0] === this.fence.marker && delimiter[1].length >= this.fence.length && !delimiter[2].trim()) this.fence = undefined;
        }
        this.linePrefix = "";
      } else if (this.linePrefix.length < 256) this.linePrefix += char;
      // A fence opener owns its whole line, including long space-only suffixes.
      if (this.fence || (char !== "\n" && /^ {0,3}(?:`{3,}|~{3,})/.test(this.linePrefix))) {
        this.resetRun();
        continue;
      }
      if (!/[\s\p{P}\p{S}\u200B-\u200F\u2060\uFEFF]/u.test(char)) { this.resetRun(); continue; }
      this.chars++;
      if (char === "\n") this.lines++;
      if ((this.chars >= this.settings.symbolMinChars && this.lines >= this.settings.symbolMinLines) ||
        this.chars >= this.settings.symbolSingleLineChars) {
        return { repeatedChars: this.chars, repeatedLines: this.lines };
      }
    }
    return this.settings.repeatedParagraphsEnabled ? this.paragraphs.push(delta, terminal) : undefined;
  }

  private resetRun(): void {
    this.chars = 0;
    this.lines = 0;
  }
}
