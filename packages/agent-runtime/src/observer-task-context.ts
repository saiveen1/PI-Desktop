import type { UiMessage } from "@pi-desktop/shared";
import { actionableUserTask } from "./early-end.js";
import type { ObserverEvidence } from "./observer-guard-evidence.js";

const MAX_USERS = 6;
const MAX_TEXT_CHARS = 20_000;

// shortcut: explicit English/Chinese continuation prefixes only; other requests keep current-turn evidence.
const CONTINUATION_PREFIX = /^(?:please\s+)?(?:continue|proceed|go ahead|resume|keep going)(?=$|[\s.,!;])|^(?:请)?(?:继续|接着做|接着完成|接着验证|接着修复)/i;
export function isObserverContinuation(task: string): boolean {
  return CONTINUATION_PREFIX.test(task.trim()) && !/\binstead\b|\b(?:new|different|another) task\b|\bswitch to\b|\bforget (?:the )?(?:previous|old)\b|(?:改为|改做|换个|换成|另一个|新任务)/i.test(task);
}

export function actionableObserverTask(task: string, hasToolProgress: boolean): boolean {
  // Preserve compound no-execution instructions before removing object-preservation clauses.
  if (/(?:不要|不得|禁止)\s*(?:执行|运行)|\b(?:do not|don't|never)\s+(?:execute|run)\b/i.test(task)) return false;
  // These clauses constrain an affirmative task; the reviewer still receives their original text.
  const intent = task.replace(/(?:^|[。.!?！？;；,，\n])\s*(?:不要|不得|禁止)(?:修改|删除|覆盖|改动)[^。.!?！？;；,，\n]+/g, " ").trim();
  return actionableUserTask(isObserverContinuation(intent) ? intent.replace(CONTINUATION_PREFIX, "continue ") : intent, hasToolProgress);
}

export type ObserverTaskContext = {
  evidence: ObserverEvidence[];
  truncated: boolean;
  actionable: boolean;
};

type RetainedEvidence = ObserverEvidence & { truncated: boolean };

/** Bounded task evidence, not an execution authority or another transcript store. */
export class ObserverTaskHistory {
  private rows: RetainedEvidence[] = [];
  private missingGoal = false;
  private actionable = false;

  constructor(history: readonly UiMessage[] = []) {
    for (const row of history) {
      if (row.parentToolCallId) continue;
      if (row.role === "user") {
        if (row.sessionMessage || row.steering) this.clear();
        else this.user(row.id, row.content, Boolean(row.attachments?.length));
      } else if (row.role === "assistant" && row.status !== "error" && row.status !== "aborted" && row.status !== "streaming" && !row.error && !row.isError) {
        this.answer(row.id, row.content, Boolean(row.outputTruncated));
      }
    }
  }

  clear(): void { this.rows = []; this.missingGoal = false; this.actionable = false; }

  context(task: string): ObserverTaskContext | undefined {
    if (!isObserverContinuation(task)) return;
    return {
      evidence: this.rows.map(({ truncated: _truncated, ...row }) => ({ ...row })),
      truncated: this.rows.length > 0 && (this.missingGoal || this.rows.some(row => row.truncated)),
      actionable: this.rows.length > 0 && !this.missingGoal && this.actionable,
    };
  }

  user(id: string, task: string, omittedAttachments = false): void {
    if (!isObserverContinuation(task)) {
      this.clear();
      this.actionable = actionableObserverTask(task, false);
    } else if (!this.rows.length) this.missingGoal = true;
    else this.actionable &&= actionableObserverTask(task, true);
    // A new user turn supersedes the previous reply; a failed turn must not revive it.
    this.rows = this.rows.filter(row => row.kind === "prior_user");
    this.rows.push(this.row(id, "prior_user", task, omittedAttachments));
    if (this.rows.length > MAX_USERS) { this.rows.shift(); this.missingGoal = true; }
  }

  answer(id: string, text: string, truncated = false): void {
    if (!this.rows.length || !text.trim()) return;
    this.rows = this.rows.filter(row => row.kind === "prior_user");
    this.rows.push(this.row(id, "prior_assistant", text, truncated));
  }

  private row(id: string, kind: "prior_user" | "prior_assistant", text: string, truncated: boolean): RetainedEvidence {
    return { id, kind, text: text.slice(0, MAX_TEXT_CHARS), truncated: truncated || text.length > MAX_TEXT_CHARS };
  }
}
