import { AlertTriangle, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import type { AccountView } from "../types";

export function AddAccountModal({ onClose, onAdd }: { onClose: () => void; onAdd: (label: string, keys: string[], detect: boolean) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [keysText, setKeysText] = useState("");
  const [saving, setSaving] = useState(false);
  const keys = [...new Set(keysText.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean))];
  async function submit(detect: boolean) {
    if (!label.trim() || !keys.length || saving) return;
    setSaving(true);
    try { await onAdd(label, keys, detect); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop" role="presentation"><form className="modal" onSubmit={e => { e.preventDefault(); void submit(true); }}><div className="modal-head"><div><h2>添加 RunningHub 账号</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={18} /></button></div><label>账号名称<input autoFocus value={label} onChange={e => setLabel(e.target.value)} placeholder="例如：海外账号（批量时自动追加序号）" /></label><label>API Key（支持批量）<textarea className="api-key-list" value={keysText} onChange={e => setKeysText(e.target.value)} placeholder="每行粘贴一个 API Key；重复项会自动去除" rows={5} spellCheck={false} /></label><div className="security-note"><AlertTriangle size={18} /><span>已输入 {keys.length} 个唯一 Key。Key 将通过系统加密保存在本机；换电脑后可能需要重新填写。</span></div><div className="modal-actions account-modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button type="button" className="secondary" disabled={saving || !label.trim() || !keys.length} onClick={() => void submit(false)}>仅保存</button><button type="submit" className="primary" disabled={saving || !label.trim() || !keys.length}>{saving ? "正在保存…" : "保存并后台检测"}</button></div></form></div>;
}

export function ReplaceAccountKeyModal({ account, onClose, onSave }: { account: AccountView; onClose: () => void; onSave: (id: string, apiKey: string) => Promise<void> }) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit() {
    if (!apiKey.trim() || saving) return;
    setSaving(true);
    try { await onSave(account.id, apiKey); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop" role="presentation"><form className="modal" onSubmit={event => { event.preventDefault(); void submit(); }}><div className="modal-head"><div><h2>重新录入 API Key</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={18} /></button></div><div className="rekey-account"><div><strong>{account.label}</strong><small>{account.id}</small></div></div><label>新的 API Key<input autoFocus type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="重新输入该账号的完整 API Key" /></label><div className="security-note"><ShieldCheck size={18} /><span>保存后只检测这个账号，不会触发其他账号检测，也不会删除任务历史。</span></div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" className="primary" disabled={!apiKey.trim() || saving}>{saving ? "保存中…" : "保存并检测此账号"}</button></div></form></div>;
}
