import { useCallback, useLayoutEffect, useRef } from "react";

/** Stable identity, with the handler from the latest committed render. */
export function useLatestCallback<A extends unknown[], R>(callback: (...args: A) => R) {
  const latest = useRef(callback);
  useLayoutEffect(() => { latest.current = callback; });
  return useCallback((...args: A) => latest.current(...args), []);
}
