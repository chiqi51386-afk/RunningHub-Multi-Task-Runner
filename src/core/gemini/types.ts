export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

export type GeminiKeyState = "unchecked" | "ready" | "cooldown" | "auth_error" | "secret_error";
export interface GeminiKeyView {
  id: string;
  label: string;
  maskedKey: string;
  enabled: boolean;
  state: GeminiKeyState;
  retryAt?: number;
  lastCheckedAt?: number;
  lastError?: string;
  lastUsedAt?: number;
}
export interface GeminiSettings { firstStageId?: string; optimizationEnabled: boolean; model: string; keys: GeminiKeyView[]; }
export interface GeminiTestResult {
  success: boolean;
  keyId?: string;
  model: string;
  latencyMs: number;
  message: string;
}
export interface GeminiGenerateInput {
  text: string;
  systemInstruction?: string;
  images?: { referenceIndex: number; mimeType: "image/jpeg" | "image/png" | "image/webp"; data: string }[];
  audio?: { mimeType: string; data: string };
  maxOutputTokens?: number;
  thinkingLevel?: "low" | "medium" | "high";
}
