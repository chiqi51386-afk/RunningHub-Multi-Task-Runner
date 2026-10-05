import { GeminiError, httpError } from "./client.js";
import { TTS_LANGUAGES, TTS_MODEL, TTS_VOICES, type TtsInput } from "./ttsTypes.js";

export function validateTtsInput(input: TtsInput): void {
  if (!input || typeof input.text !== "string" || !input.text.trim() || input.text.length > 12000) throw new GeminiError("请填写配音文本，最多 12000 字。", "config");
  if (!TTS_VOICES.some(v=>v[0]===input.voice) || !TTS_LANGUAGES.some(v=>v.id===input.language)) throw new GeminiError("请选择有效的语言和音色。", "config");
  if (typeof input.style !== "string" || input.style.length>1500) throw new GeminiError("情感与语气最多 1500 字。", "config");
}

export function ttsRequest(input: TtsInput) {
  validateTtsInput(input);
  return {model:TTS_MODEL,store:false,stream:false,
    input:[{type:"user_input",content:[{type:"text",text:input.text,
      annotations:[{type:"speech_metadata",style:[TTS_LANGUAGES.find(l=>l.id===input.language)!.direction,input.style.trim()].filter(Boolean).join("\n")}]}]}],
    response_format:{type:"audio",mime_type:"audio/wav",sample_rate:24000},
    generation_config:{speech_config:[{voice:input.voice}]}};
}

export async function generateTts(secret: string,input:TtsInput,options:{fetch?:typeof fetch;signal?:AbortSignal;timeoutMs?:number}={}):Promise<string>{
  const body=ttsRequest(input);
  const timeout=AbortSignal.timeout(options.timeoutMs??180000);
  const signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
  try{
    const response=await(options.fetch??fetch)("https://generativelanguage.googleapis.com/v1beta/interactions",{
      method:"POST",redirect:"error",signal,headers:{"Content-Type":"application/json","x-goog-api-key":secret},body:JSON.stringify(body),
    });
    const result=await response.json() as Record<string,any>;
    if(!response.ok)throw httpError(response.status,result,response.headers.get("retry-after"));
    signal.throwIfAborted();
    if(result.status && result.status!=="completed")throw new GeminiError("语音生成未完成，请重试。","content");
    const steps=Array.isArray(result.steps)?result.steps:[];
    const content=steps.filter((step:any)=>step.type==="model_output").at(-1)?.content;
    const audioParts=Array.isArray(content)?content.filter((part:any)=>part.type==="audio"):[];
    if(audioParts.length>1)throw new GeminiError("返回了多段音频，请缩短配音文本后重试。","content");
    const data=result.output_audio?.data ?? audioParts[0]?.data;
    if(typeof data!=="string" || data.length>90_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))throw new GeminiError("Google 未返回有效音频。","content");
    const wav=Buffer.from(data,"base64");
    if(wav.length<44 || wav.toString("ascii",0,4)!=="RIFF" || wav.toString("ascii",8,12)!=="WAVE")throw new GeminiError("返回音频不是有效的 WAV 文件。","content");
    return data;
  }catch(error){
    if(options.signal?.aborted)throw new GeminiError("语音生成已取消。","cancelled");
    if(error instanceof GeminiError)throw error;
    throw new GeminiError(timeout.aborted?"语音生成超时，请重试。":"无法连接 Google 语音服务，请检查网络。","transient");
  }
}
