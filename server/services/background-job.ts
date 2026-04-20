/**
 * BackgroundJob — standard abstraction for all periodic server-side jobs.
 *
 * Usage
 * -----
 * 1. Extend this class and implement `runOnce()` with the work to do each tick.
 * 2. Instantiate the subclass and call `start()` in `server/index.ts`.
 * 3. Call `stop()` inside the graceful-shutdown handler — the base class clears
 *    the interval handle so no further ticks are scheduled after `stop()`.
 *
 * Rule: any new periodic task MUST be implemented as a BackgroundJob subclass
 * and registered in `server/index.ts`. Do NOT add bare `setInterval` calls at
 * module level — they are impossible to stop cleanly during graceful shutdown.
 */
export abstract class BackgroundJob {
  private handle: NodeJS.Timeout | null = null;

  constructor(private readonly intervalMs: number) {}

  protected abstract runOnce(): Promise<void> | void;

  start(): void {
    if (this.handle !== null) {
      return;
    }
    this.handle = setInterval(() => {
      Promise.resolve(this.runOnce()).catch((err) => {
        console.warn(`[${this.constructor.name}] Unhandled error in runOnce():`, err);
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }
}
