import { api } from "./api";

/** Tool-call IDs are provider-local; Host may namespace the stored message ID. */
export async function resolveObserverEvidenceMessageId(
  sessionId: string,
  evidenceId: string,
  read: typeof api.getSession = api.getSession,
): Promise<string | undefined> {
  for (const id of [evidenceId, `${sessionId}:${evidenceId}`]) {
    const { session } = await read(sessionId, { messageAround: id, messageLimit: 1, contentLimit: 256 });
    if (!session) continue;
    if (session.id !== sessionId) return;
    const message = session.messages.find(row => row.id === id);
    if (message && (id === evidenceId || (message.role === "tool" && message.toolCallId === evidenceId))) return id;
  }
}
