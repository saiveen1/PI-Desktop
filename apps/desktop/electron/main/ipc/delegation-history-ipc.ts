import { IPC, isDelegationRunHistoryPage, isDelegationRunHistoryQuery } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";
import type { DelegationHost } from "../services/delegation-catalog";

export function registerDelegationHistoryIpc({ registrar, getHost }: {
  registrar: IpcRegistrar; getHost: () => DelegationHost | null;
}): void {
  registrar.handleWithEvent(IPC.invoke.delegationHistoryList, async (event, ...args: unknown[]) => {
    registrar.assertMainWindowSender(event);
    const query = args.length ? args[0] : {};
    if (args.length > 1 || !isDelegationRunHistoryQuery(query)) throw new Error("Invalid delegation history query");
    const host = getHost();
    if (!host) throw new Error("Delegation history host unavailable");
    const page: unknown = await host.call("delegation.history.list", query);
    if (!isDelegationRunHistoryPage(page)) throw new Error("Invalid delegation history response");
    return page;
  });
}
