import { useEffect } from "react";

/** Shared keyboard behavior for existing dialogs, without replacing their data ownership. */
export function useDialogFocus() {
  useEffect(() => {
    let current: HTMLElement | undefined;
    let previous: HTMLElement | null = null;
    const focusable = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]')).filter(item => item.getClientRects().length > 0);
    const findDialog = () => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('.modal-backdrop .modal')).filter(item => item.getClientRects().length > 0);
      const next = dialogs.at(-1);
      if (next === current) return;
      if (next) {
        if (!current) previous = document.activeElement as HTMLElement | null;
        current = next;
        if (!next.contains(document.activeElement)) focusable(next)[0]?.focus();
      } else {
        current = undefined;
        previous?.isConnected && previous.focus();
        previous = null;
      }
    };
    const observer = new MutationObserver(findDialog);
    observer.observe(document.body, { childList: true, subtree: true });
    const keydown = (event: KeyboardEvent) => {
      if (!current || event.defaultPrevented) return;
      if (event.key === "Escape") {
        const close = current.querySelector<HTMLButtonElement>('.modal-head button:not([disabled]), .modal-actions button.secondary:not([disabled])');
        if (close) { event.preventDefault(); close.click(); }
      }
      if (event.key === "Tab") {
        const items = focusable(current), first = items[0], last = items.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || !current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    findDialog();
    return () => { observer.disconnect(); document.removeEventListener("keydown", keydown); };
  }, []);
}
