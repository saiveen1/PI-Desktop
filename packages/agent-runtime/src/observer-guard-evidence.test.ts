import { describe, expect, it } from "vitest";
import { parseObserverDecision, redactObserverText } from "./observer-guard-evidence.js";

describe("simple observer decision boundary", () => {
  it.each(["continue", "stop", " CONTINUE\n", "Stop"])("accepts an exact decision %s", value => {
    expect(parseObserverDecision(value)).toBe(value.trim().toLowerCase());
  });
  it.each(["continue please", "stop then continue", "{\"decision\":\"continue\"}", "```continue```", "", "continue" + " ".repeat(40)])("rejects extra instructions and malformed output %s", value => {
    expect(parseObserverDecision(value)).toBeUndefined();
  });
  it("redacts common and explicitly known credentials without changing ordinary prose", () => {
    const safe = redactObserverText("password=pass api_key=key Bearer abcdefgh sk-proj-123456789 github_pat_abcdefgh https://name:pass@example.test known-sensitive", ["known-sensitive"]);
    for (const secret of ["=pass", "=key", "abcdefgh", "123456789", "name:pass", "known-sensitive"]) expect(safe).not.toContain(secret);
    expect(redactObserverText("Investigate the refusal and permission tests?")).toBe("Investigate the refusal and permission tests?");
  });
  it("redacts private key blocks and preserves valid Unicode under a length bound", () => {
    expect(redactObserverText("-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----")).toBe("[REDACTED]");
    expect(redactObserverText("x🙂", [], 2)).toBe("x");
  });
});
