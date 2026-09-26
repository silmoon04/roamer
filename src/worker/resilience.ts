export function backoffDelay(failures: number) { return Math.min(10000, 500 * 2 ** Math.min(6, Math.max(0, failures - 1))); }

/** For startup and queue reads only. Never wrap a Grok send or actor launch in this loop. */
export async function retryConnection<T>(operation: () => Promise<T>, options: { stopped: () => boolean; wait: (ms: number) => Promise<unknown>; failed: (error: unknown, retryInMs: number) => void }): Promise<T | undefined> {
  let failures = 0;
  while (!options.stopped()) {
    try { return await operation(); }
    catch (error) {
      const delay = backoffDelay(++failures); options.failed(error, delay); await options.wait(delay);
    }
  }
  return undefined;
}
