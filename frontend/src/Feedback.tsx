import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, Info, X } from "lucide-react";

// All transient messages share one layout, including messages from dialogs.
// Separate fixed-position banners can otherwise occupy the same coordinates.
function noticeRegion() {
  let region = document.getElementById("app-notifications");
  if (!region) {
    region = document.createElement("div");
    region.id = "app-notifications";
    region.className = "notification-stack";
    region.setAttribute("aria-label", "操作提示");
    document.body.append(region);
  }
  return region;
}

export function Notice({ children }: { children: ReactNode }) {
  return createPortal(children, noticeRegion());
}

export function Feedback({ message, tone = "error", onClose, duration, children }: {
  message?: string;
  tone?: "success" | "error" | "info";
  onClose?: () => void;
  duration?: number;
  children?: ReactNode;
}) {
  const [dismissed, setDismissed] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const timeout = duration ?? (tone === "error" ? 0 : 4000);
  useEffect(() => {
    setDismissed(false);
    if (!message || !timeout) return;
    const timer = setTimeout(() => { setDismissed(true); closeRef.current?.(); }, timeout);
    return () => clearTimeout(timer);
  }, [message, timeout]);
  if (!message || dismissed) return null;
  const Icon = tone === "error" ? AlertTriangle : tone === "success" ? Check : Info;
  return <Notice><div className={`feedback-toast ${tone}`} role={tone === "error" ? "alert" : "status"}>
    <Icon size={18}/><div className="feedback-message">{message}{children}</div>
    <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => { setDismissed(true); closeRef.current?.(); }}><X size={16}/></button>
  </div></Notice>;
}
