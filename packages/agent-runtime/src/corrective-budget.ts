/** One allowance for local corrective model requests, never replenished by tools. */
export class CorrectiveBudget {
  private used = 0;
  constructor(private limit = 1) {}

  get attempts(): number { return this.used; }
  get available(): boolean { return this.used < this.limit; }

  reset(limit: number): void {
    this.limit = limit;
    this.used = 0;
  }

  claim(): boolean {
    if (!this.available) return false;
    this.used++;
    return true;
  }
}
