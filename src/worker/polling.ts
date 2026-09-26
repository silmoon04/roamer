export function pollingPolicy(alwaysPoll: boolean, waiting: boolean, recentAt: number, now: number) {
  if (waiting || alwaysPoll) return { enabled: true, intervalMs: 2000, priority: 1 as const };
  if (recentAt > 0 && now - recentAt < 600000) return { enabled: true, intervalMs: now - recentAt < 120000 ? 5000 : 10000, priority: 0 as const };
  return { enabled: false, intervalMs: 10000, priority: 0 as const };
}

export class CliGate {
  private active = 0;
  private waiting: { priority: number; resolve: (release: () => void) => void }[] = [];
  constructor(private readonly limit: number) {}
  async acquire(priority: number): Promise<() => void> {
    if (this.active < this.limit) { this.active++; return this.release; }
    return new Promise(resolve => { this.waiting.push({ priority, resolve }); });
  }
  private release = () => {
    const priority = Math.max(...this.waiting.map(job => job.priority));
    const index = this.waiting.findIndex(job => job.priority === priority);
    if (index >= 0) this.waiting.splice(index, 1)[0].resolve(this.release);
    else this.active--;
  };
}
