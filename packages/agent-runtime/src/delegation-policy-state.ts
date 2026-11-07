import { isDelegationSettings, type DelegationPolicySnapshot, type DelegationSettings } from "@pi-desktop/shared";

export type CurrentDelegationPolicy = {
  settings?: DelegationSettings;
  selectionMode?: "task-fit";
  /** Undefined only for a legacy host; an authoritative empty list means unavailable. */
  modelKeys?: readonly string[];
};

function snapshot(value: unknown): DelegationPolicySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid delegation policy snapshot");
  const row = value as Record<string, unknown>;
  if (typeof row.revision !== "string" || !row.revision.trim() || row.revision.length > 1024 ||
      !Array.isArray(row.modelKeys) || row.modelKeys.length > 128 ||
      row.modelKeys.some(key => typeof key !== "string" || !key.trim() || key !== key.trim() || key.length > 385 || key.indexOf("/") < 1) ||
      new Set(row.modelKeys).size !== row.modelKeys.length ||
      (row.settings !== undefined && !isDelegationSettings(row.settings)) ||
      (row.selectionMode !== undefined && row.selectionMode !== "task-fit")) {
    throw new Error("Invalid delegation policy snapshot; no new delegation was authorized.");
  }
  return structuredClone(row) as DelegationPolicySnapshot;
}

function unsupported(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as { code?: unknown; rpcCode?: unknown; message?: unknown };
  return row.code === -32601 || row.rpcCode === -32601 ||
    (typeof row.message === "string" && /(?:unknown|unsupported|unexpected|not found|not implemented|no handler)/i.test(row.message) &&
      /provider\.delegationSnapshot/.test(row.message));
}

/** Session-local hot policy. No resources, child lifecycle or provider payloads are owned here. */
export class DelegationPolicyState {
  private current: CurrentDelegationPolicy;
  private supported = false;
  private unavailable = false;
  private epoch = 0;
  private pending?: Promise<CurrentDelegationPolicy>;
  private revision?: string;
  private readonly retiredRevisions = new Set<string>();

  constructor(settings: DelegationSettings | undefined, private readonly fetch: () => Promise<unknown>, selectionMode?: "task-fit") {
    this.current = { settings, selectionMode };
  }

  get value(): CurrentDelegationPolicy { return this.current; }
  get authoritative(): boolean { return this.supported; }

  invalidate(): void {
    this.epoch++;
    this.unavailable = false;
  }

  refresh(): Promise<CurrentDelegationPolicy> {
    if (this.pending) return this.pending;
    if (this.unavailable) return Promise.resolve(this.current);
    const pending = this.load();
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => undefined);
    return pending;
  }

  private async load(): Promise<CurrentDelegationPolicy> {
    // Serialize/coalesce readers. A save during a fetch discards that response
    // and requires a new fetch before any waiting admission may proceed.
    for (;;) {
      const epoch = this.epoch;
      let value: unknown;
      try { value = await this.fetch(); }
      catch (error) {
        if (epoch !== this.epoch) continue;
        if (!this.supported && unsupported(error)) { this.unavailable = true; return this.current; }
        throw error;
      }
      if (epoch !== this.epoch) continue;
      // Older optional callback transports may return no result. Preserve the
      // launch policy, never reinterpret it as an authoritative missing policy.
      if (value === undefined && !this.supported) { this.unavailable = true; return this.current; }
      const next = snapshot(value);
      if (this.retiredRevisions.has(next.revision)) {
        throw new Error("Stale delegation policy snapshot; retry after the host publishes its current revision.");
      }
      if (next.revision === this.revision) {
        if (JSON.stringify(this.current) !== JSON.stringify({ settings: next.settings, modelKeys: next.modelKeys, selectionMode: next.selectionMode })) {
          throw new Error("Delegation policy changed without a new revision");
        }
        return this.current;
      }
      if (this.revision) this.retiredRevisions.add(this.revision);
      this.supported = true;
      this.revision = next.revision;
      this.current = { settings: next.settings, modelKeys: next.modelKeys, selectionMode: next.selectionMode };
      return this.current;
    }
  }
}
