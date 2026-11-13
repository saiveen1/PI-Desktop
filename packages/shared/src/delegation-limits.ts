/** Global Task catalog/admission limits, separate from each child's work budget. */
export type DelegationLimits = {
  maxDefinitions: number;
  maxConcurrent: number;
};

export const DEFAULT_DELEGATION_LIMITS: Readonly<DelegationLimits> = Object.freeze({
  maxDefinitions: 16,
  maxConcurrent: 10,
});

export const DELEGATION_LIMIT_RANGES = {
  maxDefinitions: { min: 1, max: 128 },
  maxConcurrent: { min: 1, max: 64 },
} as const;

export function isDelegationLimits(value: unknown): value is Partial<DelegationLimits> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, number]) => {
    if (!Object.hasOwn(DELEGATION_LIMIT_RANGES, key)) return false;
    const { min, max } = DELEGATION_LIMIT_RANGES[key as keyof DelegationLimits];
    return typeof number === "number" && Number.isInteger(number) && number >= min && number <= max;
  });
}

/** Missing fields preserve historical defaults without rewriting saved settings. */
export function resolveDelegationLimits(value?: Partial<DelegationLimits>): Readonly<DelegationLimits> {
  if (value !== undefined && !isDelegationLimits(value)) throw new Error("Invalid subagent limits");
  return Object.freeze({
    maxDefinitions: value?.maxDefinitions ?? DEFAULT_DELEGATION_LIMITS.maxDefinitions,
    maxConcurrent: value?.maxConcurrent ?? DEFAULT_DELEGATION_LIMITS.maxConcurrent,
  });
}
