import type { AccountView, CreateJobDraft, JobView, WorkflowView } from "./types";

export interface RunningHubRendererBridge {
  accounts: {
    list(): Promise<AccountView[]>;
    add(input: { label: string; apiKey: string }): Promise<AccountView>;
    updateKey(input: { id: string; apiKey: string }): Promise<AccountView>;
    refresh(id: string): Promise<AccountView>;
    refreshAll(): Promise<AccountView[]>;
    setEnabled(id: string, enabled: boolean): Promise<AccountView>;
    remove(id: string): Promise<boolean>;
  };
  workflows: {
    list(): Promise<WorkflowView[]>;
    importApiJson(input: { name: string; runningHubWorkflowId: string; sourceUrl?: string; workflow: unknown }): Promise<WorkflowView>;
    importPortablePackage(input: unknown): Promise<WorkflowView>;
    exportPackage(id: string): Promise<string | undefined>;
    updateProfile(input: WorkflowView): Promise<WorkflowView>;
    remove(id: string): Promise<void>;
  };
  media: {
    select(type: "image" | "video" | "audio"): Promise<{ localPath: string; fileName: string; previewUrl: string } | undefined>;
    fromDroppedFile(file: File): Promise<{ localPath: string; fileName: string; previewUrl: string }>;
  };
  downloads: {
    directory(): Promise<string>;
    openDirectory(): Promise<void>;
    selectDirectory(): Promise<string | undefined>;
    resetDirectory(): Promise<string>;
    reveal(localPath: string): Promise<string>;
  };
  jobs: {
    list(): Promise<JobView[]>;
    create(input: CreateJobDraft): Promise<JobView>;
    createBatch(inputs: CreateJobDraft[]): Promise<JobView[]>;
    cancel(id: string): Promise<JobView>;
    remove(id: string): Promise<boolean>;
  };
  scheduler: {
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  external: {
    openApiKeys(): Promise<void>;
  };
}

declare global {
  interface Window { runningHub?: RunningHubRendererBridge; }
}

export const hasDesktopBridge = () => Boolean(window.runningHub);
