import { describe, expect, it } from "vitest";
import { classifyAgentError } from "./agent-errors.js";

describe("unknown upstream bad-request classification", () => {
  it.each([400, 422])("separates a generic upstream %s wrapper from a proven permanent rejection", status => {
    const error = classifyAgentError(new Error(`${status}: ${JSON.stringify({
      error: { code: `upstream_${status}`, message: `Upstream returned status ${status}` },
    })}`));
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      retriable: false,
      details: { providerStatus: status, recoveryCategory: "unknown-upstream" },
    });
  });

  it.each([
    { code: "invalid_request_error", message: "Invalid parameter: temperature" },
    { code: "upstream_400", message: "Invalid API key" },
    { code: "upstream_400", message: "Maximum context length exceeded" },
    { code: "upstream_400", message: "Insufficient quota" },
    { code: "upstream_400", message: "Upstream returned status 400", details: "Invalid parameter: tools" },
  ])("does not reclassify explicit permanent evidence: $message", body => {
    const error = classifyAgentError(new Error(`400: ${JSON.stringify({ error: body })}`));
    expect(error.retriable).toBe(false);
    expect(error.details).not.toHaveProperty("recoveryCategory");
  });

  it("does not infer an unknown upstream wrapper from an ordinary opaque error", () => {
    expect(classifyAgentError("400 status code (no body)").details)
      .not.toHaveProperty("recoveryCategory");
  });
});
