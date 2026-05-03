import { BackgroundJob } from "./background-job";
import { runAdSpendSync } from "./ad-spend-sync";
import { logger } from "../utils/logger";

const log = logger("AdSpendSyncJob");

export class AdSpendSyncJob extends BackgroundJob {
  constructor() {
    super(6 * 60 * 60 * 1000);
  }

  override start(): void {
    super.start();
    // Run once at startup so a fresh process picks up any missed window
    // immediately rather than waiting up to 6 h for the first interval.
    void this.runOnce();
  }

  protected async runOnce(): Promise<void> {
    try {
      await runAdSpendSync();
    } catch (err) {
      log.error(`Ad-spend sync tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
