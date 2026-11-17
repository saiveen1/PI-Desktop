import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import {
  answer, dsmlTail, messageFrames, reasoning, reasoningFrames, responseBody,
  responsesModel, toolFrames,
} from "./test-support/responses-terminal-fixture.js";

describe("Responses terminal content through a Desktop turn", () => {
  it.each(["blank", "dsml-tail"])("settles visible content without replaying the sibling tool: %s", async (finalKind) => {
    const text = finalKind === "dsml-tail" ? `${answer}\n${dsmlTail}` : answer;
    const requests: string[] = [];
    const events: AgentEventEnvelope["event"][] = [];
    let toolExecutions = 0;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(body);
      if (requests.length > 2) {
        response.writeHead(400).end("Unexpected extra request");
        return;
      }
      const frames = requests.length === 1 ? [
        ...reasoningFrames(0, reasoning, " "),
        ...messageFrames(1, text, [{ type: "output_text", text: finalKind === "dsml-tail" ? dsmlTail : "" }]),
        ...toolFrames(2),
      ] : messageFrames(0, "The requested work is complete.", [{ type: "output_text", text: "The requested work is complete." }]);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(responseBody(frames));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const runtime = new DesktopAgentRuntime({
      sessionId: "terminal-content-fixture", mode: "agent", thinkingLevel: "high",
      provider: {
        id: "fixture", name: "Fixture", modelId: responsesModel.id, apiKey: "fixture",
        baseUrl, apiStyle: "responses", supportsReasoning: true, supportedThinkingLevels: ["high"],
        modelConfig: { ...responsesModel, source: "generic", baseUrl },
      },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: {
        call: async <T>(method: string): Promise<T> => {
          if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
          if (method === "provider.delegationSnapshot" || method === "session.appendMessage") return undefined as T;
          if (method === "todos.get") return { sessionId: "terminal-content-fixture", todos: [] } as T;
          if (method === "tools.execute") {
            toolExecutions++;
            return { ok: true, content: { content: [{ type: "text", text: "Checked once." }], details: {} } } as T;
          }
          throw new Error(`Unexpected Host method: ${method}`);
        },
        onNotification: () => () => {},
      },
      onEvent: (envelope) => events.push(structuredClone(envelope.event)),
    });
    try {
      await runtime.prompt("Run the requested check once and report the result.");
      const settled = events.filter((event) => event.type === "message_end").map((event) => event.message);
      expect(settled[0]).toMatchObject({ content: text, thinking: reasoning,
        status: finalKind === "dsml-tail" ? "error" : "complete" });
      if (finalKind === "dsml-tail") expect(settled[0].error?.code).toBe("TOOL_CALL_NOT_EXECUTED");
      else expect(settled[0].error).toBeUndefined();
      expect(settled.at(-1)).toMatchObject({ status: "complete", content: "The requested work is complete." });
      expect(toolExecutions).toBe(1);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toContain(answer);
      expect(events.filter((event) => event.type === "tool_start")).toHaveLength(1);
      expect(events.filter((event) => event.type === "error")).toHaveLength(0);
      expect(runtime.getStatus().isRunning).toBe(false);
      const replay = settled[0].providerReplay?.blocks.find((block) => block.type === "thinking");
      expect(replay).toMatchObject({ length: reasoning.length });
      if (!replay || replay.type !== "thinking" || !replay.signature) throw new Error("Missing preserved reasoning replay");
      expect(JSON.parse(replay.signature).summary).toEqual([{ type: "summary_text", text: " " }]);
    } finally {
      await runtime.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
