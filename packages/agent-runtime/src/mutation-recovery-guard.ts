import { createHash } from "node:crypto";
import { isRecord } from "./agent-messages.js";
import {
  BASH_PATCH_FAILURE_KEY, MAX_MUTATION_RECOVERY_FAILURES,
  RECOVERABLE_MUTATION_ERROR_CODES, bashCommandFailureKey, isPatchCommand,
  type MutationRecoveryKind,
} from "./mutation-recovery.js";

export type MutationTermination = {
  kind: MutationRecoveryKind;
  target: string;
  lastErrorCode?: string;
};

type ToolResult = { ok: boolean; denied?: boolean; errorCode?: string; content: unknown };
type PathFailures = { count: number; graces: Set<string> };
type OwnerFailures = {
  paths: Map<string, PathFailures>;
  commands: Map<string, { count: number; signature: string }>;
};

/** Ignore transport timing/review metadata and retain only a digest of diagnostics. */
function commandFailureSignature(result: ToolResult): string {
  const body = isRecord(result.content) ? result.content : {};
  return createHash("sha256").update(JSON.stringify([
    result.errorCode, body.code, body.exitCode, body.stdout, body.stderr, body.error,
    typeof result.content === "string" ? result.content : undefined,
  ])).digest("hex");
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
    if (!key) return undefined;
    let state = this.owners.get(owner);
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
      state = { paths: new Map(), commands: new Map() };
      this.owners.set(owner, state);
    }
    let count: number;
    if (commandKey) {
      const signature = commandFailureSignature(result);
      const previous = state.commands.get(commandKey);
      count = previous?.signature === signature ? previous.count + 1 : 1;
      state.commands.set(commandKey, { count, signature });
    } else {
      const failures = state.paths.get(key) ?? { count: 0, graces: new Set<string>() };
      state.paths.set(key, failures);
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
