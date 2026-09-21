import { randomUUID } from "node:crypto";
import type { CoreDatabase } from "../database.js";
import type { BackendEvents } from "../events.js";
import type { PortableWorkflowPackage, WorkflowProfile, WorkflowRecord } from "../types.js";
import { parseApiWorkflow } from "./parser.js";
import { createPortableWorkflowPackage, materializePortableProfile, parsePortableWorkflowPackage } from "./package.js";
import { createWorkflowProfile, repairLowConfidenceSemantics, validateProfile, validateProfileAgainstWorkflow } from "./profiles.js";

export class Workflows {
  constructor(private readonly db: CoreDatabase, private readonly events: BackendEvents) {}

  importApiJson(input: {
    id?: string;
    name: string;
    runningHubWorkflowId: string;
    sourceUrl?: string;
    workflow: unknown;
  }): WorkflowRecord {
    const parsed = parseApiWorkflow(input.workflow);
    const existing = input.id ? this.db.getWorkflow(input.id) : undefined;
    const sameGraph = this.db.findWorkflowByHash(parsed.workflowHash);
    if (!existing && sameGraph && sameGraph.runningHubWorkflowId !== input.runningHubWorkflowId.trim()) {
      throw new Error(`这份 API JSON 已关联 Workflow ID ${sameGraph.runningHubWorkflowId}，不能直接绑定到 ${input.runningHubWorkflowId.trim()}。请从目标 RunningHub 工作流重新导出 API JSON。`);
    }
    if (!existing && sameGraph && sameGraph.runningHubWorkflowId === input.runningHubWorkflowId.trim()) {
      const next = {
        ...sameGraph,
        name: input.name.trim() || sameGraph.name,
        sourceUrl: input.sourceUrl?.trim() || sameGraph.sourceUrl,
        updatedAt: Date.now(),
      };
      this.db.saveWorkflow(next);
      return this.refreshDerivedMetadata(next);
    }
    const now = Date.now();
    if (existing && existing.workflowHash === parsed.workflowHash) return existing;
    const id = existing?.id ?? input.id ?? randomUUID();
    const version = existing ? existing.profileVersion + 1 : 1;
    const profile = createWorkflowProfile({
      workflowId: id, name: input.name, version, parameters: parsed.parameters, outputs: parsed.outputs,
      createdAt: existing?.profile.createdAt, now,
    });
    const record: WorkflowRecord = {
      id, name: input.name.trim(), runningHubWorkflowId: input.runningHubWorkflowId.trim(), sourceUrl: input.sourceUrl?.trim() || undefined,
      raw: parsed.raw, profile, profileVersion: version, workflowHash: parsed.workflowHash,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    this.db.saveWorkflow(record);
    this.events.emit("workflow.updated", record);
    return record;
  }

  list(): WorkflowRecord[] { return this.db.listWorkflows().map(workflow => this.refreshDerivedMetadata(workflow)); }
  get(id: string): WorkflowRecord | undefined {
    const workflow = this.db.getWorkflow(id);
    return workflow ? this.refreshDerivedMetadata(workflow) : undefined;
  }
  remove(id: string): boolean { return this.db.removeWorkflow(id); }

  exportPortablePackage(id: string, applicationVersion?: string): PortableWorkflowPackage {
    const workflow = this.db.getWorkflow(id);
    if (!workflow) throw new Error(`Workflow not found: ${id}`);
    return createPortableWorkflowPackage(workflow, applicationVersion);
  }

  importPortablePackage(value: unknown): WorkflowRecord {
    const portable = parsePortableWorkflowPackage(value);
    const existing = this.db.listWorkflows().find(workflow =>
      workflow.runningHubWorkflowId === portable.workflow.runningHubWorkflowId,
    );
    const now = Date.now();
    const id = existing?.id ?? randomUUID();
    const version = existing ? existing.profileVersion + 1 : 1;
    const profile = materializePortableProfile(portable, id, version, now, existing?.profile.createdAt ?? now);
    const record: WorkflowRecord = {
      id,
      name: portable.workflow.name,
      runningHubWorkflowId: portable.workflow.runningHubWorkflowId,
      sourceUrl: portable.workflow.sourceUrl,
      raw: structuredClone(portable.workflow.apiJson),
      profile,
      profileVersion: version,
      workflowHash: portable.workflow.workflowHash,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.saveWorkflow(record);
    this.events.emit("workflow.updated", record);
    return record;
  }

  updateProfile(id: string, profile: WorkflowProfile, metadata?: { name?: string; runningHubWorkflowId?: string; sourceUrl?: string }): WorkflowRecord {
    const workflow = this.db.getWorkflow(id);
    if (!workflow) throw new Error(`Workflow not found: ${id}`);
    const now = Date.now();
    const next: WorkflowProfile = {
      ...structuredClone(profile), workflowId: id, name: metadata?.name?.trim() || workflow.name,
      version: workflow.profileVersion + 1, createdAt: workflow.profile.createdAt, updatedAt: now,
    };
    validateProfile(next);
    validateProfileAgainstWorkflow(next, workflow.raw);
    if (metadata?.runningHubWorkflowId?.trim() && metadata.runningHubWorkflowId.trim() !== workflow.runningHubWorkflowId) {
      throw new Error("Workflow ID 不能在 Profile 编辑器中改绑；请重新导入目标 Workflow 的 API JSON。");
    }
    const record = {
      ...workflow,
      name: metadata?.name?.trim() || workflow.name,
      runningHubWorkflowId: workflow.runningHubWorkflowId,
      sourceUrl: metadata && Object.prototype.hasOwnProperty.call(metadata, "sourceUrl")
        ? metadata.sourceUrl?.trim() || undefined
        : workflow.sourceUrl,
      profile: next, profileVersion: next.version, updatedAt: now,
    };
    this.db.saveWorkflow(record);
    this.events.emit("workflow.updated", record);
    return record;
  }

  private refreshDerivedMetadata(workflow: WorkflowRecord): WorkflowRecord {
    const parsedParameters = parseApiWorkflow(workflow.raw).parameters;
    const detected = new Map(parsedParameters.map(parameter => [parameter.key, parameter]));
    let changed = false;
    let parameters = workflow.profile.parameters.map(parameter => {
      const schema = detected.get(parameter.key);
      if (schema?.classType === "ResolutionSelector" && schema.fieldName === "aspect_ratio" &&
        (parameter.defaultValue !== schema.defaultValue || !parameter.submitDefault || parameter.valueType !== "select")) {
        changed = true;
        return { ...parameter, semanticType: "aspect_ratio" as const, valueType: "select" as const,
          defaultValue: schema.defaultValue, submitDefault: true, options: schema.options, confidence: 1 };
      }
      if (parameter.showEnableToggle !== undefined || !schema?.showEnableToggle) return parameter;
      changed = true;
      return { ...parameter, showEnableToggle: true };
    });
    // Older saved profiles may predate fields added to our known node schemas.
    // In particular, early H3 profiles stored only aspect_ratio and megapixels
    // from ResolutionSelector, so the `multiple` widget never reached the UI.
    // Restore only missing fields from this stable built-in node; do not merge
    // every newly detected raw input because that would unexpectedly expose
    // internal parameters the user deliberately hid or removed.
    const existingKeys = new Set(parameters.map(parameter => parameter.key));
    for (const parameter of parsedParameters) {
      if (parameter.classType !== "ResolutionSelector" || existingKeys.has(parameter.key)) continue;
      parameters.push({ ...parameter, id: parameter.semanticType === "unknown" ? parameter.key.replace(".", "_") : parameter.semanticType });
      existingKeys.add(parameter.key);
      changed = true;
    }
    const repaired = repairLowConfidenceSemantics(parameters);
    if (repaired.some((parameter, index) => parameter.semanticType !== parameters[index]?.semanticType ||
      parameter.confidence !== parameters[index]?.confidence || parameter.valueType !== parameters[index]?.valueType)) {
      changed = true;
      parameters = repaired;
    }
    if (!changed) return workflow;
    const now = Date.now();
    const profile = {
      ...workflow.profile,
      version: workflow.profileVersion + 1,
      parameters,
      genericParameters: parameters.filter(parameter => parameter.semanticType === "unknown"),
      needsReview: parameters.some(parameter => parameter.visible !== false && parameter.confidence < 0.7),
      updatedAt: now,
    };
    const updated = { ...workflow, profile, profileVersion: profile.version, updatedAt: now };
    this.db.saveWorkflow(updated);
    return updated;
  }
}
