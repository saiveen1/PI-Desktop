import { describe, expect, it } from "vitest";
import { isAgentSendSubagentMessageRequest, SUBAGENT_MESSAGE_MAX_CHARS } from "./types/agent.js";
import { IPC, IPC_WHITELIST } from "./protocol.js";

describe("direct subagent message contract", () => {
  const valid = { sessionId: "session", delegationId: "child", messageId: "message", content: "Check the edge case." };
  it("declares one allowlisted local channel and bounded text", () => {
    expect(IPC_WHITELIST.has(IPC.invoke.agentSendSubagentMessage)).toBe(true);
    expect(isAgentSendSubagentMessageRequest(valid)).toBe(true);
    expect(isAgentSendSubagentMessageRequest({ ...valid, content: "x".repeat(SUBAGENT_MESSAGE_MAX_CHARS) })).toBe(true);
  });
  it.each([null, [], {}, { ...valid, content: " " }, { ...valid, messageId: "" },
    { ...valid, sessionId: 1 }, { ...valid, delegationId: "x".repeat(257) },
    { ...valid, content: "x".repeat(SUBAGENT_MESSAGE_MAX_CHARS + 1) }, { ...valid, model: "override" }])("rejects malformed or authority-expanding input %#", input => {
    expect(isAgentSendSubagentMessageRequest(input)).toBe(false);
  });
});
