import type { AccountView, CreateJobDraft, JobView, WorkflowView } from "./types.js";
import type { GeminiSettings, GeminiTestResult } from "../../src/core/gemini/types.js";
import type { TtsInput, TtsAudio } from "../../src/core/gemini/ttsTypes.js";

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  repositoryUrl: string;
  releaseUrl: string;
  publishedAt?: string;
  assetName?: string;
  assetUrl?: string;
  assetDigest?: string;
  assetSize?: number;
}

export interface UpdateProgress {
  stage: "downloading" | "verifying" | "extracting" | "restarting";
  percent: number;
  message: string;
}

export interface RunningHubRendererBridge {
  skills: {
    settings(workflowId:string):Promise<import('../../src/core/gemini/workflowSkills.js').WorkflowSkillSettings>;
    select(workflowId:string,skillId:string):Promise<import('../../src/core/gemini/workflowSkills.js').WorkflowSkillSettings>;
    import(workflowId:string):Promise<import('../../src/core/gemini/workflowSkills.js').WorkflowSkillSettings|undefined>;
  };
  tts: {
    optimize(id:string,input:{text:string;language:string}):Promise<string>;
    generate(id:string,input:TtsInput,preview:boolean):Promise<TtsAudio>;
    cancel(id:string):Promise<void>;
    save(localPath:string):Promise<boolean>;
  };
  gemini: {
    setOptimizationEnabled(enabled: boolean): Promise<GeminiSettings>;
    settings(): Promise<GeminiSettings>;
    addKeys(keys: string[]): Promise<GeminiSettings>;
    setModel(model: string): Promise<GeminiSettings>;
    setEnabled(id: string, enabled: boolean): Promise<GeminiSettings>;
    remove(id: string): Promise<GeminiSettings>;
    test(id?: string): Promise<GeminiTestResult>;
    copyKeysUrl(): Promise<void>;
  };
  accounts: {
    setConcurrency(id:string,value:number):Promise<AccountView>;
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
    thumbnail(localPath: string): Promise<string | undefined>;
  };
  downloads: {
    naming(): Promise<{ rule: string; preview: string }>;
    setNaming(rule: string): Promise<{ rule: string; preview: string }>;
    directory(): Promise<string>;
    openDirectory(): Promise<void>;
    selectDirectory(): Promise<string | undefined>;
    resetDirectory(): Promise<string>;
    reveal(localPath: string): Promise<string>;
  };
  jobs: {
    list(): Promise<JobView[]>;
    create(input: CreateJobDraft): Promise<JobView>;
    createBatch(inputs: CreateJobDraft[], context?: { source: "single" | "batch"; requestId: string; expectedCount: number }): Promise<JobView[]>;
    cancel(id: string): Promise<JobView>;
    retryDownload(id: string): Promise<JobView>;
    remove(id: string): Promise<boolean>;
  };
  events: {
    onAccountUpdated(listener: (account: AccountView) => void): () => void;
    onJobUpdated(listener: (job: JobView) => void): () => void;
  };
  scheduler: {
    status(): Promise<boolean>;
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  external: {
    copyApiKeysUrl(): Promise<void>;
  };
  updates: {
    check(): Promise<UpdateInfo>;
    downloadAndInstall(): Promise<{ started: true }>;
    onProgress(listener: (progress: UpdateProgress) => void): () => void;
    openRepository(): Promise<void>;
    openLatestRelease(): Promise<void>;
  };
}

declare global {
  interface Window { runningHub?: RunningHubRendererBridge; }
}

export const hasDesktopBridge = () => Boolean(window.runningHub);
