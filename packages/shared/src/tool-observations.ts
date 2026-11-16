/** Local tool telemetry, never automatically included in model context. */
export type ToolObservationOutcome =
  | "success"
  | "command_nonzero"
  | "tool_error"
  | "timeout"
  | "cancelled"
  | "interrupted"
  | "background_started"
  | "unknown";

export type ToolObservationQuery = { days: 1 | 7 | 30 };

export type ToolObservation = {
  id: string;
  timestamp: string;
  toolName: string;
  outcome: ToolObservationOutcome;
  /** Platform of the observing Desktop, not an assertion about a remote host. */
  desktopPlatform: string;
  appVersion: string;
  shellId?: string;
  errorCode?: string;
  exitCode?: number;
  durationMs?: number;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  backgroundTaskId?: string;
  truncated: boolean;
};

export type ToolObservationGroup = {
  id: string;
  toolName: string;
  outcome: ToolObservationOutcome;
  desktopPlatform: string;
  appVersion: string;
  shellId?: string;
  errorCode?: string;
  exitCode?: number;
  count: number;
  sessionCount: number;
  firstSeen: string;
  lastSeen: string;
  /** Bounded examples, not a claim that every occurrence is included. */
  examples: ToolObservation[];
};

export type ToolObservationReport = {
  schemaVersion: 1;
  generatedAt: string;
  since: string;
  days: 1 | 7 | 30;
  total: number;
  counts: Record<ToolObservationOutcome, number>;
  groups: ToolObservationGroup[];
  recent: ToolObservation[];
  coverage: {
    filesRead: number;
    malformedLines: number;
    ignoredLegacyRecords: number;
    limited: boolean;
    readErrors: number;
  };
};
