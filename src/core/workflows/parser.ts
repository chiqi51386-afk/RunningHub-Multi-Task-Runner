import { createHash } from "node:crypto";
import type { WorkflowOutput, WorkflowParameter, WorkflowValueType } from "../types.js";

export interface ParsedWorkflow {
  raw: Record<string, unknown>;
  parameters: WorkflowParameter[];
  outputs: WorkflowOutput[];
  workflowHash: string;
}

export function isGraphConnection(value: unknown, nodeIds?: ReadonlySet<string>): boolean {
  return Array.isArray(value)
    && value.length === 2
    && (typeof value[0] === "string" || typeof value[0] === "number")
    && Number.isInteger(value[1])
    && (!nodeIds || nodeIds.has(String(value[0])));
}

export function parseApiWorkflow(value: unknown): ParsedWorkflow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a ComfyUI/RunningHub API-format workflow object.");
  }
  const raw = value as Record<string, unknown>;
  const nodeIds = new Set(Object.keys(raw));
  const parameters: WorkflowParameter[] = [];
  const outputs: WorkflowOutput[] = [];
  const optionalReferenceMedia = detectOptionalReferenceMedia(raw);
  let validNodes = 0;

  for (const [nodeId, nodeValue] of Object.entries(raw)) {
    if (!nodeValue || typeof nodeValue !== "object" || Array.isArray(nodeValue)) continue;
    const node = nodeValue as Record<string, unknown>;
    const inputs = node.inputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) continue;
    validNodes += 1;
    const classType = typeof node.class_type === "string" ? node.class_type : "";
    const meta = node._meta && typeof node._meta === "object" && !Array.isArray(node._meta)
      ? node._meta as Record<string, unknown>
      : {};
    const nodeTitle = typeof meta.title === "string" ? meta.title : classType;
    const output = detectOutput(nodeId, classType, nodeTitle, inputs as Record<string, unknown>);
    if (output) outputs.push(output);

    for (const [fieldName, fieldValue] of Object.entries(inputs as Record<string, unknown>)) {
      if (isGraphConnection(fieldValue, nodeIds)) continue;
      const valueType = primitiveType(fieldValue);
      if (!valueType) continue;
      parameters.push(applyKnownNodeSchema({
        key: `${nodeId}.${fieldName}`,
        nodeId,
        fieldName,
        classType,
        nodeTitle,
        valueType,
        semanticType: "unknown",
        defaultValue: normalizePrimitiveDefault(fieldValue),
        confidence: 0,
        showEnableToggle: optionalReferenceMedia.has(nodeId) && /^(image|audio|video)$/i.test(fieldName),
      }));
    }
  }
  if (validNodes === 0) {
    throw new Error("Workflow has no API-format nodes with an inputs object.");
  }
  outputs.sort((a, b) => a.stage - b.stage || Number(a.nodeId) - Number(b.nodeId));
  return { raw, parameters, outputs, workflowHash: hashWorkflow(raw) };
}

function normalizePrimitiveDefault(value: unknown): unknown {
  if (typeof value !== "number" || Number.isInteger(value) || !Number.isFinite(value)) return value;
  // ComfyUI JSON can expose binary floating-point tails such as
  // 1.5000000000000002 even though the widget displays 1.50.
  return Number(value.toPrecision(12));
}

/**
 * Multi-reference nodes store their optional image/audio/video sockets as
 * nested graph links (for example ref_images.ref_image_1). The API JSON does
 * not export the web editor's visual enable switches, so derive the same UI
 * behaviour from this stable graph structure instead of a workflow name/id.
 */
function detectOptionalReferenceMedia(raw: Record<string, unknown>): Set<string> {
  const sources = new Set<string>();
  const nodeIds = new Set(Object.keys(raw));
  const visit = (value: unknown, path: string[]): void => {
    if (isGraphConnection(value, nodeIds)) {
      if (/ref(?:erence)?[_-]?(?:images?|audios?|videos?)/i.test(path.join("."))) sources.add(String((value as [string | number, number])[0]));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) visit(child, [...path, key]);
  };
  for (const nodeValue of Object.values(raw)) {
    if (!nodeValue || typeof nodeValue !== "object" || Array.isArray(nodeValue)) continue;
    const inputs = (nodeValue as Record<string, unknown>).inputs;
    if (inputs && typeof inputs === "object") visit(inputs, []);
  }
  return sources;
}

/**
 * API-format workflow JSON stores only the currently selected combo value.
 * For built-in ComfyUI nodes, restore the public node schema so the renderer
 * can offer the real values rather than an empty, unusable select element.
 */
function applyKnownNodeSchema(parameter: WorkflowParameter): WorkflowParameter {
  if (parameter.classType === "ResolutionSelector" && parameter.fieldName === "aspect_ratio") {
    return {
      ...parameter,
      valueType: "select",
      // User-facing product default: vertical video. This is an exact enum
      // value accepted by the built-in ResolutionSelector node.
      defaultValue: "9:16 (Portrait Widescreen)",
      // This product default intentionally differs from many imported
      // workflows, so it must still be included in the sparse override list.
      submitDefault: true,
      options: [
        "1:1 (Square)", "2:3 (Portrait Photo)", "3:2 (Photo)",
        "3:4 (Portrait Standard)", "4:3 (Standard)",
        "9:16 (Portrait Widescreen)", "16:9 (Widescreen)", "21:9 (Ultrawide)",
      ],
    };
  }
  if (parameter.classType === "ResolutionSelector" && parameter.fieldName === "megapixels") {
    return { ...parameter, valueType: "number", min: 0.1, max: 16, step: 0.1 };
  }
  return parameter;
}

function detectOutput(nodeId: string, classType: string, nodeTitle: string, inputs: Record<string, unknown>): WorkflowOutput | undefined {
  const context = `${classType} ${nodeTitle}`.toLowerCase();
  let mediaType: WorkflowOutput["mediaType"] | undefined;
  if (/video.*combine|save.*video|video.*output|视频.*输出|合成.*视频/.test(context)) mediaType = "video";
  else if (/save.*image|preview.*image|image.*output|图片.*输出/.test(context)) mediaType = "image";
  else if (/save.*audio|preview.*audio|audio.*output|音频.*输出/.test(context)) mediaType = "audio";
  if (!mediaType) return undefined;
  const prefix = typeof inputs.filename_prefix === "string" ? inputs.filename_prefix : undefined;
  const label = prefix || nodeTitle || `${mediaType} output`;
  return {
    id: `output_${nodeId}`,
    nodeId,
    classType,
    nodeTitle,
    mediaType,
    label,
    filenamePrefix: prefix,
    saveOutput: typeof inputs.save_output === "boolean" ? inputs.save_output : undefined,
    stage: inferStage(label),
  };
}

function inferStage(value: string): number {
  const normalized = value.toLowerCase();
  if (/一采|第一次|first|stage\s*1|pass\s*1/.test(normalized)) return 1;
  if (/二采|第二次|second|stage\s*2|pass\s*2/.test(normalized)) return 2;
  const number = normalized.match(/(?:stage|pass|采样|输出)[^0-9]*([0-9]+)/)?.[1];
  return number ? Number(number) : 1;
}

function primitiveType(value: unknown): WorkflowValueType | null {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value) || (value && typeof value === "object")) return "json";
  return null;
}

export function hashWorkflow(workflow: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(workflow)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
