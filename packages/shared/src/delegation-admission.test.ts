import { describe, expect, it } from "vitest";
import {
  DELEGATION_CONTEXT_WINDOW_MAX,
  DelegationRequestError,
  isDelegationContextMinimum,
  normalizeDelegationContextWindow,
} from "./delegation-admission.js";

describe("delegation context requirements", () => {
  it.each([undefined, 0])("normalizes no minimum (%s) to omitted metadata", value => {
    expect(normalizeDelegationContextWindow(value)).toBeUndefined();
    expect(isDelegationContextMinimum(value)).toBe(false);
  });
  it.each([1, 4096, DELEGATION_CONTEXT_WINDOW_MAX])("preserves bounded positive integers (%s)", value => {
    expect(normalizeDelegationContextWindow(value)).toBe(value);
    expect(isDelegationContextMinimum(value)).toBe(true);
  });
  it.each([-1, 0.5, DELEGATION_CONTEXT_WINDOW_MAX + 1, Number.MAX_SAFE_INTEGER + 1,
    Number.NaN, Number.POSITIVE_INFINITY, "4096", null, {}, []])("rejects malformed minimum %s", value => {
    expect(isDelegationContextMinimum(value)).toBe(false);
    expect(() => normalizeDelegationContextWindow(value)).toThrow(DelegationRequestError);
    expect(() => normalizeDelegationContextWindow(value)).toThrow(/minContextWindow/);
  });
});
