import { useCallback, useState } from "react";

export function useErrorQueue() {
  const [errors, setErrors] = useState<string[]>([]);
  const report = useCallback((error?: string) => {
    setErrors(current => error === undefined ? current.slice(1)
      : current.includes(error) ? current : [...current, error].slice(-5));
  }, []);
  return [errors[0], report] as const;
}
