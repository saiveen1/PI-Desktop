import { createHash } from "node:crypto";
import { isRecord } from "./agent-messages.js";
import {
  BASH_PATCH_FAILURE_KEY, MAX_MUTATION_RECOVERY_FAILURES,
  RECOVERABLE_MUTATION_ERROR_CODES, bashCommandFailureKey, isPatchCommand,
  type MutationRecoveryKind,
} from "./mutation-recovery.js";

export const MAX_HOST_ADMISSION_FAILURES = 3;
export const MAX_REVEAL_PROGRESS_GRACES = 8;

export type MutationTermination = {
  kind: MutationRecoveryKind;
  target: string;
  lastErrorCode?: string;
};

type ToolResult = { ok: boolean; denied?: boolean; errorCode?: string; content: unknown };
type PathFailures = { count: number; graces: Set<string>; revealed: Set<string>; revealGraces: number };
type OwnerFailures = {
  paths: Map<string, PathFailures>;
  commands: Map<string, { count: number; signature: string }>;
  admission: Map<string, number>;
};

/** Ignore transport timing/review metadata and retain only a digest of diagnostics. */
function commandFailureSignature(result: ToolResult): string {
  const body = isRecord(result.content) ? result.content : {};
  return createHash("sha256").update(JSON.stringify([
    result.errorCode, body.code, body.exitCode, body.stdout, body.stderr, body.error,
    typeof result.content === "string" ? result.content : undefined,
  ])).digest("hex");
}

function hasNewCompleteReveal(content: unknown, failures: PathFailures): boolean {
  if (failures.revealGraces >= MAX_REVEAL_PROGRESS_GRACES || !isRecord(content) ||
      content.merged !== true || content.revealTruncated !== false ||
      !Array.isArray(content.unseenLines) || content.unseenLines.length === 0 ||
      content.unseenLines.length > 128 || content.unseenCount !== content.unseenLines.length) return false;
  const keys: string[] = [];
  for (const row of content.unseenLines) {
    if (!isRecord(row) || typeof row.line !== "number" || !Number.isSafeInteger(row.line) || row.line < 1 ||
        typeof row.text !== "string" || row.clipped !== false) return false;
    keys.push(createHash("sha256").update(JSON.stringify([row.line, row.text])).digest("hex"));
  }
  if (keys.every(key => failures.revealed.has(key))) return false;
  for (const key of keys) failures.revealed.add(key);
  failures.revealGraces++;
  return true;
}

/** Budgets belong to the executing agent; successful file work permits a retest. */
export class MutationRecoveryGuard {
  private readonly owners = new Map<string, OwnerFailures>();

  observe(input: {
    owner: string;
    toolName: string;
    path?: string;
    pathKey?: string;
    command?: unknown;
    result: ToolResult;
  }): MutationTermination | undefined {
    const { owner, toolName, path, pathKey, command, result } = input;
    if (result.denied || result.errorCode === "TOOL_ABORTED") return undefined;
    const fileTool = toolName === "Edit" || toolName === "Write";
    const patch = toolName === "Bash" && isPatchCommand(command);
    const commandKey = toolName === "Bash" && !patch ? bashCommandFailureKey(command) : undefined;
    const key = fileTool ? pathKey : patch ? BASH_PATCH_FAILURE_KEY : commandKey;
    const admissionClass = fileTool ? "mutation" : ["Read", "Glob", "Grep"].includes(toolName) ? "read" : toolName;
    let state = this.owners.get(owner);
    if (!result.ok && result.errorCode === "HOST_OVERLOADED") {
      if (!state) {
        state = { paths: new Map(), commands: new Map(), admission: new Map() };
        this.owners.set(owner, state);
      }
      const count = (state.admission.get(admissionClass) ?? 0) + 1;
      state.admission.set(admissionClass, count);
      return count < MAX_HOST_ADMISSION_FAILURES ? undefined
        : { kind: "host-admission", target: toolName, lastErrorCode: "HOST_OVERLOADED" };
    }
    if (result.ok) state?.admission.delete(admissionClass);
    if (!key) return undefined;
    if (result.ok) {
      if (!state) return undefined;
      if (commandKey) state.commands.delete(commandKey);
      else {
        state.paths.delete(key);
        // A fix can make the previously failing build/test meaningful again.
        state.commands.clear();
      }
      return undefined;
    }
    if (!state) {
      state = { paths: new Map(), commands: new Map(), admission: new Map() };
      this.owners.set(owner, state);
    }
    let count: number;
    if (commandKey) {
      const signature = commandFailureSignature(result);
      const previous = state.commands.get(commandKey);
      count = previous?.signature === signature ? previous.count + 1 : 1;
      state.commands.set(commandKey, { count, signature });
    } else {
      const failures = state.paths.get(key) ?? { count: 0, graces: new Set<string>(), revealed: new Set<string>(), revealGraces: 0 };
      state.paths.set(key, failures);
      if (toolName === "Edit" && result.errorCode === "EDIT_LINES_UNSEEN" && hasNewCompleteReveal(result.content, failures)) {
        failures.graces.add(result.errorCode);
        return undefined;
      }
      if (toolName === "Edit" && result.errorCode &&
        RECOVERABLE_MUTATION_ERROR_CODES.has(result.errorCode) && !failures.graces.has(result.errorCode)) {
        failures.graces.add(result.errorCode);
        return undefined;
      }
      count = ++failures.count;
    }
    if (count < MAX_MUTATION_RECOVERY_FAILURES) return undefined;
    const kind: MutationRecoveryKind = fileTool ? (toolName === "Write" ? "write" : "edit")
      : patch ? "patch-command" : "command";
    return {
      kind,
      target: fileTool ? path ?? key : patch ? "the patch command" : "the same Bash command",
      ...(result.errorCode ? { lastErrorCode: result.errorCode } : {}),
    };
  }

  clear(owner?: string): void {
    if (owner === undefined) this.owners.clear();
    else this.owners.delete(owner);
  }
}
