import { bitswap } from "@helia/block-brokers";
import { createHelia, heliaDefaults } from "helia";
import { createHeliaHTTP } from "@helia/http";
import { ipns, type IPNS } from "@helia/ipns";
import { delegatedHTTPRouting, delegatedHTTPRoutingDefaults, httpGatewayRouting, libp2pRouting } from "@helia/routers";
import { type UnixFS, unixfs } from "@helia/unixfs";
import type { Helia } from "@helia/interface";
import { LUMEN, modules } from "@lumen-chain/sdk";
import { CID } from "multiformats/cid";

import type {
  ChainConsistencyMode,
  ContentKind,
  ContentListEntry,
  ContentStat,
  DnsVerificationMode,
  DirectoryContentEntry,
  DirectoryContentResult,
  DomainInfoLike,
  DomainTarget,
  FileContentResult,
  FullContentResult,
  GatewayCandidate,
  GatewayPerformanceStats,
  GetFullContentOptions,
  ListOptions,
  PrefetchOptions,
  PrefetchResult,
  ReadBytesOptions,
  ReadStreamOptions,
  ReadTextOptions,
  ResolveDomainResult,
  ResolvedResource,
  ResolverEvent,
  ResolverObserver,
  ResolverSecurityMetadata,
  ResolverStatus,
  ResolveResourceOptions,
  ResolverCacheRecord,
  ResolverCacheStore,
  ResolverOptions,
  ResolverTransport,
} from "./types.js";
import {
  createDefaultCacheStore,
  createMemoryCacheStore,
  makeCacheRecord,
} from "./cache.js";
import { LumenDnsLightVerifier } from "./dnsLightVerifier.js";
import { createParallelGatewayBroker, type GatewayResultEvent } from "./parallelGatewayBroker.js";
import { PersistentTrustStateStore } from "./trustState.js";
import {
  DEFAULT_DOMAIN_CACHE_TTL_MS,
  DEFAULT_GATEWAY_CACHE_TTL_MS,
  DEFAULT_GATEWAY_LIMIT,
  DEFAULT_PUBLIC_GATEWAYS,
  concatChunks,
  decodeText,
  dedupeGateways,
  extractGatewayCandidates,
  isCidLike,
  mergePaths,
  normalizeGatewayInput,
  normalizePath,
  parseCid,
  parseRecordTarget,
  pickTargetFromDomainInfo,
  shuffleArray,
  splitSubdomain,
  stripLeadingSlash,
  targetProtoFromIdentifier,
  trimTrailingSlash,
} from "./utils.js";

const DEFAULT_REST_TIMEOUT_MS = 5_000;
const DEFAULT_RPC_TIMEOUT_MS = 8_000;
const DEFAULT_CONTENT_CACHE_MAX_ENTRIES = 256;
const DEFAULT_CONTENT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_IPNS_RESOLVE_TIMEOUT_MS = 1_500;
const DEFAULT_IPNS_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_P2P_ATTEMPT_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_NAMESPACE = "domain-resolver";
const DEFAULT_GATEWAY_SCORE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECENT_EVENTS = 200;
const DEFAULT_PREFETCH_CONCURRENCY = 4;
const DEFAULT_PREFETCH_MAX_ENTRIES = 64;
const DEFAULT_PREFETCH_MAX_BYTES = 16 * 1024 * 1024;

const CACHE_DOMAIN = "domain";
const CACHE_GATEWAYS = "gateways";
const CACHE_CONTENT = "content";
const CACHE_IPNS = "ipns";
const CACHE_GATEWAY_SCORES = "gateway_scores";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type CacheLookup<T> = {
  record: ResolverCacheRecord<T>;
  expired: boolean;
} | null;

type HeliaBundle = {
  helia: Helia;
  fs: UnixFS;
  ipnsApi: IPNS;
  transport: ResolverTransport;
  gatewayKey: string;
};

type ParsedStringResource =
  | {
      kind: "domain";
      host: string;
      baseDomain: string;
      recordKey: string | null;
      inlinePath: string;
    }
  | {
      kind: "target";
      target: DomainTarget;
      inlinePath: string;
    };

type IpnsCacheValue = {
  cidString: string;
  path?: string;
};

type DomainResolutionState = {
  info: DomainInfoLike | null;
  security: ResolverSecurityMetadata;
};

type AbortContext = {
  signal?: AbortSignal;
  timedOut: () => boolean;
  parentAborted: () => boolean;
  cleanup: () => void;
};

type RestConsensusSuccess<T> = {
  endpoint: string;
  value: T;
  normalized: string;
};

type PrefetchAccumulator = {
  visitedEntries: number;
  warmedFiles: number;
  warmedBytes: number;
  prefetchedPaths: string[];
};

function normalizeDomainPayload(payload: unknown): DomainInfoLike | null {
  const raw =
    (payload as any)?.domain ??
    (payload as any)?.data?.domain ??
    (payload as any)?.data ??
    payload;

  return raw && typeof raw === "object" ? (raw as DomainInfoLike) : null;
}

function defaultSecurityMetadata(mode: DnsVerificationMode, source: "rpc-proof" | "rest"): ResolverSecurityMetadata {
  const verified = source === "rpc-proof";
  const downgraded = false;
  return {
    mode,
    source,
    verified,
    downgraded,
    unsafe: !verified,
  };
}

function normalizeDomainResolutionState(
  value: DomainResolutionState | DomainInfoLike | null,
  mode: DnsVerificationMode,
): DomainResolutionState {
  if (
    value != null &&
    typeof value === "object" &&
    "security" in value &&
    "info" in value
  ) {
    return value as DomainResolutionState;
  }

  return {
    info: normalizeDomainPayload(value),
    security: defaultSecurityMetadata(mode, "rest"),
  };
}

function now(): number {
  return Date.now();
}

function toUnixfsPath(path: string): string | undefined {
  const normalized = normalizePath(path);
  if (normalized === "/") return undefined;
  return stripLeadingSlash(normalized);
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry));
  }

  if (
    value != null &&
    typeof value === "object" &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer)
  ) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableNormalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }

  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

function normalizeDomainForConsensus(info: DomainInfoLike | null): unknown {
  if (!info) return null;
  const records = Array.isArray(info.records)
    ? [...info.records]
        .map((entry) => stableNormalize(entry) as Record<string, unknown>)
        .sort((left, right) => {
          const leftKey = `${String(left.key ?? "")}\u0000${String(left.value ?? "")}`;
          const rightKey = `${String(right.key ?? "")}\u0000${String(right.value ?? "")}`;
          return leftKey.localeCompare(rightKey);
        })
    : undefined;

  return stableNormalize({
    ...info,
    ...(records ? { records } : {}),
  });
}

function normalizeGatewaysForConsensus(gateways: GatewayCandidate[]): unknown {
  return [...gateways]
    .map((gateway) => stableNormalize({
      url: trimTrailingSlash(gateway.url).toLowerCase(),
      source: gateway.source,
      gatewayId: gateway.gatewayId,
      endpoint: gateway.endpoint,
      active: gateway.active,
      metadata: gateway.metadata ?? {},
    }))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}

function normalizeRestEndpoints(inputs: Array<string | URL>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const input of inputs) {
    const value = trimTrailingSlash(String(input || "").trim());
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }

  return out;
}

function buildRestUrl(endpoint: string, path: string): string {
  const url = new URL(path.replace(/^\/+/, ""), `${trimTrailingSlash(endpoint)}/`);
  return url.toString();
}

function gatewayKeyFromCandidates(gateways: GatewayCandidate[]): string {
  return gateways
    .map((gateway) => trimTrailingSlash(gateway.url).toLowerCase())
    .sort()
    .join("|");
}

function createAbortContext(input: { signal?: AbortSignal; timeoutMs?: number }): AbortContext {
  const timeoutMs = input.timeoutMs != null && input.timeoutMs > 0 ? input.timeoutMs : undefined;

  if (!input.signal && timeoutMs == null) {
    return {
      signal: undefined,
      timedOut: () => false,
      parentAborted: () => false,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  let didTimeout = false;
  let didParentAbort = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const parentListener = () => {
    didParentAbort = true;
    controller.abort(input.signal?.reason);
  };

  if (input.signal) {
    if (input.signal.aborted) {
      didParentAbort = true;
      controller.abort(input.signal.reason);
    } else {
      input.signal.addEventListener("abort", parentListener);
    }
  }

  if (!controller.signal.aborted && timeoutMs != null) {
    timeoutHandle = setTimeout(() => {
      didTimeout = true;
      controller.abort(new Error(`timeout_after_${timeoutMs}ms`));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    parentAborted: () => didParentAbort,
    cleanup: () => {
      if (timeoutHandle != null) clearTimeout(timeoutHandle);
      if (input.signal) input.signal.removeEventListener("abort", parentListener);
    },
  };
}

function contentCacheKey(resolved: ResolvedResource): string {
  return `${resolved.cidString}:${resolved.effectivePath}`;
}

function normalizeIpnsPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const normalized = normalizePath(path);
  return normalized === "/" ? undefined : normalized;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;

  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      await worker(items[currentIndex]!, currentIndex);
    }
  }));
}

function isLocalGatewayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = String(parsed.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function isGatewayAllowed(url: string, allowInsecureGateways: boolean, allowLocalGateways: boolean): boolean {
  try {
    const parsed = new URL(url);
    if (!allowInsecureGateways && parsed.protocol !== "https:") return false;
    if (!allowLocalGateways && isLocalGatewayUrl(url)) return false;
    return true;
  } catch {
    return false;
  }
}

function parentPath(input: string): string {
  const normalized = normalizePath(input);
  if (normalized === "/") return "/";
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 1) return "/";
  return `/${segments.slice(0, -1).join("/")}`;
}

function scoreGatewayStats(stats: Omit<GatewayPerformanceStats, "score">): number {
  const attempts = stats.successes + stats.failures;
  const successRate = attempts > 0 ? stats.successes / attempts : 0.5;
  const freshnessBoost = stats.lastSuccessAt ? Math.max(0, 120 - ((now() - stats.lastSuccessAt) / 60_000)) : 0;
  const abortPenalty = Math.min(stats.aborted * 2, 20);
  const latencyPenalty = Math.min(stats.averageLatencyMs, 5_000) / 25;
  return Number((successRate * 1_000 + freshnessBoost - abortPenalty - latencyPenalty).toFixed(3));
}

function createGatewayStats(url: string, partial: Partial<GatewayPerformanceStats> = {}): GatewayPerformanceStats {
  const base = {
    url,
    successes: 0,
    failures: 0,
    aborted: 0,
    averageLatencyMs: 0,
    lastSuccessAt: undefined,
    lastFailureAt: undefined,
    ...partial,
  };
  return {
    ...base,
    score: scoreGatewayStats({
      url: base.url,
      successes: base.successes,
      failures: base.failures,
      aborted: base.aborted,
      averageLatencyMs: base.averageLatencyMs,
      lastSuccessAt: base.lastSuccessAt,
      lastFailureAt: base.lastFailureAt,
    }),
  };
}

function parseStringResource(input: string): ParsedStringResource {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Resource is required");

  const directTarget = parseRecordTarget(raw);
  if (directTarget) {
    return { kind: "target", target: directTarget, inlinePath: "/" };
  }

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    const host = String(url.host || "").trim().toLowerCase();
    if (!host) throw new Error("Invalid domain URL");
    const { baseDomain, recordKey } = splitSubdomain(host);
    return {
      kind: "domain",
      host,
      baseDomain,
      recordKey,
      inlinePath: normalizePath(url.pathname),
    };
  }

  const pathless = raw.split(/[?#]/, 1)[0] || raw;
  const slashIndex = pathless.indexOf("/");
  if (slashIndex > 0) {
    const head = pathless.slice(0, slashIndex).trim();
    const tail = normalizePath(pathless.slice(slashIndex));
    const headCid = parseCid(head);
    if (headCid) {
      return {
        kind: "target",
        target: {
          proto: headCid.code === 0x72 ? "ipns" : "ipfs",
          id: head,
        },
        inlinePath: tail,
      };
    }
  }

  if (isCidLike(raw)) {
    return {
      kind: "target",
      target: {
        proto: targetProtoFromIdentifier(raw),
        id: raw,
      },
      inlinePath: "/",
    };
  }

  const host = (slashIndex >= 0 ? pathless.slice(0, slashIndex) : pathless).trim().toLowerCase();
  const inlinePath = slashIndex >= 0 ? normalizePath(pathless.slice(slashIndex)) : "/";
  if (!host) throw new Error("Invalid domain host");

  const { baseDomain, recordKey } = splitSubdomain(host);
  return {
    kind: "domain",
    host,
    baseDomain,
    recordKey,
    inlinePath,
  };
}

export class LumenDomainResolver {
  private readonly transport: ResolverTransport;
  private readonly httpFallback: boolean;
  private readonly p2pUseDelegatedRouting: boolean;
  private readonly p2pAttemptTimeoutMs: number;
  private readonly restEndpoint: string;
  private readonly restEndpoints: string[];
  private readonly restTimeoutMs: number;
  private readonly rpcEndpoint: string;
  private readonly rpcEndpoints: string[];
  private readonly rpcTimeoutMs: number;
  private readonly chainConsistencyMode: ChainConsistencyMode;
  private readonly dnsVerificationMode: DnsVerificationMode;
  private readonly dnsModule: ResolverOptions["dnsModule"] | null;
  private readonly gatewaysModule: ResolverOptions["gatewaysModule"] | null;
  private readonly customGateways: Array<string | URL>;
  private readonly publicGateways: Array<string | URL>;
  private readonly delegatedRoutingEndpoints: Array<string | URL>;
  private readonly allowInsecureGateways: boolean;
  private readonly allowLocalGateways: boolean;
  private readonly domainCacheTtlMs: number;
  private readonly gatewayCacheTtlMs: number;
  private readonly gatewayLimit: number;
  private readonly cacheNamespace: string;
  private readonly contentCacheMaxEntries: number;
  private readonly contentCacheMaxBytes: number;
  private readonly ipnsResolveTimeoutMs: number;
  private readonly ipnsFallbackTtlMs: number;
  private readonly enableGatewayScoring: boolean;
  private readonly gatewayScoreTtlMs: number;
  private readonly maxRecentEvents: number;
  private readonly prefetchConcurrency: number;
  private readonly prefetchMaxEntries: number;
  private readonly prefetchMaxBytes: number;
  private readonly observer?: ResolverObserver;
  private readonly cacheStorePromise: Promise<ResolverCacheStore>;
  private readonly trustStateStorePromise: Promise<PersistentTrustStateStore>;
  private readonly dnsLightVerifier: LumenDnsLightVerifier | null;

  private readonly domainCache = new Map<string, CacheEntry<DomainResolutionState>>();
  private readonly recentEvents: ResolverEvent[] = [];
  private readonly gatewayScores = new Map<string, GatewayPerformanceStats>();
  private readonly statusCounters = {
    cacheHits: 0,
    cacheMisses: 0,
    fallbacks: 0,
  };
  private gatewayCache: CacheEntry<GatewayCandidate[]> | null = null;
  private gatewayScoresLoaded = false;
  private gatewayScorePersistPromise: Promise<void> | null = null;
  private trustStateLoadPromise: Promise<void> | null = null;
  private trustStatePersistPromise: Promise<void> | null = null;
  private readonly heliaBundles = new Map<string, HeliaBundle>();
  private readonly heliaPromises = new Map<string, Promise<HeliaBundle>>();

  constructor(options: ResolverOptions = {}) {
    this.transport = options.transport ?? "http";
    this.httpFallback = options.httpFallback ?? false;
    this.p2pUseDelegatedRouting = options.p2pUseDelegatedRouting ?? true;
    this.p2pAttemptTimeoutMs = Math.max(
      0,
      options.p2pAttemptTimeoutMs ?? (this.httpFallback ? DEFAULT_P2P_ATTEMPT_TIMEOUT_MS : 0),
    );
    const explicitEndpoints = normalizeRestEndpoints(options.restEndpoints ?? []);
    const singleEndpoint = options.restEndpoint ? normalizeRestEndpoints([options.restEndpoint]) : [];
    const explicitRpcEndpoints = normalizeRestEndpoints(options.rpcEndpoints ?? []);
    const singleRpcEndpoint = options.rpcEndpoint ? normalizeRestEndpoints([options.rpcEndpoint]) : [];
    const defaultEndpoints =
      explicitEndpoints.length || singleEndpoint.length || options.dnsModule || options.gatewaysModule
        ? []
        : [LUMEN.defaultRest];

    this.restEndpoints = explicitEndpoints.length
      ? explicitEndpoints
      : singleEndpoint.length
        ? singleEndpoint
        : normalizeRestEndpoints(defaultEndpoints);
    this.restEndpoint = this.restEndpoints[0] ?? trimTrailingSlash(options.restEndpoint ?? LUMEN.defaultRest);
    this.restTimeoutMs = options.restTimeoutMs ?? DEFAULT_REST_TIMEOUT_MS;
    this.rpcEndpoints = explicitRpcEndpoints.length
      ? explicitRpcEndpoints
      : singleRpcEndpoint.length
        ? singleRpcEndpoint
        : [];
    this.rpcEndpoint = this.rpcEndpoints[0] ?? trimTrailingSlash(options.rpcEndpoint ?? "");
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.chainConsistencyMode = options.chainConsistencyMode ?? (this.restEndpoints.length > 1 ? "majority" : "single");
    this.dnsVerificationMode = options.dnsVerificationMode ?? (this.rpcEndpoints.length > 0 ? "auto" : "rest");
    this.dnsModule = options.dnsModule ?? (this.restEndpoint ? new modules.DnsModule(this.restEndpoint) : null);
    this.gatewaysModule = options.gatewaysModule ?? (this.restEndpoint ? new modules.GatewaysModule(this.restEndpoint) : null);
    this.customGateways = options.customGateways ?? [];
    this.publicGateways = options.publicGateways ?? DEFAULT_PUBLIC_GATEWAYS;
    this.delegatedRoutingEndpoints = options.delegatedRoutingEndpoints ?? [];
    this.allowInsecureGateways = options.allowInsecureGateways ?? false;
    this.allowLocalGateways = options.allowLocalGateways ?? false;
    this.domainCacheTtlMs = options.domainCacheTtlMs ?? DEFAULT_DOMAIN_CACHE_TTL_MS;
    this.gatewayCacheTtlMs = options.gatewayCacheTtlMs ?? DEFAULT_GATEWAY_CACHE_TTL_MS;
    this.gatewayLimit = options.gatewayLimit ?? DEFAULT_GATEWAY_LIMIT;
    this.cacheNamespace = String(options.cacheNamespace || DEFAULT_CACHE_NAMESPACE).trim() || DEFAULT_CACHE_NAMESPACE;
    this.contentCacheMaxEntries = Math.max(0, options.contentCacheMaxEntries ?? DEFAULT_CONTENT_CACHE_MAX_ENTRIES);
    this.contentCacheMaxBytes = Math.max(0, options.contentCacheMaxBytes ?? DEFAULT_CONTENT_CACHE_MAX_BYTES);
    this.ipnsResolveTimeoutMs = Math.max(0, options.ipnsResolveTimeoutMs ?? DEFAULT_IPNS_RESOLVE_TIMEOUT_MS);
    this.ipnsFallbackTtlMs = Math.max(0, options.ipnsFallbackTtlMs ?? DEFAULT_IPNS_FALLBACK_TTL_MS);
    this.enableGatewayScoring = options.enableGatewayScoring ?? true;
    this.gatewayScoreTtlMs = Math.max(0, options.gatewayScoreTtlMs ?? DEFAULT_GATEWAY_SCORE_TTL_MS);
    this.maxRecentEvents = Math.max(0, options.maxRecentEvents ?? DEFAULT_MAX_RECENT_EVENTS);
    this.prefetchConcurrency = Math.max(1, options.prefetchConcurrency ?? DEFAULT_PREFETCH_CONCURRENCY);
    this.prefetchMaxEntries = Math.max(1, options.prefetchMaxEntries ?? DEFAULT_PREFETCH_MAX_ENTRIES);
    this.prefetchMaxBytes = Math.max(1, options.prefetchMaxBytes ?? DEFAULT_PREFETCH_MAX_BYTES);
    this.observer = options.onEvent;
    this.cacheStorePromise = Promise.resolve(options.cacheStore)
      .then(async (store) => {
        if (store) return store;
        return await createDefaultCacheStore({
          cacheMode: options.cacheMode,
          cacheDirectory: options.cacheDirectory,
          cacheNamespace: this.cacheNamespace,
        });
      })
      .catch(() => createMemoryCacheStore());
    this.trustStateStorePromise = this.cacheStorePromise.then((store) =>
      new PersistentTrustStateStore(store, this.cacheNamespace)
    );
    this.dnsLightVerifier = this.rpcEndpoints.length
      ? new LumenDnsLightVerifier({
          rpcEndpoints: this.rpcEndpoints,
          timeoutMs: this.rpcTimeoutMs,
          globalTimeoutMs: options.rpcGlobalTimeoutMs,
          maxAttempts: options.rpcMaxAttempts,
          retryBaseDelayMs: options.rpcRetryBaseDelayMs,
          retryMaxDelayMs: options.rpcRetryMaxDelayMs,
          circuitBreakerThreshold: options.rpcCircuitBreakerThreshold,
          circuitBreakerCooldownMs: options.rpcCircuitBreakerCooldownMs,
          circuitBreakerDecayMs: options.rpcCircuitBreakerDecayMs,
          trustOptions: options.trustOptions,
          trustedCheckpoint: options.dnsTrustedCheckpoint,
          statusCacheTtlMs: options.dnsStatusCacheTtlMs,
          verifiedHeaderCacheSize: options.dnsVerifiedHeaderCacheSize,
          observer: (type, data) => this.emitEvent(type, data),
        })
      : null;
  }

  async close(): Promise<void> {
    if (this.gatewayScorePersistPromise) {
      await this.gatewayScorePersistPromise.catch(() => undefined);
    }
    if (this.trustStatePersistPromise) {
      await this.trustStatePersistPromise.catch(() => undefined);
    }
    await this.persistTrustState().catch(() => undefined);
    if (this.dnsLightVerifier) {
      await this.dnsLightVerifier.close().catch(() => undefined);
    }
    await this.resetHelia();
    const cacheStore = await this.cacheStorePromise.catch(() => null);
    if (cacheStore?.close) {
      await cacheStore.close().catch(() => undefined);
    }
  }

  async resolveDomain(domain: string, options: ResolveResourceOptions = {}): Promise<ResolveDomainResult> {
    const parsed = parseStringResource(domain);
    if (parsed.kind !== "domain") {
      throw new Error("resolveDomain expects a domain-like input");
    }

    const state = await this.getDomainState(parsed.baseDomain, options.forceRefresh === true);
    const picked = pickTargetFromDomainInfo(state.info, parsed.recordKey);

    if (!picked) {
      if (isCidLike(parsed.baseDomain)) {
        return {
          host: parsed.host,
          baseDomain: parsed.baseDomain,
          recordKey: parsed.recordKey,
          domain: state.info,
          target: {
            proto: targetProtoFromIdentifier(parsed.baseDomain),
            id: parsed.baseDomain,
          },
          source: "domain.fallback_cid",
          security: state.security,
          gateways: await this.getGatewayCandidates(options.forceRefresh === true),
          effectivePath: mergePaths(parsed.inlinePath, options.path),
        };
      }
      throw new Error(`Domain "${parsed.baseDomain}" is not linked to IPFS/IPNS content`);
    }

    return {
      host: parsed.host,
      baseDomain: parsed.baseDomain,
      recordKey: parsed.recordKey,
      domain: state.info,
      target: picked.target,
      source: picked.source,
      security: state.security,
      gateways: await this.getGatewayCandidates(options.forceRefresh === true),
      effectivePath: mergePaths(picked.target.basePath, parsed.inlinePath, options.path),
    };
  }

  async resolveResource(resource: string | DomainTarget, options: ResolveResourceOptions = {}): Promise<ResolvedResource> {
    if (typeof resource !== "string") {
      return this.resolveTarget(resource, {
        inlinePath: "/",
        ...options,
      });
    }

    const parsed = parseStringResource(resource);
    if (parsed.kind === "target") {
      return this.resolveTarget(parsed.target, {
        inlinePath: parsed.inlinePath,
        ...options,
      });
    }

    const state = await this.getDomainState(parsed.baseDomain, options.forceRefresh === true);
    const picked = pickTargetFromDomainInfo(state.info, parsed.recordKey);
    const gateways = await this.getGatewayCandidates(options.forceRefresh === true);

    if (picked) {
      return this.resolveTarget(picked.target, {
        inlinePath: parsed.inlinePath,
        ...options,
        source: "domain",
        host: parsed.host,
        baseDomain: parsed.baseDomain,
        recordKey: parsed.recordKey,
        domain: state.info,
        security: state.security,
        gateways,
      });
    }

    if (!isCidLike(parsed.baseDomain)) {
      throw new Error(`Domain "${parsed.baseDomain}" is not linked to IPFS/IPNS content`);
    }

    return this.resolveTarget({
      proto: targetProtoFromIdentifier(parsed.baseDomain),
      id: parsed.baseDomain,
    }, {
      inlinePath: parsed.inlinePath,
      ...options,
      source: "domain",
      host: parsed.host,
      baseDomain: parsed.baseDomain,
      recordKey: parsed.recordKey,
      domain: state.info,
      security: state.security,
      gateways,
    });
  }

  async stat(resource: string | DomainTarget, options: ResolveResourceOptions = {}): Promise<ContentStat> {
    const resolved = await this.resolveResource(resource, options);
    return this.statResolved(resolved, options.signal);
  }

  async ls(resource: string | DomainTarget, options: ListOptions = {}): Promise<ContentListEntry[]> {
    const resolved = await this.resolveResource(resource, options);
    return this.lsResolved(resolved, options);
  }

  async readBytes(resource: string | DomainTarget, options: ReadBytesOptions = {}): Promise<Uint8Array> {
    const resolved = await this.resolveResource(resource, options);
    return this.readBytesResolved(resolved, options);
  }

  async readText(resource: string | DomainTarget, options: ReadTextOptions = {}): Promise<string> {
    const bytes = await this.readBytes(resource, options);
    return decodeText(bytes, options.encoding ?? "utf-8");
  }

  async readJson<T = unknown>(resource: string | DomainTarget, options: ReadTextOptions = {}): Promise<T> {
    return JSON.parse(await this.readText(resource, options)) as T;
  }

  async getFullContent(resource: string | DomainTarget, options: GetFullContentOptions = {}): Promise<FullContentResult> {
    const resolved = await this.resolveResource(resource, options);
    return this.getFullContentResolved(resolved, options, 0, {
      seenEntries: 0,
    });
  }

  async *readStream(resource: string | DomainTarget, options: ReadStreamOptions = {}): AsyncIterable<Uint8Array> {
    const resolved = await this.resolveResource(resource, options);
    yield* this.readStreamResolved(resolved, options);
  }

  async prefetch(resource: string | DomainTarget, options: PrefetchOptions = {}): Promise<PrefetchResult> {
    const resolved = await this.resolveResource(resource, options);
    const stat = await this.statResolved(resolved, options.signal);
    const strategy = options.strategy ?? (stat.kind === "directory" ? "shallow" : "adjacent");
    const accumulator: PrefetchAccumulator = {
      visitedEntries: 0,
      warmedFiles: 0,
      warmedBytes: 0,
      prefetchedPaths: [],
    };

    if (stat.kind === "directory") {
      await this.prefetchDirectoryResolved(resolved, options, strategy, 0, accumulator);
    } else {
      await this.prefetchFileResolved(resolved, {
        signal: options.signal,
        forceRefresh: options.forceRefresh,
        maxBytes: options.maxBytes ?? this.prefetchMaxBytes,
      }, accumulator);

      if (strategy === "adjacent") {
        await this.prefetchAdjacentResolved(resolved, options, accumulator);
      }
    }

    const result: PrefetchResult = {
      resolved,
      strategy,
      visitedEntries: accumulator.visitedEntries,
      warmedFiles: accumulator.warmedFiles,
      warmedBytes: accumulator.warmedBytes,
      prefetchedPaths: accumulator.prefetchedPaths,
    };

    this.emitEvent("prefetch_result", {
      path: resolved.effectivePath,
      strategy,
      visitedEntries: result.visitedEntries,
      warmedFiles: result.warmedFiles,
      warmedBytes: result.warmedBytes,
    });

    return result;
  }

  getRecentEvents(limit = this.maxRecentEvents): ResolverEvent[] {
    if (limit <= 0) return [];
    return this.recentEvents.slice(-limit);
  }

  async getGatewayScores(): Promise<GatewayPerformanceStats[]> {
    await this.ensureGatewayScoresLoaded();
    return [...this.gatewayScores.values()].sort((left, right) => right.score - left.score);
  }

  getResolverStatus(): ResolverStatus {
    const proofMetrics = this.dnsLightVerifier?.getMetrics() ?? {
      proofAttempts: 0,
      proofSuccesses: 0,
      fallbackCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };
    const runtime = this.dnsLightVerifier?.getRuntimeStatus() ?? {
      lastVerifiedHeight: 0,
      checkpointAge: 0,
    };
    const fallbackCount = proofMetrics.fallbackCount + this.statusCounters.fallbacks;
    const totalCacheHits = proofMetrics.cacheHits + this.statusCounters.cacheHits;
    const totalCacheMisses = proofMetrics.cacheMisses + this.statusCounters.cacheMisses;
    return {
      mode: this.dnsVerificationMode,
      lastVerifiedHeight: runtime.lastVerifiedHeight,
      checkpointAge: runtime.checkpointAge,
      proofSuccessRate: proofMetrics.proofAttempts > 0
        ? Number((proofMetrics.proofSuccesses / proofMetrics.proofAttempts).toFixed(4))
        : 0,
      fallbackRate: (proofMetrics.proofAttempts + fallbackCount) > 0
        ? Number((fallbackCount / (proofMetrics.proofAttempts + fallbackCount)).toFixed(4))
        : 0,
      cacheHitRate: (totalCacheHits + totalCacheMisses) > 0
        ? Number((totalCacheHits / (totalCacheHits + totalCacheMisses)).toFixed(4))
        : 0,
    };
  }

  private async resolveTarget(
    target: DomainTarget,
    context: ResolveResourceOptions & {
      inlinePath: string;
      source?: "domain" | "target";
      host?: string;
      baseDomain?: string;
      recordKey?: string | null;
      domain?: DomainInfoLike | null;
      security?: ResolverSecurityMetadata;
      gateways?: GatewayCandidate[];
    },
  ): Promise<ResolvedResource> {
    const forceRefresh = context.forceRefresh === true;
    const gateways = context.gateways ?? await this.getGatewayCandidates(forceRefresh);
    const security = context.security ?? {
      mode: this.dnsVerificationMode,
      source: "rpc-proof",
      verified: true,
      downgraded: false,
      unsafe: false,
    };

    if (target.proto === "ipns") {
      const resolvedIpns = await this.resolveIpnsTarget(target, {
        forceRefresh,
        signal: context.signal,
        gateways,
      });
      const effectivePath = mergePaths(target.basePath, resolvedIpns.path, context.inlinePath, context.path);

      return {
        input: context.host ?? target,
        source: context.source ?? "target",
        host: context.host,
        baseDomain: context.baseDomain,
        recordKey: context.recordKey,
        domain: context.domain ?? null,
        target,
        security,
        cid: resolvedIpns.cid,
        cidString: resolvedIpns.cid.toString(),
        gateways,
        effectivePath,
        resolvedIpnsPath: resolvedIpns.path,
      };
    }

    const cid = CID.parse(target.id);
    return {
      input: context.host ?? target,
      source: context.source ?? "target",
      host: context.host,
      baseDomain: context.baseDomain,
      recordKey: context.recordKey,
      domain: context.domain ?? null,
      target,
      security,
      cid,
      cidString: cid.toString(),
      gateways,
      effectivePath: mergePaths(target.basePath, context.inlinePath, context.path),
    };
  }

  private async resolveIpnsTarget(
    target: DomainTarget,
    context: {
      forceRefresh: boolean;
      signal?: AbortSignal;
      gateways: GatewayCandidate[];
    },
  ): Promise<{ cid: CID; path?: string }> {
    const keyCid = parseCid(target.id);
    if (!keyCid || keyCid.code !== 0x72) {
      throw new Error(`Unsupported IPNS identifier "${target.id}"`);
    }

    const fallback = await this.getCacheValue<IpnsCacheValue>(CACHE_IPNS, target.id, {
      allowExpired: false,
      touch: true,
      forceRefresh: false,
    });

    const abortContext = createAbortContext({
      signal: context.signal,
      timeoutMs: this.ipnsResolveTimeoutMs,
    });

    try {
      const startedAt = now();
      const resolved = await this.withContentBackend(
        context.forceRefresh,
        context.gateways,
        context.signal,
        async ({ ipnsApi }) =>
          await ipnsApi.resolve(keyCid as any, {
            signal: abortContext.signal,
            nocache: context.forceRefresh,
          }),
      );
      const cachedPath = normalizeIpnsPath(resolved.path);
      const cachedValue: IpnsCacheValue = {
        cidString: resolved.cid.toString(),
        ...(cachedPath ? { path: cachedPath } : {}),
      };
      await this.setCacheValue(CACHE_IPNS, target.id, cachedValue, {
        ttlMs: this.ipnsFallbackTtlMs || undefined,
      });
      this.emitEvent("ipns_resolve", {
        target: target.id,
        cid: resolved.cid.toString(),
        path: cachedPath,
        durationMs: now() - startedAt,
      });
      return {
        cid: resolved.cid,
        path: cachedPath,
      };
    } catch (error) {
      if (abortContext.parentAborted()) throw error;
      if (fallback) {
        try {
          this.emitEvent("ipns_fallback", {
            target: target.id,
            cid: fallback.record.value.cidString,
            path: fallback.record.value.path,
            reason: error instanceof Error ? error.message : String(error),
            timedOut: abortContext.timedOut(),
          });
          return {
            cid: CID.parse(fallback.record.value.cidString),
            path: normalizeIpnsPath(fallback.record.value.path),
          };
        } catch {
          // Ignore corrupt fallback cache.
        }
      }
      throw error;
    } finally {
      abortContext.cleanup();
    }
  }

  private async getDomainState(baseDomain: string, forceRefresh: boolean): Promise<DomainResolutionState> {
    const key = baseDomain.toLowerCase();
    const memory = this.domainCache.get(key);
    if (!forceRefresh && memory && memory.expiresAt > now()) {
      this.emitEvent("cache_hit", { namespace: CACHE_DOMAIN, key, layer: "memory" });
      return memory.value;
    }

    const cached = await this.getCacheValue<DomainResolutionState | DomainInfoLike | null>(CACHE_DOMAIN, key, {
      allowExpired: true,
      touch: true,
      forceRefresh,
    });
    const normalizedCached = cached
      ? {
          ...cached,
          record: {
            ...cached.record,
            value: normalizeDomainResolutionState(cached.record.value, this.dnsVerificationMode),
          },
        }
      : null;

    if (!forceRefresh && normalizedCached && !normalizedCached.expired) {
      this.emitEvent("cache_hit", { namespace: CACHE_DOMAIN, key, layer: "persistent" });
      this.domainCache.set(key, {
        value: normalizedCached.record.value,
        expiresAt: normalizedCached.record.expiresAt ?? (now() + this.domainCacheTtlMs),
      });
      return normalizedCached.record.value;
    }

    if (normalizedCached?.expired) {
      this.emitEvent("cache_stale", { namespace: CACHE_DOMAIN, key });
    } else if (!memory) {
      this.emitEvent("cache_miss", { namespace: CACHE_DOMAIN, key });
    }

    try {
      const value = await this.loadDomainInfoNetwork(baseDomain);
      const expiresAt = now() + this.domainCacheTtlMs;
      this.domainCache.set(key, { value, expiresAt });
      await this.setCacheValue(CACHE_DOMAIN, key, value, { ttlMs: this.domainCacheTtlMs });
      return value;
    } catch (error) {
      if (normalizedCached) return normalizedCached.record.value;
      if (memory) return memory.value;
      throw error;
    }
  }

  private async getGatewayCandidates(forceRefresh: boolean): Promise<GatewayCandidate[]> {
    if (this.enableGatewayScoring) {
      await this.ensureGatewayScoresLoaded();
    }

    if (!forceRefresh && this.gatewayCache && this.gatewayCache.expiresAt > now()) {
      this.emitEvent("cache_hit", { namespace: CACHE_GATEWAYS, key: "all", layer: "memory" });
      return this.rankGatewayCandidates(this.gatewayCache.value);
    }

    const cached = await this.getCacheValue<GatewayCandidate[]>(CACHE_GATEWAYS, "all", {
      allowExpired: true,
      touch: true,
      forceRefresh,
    });

    if (!forceRefresh && cached && !cached.expired) {
      this.emitEvent("cache_hit", { namespace: CACHE_GATEWAYS, key: "all", layer: "persistent" });
      const ranked = this.rankGatewayCandidates(cached.record.value);
      this.gatewayCache = {
        value: ranked,
        expiresAt: cached.record.expiresAt ?? (now() + this.gatewayCacheTtlMs),
      };
      return ranked;
    }

    if (cached?.expired) {
      this.emitEvent("cache_stale", { namespace: CACHE_GATEWAYS, key: "all" });
    } else if (!this.gatewayCache) {
      this.emitEvent("cache_miss", { namespace: CACHE_GATEWAYS, key: "all" });
    }

    try {
      const custom = this.customGateways
        .map((entry) => normalizeGatewayInput(entry, "custom"))
        .filter((entry): entry is GatewayCandidate => entry != null);
      const onchain = await this.loadOnchainGateways().catch(() => []);
      const defaults = this.publicGateways
        .map((entry) => normalizeGatewayInput(entry, "default"))
        .filter((entry): entry is GatewayCandidate => entry != null);

      const candidates = dedupeGateways([
        ...custom,
        ...shuffleArray(onchain),
        ...shuffleArray(defaults),
      ])
        .filter((gateway) => isGatewayAllowed(gateway.url, this.allowInsecureGateways, this.allowLocalGateways));
      const rankedCandidates = this.rankGatewayCandidates(candidates);

      this.gatewayCache = {
        value: rankedCandidates,
        expiresAt: now() + this.gatewayCacheTtlMs,
      };
      await this.setCacheValue(CACHE_GATEWAYS, "all", rankedCandidates, { ttlMs: this.gatewayCacheTtlMs });
      return rankedCandidates;
    } catch (error) {
      if (cached) return cached.record.value;
      if (this.gatewayCache) return this.gatewayCache.value;
      throw error;
    }
  }

  private async getHelia(
    transport: ResolverTransport,
    forceRefresh: boolean,
    gateways?: GatewayCandidate[],
  ): Promise<HeliaBundle> {
    const gatewayCandidates = gateways ?? await this.getGatewayCandidates(forceRefresh);
    const cacheKey = this.getHeliaCacheKey(transport, gatewayCandidates);

    if (forceRefresh) {
      await this.resetHeliaBundle(cacheKey);
    }

    await this.resetHeliaTransport(transport, cacheKey);

    const existing = this.heliaBundles.get(cacheKey);
    if (existing) return existing;

    const inflight = this.heliaPromises.get(cacheKey);
    if (inflight) return inflight;

    const promise = this.createHeliaBundle(transport, gatewayCandidates)
      .then((bundle) => {
        this.heliaBundles.set(cacheKey, bundle);
        return bundle;
      })
      .finally(() => {
        this.heliaPromises.delete(cacheKey);
      });

    this.heliaPromises.set(cacheKey, promise);
    return promise;
  }

  private getHeliaCacheKey(transport: ResolverTransport, gateways: GatewayCandidate[]): string {
    return `${transport}:${gatewayKeyFromCandidates(gateways) || "default"}`;
  }

  private createDelegatedRouters() {
    const delegatedEndpoints = this.delegatedRoutingEndpoints
      .map((entry) => normalizeGatewayInput(entry, "default"))
      .filter((entry): entry is GatewayCandidate => entry != null)
      .map((entry) => entry.url);

    return delegatedEndpoints.length
      ? delegatedEndpoints.map((url) =>
          delegatedHTTPRouting({
            ...delegatedHTTPRoutingDefaults(),
            url,
          }),
        )
      : [
          delegatedHTTPRouting(delegatedHTTPRoutingDefaults()),
        ];
  }

  private createHttpBlockBroker(gateways: GatewayCandidate[]) {
    const gatewayUrls = gateways.map((gateway) => gateway.url);
    return createParallelGatewayBroker({
      gateways: gatewayUrls,
      requestCache: "force-cache",
      rankGateways: (urls) => this.rankGatewayUrls(urls),
      onGatewayResult: (event) => {
        void this.handleGatewayResult(event);
      },
    });
  }

  private async createHeliaBundle(transport: ResolverTransport, gateways: GatewayCandidate[]): Promise<HeliaBundle> {
    if (transport === "p2p") {
      return this.createP2PHeliaBundle(gateways);
    }
    return this.createHttpHeliaBundle(gateways);
  }

  private async createHttpHeliaBundle(gateways: GatewayCandidate[]): Promise<HeliaBundle> {
    const gatewayUrls = gateways.map((gateway) => gateway.url);
    const delegatedRouters = this.createDelegatedRouters();
    const helia = await createHeliaHTTP({
      blockBrokers: [
        this.createHttpBlockBroker(gateways),
      ],
      routers: [
        ...delegatedRouters,
        httpGatewayRouting({
          gateways: gatewayUrls,
          shuffle: true,
        }),
      ],
    });

    return {
      helia,
      fs: unixfs(helia),
      ipnsApi: ipns(helia as any),
      transport: "http",
      gatewayKey: gatewayKeyFromCandidates(gateways),
    };
  }

  private async createP2PHeliaBundle(gateways: GatewayCandidate[]): Promise<HeliaBundle> {
    const base = await heliaDefaults({
      start: false,
      blockBrokers: [bitswap()],
    });
    base.routers = [
      libp2pRouting(base.libp2p),
      ...(this.p2pUseDelegatedRouting ? this.createDelegatedRouters() : []),
    ];

    const helia = await createHelia(base);

    return {
      helia,
      fs: unixfs(helia),
      ipnsApi: ipns(helia as any),
      transport: "p2p",
      gatewayKey: gatewayKeyFromCandidates(gateways),
    };
  }

  private async resetHeliaBundle(cacheKey: string): Promise<void> {
    const bundle = this.heliaBundles.get(cacheKey) ??
      (this.heliaPromises.has(cacheKey) ? await this.heliaPromises.get(cacheKey)!.catch(() => null) : null);
    this.heliaBundles.delete(cacheKey);
    this.heliaPromises.delete(cacheKey);
    if (bundle) {
      await bundle.helia.stop().catch(() => undefined);
    }
  }

  private async resetHeliaTransport(transport: ResolverTransport, keepCacheKey?: string): Promise<void> {
    const knownKeys = new Set<string>([
      ...this.heliaBundles.keys(),
      ...this.heliaPromises.keys(),
    ]);

    for (const key of knownKeys) {
      if (!key.startsWith(`${transport}:`)) continue;
      if (keepCacheKey && key === keepCacheKey) continue;
      await this.resetHeliaBundle(key);
    }
  }

  private async resetHelia(): Promise<void> {
    const knownKeys = new Set<string>([
      ...this.heliaBundles.keys(),
      ...this.heliaPromises.keys(),
    ]);

    for (const key of knownKeys) {
      await this.resetHeliaBundle(key);
    }
  }

  private contentTransports(): ResolverTransport[] {
    return this.transport === "p2p" && this.httpFallback
      ? ["p2p", "http"]
      : [this.transport];
  }

  private createContentAbortContext(transport: ResolverTransport, signal?: AbortSignal): AbortContext {
    const timeoutMs = transport === "p2p" && this.p2pAttemptTimeoutMs > 0
      ? this.p2pAttemptTimeoutMs
      : undefined;
    return createAbortContext({
      signal,
      timeoutMs,
    });
  }

  private normalizeContentTransportError(
    transport: ResolverTransport,
    abortContext: AbortContext,
    error: unknown,
  ): Error {
    if (abortContext.timedOut()) {
      return new Error(`${transport.toUpperCase()} content lookup timed out after ${this.p2pAttemptTimeoutMs}ms`);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async withContentBackend<T>(
    forceRefresh: boolean,
    gateways: GatewayCandidate[] | undefined,
    signal: AbortSignal | undefined,
    worker: (bundle: HeliaBundle, signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown = null;

    for (const transport of this.contentTransports()) {
      const abortContext = this.createContentAbortContext(transport, signal);
      try {
        const bundle = await this.getHelia(transport, forceRefresh, gateways);
        return await worker(bundle, abortContext.signal);
      } catch (error) {
        if (signal?.aborted || abortContext.parentAborted()) throw error;
        const transportError = this.normalizeContentTransportError(transport, abortContext, error);
        lastError = transportError;
        if (transport !== "p2p" || !this.httpFallback) {
          throw transportError;
        }
      } finally {
        abortContext.cleanup();
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Unable to load content"));
  }

  private async statResolved(resolved: ResolvedResource, signal?: AbortSignal): Promise<ContentStat> {
    const path = toUnixfsPath(resolved.effectivePath);
    const stat = await this.withContentBackend(
      false,
      resolved.gateways,
      signal,
      async ({ fs }, attemptSignal) =>
        await fs.stat(resolved.cidString as any, {
          signal: attemptSignal,
          ...(path ? { path } : {}),
        }),
    );

    return {
      resolved,
      cid: stat.cid.toString(),
      path: resolved.effectivePath,
      kind: this.normalizeContentKind(stat.type),
      sizeBytes: stat.size.toString(),
      mode: stat.mode,
    };
  }

  private async lsResolved(resolved: ResolvedResource, options: ListOptions): Promise<ContentListEntry[]> {
    const path = toUnixfsPath(resolved.effectivePath);
    return await this.withContentBackend(
      false,
      resolved.gateways,
      options.signal,
      async ({ fs }, attemptSignal) => {
        const entries: ContentListEntry[] = [];

        for await (const entry of fs.ls(resolved.cidString as any, {
          signal: attemptSignal,
          offset: options.offset,
          length: options.length,
          ...(path ? { path } : {}),
        })) {
          const name = String((entry as any).name ?? (entry as any).path ?? (entry as any).cid ?? "").trim();
          entries.push({
            name: name || String((entry as any).cid),
            path: mergePaths(resolved.effectivePath, name),
            cid: String((entry as any).cid),
            kind: this.normalizeContentKind((entry as any).type),
            sizeBytes: (entry as any).size != null ? String((entry as any).size) : undefined,
          });
        }

        return entries;
      },
    );
  }

  private async *readStreamResolved(
    resolved: ResolvedResource,
    options: ReadStreamOptions,
  ): AsyncIterable<Uint8Array> {
    const cacheEligible = options.offset == null && options.length == null;
    if (cacheEligible) {
      const cached = await this.getCacheValue<Uint8Array>(CACHE_CONTENT, contentCacheKey(resolved), {
        allowExpired: false,
        touch: true,
        forceRefresh: options.forceRefresh === true,
      });

      if (cached) {
        this.emitEvent("cache_hit", {
          namespace: CACHE_CONTENT,
          key: contentCacheKey(resolved),
          layer: "persistent",
        });
        if (options.maxBytes != null && cached.record.value.byteLength > options.maxBytes) {
          throw new Error(`Content exceeds maxBytes limit (${options.maxBytes})`);
        }
        this.emitEvent("content_stream", {
          path: resolved.effectivePath,
          cid: resolved.cidString,
          source: "cache",
          bytes: cached.record.value.byteLength,
        });
        yield cached.record.value;
        return;
      }

      this.emitEvent("cache_miss", {
        namespace: CACHE_CONTENT,
        key: contentCacheKey(resolved),
      });
    }

    const stat = await this.statResolved(resolved, options.signal);
    if (stat.kind === "directory") {
      throw new Error(`Cannot read bytes from directory path "${resolved.effectivePath}"`);
    }

    const path = toUnixfsPath(resolved.effectivePath);
    let lastError: unknown = null;

    for (const transport of this.contentTransports()) {
      const abortContext = this.createContentAbortContext(transport, options.signal);
      const chunks: Uint8Array[] = [];
      let total = 0;
      let canCache = cacheEligible;
      let yieldedAny = false;

      try {
        const { fs } = await this.getHelia(transport, false, resolved.gateways);
        this.emitEvent("content_stream", {
          path: resolved.effectivePath,
          cid: resolved.cidString,
          source: "network",
          transport,
          offset: options.offset,
          length: options.length,
        });

        for await (const chunk of fs.cat(resolved.cidString as any, {
          signal: abortContext.signal,
          offset: options.offset,
          length: options.length,
          ...(path ? { path } : {}),
        })) {
          yieldedAny = true;
          total += chunk.byteLength;
          if (options.maxBytes != null && total > options.maxBytes) {
            throw new Error(`Content exceeds maxBytes limit (${options.maxBytes})`);
          }

          if (canCache) {
            if (total <= this.contentCacheMaxBytes) {
              chunks.push(chunk);
            } else {
              canCache = false;
              chunks.length = 0;
            }
          }

          yield chunk;
        }

        if (canCache && chunks.length) {
          const bytes = concatChunks(chunks);
          await this.setContentCacheValue(contentCacheKey(resolved), bytes);
        }
        return;
      } catch (error) {
        if (options.signal?.aborted || abortContext.parentAborted() || yieldedAny) {
          throw error;
        }
        const transportError = this.normalizeContentTransportError(transport, abortContext, error);
        lastError = transportError;
        if (transport !== "p2p" || !this.httpFallback) {
          throw transportError;
        }
      } finally {
        abortContext.cleanup();
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Unable to stream content"));
  }

  private async readBytesResolved(resolved: ResolvedResource, options: ReadBytesOptions): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;

    for await (const chunk of this.readStreamResolved(resolved, options)) {
      total += chunk.byteLength;
      chunks.push(chunk);
    }
    return concatChunks(chunks);
  }

  private async getFullContentResolved(
    resolved: ResolvedResource,
    options: GetFullContentOptions,
    depth: number,
    limits: { seenEntries: number },
  ): Promise<FullContentResult> {
    const stat = await this.statResolved(resolved, options.signal);
    if (stat.kind !== "directory") {
      return this.readFileContent(resolved, stat, options);
    }

    if (options.recursive !== true) {
      const entries = await this.lsResolved(resolved, options);
      return {
        ...stat,
        kind: "directory",
        entries: entries.map((entry) => ({ ...entry })),
        recursive: false,
      } satisfies DirectoryContentResult;
    }

    const maxDepth = options.maxDepth ?? 16;
    if (depth > maxDepth) {
      throw new Error(`Directory recursion exceeded maxDepth=${maxDepth}`);
    }

    const listed = await this.lsResolved(resolved, options);
    const entries: DirectoryContentEntry[] = [];
    const maxEntries = options.maxEntries ?? 10_000;

    for (const entry of listed) {
      limits.seenEntries += 1;
      if (limits.seenEntries > maxEntries) {
        throw new Error(`Directory recursion exceeded maxEntries=${maxEntries}`);
      }

      const childResolved: ResolvedResource = {
        ...resolved,
        effectivePath: entry.path,
      };

      if (entry.kind === "directory") {
        const nested = await this.getFullContentResolved(childResolved, options, depth + 1, limits);
        entries.push({ ...entry, content: nested });
      } else {
        const childStat: ContentStat = {
          resolved: childResolved,
          cid: entry.cid,
          path: entry.path,
          kind: entry.kind,
          sizeBytes: entry.sizeBytes ?? "0",
        };
        entries.push({
          ...entry,
          content: await this.readFileContent(childResolved, childStat, options),
        });
      }
    }

    return {
      ...stat,
      kind: "directory",
      entries,
      recursive: true,
    } satisfies DirectoryContentResult;
  }

  private async readFileContent(
    resolved: ResolvedResource,
    stat: ContentStat,
    options: GetFullContentOptions,
  ): Promise<FileContentResult> {
    const bytes = await this.readBytesResolved(resolved, {
      signal: options.signal,
      maxBytes: options.maxBytes,
      forceRefresh: options.forceRefresh,
    });

    return {
      ...stat,
      kind: stat.kind === "raw" ? "raw" : "file",
      bytes,
      ...(options.includeText ? { text: decodeText(bytes) } : {}),
    };
  }

  private async ensureTrustStateLoaded(): Promise<void> {
    if (!this.dnsLightVerifier) return;
    if (this.trustStateLoadPromise) {
      await this.trustStateLoadPromise;
      return;
    }

    this.trustStateLoadPromise = (async () => {
      try {
        const store = await this.trustStateStorePromise;
        const state = await store.load();
        this.dnsLightVerifier?.importTrustState(state);
        if (state?.gatewayScores?.length) {
          for (const entry of state.gatewayScores) {
            this.gatewayScores.set(entry.url, createGatewayStats(entry.url, entry));
          }
        }
      } catch {
        // Ignore corrupted or missing trust state and continue with a cold start.
      }
    })();

    await this.trustStateLoadPromise;
  }

  private async scheduleTrustStatePersist(): Promise<void> {
    if (!this.dnsLightVerifier) return;
    if (this.trustStatePersistPromise) return await this.trustStatePersistPromise;

    this.trustStatePersistPromise = this.persistTrustState()
      .catch(() => undefined)
      .finally(() => {
        this.trustStatePersistPromise = null;
      });
    await this.trustStatePersistPromise;
  }

  private async persistTrustState(): Promise<void> {
    if (!this.dnsLightVerifier) return;
    await this.ensureTrustStateLoaded();
    const store = await this.trustStateStorePromise;
    const state = this.dnsLightVerifier.exportTrustState();
    state.gatewayScores = [...this.gatewayScores.values()].sort((left, right) => right.score - left.score);
    await store.save(state);
  }

  private emitEvent(type: ResolverEvent["type"], data: Record<string, unknown>): void {
    const event: ResolverEvent = {
      type,
      timestamp: now(),
      data,
    };

    if (this.maxRecentEvents > 0) {
      this.recentEvents.push(event);
      if (this.recentEvents.length > this.maxRecentEvents) {
        this.recentEvents.splice(0, this.recentEvents.length - this.maxRecentEvents);
      }
    }

    if (type === "cache_hit" || type === "dns_header_cache_hit" || type === "dns_status_cache_hit") {
      this.statusCounters.cacheHits += 1;
    }
    if (type === "cache_miss" || type === "cache_stale") {
      this.statusCounters.cacheMisses += 1;
    }
    try {
      this.observer?.(event);
    } catch {
      // Ignore observer failures.
    }
  }

  private async ensureGatewayScoresLoaded(): Promise<void> {
    if (this.gatewayScoresLoaded) return;
    this.gatewayScoresLoaded = true;

    const cached = await this.getCacheValue<GatewayPerformanceStats[]>(CACHE_GATEWAY_SCORES, "all", {
      allowExpired: false,
      touch: false,
      forceRefresh: false,
    });

    if (!cached) return;
    for (const entry of cached.record.value) {
      this.gatewayScores.set(entry.url, createGatewayStats(entry.url, entry));
    }
  }

  private gatewayScoreFor(url: string): number {
    return this.gatewayScores.get(trimTrailingSlash(url).toLowerCase())?.score ?? 0;
  }

  private rankGatewayCandidates(candidates: GatewayCandidate[]): GatewayCandidate[] {
    if (!this.enableGatewayScoring) return candidates;

    const sourceWeight = (source: GatewayCandidate["source"]): number => {
      if (source === "custom") return 3;
      if (source === "onchain") return 2;
      return 1;
    };

    return [...candidates].sort((left, right) => {
      const scoreDelta = this.gatewayScoreFor(right.url) - this.gatewayScoreFor(left.url);
      if (Math.abs(scoreDelta) > 0.001) return scoreDelta;
      const sourceDelta = sourceWeight(right.source) - sourceWeight(left.source);
      if (sourceDelta !== 0) return sourceDelta;
      return Math.random() < 0.5 ? -1 : 1;
    });
  }

  private rankGatewayUrls(urls: string[]): string[] {
    if (!this.enableGatewayScoring) return shuffleArray(urls);
    return [...urls].sort((left, right) => {
      const delta = this.gatewayScoreFor(right) - this.gatewayScoreFor(left);
      if (Math.abs(delta) > 0.001) return delta;
      return Math.random() < 0.5 ? -1 : 1;
    });
  }

  private async persistGatewayScores(): Promise<void> {
    const payload = [...this.gatewayScores.values()].sort((left, right) => right.score - left.score);
    await this.setCacheValue(CACHE_GATEWAY_SCORES, "all", payload, {
      ttlMs: this.gatewayScoreTtlMs || undefined,
    });
  }

  private async handleGatewayResult(event: GatewayResultEvent): Promise<void> {
    await this.ensureGatewayScoresLoaded();

    const key = trimTrailingSlash(event.gateway).toLowerCase();
    const previous = this.gatewayScores.get(key) ?? createGatewayStats(key);
    const updated = createGatewayStats(key, {
      ...previous,
      successes: previous.successes + (event.ok ? 1 : 0),
      failures: previous.failures + (!event.ok && !event.aborted ? 1 : 0),
      aborted: previous.aborted + (event.aborted ? 1 : 0),
      averageLatencyMs: previous.averageLatencyMs > 0
        ? (previous.averageLatencyMs * 0.7) + (event.durationMs * 0.3)
        : event.durationMs,
      lastSuccessAt: event.ok ? now() : previous.lastSuccessAt,
      lastFailureAt: !event.ok && !event.aborted ? now() : previous.lastFailureAt,
    });
    this.gatewayScores.set(key, updated);

    this.emitEvent("gateway_result", {
      gateway: key,
      cid: event.cid,
      ok: event.ok,
      aborted: event.aborted ?? false,
      winner: event.winner ?? false,
      durationMs: event.durationMs,
      score: updated.score,
      successes: updated.successes,
      failures: updated.failures,
      averageLatencyMs: updated.averageLatencyMs,
      ...(event.error ? { error: event.error } : {}),
    });

    if (!this.gatewayScorePersistPromise) {
      this.gatewayScorePersistPromise = this.persistGatewayScores()
        .catch(() => undefined)
        .finally(() => {
          this.gatewayScorePersistPromise = null;
        });
    }
  }

  private async prefetchFileResolved(
    resolved: ResolvedResource,
    options: ReadBytesOptions,
    accumulator: PrefetchAccumulator,
  ): Promise<void> {
    const bytes = await this.readBytesResolved(resolved, options);
    accumulator.warmedFiles += 1;
    accumulator.warmedBytes += bytes.byteLength;
    if (!accumulator.prefetchedPaths.includes(resolved.effectivePath)) {
      accumulator.prefetchedPaths.push(resolved.effectivePath);
    }
    this.emitEvent("prefetch_result", {
      path: resolved.effectivePath,
      kind: "file",
      ok: true,
      bytes: bytes.byteLength,
    });
  }

  private async prefetchAdjacentResolved(
    resolved: ResolvedResource,
    options: PrefetchOptions,
    accumulator: PrefetchAccumulator,
  ): Promise<void> {
    const parent = parentPath(resolved.effectivePath);
    if (parent === resolved.effectivePath) return;

    const siblingResolved: ResolvedResource = {
      ...resolved,
      effectivePath: parent,
    };
    const entries = await this.lsResolved(siblingResolved, options);
    const remaining = Math.max(0, (options.maxEntries ?? this.prefetchMaxEntries) - accumulator.visitedEntries);
    const siblings = entries
      .filter((entry) => entry.kind !== "directory" && entry.path !== resolved.effectivePath)
      .slice(0, remaining);

    await runWithConcurrency(siblings, options.concurrency ?? this.prefetchConcurrency, async (entry) => {
      accumulator.visitedEntries += 1;
      const childResolved: ResolvedResource = {
        ...resolved,
        effectivePath: entry.path,
      };
      try {
        await this.prefetchFileResolved(childResolved, {
          signal: options.signal,
          forceRefresh: options.forceRefresh,
          maxBytes: options.maxBytes ?? this.prefetchMaxBytes,
        }, accumulator);
      } catch (error) {
        this.emitEvent("prefetch_result", {
          path: entry.path,
          kind: entry.kind,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private async prefetchDirectoryResolved(
    resolved: ResolvedResource,
    options: PrefetchOptions,
    strategy: PrefetchOptions["strategy"],
    depth: number,
    accumulator: PrefetchAccumulator,
  ): Promise<void> {
    const maxDepth = options.maxDepth ?? (strategy === "recursive" ? 4 : 1);
    if (depth > maxDepth) return;

    const entries = await this.lsResolved(resolved, options);
    const remaining = Math.max(0, (options.maxEntries ?? this.prefetchMaxEntries) - accumulator.visitedEntries);
    const selected = entries.slice(0, remaining);

    await runWithConcurrency(selected, options.concurrency ?? this.prefetchConcurrency, async (entry) => {
      accumulator.visitedEntries += 1;
      const childResolved: ResolvedResource = {
        ...resolved,
        effectivePath: entry.path,
      };

      if (entry.kind === "directory") {
        if (strategy === "recursive") {
          await this.prefetchDirectoryResolved(childResolved, options, strategy, depth + 1, accumulator);
        }
        return;
      }

      try {
        await this.prefetchFileResolved(childResolved, {
          signal: options.signal,
          forceRefresh: options.forceRefresh,
          maxBytes: options.maxBytes ?? this.prefetchMaxBytes,
        }, accumulator);
      } catch (error) {
        this.emitEvent("prefetch_result", {
          path: entry.path,
          kind: entry.kind,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private async loadDomainInfoNetwork(baseDomain: string): Promise<DomainResolutionState> {
    await this.ensureTrustStateLoaded();

    if (this.dnsVerificationMode !== "rest") {
      if (!this.dnsLightVerifier) {
        if (this.dnsVerificationMode === "proof") {
          this.emitEvent("dns_verify_failed", {
            domain: baseDomain,
            mode: this.dnsVerificationMode,
            error: "DNS proof verification was requested but no Tendermint RPC endpoints are configured",
          });
          throw new Error("DNS proof verification was requested but no Tendermint RPC endpoints are configured");
        }

        this.statusCounters.fallbacks += 1;
        this.emitEvent("dns_verify_fallback", {
          domain: baseDomain,
          mode: this.dnsVerificationMode,
          reason: "rpc_unavailable",
        });
        this.emitEvent("security_downgrade", {
          domain: baseDomain,
          mode: this.dnsVerificationMode,
          reason: "rpc_unavailable",
        });
      } else {
        try {
          const verified = await this.dnsLightVerifier.queryDomain(baseDomain, this.chainConsistencyMode);
          void this.scheduleTrustStatePersist();
          return {
            info: verified.domain,
            security: {
              mode: this.dnsVerificationMode,
              source: "rpc-proof",
              verified: true,
              downgraded: false,
              unsafe: false,
              verification: {
                endpoint: verified.endpoint,
                chainId: verified.chainId,
                height: verified.height,
                anchorHeight: verified.anchorHeight,
                latestHeight: verified.latestHeight,
                headerHash: verified.headerHashHex,
                commitBlockHash: verified.commitBlockHashHex,
                appHash: verified.appHashHex,
                storeRoot: verified.storeRootHex,
                validatorsHash: verified.validatorsHashHex,
                nextValidatorsHash: verified.nextValidatorsHashHex,
                totalVotingPower: verified.totalVotingPower,
                signedVotingPower: verified.signedVotingPower,
              },
            },
          };
        } catch (error) {
          if (this.dnsVerificationMode === "proof") {
            throw error;
          }

          this.dnsLightVerifier.markFallback();
          this.emitEvent("dns_verify_fallback", {
            domain: baseDomain,
            mode: this.dnsVerificationMode,
            rpcEndpoint: this.rpcEndpoint || undefined,
            rpcEndpoints: this.rpcEndpoints,
            error: error instanceof Error ? error.message : String(error),
          });
          this.emitEvent("security_downgrade", {
            domain: baseDomain,
            mode: this.dnsVerificationMode,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (this.restEndpoints.length > 0) {
      const info = await this.queryRestConsensus(
        "domain",
        async (endpoint) => {
          const url = buildRestUrl(endpoint, `/lumen/dns/v1/domain/${encodeURIComponent(baseDomain)}`);
          const response = await this.fetchJson(url, { allowNotFound: true });
          return normalizeDomainPayload(response);
        },
        (value) => normalizeDomainForConsensus(value),
      );
      void this.scheduleTrustStatePersist();
      return {
        info,
        security: {
          mode: this.dnsVerificationMode,
          source: "rest",
          verified: false,
          downgraded: this.dnsVerificationMode === "auto",
          unsafe: true,
          ...(this.dnsVerificationMode === "auto"
            ? { downgradeReason: "proof_unavailable_or_failed" }
            : {}),
        },
      };
    }

    if (!this.dnsModule?.domain) {
      throw new Error("No DNS query source configured");
    }

    const payload = await this.dnsModule.domain(baseDomain);
    void this.scheduleTrustStatePersist();
    return {
      info: normalizeDomainPayload(payload),
      security: {
        mode: this.dnsVerificationMode,
        source: "rest",
        verified: false,
        downgraded: this.dnsVerificationMode === "auto",
        unsafe: true,
        ...(this.dnsVerificationMode === "auto"
          ? { downgradeReason: "sdk_rest_fallback" }
          : {}),
      },
    };
  }

  private async loadOnchainGateways(): Promise<GatewayCandidate[]> {
    if (this.restEndpoints.length > 0) {
      return await this.queryRestConsensus(
        "gateways",
        async (endpoint) => {
          const url = new URL("/lumen/gateway/v1/gateways", `${trimTrailingSlash(endpoint)}/`);
          url.searchParams.set("offset", "0");
          url.searchParams.set("limit", String(this.gatewayLimit));
          const payload = await this.fetchJson(url.toString(), { allowNotFound: true });
          return extractGatewayCandidates(payload, "onchain").filter((gateway) => gateway.active !== false);
        },
        (value) => normalizeGatewaysForConsensus(value),
      );
    }

    if (!this.gatewaysModule?.gateways) {
      return [];
    }

    const payload = await this.gatewaysModule.gateways({
      offset: 0,
      limit: this.gatewayLimit,
    });
    return extractGatewayCandidates(payload, "onchain").filter((gateway) => gateway.active !== false);
  }

  private async queryRestConsensus<T>(
    label: string,
    loader: (endpoint: string) => Promise<T>,
    normalize: (value: T) => unknown,
  ): Promise<T> {
    const results: Array<PromiseSettledResult<RestConsensusSuccess<T>>> = await Promise.allSettled(
      this.restEndpoints.map(async (endpoint) => {
        const value = await loader(endpoint);
        return {
          endpoint,
          value,
          normalized: stableStringify(normalize(value)),
        } satisfies RestConsensusSuccess<T>;
      }),
    );

    const successes: RestConsensusSuccess<T>[] = [];
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        successes.push(result.value);
      } else {
        failures.push(result.reason);
      }
    }

    if (!successes.length) {
      throw new AggregateError(failures, `Failed to load ${label} from every configured REST endpoint`);
    }

    if (this.chainConsistencyMode === "single" || successes.length === 1) {
      return successes[0]!.value;
    }

    const buckets = new Map<string, { count: number; winner: RestConsensusSuccess<T> }>();
    for (const success of successes) {
      const existing = buckets.get(success.normalized);
      if (existing) {
        existing.count += 1;
      } else {
        buckets.set(success.normalized, {
          count: 1,
          winner: success,
        });
      }
    }

    const ranked = [...buckets.values()].sort((left, right) => right.count - left.count);
    const winner = ranked[0];
    const runnerUp = ranked[1];

    if (!winner) {
      throw new Error(`Failed to determine a consensus ${label} response`);
    }

    if ((runnerUp && runnerUp.count === winner.count) || winner.count <= successes.length / 2) {
      throw new Error(
        `Inconsistent ${label} state across REST endpoints: ${successes.map((item) => item.endpoint).join(", ")}`,
      );
    }

    this.emitEvent("rest_consensus", {
      label,
      mode: this.chainConsistencyMode,
      endpoints: successes.map((item) => item.endpoint),
      winnerEndpoints: successes
        .filter((item) => item.normalized === winner.winner.normalized)
        .map((item) => item.endpoint),
    });

    return winner.winner.value;
  }

  private async fetchJson(url: string, options: { allowNotFound?: boolean } = {}): Promise<unknown> {
    const abortContext = createAbortContext({
      timeoutMs: this.restTimeoutMs,
    });
    const startedAt = now();

    try {
      const response = await fetch(url, {
        signal: abortContext.signal,
        headers: {
          Accept: "application/json",
        },
        cache: "no-store",
      });

      if (response.status === 404 && options.allowNotFound) {
        this.emitEvent("rest_query", {
          url,
          ok: true,
          status: 404,
          allowNotFound: true,
          durationMs: now() - startedAt,
        });
        return null;
      }

      if (!response.ok) {
        throw new Error(`REST request failed (${response.status} ${response.statusText}) for ${url}`);
      }

      const payload = await response.json();
      this.emitEvent("rest_query", {
        url,
        ok: true,
        status: response.status,
        durationMs: now() - startedAt,
      });
      return payload;
    } catch (error) {
      this.emitEvent("rest_query", {
        url,
        ok: false,
        durationMs: now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      abortContext.cleanup();
    }
  }

  private async getCacheStore(): Promise<ResolverCacheStore> {
    return await this.cacheStorePromise;
  }

  private namespace(name: string): string {
    return `${this.cacheNamespace}:${name}`;
  }

  private async getCacheValue<T>(
    namespace: string,
    key: string,
    options: { allowExpired: boolean; touch: boolean; forceRefresh: boolean },
  ): Promise<CacheLookup<T>> {
    if (options.forceRefresh) return null;

    try {
      const store = await this.getCacheStore();
      const record = await store.get<T>(this.namespace(namespace), key);
      if (!record) return null;

      const expired = record.expiresAt != null && record.expiresAt <= now();
      if (expired && !options.allowExpired) return null;

      if (options.touch) {
        const touched = makeCacheRecord(record.key, record.value, {
          expiresAt: record.expiresAt,
          sizeBytes: record.sizeBytes,
          lastAccessedAt: now(),
        });
        await store.set(this.namespace(namespace), key, touched);
        return { record: touched, expired };
      }

      return { record, expired };
    } catch {
      return null;
    }
  }

  private async setCacheValue<T>(
    namespace: string,
    key: string,
    value: T,
    options: { ttlMs?: number } = {},
  ): Promise<void> {
    try {
      const store = await this.getCacheStore();
      await store.set(
        this.namespace(namespace),
        key,
        makeCacheRecord(key, value, {
          expiresAt: options.ttlMs != null ? now() + options.ttlMs : undefined,
        }),
      );
    } catch {
      // Ignore cache storage failures.
    }
  }

  private async setContentCacheValue(key: string, value: Uint8Array): Promise<void> {
    if (!value.byteLength) return;
    if (this.contentCacheMaxEntries <= 0 || this.contentCacheMaxBytes <= 0) return;
    if (value.byteLength > this.contentCacheMaxBytes) return;

    await this.setCacheValue(CACHE_CONTENT, key, value);
    await this.trimContentCache();
  }

  private async trimContentCache(): Promise<void> {
    try {
      const store = await this.getCacheStore();
      const namespace = this.namespace(CACHE_CONTENT);
      const entries = await store.list(namespace);
      const currentTime = now();
      let totalBytes = 0;
      const retained = entries
        .filter((entry) => {
          const expired = entry.expiresAt != null && entry.expiresAt <= currentTime;
          if (expired) {
            void store.delete(namespace, entry.key);
            return false;
          }
          totalBytes += entry.sizeBytes;
          return true;
        })
        .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);

      while (retained.length > this.contentCacheMaxEntries || totalBytes > this.contentCacheMaxBytes) {
        const victim = retained.shift();
        if (!victim) break;
        totalBytes -= victim.sizeBytes;
        await store.delete(namespace, victim.key);
      }
    } catch {
      // Ignore cache trimming failures.
    }
  }

  private normalizeContentKind(type: unknown): ContentKind {
    const normalized = String(type ?? "").trim().toLowerCase();
    if (normalized === "directory") return "directory";
    if (normalized === "raw") return "raw";
    if (!normalized) return "unknown";
    return "file";
  }
}

export function createDomainResolver(options: ResolverOptions = {}): LumenDomainResolver {
  return new LumenDomainResolver(options);
}
