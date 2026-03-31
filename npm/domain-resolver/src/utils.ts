import { CID } from "multiformats/cid";

import type { DomainInfoLike, DomainTarget, GatewayCandidate, GatewaySource } from "./types.js";

export const DEFAULT_PUBLIC_GATEWAYS = [
  "https://trustless-gateway.link",
  "https://ipfs.io",
  "https://dweb.link",
];

export const DEFAULT_DOMAIN_CACHE_TTL_MS = 30_000;
export const DEFAULT_GATEWAY_CACHE_TTL_MS = 5 * 60_000;
export const DEFAULT_GATEWAY_LIMIT = 128;

export function normalizePath(rawPath: string): string {
  const raw = String(rawPath || "").trim();
  if (!raw) return "/";
  const pathOnly = raw.split(/[?#]/, 1)[0] || "";
  if (!pathOnly) return "/";
  return pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
}

export function stripLeadingSlash(path: string): string {
  const normalized = normalizePath(path);
  return normalized.replace(/^\/+/, "");
}

export function mergePaths(...parts: Array<string | undefined | null>): string {
  const segments: string[] = [];

  for (const part of parts) {
    if (!part) continue;
    const normalized = normalizePath(part);
    if (normalized === "/") continue;
    for (const segment of normalized.split("/")) {
      const clean = segment.trim();
      if (!clean) continue;
      segments.push(clean);
    }
  }

  return segments.length ? `/${segments.join("/")}` : "/";
}

export function trimTrailingSlash(url: string): string {
  return String(url || "").replace(/\/+$/, "");
}

export function parseCid(value: string): CID | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return CID.parse(raw);
  } catch {
    return null;
  }
}

export function isCidLike(value: string): boolean {
  return parseCid(value) != null;
}

export function targetProtoFromIdentifier(value: string): DomainTarget["proto"] {
  const cid = parseCid(value);
  if (cid?.code === 0x72) return "ipns";
  return "ipfs";
}

export function parseRecordTarget(value: unknown): DomainTarget | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const normalizeBasePath = (path: string): string => {
    const normalized = normalizePath(path);
    if (normalized === "/") return "";
    return normalized.replace(/\/+$/, "");
  };

  const parseWithProto = (proto: DomainTarget["proto"], input: string): DomainTarget | null => {
    const cleaned = String(input || "").trim().replace(/^\/+/, "");
    if (!cleaned) return null;
    const pathOnly = cleaned.split(/[?#]/, 1)[0] || "";
    const segments = pathOnly.split("/");
    const id = String(segments[0] || "").trim();
    if (!id) return null;
    const rest = segments.slice(1).join("/");
    const basePath = rest ? normalizeBasePath(`/${rest}`) : "";
    return { proto, id, ...(basePath ? { basePath } : {}) };
  };

  if (lower.startsWith("ipfs://")) return parseWithProto("ipfs", raw.slice("ipfs://".length));
  if (lower.startsWith("ipns://")) return parseWithProto("ipns", raw.slice("ipns://".length));
  if (lower.startsWith("lumen://ipfs/")) return parseWithProto("ipfs", raw.slice("lumen://ipfs/".length));
  if (lower.startsWith("lumen://ipns/")) return parseWithProto("ipns", raw.slice("lumen://ipns/".length));
  if (lower.startsWith("/ipfs/")) return parseWithProto("ipfs", raw.slice("/ipfs/".length));
  if (lower.startsWith("/ipns/")) return parseWithProto("ipns", raw.slice("/ipns/".length));

  const directCid = parseCid(raw);
  if (directCid) {
    return {
      proto: directCid.code === 0x72 ? "ipns" : "ipfs",
      id: raw,
    };
  }

  return null;
}

export function splitSubdomain(host: string): { baseDomain: string; recordKey: string | null } {
  const normalized = String(host || "").trim().toLowerCase();
  const parts = normalized.split(".").filter(Boolean);
  if (parts.length >= 3) {
    return {
      recordKey: parts[0] || null,
      baseDomain: parts.slice(1).join("."),
    };
  }
  return { recordKey: null, baseDomain: normalized };
}

export function pickTargetFromDomainInfo(
  info: DomainInfoLike | null,
  recordKey?: string | null,
): { target: DomainTarget; source: string } | null {
  if (!info) return null;

  const records = Array.isArray(info.records) ? info.records : [];
  const lowerRecordKey = String(recordKey || "").trim().toLowerCase();

  if (lowerRecordKey) {
    const record = records.find((entry) => String(entry?.key || "").trim().toLowerCase() === lowerRecordKey);
    const target = record ? parseRecordTarget(record.value) : null;
    if (target) return { target, source: `record:${lowerRecordKey}` };
  }

  for (const key of ["cid", "ipfs", "ipns", "root", "site", "website"]) {
    const record = records.find((entry) => String(entry?.key || "").trim().toLowerCase() === key);
    const target = record ? parseRecordTarget(record.value) : null;
    if (target) return { target, source: `record:${key}` };
  }

  const directCid = parseRecordTarget(info.cid);
  if (directCid) return { target: directCid, source: "domain.cid" };

  const directIpns = parseRecordTarget(info.ipns);
  if (directIpns) return { target: directIpns, source: "domain.ipns" };

  return null;
}

export function coerceGatewayEndpoint(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";

  try {
    const hasScheme = /^[a-z]+:\/\//i.test(raw);
    if (hasScheme) {
      const url = new URL(raw);
      const protocol = String(url.protocol || "").toLowerCase();
      if (protocol === "http:" || protocol === "https:") {
        const origin = url.origin || raw;
        if (origin && origin !== "null") return trimTrailingSlash(origin).toLowerCase();
      }
      const host = url.host || url.hostname || raw;
      return trimTrailingSlash(String(host)).toLowerCase();
    }
  } catch {
    // Fall back to non-URL normalization.
  }

  const head = raw.split(/[/?#]/, 1)[0] || "";
  return trimTrailingSlash(head).toLowerCase();
}

export function parseGatewayMetadata(input: unknown): Record<string, unknown> {
  if (!input) return {};
  if (typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input !== "string") return {};

  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function toGatewayUrl(input: unknown): string | null {
  const endpoint = coerceGatewayEndpoint(input);
  if (!endpoint) return null;
  if (/^https?:\/\//i.test(endpoint)) return trimTrailingSlash(endpoint);
  return `https://${endpoint}`;
}

export function normalizeGatewayInput(input: string | URL, source: GatewaySource): GatewayCandidate | null {
  const value = input instanceof URL ? input.toString() : String(input || "").trim();
  const url = toGatewayUrl(value);
  if (!url) return null;
  return { url, source };
}

export function extractGatewayCandidates(payload: unknown, source: GatewaySource): GatewayCandidate[] {
  const list =
    Array.isArray((payload as any)?.gateways) ? (payload as any).gateways
    : Array.isArray((payload as any)?.Gateways) ? (payload as any).Gateways
    : Array.isArray((payload as any)?.items) ? (payload as any).items
    : Array.isArray((payload as any)?.data) ? (payload as any).data
    : Array.isArray(payload) ? payload
    : [];

  return list
    .map((raw: any) => {
      const metadata = parseGatewayMetadata(raw?.metadata ?? raw?.meta ?? raw?.MetaData ?? raw?.info);
      const endpoint = coerceGatewayEndpoint(
        metadata.endpoint ?? raw?.endpoint ?? raw?.baseUrl ?? raw?.url ?? "",
      );
      const url = toGatewayUrl(endpoint);
      if (!url) return null;

      return {
        url,
        source,
        gatewayId: String(raw?.id ?? raw?.gatewayId ?? raw?.ID ?? "").trim() || undefined,
        endpoint: endpoint || undefined,
        active:
          typeof raw?.active === "boolean"
            ? raw.active
            : typeof raw?.Active === "boolean"
              ? raw.Active
              : undefined,
        metadata,
      } satisfies GatewayCandidate;
    })
    .filter((gateway: GatewayCandidate | null): gateway is GatewayCandidate => gateway != null);
}

export function dedupeGateways(gateways: GatewayCandidate[]): GatewayCandidate[] {
  const seen = new Set<string>();
  const out: GatewayCandidate[] = [];

  for (const gateway of gateways) {
    const key = trimTrailingSlash(gateway.url).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...gateway, url: trimTrailingSlash(gateway.url) });
  }

  return out;
}

export function shuffleArray<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function decodeText(bytes: Uint8Array, encoding = "utf-8"): string {
  return new TextDecoder(encoding).decode(bytes);
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}
