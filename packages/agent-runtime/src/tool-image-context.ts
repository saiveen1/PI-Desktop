import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool } from "@earendil-works/pi-agent-core";

// Delegates reuse Host tools, but image admission belongs to the invoking model.
const imageCapability = new AsyncLocalStorage<() => boolean>();

export function activeToolSupportsImages(fallback: boolean): boolean {
  return imageCapability.getStore()?.() ?? fallback;
}

export function withToolImageCapability(tool: AgentTool, supportsImages: () => boolean): AgentTool {
  return {
    ...tool,
    execute: (...args) => imageCapability.run(supportsImages, () => tool.execute(...args)),
  };
}
