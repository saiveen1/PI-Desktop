import { describe, expect, it } from "vitest";
import {
  isUnknownUpstreamRetryLimit,
  resolveUnknownUpstreamRetryLimit,
  UNKNOWN_UPSTREAM_RETRY_LIMIT_DEFAULT,
  UNKNOWN_UPSTREAM_RETRY_LIMIT_MAX,
} from "./provider-retry.js";

describe("unknown upstream retry policy", () => {
  it("keeps new recovery disabled unless the user configures it", () => {
    expect(UNKNOWN_UPSTREAM_RETRY_LIMIT_DEFAULT).toBe(0);
    expect(UNKNOWN_UPSTREAM_RETRY_LIMIT_MAX).toBe(3);
    expect(resolveUnknownUpstreamRetryLimit()).toBe(0);
    for (const value of [0, 1, 3]) {
      expect(isUnknownUpstreamRetryLimit(value)).toBe(true);
      expect(resolveUnknownUpstreamRetryLimit(value)).toBe(value);
    }
  });

  it("rejects invalid settings rather than coercing or clamping them", () => {
    for (const value of [-1, 4, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, "1", null, true, {}]) {
      expect(isUnknownUpstreamRetryLimit(value)).toBe(false);
    }
    for (const value of [-1, 4, 0.5, NaN, Infinity]) {
      expect(() => resolveUnknownUpstreamRetryLimit(value)).toThrow("Invalid unknown upstream retry limit");
    }
  });
});
