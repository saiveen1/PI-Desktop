import { SUBAGENT_MESSAGE_MAX_CHARS } from "@pi-desktop/shared";
import type { api } from "../../lib/api";

type Request = Parameters<typeof api.sendSubagentMessage>[0];
type Send = typeof api.sendSubagentMessage;
export type ChildMessageDraft = {
  content: string;
  revision: number;
  pending: boolean;
  error?: string;
  request?: Request;
  acceptedDelegationId?: string;
  acceptedFromId?: string;
};
const EMPTY: ChildMessageDraft = { content: "", revision: 0, pending: false };
export const CHILD_MESSAGE_LIMIT = SUBAGENT_MESSAGE_MAX_CHARS;
export const childMessageOwner = (sessionId: string, chainId: string) => JSON.stringify([sessionId, chainId]);

/** Draft and transport retry ownership outlive an individual work-panel mount. */
export function createChildMessageController(newId = () => crypto.randomUUID()) {
  const drafts = new Map<string, ChildMessageDraft>();
  const listeners = new Set<() => void>();
  const get = (owner: string) => drafts.get(owner) ?? EMPTY;
  const put = (owner: string, next: ChildMessageDraft) => {
    drafts.set(owner, next);
    for (const listener of listeners) listener();
  };
  return {
    get,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    edit(owner: string, content: string) {
      const previous = get(owner);
      if (content === previous.content) return;
      put(owner, { ...previous, content, revision: previous.revision + 1, request: undefined });
    },
    async send(owner: string, target: { sessionId: string; delegationId: string }, send: Send,
      isCurrent: () => boolean = () => true) {
      const before = get(owner);
      if (before.pending || !before.content.trim() || before.content.length > CHILD_MESSAGE_LIMIT) return;
      // A transport failure may have reached the host. Retry the entire original
      // request, even if that first delivery already advanced the chain.
      const request = before.request ?? { ...target,
        delegationId: target.delegationId === before.acceptedFromId
          ? before.acceptedDelegationId ?? target.delegationId : target.delegationId,
        messageId: newId(), content: before.content };
      put(owner, { ...before, request, pending: true });
      try {
        const result = await send(request);
        const current = get(owner);
        if (!result.accepted) {
          put(owner, { ...current, pending: false, request: undefined, error: result.error });
          return;
        }
        const unchanged = current.revision === before.revision;
        put(owner, { ...current, pending: false, error: undefined, request: undefined,
          acceptedDelegationId: result.delegationId,
          acceptedFromId: target.delegationId,
          ...(unchanged && isCurrent() ? { content: "" } : {}) });
      } catch (error) {
        const current = get(owner);
        put(owner, { ...current, pending: false,
          error: error instanceof Error ? error.message : String(error),
          ...(current.revision === before.revision ? { request } : { request: undefined }) });
      }
    },
  };
}

export const childMessages = createChildMessageController();
