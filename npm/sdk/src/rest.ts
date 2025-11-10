type QueryParams = Record<string, string | number | boolean | undefined | null>;

export interface RestRequestInit extends RequestInit {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 12_000;

export async function fetchJson(url: string, init: RestRequestInit = {}): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload: any = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      const error = typeof payload === "string" ? payload : response.statusText;
      throw new Error(`${response.status} ${error}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export function withQuery(url: string, params?: QueryParams): string {
  if (!params) return url;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  if (!query) return url;
  return `${url}?${query}`;
}

export function joinRest(base: string, suffix: string): string {
  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${normalizedBase}${normalizedSuffix}`;
}
