import type { CID } from "multiformats/cid";

export type TargetProtocol = "ipfs" | "ipns";
export type GatewaySource = "custom" | "onchain" | "default";
export type ContentKind = "file" | "directory" | "raw";
export type ChainConsistencyMode = "single" | "majority";
export type DnsVerificationMode = "auto" | "rest" | "proof";
export type PrefetchStrategy = "file" | "shallow" | "recursive" | "adjacent";
export type RpcErrorKind =
  | "network"
  | "proof_verification"
  | "consensus_mismatch"
  | "timeout"
  | "invalid_response"
  | "circuit_open";
export type ResolverEventType =
  | "cache_hit"
  | "cache_miss"
  | "cache_stale"
  | "rest_query"
  | "rpc_query"
  | "rest_consensus"
  | "ipns_resolve"
  | "ipns_fallback"
  | "gateway_result"
  | "content_stream"
  | "prefetch_result"
  | "dns_verified"
  | "dns_verify_failed"
  | "dns_verify_fallback"
  | "security_downgrade"
  | "dns_checkpoint_verified"
  | "dns_checkpoint_stale"
  | "dns_header_cache_hit"
  | "dns_status_cache_hit"
  | "dns_rpc_error"
  | "dns_timeout";

export interface DomainTarget {
  proto: TargetProtocol;
  id: string;
  basePath?: string;
}

export interface DomainRecordLike {
  key?: string;
  value?: string;
  [key: string]: unknown;
}

export interface DomainInfoLike {
  cid?: string;
  ipns?: string;
  records?: DomainRecordLike[];
  [key: string]: unknown;
}

export interface GatewayCandidate {
  url: string;
  source: GatewaySource;
  gatewayId?: string;
  endpoint?: string;
  active?: boolean;
  metadata?: Record<string, unknown>;
}

export interface GatewayPerformanceStats {
  url: string;
  score: number;
  successes: number;
  failures: number;
  aborted: number;
  averageLatencyMs: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

export interface RpcEndpointHealth {
  endpoint: string;
  successes: number;
  failures: number;
  timeoutCount: number;
  proofFailureCount: number;
  consensusMismatchCount: number;
  failureScore: number;
  circuitOpenUntil?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastErrorKind?: RpcErrorKind;
  lastErrorMessage?: string;
}

export interface ResolverMetricsSnapshot {
  proofAttempts: number;
  proofSuccesses: number;
  fallbackCount: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface ResolverStatus {
  mode: DnsVerificationMode;
  lastVerifiedHeight: number;
  checkpointAge: number;
  proofSuccessRate: number;
  fallbackRate: number;
  cacheHitRate: number;
}

export interface TrustedCheckpoint {
  height: number;
  blockHash: string | Uint8Array;
  chainId: string;
  trustedAt: number;
}

export type DnsTrustedCheckpoint = TrustedCheckpoint;

export interface TrustOptions {
  checkpoints?: TrustedCheckpoint[];
  maxDriftBlocks?: number;
  requireChainIdMatch?: boolean;
  trustingPeriodMs?: number;
  expectedChainId?: string;
}

export interface DnsVerificationMetadata {
  endpoint?: string;
  chainId?: string;
  height?: number;
  anchorHeight?: number;
  latestHeight?: number;
  headerHash?: string;
  commitBlockHash?: string;
  appHash?: string;
  storeRoot?: string;
  validatorsHash?: string;
  nextValidatorsHash?: string;
  totalVotingPower?: string;
  signedVotingPower?: string;
}

export interface ResolverSecurityMetadata {
  mode: DnsVerificationMode;
  source: "rpc-proof" | "rest";
  verified: boolean;
  downgraded: boolean;
  unsafe: boolean;
  downgradeReason?: string;
  verification?: DnsVerificationMetadata;
}

export interface VerifiedHeaderSnapshot {
  endpoint: string;
  chainId: string;
  height: number;
  latestHeight: number;
  headerHash: string;
  commitBlockHash: string;
  appHash: string;
  validatorsHash: string;
  nextValidatorsHash: string;
  totalVotingPower: string;
  signedVotingPower: string;
  verifiedAt: number;
}

export interface VerifiedValidatorSetSnapshot {
  endpoint: string;
  chainId: string;
  height: number;
  validatorsHash: string;
  validatorCount: number;
  totalVotingPower: string;
  capturedAt: number;
}

export interface PersistedResolverTrustState {
  version: number;
  updatedAt: number;
  lastVerifiedHeader?: VerifiedHeaderSnapshot;
  lastValidatorSet?: VerifiedValidatorSetSnapshot;
  lastGoodCheckpoint?: TrustedCheckpoint;
  gatewayScores?: GatewayPerformanceStats[];
  rpcHealth?: RpcEndpointHealth[];
  metrics?: ResolverMetricsSnapshot;
}

export interface ResolverEvent {
  type: ResolverEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export type ResolverObserver = (event: ResolverEvent) => void;

export interface ResolverCacheRecord<T = unknown> {
  key: string;
  value: T;
  expiresAt?: number;
  lastAccessedAt: number;
  sizeBytes: number;
}

export interface ResolverCacheRecordMeta {
  key: string;
  expiresAt?: number;
  lastAccessedAt: number;
  sizeBytes: number;
}

export interface ResolverCacheStore {
  get<T>(namespace: string, key: string): Promise<ResolverCacheRecord<T> | null>;
  set<T>(namespace: string, key: string, record: ResolverCacheRecord<T>): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  list(namespace: string): Promise<ResolverCacheRecordMeta[]>;
  clear?(namespace?: string): Promise<void>;
  close?(): Promise<void>;
}

export interface ResolverOptions {
  restEndpoint?: string;
  restEndpoints?: Array<string | URL>;
  restTimeoutMs?: number;
  rpcEndpoint?: string;
  rpcEndpoints?: Array<string | URL>;
  rpcTimeoutMs?: number;
  rpcGlobalTimeoutMs?: number;
  rpcMaxAttempts?: number;
  rpcRetryBaseDelayMs?: number;
  rpcRetryMaxDelayMs?: number;
  rpcCircuitBreakerThreshold?: number;
  rpcCircuitBreakerCooldownMs?: number;
  rpcCircuitBreakerDecayMs?: number;
  chainConsistencyMode?: ChainConsistencyMode;
  dnsVerificationMode?: DnsVerificationMode;
  trustOptions?: TrustOptions;
  dnsTrustedCheckpoint?: DnsTrustedCheckpoint;
  dnsStatusCacheTtlMs?: number;
  dnsVerifiedHeaderCacheSize?: number;
  dnsModule?: {
    domain(index: string): Promise<unknown>;
  };
  gatewaysModule?: {
    gateways(filters?: { offset?: number; limit?: number }): Promise<unknown>;
  };
  customGateways?: Array<string | URL>;
  publicGateways?: Array<string | URL>;
  delegatedRoutingEndpoints?: Array<string | URL>;
  allowInsecureGateways?: boolean;
  allowLocalGateways?: boolean;
  domainCacheTtlMs?: number;
  gatewayCacheTtlMs?: number;
  gatewayLimit?: number;
  cacheStore?: ResolverCacheStore;
  cacheMode?: "auto" | "memory" | "indexeddb" | "filesystem";
  cacheDirectory?: string;
  cacheNamespace?: string;
  contentCacheMaxEntries?: number;
  contentCacheMaxBytes?: number;
  ipnsResolveTimeoutMs?: number;
  ipnsFallbackTtlMs?: number;
  enableGatewayScoring?: boolean;
  gatewayScoreTtlMs?: number;
  maxRecentEvents?: number;
  prefetchConcurrency?: number;
  prefetchMaxEntries?: number;
  prefetchMaxBytes?: number;
  onEvent?: ResolverObserver;
}

export interface ResolveResourceOptions {
  path?: string;
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

export interface ResolveDomainResult {
  host: string;
  baseDomain: string;
  recordKey?: string | null;
  domain: DomainInfoLike | null;
  target: DomainTarget;
  source: string;
  security: ResolverSecurityMetadata;
  gateways: GatewayCandidate[];
  effectivePath: string;
}

export interface ResolvedResource {
  input: string | DomainTarget;
  source: "domain" | "target";
  host?: string;
  baseDomain?: string;
  recordKey?: string | null;
  domain: DomainInfoLike | null;
  target: DomainTarget;
  security: ResolverSecurityMetadata;
  cid: CID;
  cidString: string;
  gateways: GatewayCandidate[];
  effectivePath: string;
  resolvedIpnsPath?: string;
}

export interface ContentStat {
  resolved: ResolvedResource;
  cid: string;
  path: string;
  kind: ContentKind;
  sizeBytes: string;
  mode?: number;
}

export interface ListOptions extends ResolveResourceOptions {
  offset?: number;
  length?: number;
}

export interface ContentListEntry {
  name: string;
  path: string;
  cid: string;
  kind: ContentKind;
  sizeBytes?: string;
}

export interface ReadBytesOptions extends ResolveResourceOptions {
  maxBytes?: number;
}

export interface ReadTextOptions extends ReadBytesOptions {
  encoding?: string;
}

export interface ReadStreamOptions extends ReadBytesOptions {
  offset?: number;
  length?: number;
}

export interface GetFullContentOptions extends ReadBytesOptions {
  recursive?: boolean;
  maxDepth?: number;
  maxEntries?: number;
  includeText?: boolean;
}

export interface PrefetchOptions extends ResolveResourceOptions {
  strategy?: PrefetchStrategy;
  maxDepth?: number;
  maxEntries?: number;
  maxBytes?: number;
  concurrency?: number;
}

export interface PrefetchResult {
  resolved: ResolvedResource;
  strategy: PrefetchStrategy;
  visitedEntries: number;
  warmedFiles: number;
  warmedBytes: number;
  prefetchedPaths: string[];
}

export interface FileContentResult extends ContentStat {
  kind: "file" | "raw";
  bytes: Uint8Array;
  text?: string;
}

export interface DirectoryContentEntry extends ContentListEntry {
  content?: FullContentResult;
}

export interface DirectoryContentResult extends ContentStat {
  kind: "directory";
  entries: DirectoryContentEntry[];
  recursive: boolean;
}

export type FullContentResult = FileContentResult | DirectoryContentResult;
