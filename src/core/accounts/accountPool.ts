import type { CoreDatabase } from "../database.js";
import type { BackendEvents } from "../events.js";
import type { Logger } from "../logger.js";
import { RunningHubError } from "../runninghub/errors.js";
import { SecretStorageError } from "../secureSecrets.js";
import type { Account, AccountWithSecret, RunningHubClientLike, RunningHubConfig } from "../types.js";

export type ClientFactory = (apiKey: string) => RunningHubClientLike;

export class AccountPool {
  private readonly refreshes = new Map<string, Promise<Account>>();

  constructor(
    private readonly db: CoreDatabase,
    private readonly config: RunningHubConfig,
    private readonly events: BackendEvents,
    private readonly logger: Logger,
    private readonly clientFactory: ClientFactory,
  ) {}

  add(label: string, apiKey: string): Account {
    const account = this.db.addAccount(label, apiKey);
    this.events.emit("account.updated", account);
    return account;
  }

  remove(id: string): boolean {
    const account = this.db.getAccount(id);
    if (!account) return false;
    if (account.currentJobId || account.activeJobCount) throw new Error("该账号仍关联执行中的任务；请先等待、取消任务，或让远端任务结束后再删除。");
    return this.db.removeAccount(id);
  }
  updateKey(id: string, apiKey: string): Account {
    const account = this.db.updateAccountKey(id, apiKey);
    this.events.emit("account.updated", account);
    return account;
  }
  setConcurrency(id:string,value:unknown): Account {
    const account=this.db.setAccountConcurrency(id,value);
    this.events.emit("account.updated",account);
    return account;
  }
  list(): Account[] { return this.db.listAccounts(); }
  get(id: string): Account | undefined { return this.db.getAccount(id); }

  enable(id: string): Account {
    const account = this.db.setAccountEnabled(id, true);
    this.events.emit("account.updated", account);
    void this.refresh(id);
    return account;
  }

  disable(id: string): Account {
    const account = this.db.setAccountEnabled(id, false);
    this.events.emit("account.updated", account);
    return account;
  }

  clientFor(id: string): { account: AccountWithSecret; client: RunningHubClientLike } {
    const account = this.db.getAccountWithSecret(id);
    if (!account) throw new Error(`Account not found: ${id}`);
    return { account, client: this.clientFactory(account.apiKey) };
  }

  available(): Account[] { return this.db.listAvailableAccounts(); }

  isFresh(account: Account, now = Date.now()): boolean {
    return account.lastCheckedAt !== undefined && now - account.lastCheckedAt <= this.config.accountFreshnessMs;
  }

  async refresh(id: string): Promise<Account> {
    const active = this.refreshes.get(id);
    if (active) return active;
    const refresh = this.performRefresh(id).finally(() => {
      if (this.refreshes.get(id) === refresh) this.refreshes.delete(id);
    });
    this.refreshes.set(id, refresh);
    return refresh;
  }

  private async performRefresh(id: string): Promise<Account> {
    let account = this.db.getAccount(id);
    if (!account) throw new Error(`Account not found: ${id}`);
    if (!account.enabled || account.manualDisabled) {
      account = this.db.updateAccount(id, { state: "DISABLED" });
      this.events.emit("account.updated", account);
      return account;
    }
    if (!account.currentJobId) account = this.db.updateAccount(id, { state: "CHECKING" });
    this.events.emit("account.updated", account);

    try {
      const { client } = this.clientFor(id);
      const knownBefore = new Set(this.db.activeAccountJobs(id).filter(j=>j.remoteTaskId).map(j=>j.id));
      const status = await client.accountStatus();
      const now = Date.now();
      const balanceNumber = Number(status.balance ?? "0");
      const coinsNumber = Number(status.coins ?? "0");
      const remoteCount = status.currentTaskCount ?? 0;
      const current = this.db.getAccount(id)!;
      let state: Account["state"];
      let autoDisabled = false;
      let reason: string | null = null;
      if (!status.valid) { state = "INVALID_KEY"; autoDisabled = true; reason = "invalid_key"; }
      else if (status.coins !== undefined
        ? Number.isFinite(coinsNumber) && coinsNumber <= 0
        : status.balance !== undefined && Number.isFinite(balanceNumber) && balanceNumber <= 0) {
        state = "NO_BALANCE"; autoDisabled = true; reason = "no_balance";
      }
      else if ((current.activeJobCount ?? 0) + Math.max(0,remoteCount-this.db.activeAccountJobs(id).filter(j=>j.remoteTaskId && knownBefore.has(j.id)).length) >= (current.maxConcurrency ?? 1)) state = "REMOTE_BUSY";
      else state = current.activeJobCount ? "BUSY" : "IDLE";
      account = this.db.updateAccount(id, {
        state, autoDisabled, autoDisabledReason: reason,
        cooldownUntil: null,
        balance: status.balance ?? null, coins: status.coins ?? null,
        externalTaskCount: Math.max(0,remoteCount-this.db.activeAccountJobs(id).filter(j=>j.remoteTaskId && knownBefore.has(j.id)).length),
        remoteTaskCount: remoteCount, apiType: status.apiType ?? null, lastCheckedAt: now,
      });
    } catch (error) {
      const current = this.db.getAccount(id)!;
      if (error instanceof SecretStorageError || (error instanceof Error && /decrypt|safeStorage|Encrypted API key|not plaintext|API key storage/i.test(error.message))) {
        account = this.db.updateAccount(id, {
          state: "SECRET_UNREADABLE",
          lastErrorAt: Date.now(), lastCheckedAt: Date.now(),
        });
      } else if (error instanceof RunningHubError && error.detail.code === "ACCOUNT_INVALID_KEY") {
        account = this.db.updateAccount(id, {
          state: "INVALID_KEY", autoDisabled: true,
          autoDisabledReason: "invalid_key", lastErrorAt: Date.now(), lastCheckedAt: Date.now(),
        });
      } else {
        account = this.db.updateAccount(id, {
          state: "TEMP_UNAVAILABLE",
          lastErrorAt: Date.now(), lastCheckedAt: Date.now(),
        });
      }
      this.logger.warn("Account refresh failed", { accountId: id, phase: "ACCOUNT" }, error);
    }
    this.events.emit("account.updated", account);
    return account;
  }

  async refreshAll(): Promise<Account[]> {
    const enabled = this.list().filter(account => account.enabled && !account.manualDisabled);
    const refreshed: Account[] = [];
    for (const account of enabled) {
      refreshed.push(await this.refresh(account.id));
      if (refreshed.length < enabled.length) await new Promise(resolve => setTimeout(resolve, 350));
    }
    return refreshed;
  }

  release(id: string, jobId: string, successful: boolean, state: Account["state"] = "IDLE"): Account | undefined {
    const account = this.db.releaseAccount(id, jobId, successful, state);
    if (account) this.events.emit("account.updated", account);
    return account;
  }
}
