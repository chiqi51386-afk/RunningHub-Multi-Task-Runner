import { useEffect, useRef, useState } from "react";
import { Select } from "./Select";
import { Feedback } from "./Feedback";
import { useDebouncedSave } from "./useDebouncedSave";
import { readSaved } from "./draft-storage";
import { TTS_LANGUAGES, TTS_VOICES, TTS_VOICE_DETAILS, type TtsAudio, type TtsInput } from "../../src/core/gemini/ttsTypes";

function initialInput():TtsInput{
  const saved=readSaved("rh-runner.tts.v1") as Partial<TtsInput>|null;
  return {text:typeof saved?.text==="string"?saved.text:"",style:typeof saved?.style==="string"?saved.style:"",
    language:TTS_LANGUAGES.some(l=>l.id===saved?.language)?saved!.language!:"vi",
    voice:TTS_VOICES.some(v=>v[0]===saved?.voice)?saved!.voice!:"Erinome"};
}

export function GeminiTts({onSend,active}:{onSend:(audio:TtsAudio)=>void;active:boolean}){
  const [input,setInput]=useState<TtsInput>(initialInput);
  const [result,setResult]=useState<TtsAudio>();
  const [sample,setSample]=useState<TtsAudio>();
  const [busy,setBusy]=useState<"sample"|"generate"|"save"|null>(null);
  const [error,setError]=useState<string>();
  const [notice,setNotice]=useState<string>();
  const request=useRef<string | undefined>(undefined);
  const lock=useRef(false),alive=useRef(true);
  const samplePlayer=useRef<HTMLAudioElement>(null),resultPlayer=useRef<HTMLAudioElement>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(request.current)void window.runningHub?.tts?.cancel(request.current);};},[]);
  useDebouncedSave(()=>{try{localStorage.setItem("rh-runner.tts.v1",JSON.stringify(input));}catch{setError("配音草稿保存失败。");}},[input]);
  function update(change:Partial<TtsInput>){setInput(current=>({...current,...change}));setNotice(undefined);}
  async function generate(preview:boolean){
    if(lock.current)return;
    if(!window.runningHub?.tts){setError("语音功能未加载，请重启桌面端。");return;}
    lock.current=true;setBusy(preview?"sample":"generate");setError(undefined);setNotice(undefined);
    samplePlayer.current?.pause();resultPlayer.current?.pause();
    if(preview)setSample(undefined);
    const id=crypto.randomUUID();request.current=id;
    try{
      const audio=await window.runningHub.tts.generate(id,{...input},preview);
      if(alive.current){if(preview)setSample(audio);else setResult(audio);}
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:"语音生成失败。");}
    finally{request.current=undefined;lock.current=false;if(alive.current)setBusy(null);}
  }
  async function save(){
    if(!result || lock.current)return;
    lock.current=true;setBusy("save");setError(undefined);
    try{if(await window.runningHub!.tts.save(result.localPath))setNotice("音频已保存。");}
    catch(e){setError(e instanceof Error?e.message:"保存失败。");}
    finally{lock.current=false;if(alive.current)setBusy(null);}
  }
  return <section className="tts-workspace">
    <div className="tts-options">
      <label className="parameter-field"><span className="field-label">语言</span><Select aria-label="配音语言" value={input.language} disabled={!!busy} onChange={e=>{update({language:e.target.value});setSample(undefined);}}>{TTS_LANGUAGES.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</Select></label>
      <label className="parameter-field"><span className="field-label">音色</span><Select aria-label="配音音色" value={input.voice} disabled={!!busy} onChange={e=>{update({voice:e.target.value});setSample(undefined);}}>{TTS_VOICES.map(([id,gender,description])=><option key={id} value={id}>{id} · {gender} · {TTS_VOICE_DETAILS[id]?.age??description}</option>)}</Select></label>
      <button type="button" className="secondary-button" disabled={!!busy} onClick={()=>void generate(true)}>{busy==="sample"?"试听生成中…":"试听音色"}</button>
    </div>
    <p className="tts-voice-description">{TTS_VOICE_DETAILS[input.voice]?.description}</p>
    {sample&&<audio className="tts-sample" ref={samplePlayer} key={sample.previewUrl} src={sample.previewUrl} controls autoPlay={active} onPlay={()=>resultPlayer.current?.pause()}/>}
    <div className="parameter-field"><div className="tts-text-heading"><label htmlFor="tts-transcript" className="field-label">配音文本</label><button type="button" className="secondary-button" disabled={!!busy||(!input.text&&!input.style)} onClick={()=>{update({text:"",style:""});setError(undefined);}}>清空文本</button></div><textarea id="tts-transcript" aria-label="配音文本" className="tts-text" value={input.text} disabled={!!busy} maxLength={12000} placeholder="输入需要朗读的文字…" onChange={e=>update({text:e.target.value})}/></div>
    <label className="parameter-field"><span className="field-label">风格指令</span><textarea aria-label="风格指令" className="tts-style" value={input.style} disabled={!!busy} maxLength={1500} placeholder="可选，例如：温柔、带一点悲伤，语速稍慢，像在安慰亲人。" onChange={e=>update({style:e.target.value})}/></label>
    <Feedback message={error} onClose={()=>setError(undefined)}/>
    <Feedback message={notice} tone="success" onClose={()=>setNotice(undefined)}/>
    <div className="tts-actions"><button type="button" className="primary-button" disabled={!!busy||!input.text.trim()} onClick={()=>void generate(false)}>{busy==="generate"?"正在生成音频…":"生成音频"}</button>{(busy==="generate"||busy==="sample")&&<button type="button" className="secondary-button" onClick={()=>{if(request.current)void window.runningHub?.tts.cancel(request.current).catch(()=>setError("取消失败，请重试。"));}}>取消</button>}</div>
    {result&&<div className="tts-result"><audio ref={resultPlayer} key={result.previewUrl} src={result.previewUrl} controls preload="metadata" onPlay={()=>samplePlayer.current?.pause()}/><div className="tts-actions"><button type="button" className="primary-button" disabled={!!busy} onClick={()=>{resultPlayer.current?.pause();onSend(result);}}>发送到数字人</button><button type="button" className="secondary-button" disabled={!!busy} onClick={()=>void save()}>保存音频</button></div></div>}
  </section>;
}
