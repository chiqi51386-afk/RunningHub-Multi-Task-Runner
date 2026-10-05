import { generateGemini, GeminiError, validateGeminiInput } from "./client.js";
import { GeminiStore } from "./store.js";
import type { GeminiGenerateInput, GeminiTestResult } from "./types.js";
import { generateTts, validateTtsInput } from "./tts.js";
import { TTS_MODEL, type TtsInput } from "./ttsTypes.js";

interface QueueItem<T> {
  action: () => Promise<T>;
  resolve: (value:T)=>void;
  reject: (reason:unknown)=>void;
  signal?: AbortSignal;
  abort?: ()=>void;
}

/** Four bounded workers improve batch latency while per-key reservations prevent overlap. */
export class GeminiPool {
  private readonly queue: QueueItem<any>[]=[];
  private active = 0;
  private pending = 0;
  private lastKeyId?: string;
  private readonly reservedKeys=new Set<string>();
  private readonly keyWaiters=new Set<()=>void>();
  constructor(readonly store: GeminiStore, private options: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {}) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private enqueue<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.pending >= 20) return Promise.reject(new Error("Google 请求队列已满，请稍后重试。"));
    this.pending++;
    return new Promise<T>((resolve,reject)=>{
      if(signal?.aborted){this.pending--;reject(new GeminiError('Google 请求已取消。','cancelled'));return;}
      const item:QueueItem<T>={action,resolve,reject,signal};
      item.abort=()=>{
        const index=this.queue.indexOf(item);
        if(index<0)return;
        this.queue.splice(index,1);this.pending--;
        reject(new GeminiError('Google 请求已取消。','cancelled'));
      };
      signal?.addEventListener('abort',item.abort,{once:true});
      this.queue.push(item);this.drain();
    });
  }
  private drain():void {
    while(this.active<4 && this.queue.length){
      const item=this.queue.shift()!;
      item.signal?.removeEventListener('abort',item.abort!);
      this.active++;
      Promise.resolve().then(()=>{item.signal?.throwIfAborted();return item.action();}).then(item.resolve,item.reject).finally(()=>{
        this.active--;this.pending--;this.drain();
      });
    }
  }
  private waitForKey(signal?:AbortSignal):Promise<void>{
    return new Promise((resolve,reject)=>{
      const finish=()=>{signal?.removeEventListener('abort',abort);this.keyWaiters.delete(finish);resolve();};
      const abort=()=>{this.keyWaiters.delete(finish);reject(new GeminiError('Google 请求已取消。','cancelled'));};
      this.keyWaiters.add(finish);signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
    });
  }
  private releaseKey(id:string):void{
    this.reservedKeys.delete(id);
    for(const wake of [...this.keyWaiters])wake();
  }
  generate(input: GeminiGenerateInput, signal?: AbortSignal, selectedModel?: string): Promise<{text:string;keyId:string;model:string}> {
    validateGeminiInput(input);
    const snapshot = structuredClone(input), model = selectedModel ?? this.store.settings().model;
    return this.enqueue(() => this.run(snapshot,model,undefined,signal),signal);
  }
  async test(id?: string): Promise<GeminiTestResult> {
    const start = this.now(), model = this.store.settings().model;
    try {
      const result = await this.enqueue(() => this.run({text:"Reply with OK only.",maxOutputTokens:2048},model,id));
      return { success:true,keyId:result.keyId,model,latencyMs:this.now()-start,message:"连接成功" };
    } catch (error) {
      return {success:false,keyId:id,model,latencyMs:this.now()-start,message:error instanceof Error ? error.message : "检测失败"};
    }
  }
  speech(input:TtsInput,signal?:AbortSignal):Promise<{text:string;keyId:string;model:string}>{
    validateTtsInput(input);
    const snapshot=structuredClone(input);
    return this.enqueue(()=>this.run({text:snapshot.text},TTS_MODEL,undefined,signal,
      secret=>generateTts(secret,snapshot,{fetch:this.options.fetch,signal,timeoutMs:this.options.timeoutMs})),signal);
  }
  private async run(input: GeminiGenerateInput, model: string, forcedId?: string, signal?: AbortSignal, operation?:(secret:string)=>Promise<string>): Promise<{text:string;keyId:string;model:string}> {
    const all = this.store.list(model);
    const start = (all.findIndex(k => k.id === this.lastKeyId)+1) % Math.max(1,all.length);
    const ordered = forcedId ? all.filter(k => k.id === forcedId) : [...all.slice(start),...all.slice(0,start)];
    let lastError: Error | undefined, attempts = 0, blockedByReservation=false;
    for (const entry of ordered) {
      const key = this.store.list(model).find(k => k.id===entry.id);
      if (!key || (!forcedId && (!key.enabled || (key.retryAt ?? 0)>this.now()))) continue;
      if(this.reservedKeys.has(key.id)){blockedByReservation=true;continue;}
      signal?.throwIfAborted();
      if (++attempts>3) break;
      if (!forcedId) this.lastKeyId = key.id;
      this.reservedKeys.add(key.id);
      let secret: string;
      try { secret=this.store.secret(key.id); }
      catch { this.releaseKey(key.id);this.store.record(key.id,"secret_error",this.now(),"无法读取 Key，请删除后重新添加。",this.now()+300_000,model);lastError=new Error("无法读取 Key，请重新添加。");continue; }
      try {
        this.store.used(key.id,this.now());
        const text = await (operation ? operation(secret) : generateGemini(secret,model,input,{fetch:this.options.fetch,timeoutMs:this.options.timeoutMs,signal}));
        this.store.record(key.id,"ready",this.now(),undefined,undefined,model);
        return {text,keyId:key.id,model};
      } catch (error) {
        if (!(error instanceof GeminiError)) throw error;
        if (error.kind==="cancelled") throw error;
        if (error.kind==="config" || error.kind==="content") {
          this.store.record(key.id,key.state==="ready"?"ready":"unchecked",this.now(),error.message,undefined,model);
          throw error;
        }
        this.store.record(key.id,error.kind==="auth"?"auth_error":"cooldown",this.now(),error.message,this.now()+error.retryAfterMs,model);
        lastError=error;
      } finally {
        this.releaseKey(key.id);
      }
    }
    if (lastError) throw lastError;
    if(blockedByReservation){await this.waitForKey(signal);return this.run(input,model,forcedId,signal,operation);}
    if (forcedId) throw new Error("API Key 已删除。");
    throw new Error(all.some(k=>k.enabled) ? "Google Key 暂在冷却，稍后可自动参与轮询，也可单独重新检测。" : "请先在账号池 → Gemini 中添加并启用 API Key。");
  }
}
