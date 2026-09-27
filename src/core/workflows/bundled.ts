import { createHash } from "node:crypto";
import type { CoreDatabase } from "../database.js";
import type { WorkflowRecord } from "../types.js";
import { materializePortableProfile, parsePortableWorkflowPackage } from "./package.js";

/** Definitions live in the application; persist identity and revision only. */
export function syncBundledWorkflows(db: CoreDatabase, inputs: { key: string; value: unknown }[]): void {
  const bundles = inputs.map(input => ({ key: input.key, portable: parsePortableWorkflowPackage(input.value) }));
  if (new Set(bundles.map(item => item.key)).size !== bundles.length) throw new Error("内置工作流标识重复");
  db.detachJobWorkflowForeignKey();
  const records = db.transaction(() => {
    const installed = db.raw.prepare("SELECT bundle_key, workflow_id FROM bundled_workflow_state").all() as { bundle_key: string; workflow_id: string }[];
    const result: WorkflowRecord[] = [];
    for (const { key, portable } of bundles) {
      const tracked = installed.find(item => item.bundle_key === key);
      const legacy = !tracked ? db.raw.prepare("SELECT id FROM workflows WHERE runninghub_workflow_id = ? AND deleted_at IS NULL ORDER BY created_at").all(portable.workflow.runningHubWorkflowId) as { id: string }[] : [];
      const id = tracked?.workflow_id ?? (legacy.length === 1 ? legacy[0]!.id : `builtin:${key}`);
      const hash = createHash("sha256").update(JSON.stringify({ workflow: portable.workflow, profile: portable.profile, loader: 2 })).digest("hex");
      const version = parseInt(hash.slice(0, 12), 16);
      result.push({ id, name: portable.workflow.name, runningHubWorkflowId: portable.workflow.runningHubWorkflowId,
        sourceUrl: portable.workflow.sourceUrl, raw: structuredClone(portable.workflow.apiJson),
        workflowHash: portable.workflow.workflowHash, profileVersion: version,
        profile: materializePortableProfile(portable, id, version, 0, 0), createdAt: 0, updatedAt: 0 });
      db.raw.prepare("DELETE FROM workflows WHERE id = ?").run(id);
      db.raw.prepare(`INSERT INTO bundled_workflow_state (bundle_key, workflow_id, bundle_hash, installed_hash)
        VALUES (?, ?, ?, ?) ON CONFLICT(bundle_key) DO UPDATE SET workflow_id=excluded.workflow_id,
        bundle_hash=excluded.bundle_hash, installed_hash=excluded.installed_hash`).run(key, id, hash, hash);
    }
    for (const old of installed) db.raw.prepare("DELETE FROM workflows WHERE id = ?").run(old.workflow_id);
    // Only software-managed definition backups, never personal imports.
    for (const key of new Set([...installed.map(item => item.bundle_key), ...bundles.map(item => item.key)])) {
      db.raw.prepare("DELETE FROM bundled_workflow_backups WHERE bundle_key = ?").run(key);
    }
    return result;
  });
  db.setBundledWorkflows(records);
}
