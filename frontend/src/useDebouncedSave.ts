import { useEffect, useLayoutEffect, useRef } from "react";

/** Serialize after editing settles; flush the latest committed input on exit. */
export function useDebouncedSave(save: () => void, dependencies: readonly unknown[], delay = 300) {
  const latest = useRef(save);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => { latest.current = save; });
  const flush = () => {
    clearTimeout(timer.current);
    if (!pending.current) return;
    pending.current = false;
    latest.current();
  };
  useEffect(() => {
    pending.current = true;
    timer.current = setTimeout(flush, delay);
    return () => clearTimeout(timer.current);
  }, [...dependencies, delay]);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", hidden);
      flush();
    };
  }, []);
}
