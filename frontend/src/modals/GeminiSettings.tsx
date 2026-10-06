import { Copy, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Feedback, Notice } from "../Feedback";
import { Select } from "../Select";
import { DEFAULT_GEMINI_MODEL, type GeminiKeyView, type GeminiSettings as Settings } from "../../../src/core/gemini/types";

function stateLabel(key: GeminiKeyView) {
  if (!key.enabled) return "已停用";
  if (key.retryAt && key.retryAt <= Date.now() && key.state !== "ready") return "等待重新检测";
  return {unchecked:"未检测",ready:"可用",cooldown:"冷却中",auth_error:"权限异常",secret_error:"需重新添加"}[key.state];
}

const modelOptions = [
  { id: DEFAULT_GEMINI_MODEL, label: "Gemini 3.5 Flash-Lite" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
];

export default function GeminiSettings() {
  const bridge = window.runningHub?.gemini;
  const [settings,setSettings] = useState<Settings>({optimizationEnabled:false,model:DEFAULT_GEMINI_MODEL,keys:[]});
  const [model,setModel] = useState(DEFAULT_GEMINI_MODEL);
  const [keys,setKeys] = useState("");
  const [busy,setBusy] = useState<string>();
  const [message,setMessage] = useState("");
  const [error,setError] = useState(false);
  const working = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current=true;
    void bridge?.settings().then(value => {if(alive.current){setSettings(value);setModel(value.model);}}).catch(e=>{if(alive.current){setError(true);setMessage(String(e));}});
    return()=>{alive.current=false;};
  },[bridge]);
  async function perform(name:string,action:()=>Promise<string>) {
    if(working.current || !bridge)return;
    working.current=true;setBusy(name);setMessage("");setError(false);
    try {const text=await action();if(alive.current)setMessage(text);}
    catch(e){if(alive.current){setMessage(e instanceof Error?e.message:"操作失败");setError(true);}}
    finally {
      try {const value=await bridge.settings();if(alive.current)setSettings(value);}catch{ /* retain action error */ }
      working.current=false;if(alive.current)setBusy(undefined);
    }
  }
  const modelChanged=model.trim()!==settings.model;
  async function test(id?:string) {
    const result=await bridge!.test(id);
    if(!result.success)throw new Error(result.message);
    const key=settings.keys.find(k=>k.id===result.keyId);
    return `${key?.label??"Google"} · ${result.model} 连接成功 · ${(result.latencyMs/1000).toFixed(1)} 秒`;
  }
  async function testAll() {
    const targets=[...settings.keys];
    let success=0;
    const errors:string[]=[];
    for(const [index,key] of targets.entries()){
      if(!alive.current)break;
      setMessage(`正在检测 ${index+1}/${targets.length}：${key.label} · ${settings.model}`);
      const result=await bridge!.test(key.id);
      if(result.success)success++;
      else errors.push(`${key.label}：${result.message}`);
      if(alive.current)setSettings(await bridge!.settings());
    }
    const summary=`检测完成：成功 ${success} 个，失败 ${errors.length} 个 · ${settings.model}`;
    if(errors.length)throw new Error(`${summary}；${errors.join("；")}`);
    return summary;
  }
  return <section className="settings-section gemini-settings" aria-label="Gemini API 管理">
    <div className="settings-section-title"><strong>模型与 API Key 轮询池</strong><span>{settings.keys.length} 个 Key</span></div>
    <div className="gemini-model-row"><label>模型<Select aria-label="Gemini 模型" value={model} disabled={!!busy||!bridge} onChange={e=>setModel(e.target.value)}>{modelOptions.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}{!modelOptions.some(option=>option.id===settings.model)&&<option value={settings.model}>{settings.model}（已保存）</option>}</Select></label><button type="button" className="secondary" disabled={!!busy||!bridge||!modelChanged} onClick={()=>void perform("model",async()=>{await bridge!.setModel(model);return "模型已保存，请检测当前模型是否可用";})}>保存模型</button></div>
    <p>{modelChanged ? "模型尚未保存，保存后再检测。" : `当前模型：${settings.model}`} 免费额度与调用权限以当前项目实际结果为准。</p>
    <label>添加 API Key<textarea aria-label="Google API Keys" rows={3} value={keys} disabled={!!busy||!bridge} onChange={e=>setKeys(e.target.value)} placeholder="每行一个 API Key" autoComplete="off" spellCheck={false}/></label>
    <div className="settings-actions"><button type="button" className="secondary" disabled={!!busy||!bridge||!keys.trim()} onClick={()=>void perform("add",async()=>{await bridge!.addKeys(keys.split(/\r?\n/).map(k=>k.trim()).filter(Boolean));if(alive.current)setKeys("");return "已添加，重复 Key 自动忽略";})}><Plus size={15}/>添加</button><button type="button" className="ghost" disabled={!!busy||!bridge} onClick={()=>void perform("copy",async()=>{await bridge!.copyKeysUrl();return "密钥申请地址已复制";})}><Copy size={14}/>复制申请地址</button></div>
    {!settings.keys.length && <p>暂无 Key，请在上方按行添加。</p>}
    <div className="gemini-key-list">{settings.keys.map(key=><article className="gemini-key-row" key={key.id}>
      <div className="gemini-key-info"><strong>{key.label}</strong><code>{key.maskedKey}</code><span>{stateLabel(key)}</span>{key.lastError&&<span className="gemini-key-error">{key.lastError}</span>}{key.retryAt&&key.retryAt>Date.now()&&<span>下次可重试：{new Date(key.retryAt).toLocaleTimeString()}</span>}</div>
      <div className="gemini-key-actions"><button type="button" className={`switch ${key.enabled?"checked":""}`} aria-label={`${key.label} 启用`} aria-pressed={key.enabled} disabled={!!busy} onClick={()=>void perform(key.id,async()=>{await bridge!.setEnabled(key.id,!key.enabled);return key.enabled?"已停用":"已启用";})}><span/></button><button type="button" className="secondary small" disabled={!!busy||modelChanged} onClick={()=>void perform(key.id,()=>test(key.id))}>检测</button><button type="button" className="icon-button danger" disabled={!!busy} aria-label={`删除 ${key.label}`} onClick={()=>void perform(key.id,async()=>{await bridge!.remove(key.id);return "已删除";})}><Trash2 size={15}/></button></div>
    </article>)}</div>
    <div className="settings-actions"><button type="button" className="secondary" disabled={!!busy||!bridge||modelChanged||!settings.keys.length} onClick={()=>void perform("all",testAll)}><RefreshCw size={14}/>{busy==="all"?"正在检测全部…":"检测全部账号"}</button></div>
    <p>按顺序轮询启用的 Key；临时错误冷却后恢复参与。相同 Google 项目的 Key 共用额度。检测会发送一条简短请求。</p>
    {!bridge&&<p>请在更新后的桌面测试版中配置。</p>}
    {busy&&<Notice><div role="status" className="operation-toast"><LoaderCircle className="spin" size={15}/>正在处理…</div></Notice>}
    <Feedback message={message} tone={error?"error":"success"} onClose={()=>setMessage("")}/>
  </section>;
}
