import { IPC, isDelegationApprovalHistoryMarkRead } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";
import type { createDelegationApprovalService } from "../services/delegation-approval";

/** Not exposed through plugin MCP or the generic extension UI bridge. */
export function registerDelegationApprovalIpc({ registrar, approvals }: {
  registrar: IpcRegistrar;
  approvals: Pick<ReturnType<typeof createDelegationApprovalService>, "list" | "respond" | "extend" | "listHistory" | "markHistoryRead" | "clearHistory">;
}): void {
  for (const [channel, action] of [
    [IPC.invoke.delegationApprovalHistoryList, approvals.listHistory],
    [IPC.invoke.delegationApprovalHistoryClear, approvals.clearHistory],
  ] as const) registrar.handleWithEvent(channel, async (event, ...args: unknown[]) => {
    registrar.assertMainWindowSender(event);
    if (args.length) throw new Error("Delegation approval history accepts no arguments");
    return action();
  });
  registrar.handleWithEvent(IPC.invoke.delegationApprovalHistoryMarkRead, async (event, ...args: unknown[]) => {
    registrar.assertMainWindowSender(event);
    if (args.length !== 1 || !isDelegationApprovalHistoryMarkRead(args[0])) throw new Error("Invalid delegation history identity");
    return approvals.markHistoryRead(args[0]);
  });
  registrar.handleWithEvent(IPC.invoke.delegationApprovalList, async (event, ...args: unknown[]) => {
    registrar.assertMainWindowSender(event);
    if (args.length) throw new Error("Delegation approval list accepts no arguments");
    return approvals.list();
  });
  for (const [channel, action] of [
    [IPC.invoke.delegationApprovalRespond, approvals.respond],
    [IPC.invoke.delegationApprovalExtend, approvals.extend],
  ] as const) {
    registrar.handleWithEvent(channel, async (event, ...args: unknown[]) => {
      registrar.assertMainWindowSender(event);
      if (args.length !== 1) return { accepted: false, code: "invalid", error: "One delegation action is required" };
      return action(args[0]);
    });
  }
}
