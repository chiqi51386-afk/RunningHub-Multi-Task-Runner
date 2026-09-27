import { useEffect, useRef, useState } from "react";

export function useConfirmDialog() {
  const [message, setMessage] = useState<string>();
  const resolve = useRef<((value: boolean) => void) | undefined>(undefined);
  useEffect(() => () => resolve.current?.(false), []);
  function finish(value: boolean) {
    resolve.current?.(value);
    resolve.current = undefined;
    setMessage(undefined);
  }
  function confirm(message: string): Promise<boolean> {
    resolve.current?.(false);
    setMessage(message);
    return new Promise<boolean>(done => { resolve.current = done; });
  }
  const dialog = message ? <div className="modal-backdrop"><div className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
    <div className="modal-head"><h2 id="confirm-title">确认操作</h2><button type="button" className="icon-button" aria-label="关闭" onClick={() => finish(false)}>×</button></div>
    <p id="confirm-message">{message}</p>
    <div className="modal-actions"><button type="button" className="secondary" autoFocus onClick={() => finish(false)}>返回</button><button type="button" className="danger-button" onClick={() => finish(true)}>确认</button></div>
  </div></div> : null;
  return { confirm, dialog };
}
