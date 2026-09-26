/** A granted slot transfers directly to its next waiter; cancelled waiters never launch work. */
export class WorkPool {
  private active = 0;
  private waiting: Array<{ grant: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void }> = [];
  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((grant, reject) => {
      const waiter = { grant, reject, signal, abort: () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal?.reason ?? new Error('The search was cancelled.'));
      } };
      this.waiting.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      if (signal?.aborted) waiter.abort();
    });
    try { signal?.throwIfAborted(); return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) { next.signal?.removeEventListener('abort', next.abort); next.grant(); }
      else this.active--;
    }
  }
}

export function pause(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('The search was cancelled.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
