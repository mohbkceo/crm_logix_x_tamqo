import {
  useEffect,
  useState,
  useCallback,
  createContext,
  useContext,
} from "react";
export async function api(path, options = {}) {
  const response = await fetch("/api" + path, {
    credentials: "include",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Request failed.");
  return data;
}
export function params(values) {
  return new URLSearchParams(
    Object.entries(values).filter(
      ([, v]) => v !== "" && v !== undefined && v !== null,
    ),
  ).toString();
}
export function useApi(path) {
  const [state, setState] = useState({ data: null, loading: true, error: "" });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: "" }));
    api(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ data, loading: false, error: "" });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ data: null, loading: false, error: error.message });
      });
    return () => controller.abort();
  }, [path, version]);
  return { ...state, reload };
}
export const ConfigContext = createContext(null);
export const useConfig = () => useContext(ConfigContext);
export const money = (n) =>
  new Intl.NumberFormat("en-DZ", { maximumFractionDigits: 2 }).format(n || 0) +
  " DA";
export const number = (n) =>
  new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(n || 0);
export const human = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
export const date = (d) =>
  d
    ? new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Africa/Algiers",
      }).format(new Date(d))
    : "—";
export const dateInput = (d) =>
  new Date(+new Date(d || Date.now()) + 3600000).toISOString().slice(0, 10);
