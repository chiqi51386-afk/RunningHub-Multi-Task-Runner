import { EventEmitter } from "node:events";
import type { Account, Job, WorkflowRecord } from "./types.js";

export interface BackendEventMap {
  "job.updated": [job: Job];
  "account.updated": [account: Account];
  "queue.updated": [pendingCount: number];
  "workflow.updated": [workflow: WorkflowRecord];
  "download.updated": [job: Job];
}

export class BackendEvents extends EventEmitter<BackendEventMap> {}
