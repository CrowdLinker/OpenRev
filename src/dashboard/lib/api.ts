import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** The response body, for errors that carry more than a message. */
    public data?: unknown,
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

export async function api<T = unknown>(path: string, opts: { method?: Method; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
    signal: opts.signal,
  });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const message = (data as { error?: string })?.error || res.statusText || "Request failed";
    if (res.status === 401 && !path.startsWith("/api/auth") && !path.startsWith("/api/share")) {
      window.dispatchEvent(new CustomEvent("openrev:unauthorized"));
    }
    throw new ApiError(message, res.status, data);
  }
  return data as T;
}

export interface ApiState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
  /** Replaces the data without a request (e.g. after fetching it elsewhere). */
  setData: (d: T) => void;
}

/** Fetches `path` (re-fetching when it changes), keeping previous data while reloading. */
export function useApi<T>(path: string | null, opts: { poll?: number } = {}): ApiState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(!!path);
  const [nonce, setNonce] = useState(0);
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    let alive = true;
    if (lastPath.current !== path) setLoading(true);
    lastPath.current = path;
    const load = (background = false) => {
      if (!background) setLoading(true);
      api<T>(path, { signal: ctrl.signal })
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError(undefined);
          setLoading(false);
        })
        .catch((e) => {
          if (!alive || (e as Error).name === "AbortError") return;
          setError(e as Error);
          setLoading(false);
        });
    };
    load();
    const timer = opts.poll ? setInterval(() => document.visibilityState === "visible" && load(true), opts.poll) : null;
    return () => {
      alive = false;
      ctrl.abort();
      if (timer) clearInterval(timer);
    };
  }, [path, nonce, opts.poll]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload, setData };
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const read = (k: string): T => {
    try {
      const raw = localStorage.getItem(k);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  };
  // Keyed state: when the key changes (e.g. once the site id loads) re-read the stored value.
  const [state, setState] = useState(() => ({ key, value: read(key) }));
  const value = state.key === key ? state.value : read(key);
  if (state.key !== key) setState({ key, value });
  const set = useCallback(
    (v: T) => {
      setState({ key, value: v });
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [value, set];
}
