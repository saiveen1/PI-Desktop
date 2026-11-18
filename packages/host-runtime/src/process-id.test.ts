import { expect, it } from "vitest";
import { AgentSidecar } from "./agent-sidecar.js";
import { HostProcess } from "./host-process.js";

it("exposes the two live owned child PIDs and clears them on dispose", async () => {
  // Plain Node fixtures need no host database, Desktop or credentials.
  const host = new HostProcess({ binaryPath: process.execPath, dataDir: "unused", env: { NODE_OPTIONS: "" }, onStderr() {} });
  const agent = new AgentSidecar({ launch: { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: {} }, onStderr() {} });
  try {
    const pids = [host.processId, agent.processId];
    expect(new Set(pids).size).toBe(2);
    for (const pid of pids) {
      if (pid === null) throw new Error("Fixture process did not spawn");
      expect(pid).not.toBe(process.pid);
      expect(process.kill(pid, 0)).toBe(true);
    }
  } finally {
    const stopped = Promise.all([host.dispose(), agent.dispose()]);
    expect(host.processId).toBeNull();
    expect(agent.processId).toBeNull();
    await stopped;
  }
});