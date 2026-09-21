import path from "node:path";
import { AccountPool } from "./accounts/accountPool.js";
import { resolveConfig } from "./config.js";
import { CoreDatabase } from "./database.js";
import { DownloadQueue } from "./downloads/downloads.js";
import { BackendEvents } from "./events.js";
import { Jobs } from "./jobs/jobs.js";
import { ConsoleLogger, type Logger } from "./logger.js";
import { RunningHubClient } from "./runninghub/client.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { InMemorySecretStore, UnsupportedPersistentSecretStore, type SecretStore } from "./secretStore.js";
import type { RunningHubClientLike, RunningHubConfig } from "./types.js";
import { Workflows } from "./workflows/workflows.js";

export interface BackendOptions {
  databasePath?: string;
  config?: Partial<RunningHubConfig>;
  secretStore?: SecretStore;
  logger?: Logger;
  fetch?: typeof fetch;
  clientFactory?: (apiKey: string) => RunningHubClientLike;
}

export class RunningHubBackend {
  readonly config: RunningHubConfig;
  readonly events = new BackendEvents();
  readonly database: CoreDatabase;
  readonly accounts: AccountPool;
  readonly workflows: Workflows;
  readonly jobs: Jobs;
  readonly downloads: DownloadQueue;
  readonly scheduler: Scheduler;
  private started = false;

  constructor(options: BackendOptions = {}) {
    this.config = resolveConfig(options.config);
    const logger = options.logger ?? new ConsoleLogger();
    const fetchImpl = options.fetch ?? fetch;
    const databasePath = options.databasePath ?? path.resolve("data", "runninghub.sqlite");
    const secretStore = options.secretStore ?? (databasePath === ":memory:"
      ? new InMemorySecretStore()
      : new UnsupportedPersistentSecretStore());
    this.database = new CoreDatabase(databasePath, secretStore);
    this.accounts = new AccountPool(
      this.database, this.config, this.events, logger,
      options.clientFactory ?? (apiKey => new RunningHubClient(apiKey, this.config, fetchImpl)),
    );
    this.workflows = new Workflows(this.database, this.events);
    this.jobs = new Jobs(this.database, this.events);
    this.downloads = new DownloadQueue(this.config, this.jobs, this.events, logger, fetchImpl);
    this.scheduler = new Scheduler(
      this.database, this.config, this.accounts, this.jobs, this.downloads, this.events, logger,
    );
    this.events.on("queue.updated", () => void this.scheduler.schedule());
    this.events.on("account.updated", () => void this.scheduler.schedule());
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.scheduler.start();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.scheduler.stop();
    this.started = false;
  }

  async close(): Promise<void> {
    await this.stop();
    this.database.close();
  }
}

export * from "./types.js";
export * from "./config.js";
export * from "./secretStore.js";
export * from "./runninghub/client.js";
export * from "./runninghub/errors.js";
export * from "./runninghub/normalizer.js";
export * from "./runninghub/mockClient.js";
export * from "./workflows/parser.js";
export * from "./workflows/recognizer.js";
export * from "./workflows/profiles.js";
export * from "./workflows/nodeInfo.js";
export * from "./workflows/package.js";
