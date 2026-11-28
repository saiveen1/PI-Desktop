import type { ProcessMetric } from "electron";

/** Window chrome only: never use this display hint to authorize an operation. */
export function readWindowsElevation(
  platform: NodeJS.Platform,
  mainPid: number,
  getMetrics: () => readonly Pick<ProcessMetric, "pid" | "integrityLevel">[],
  onError: (error: unknown) => void,
): boolean {
  if (platform !== "win32") return false;
  try {
    return getMetrics().find(metric => metric.pid === mainPid)?.integrityLevel === "high";
  } catch (error) {
    onError(error);
    return false;
  }
}
