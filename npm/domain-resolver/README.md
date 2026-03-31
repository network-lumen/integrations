## `@lumen-chain/domain-resolver`

Trustless resolver for Lumen on-chain domains that point to IPFS/IPNS content.

The package is built for generic JavaScript and TypeScript usage:

- resolve a Lumen domain to `ipfs` or `ipns`
- list a directory with `ls`
- read a file with `readBytes`, `readText`, or `readJson`
- stream a file with `readStream`
- warm the cache with `prefetch`
- fetch a whole subtree with `getFullContent`

It uses:

- `@lumen-chain/sdk` for on-chain DNS and gateway registry reads
- `helia`, `@helia/http`, `@helia/ipns`, and `@helia/unixfs` for trustless content retrieval over HTTP gateways or browser P2P
- CometBFT RPC proofs plus validator signature checks for DNS proof mode

That means content is checked against the resolved CID instead of blindly trusting a raw HTTP gateway response.

### Security Model

- `dnsVerificationMode: "proof"` is fail-closed. If proof verification fails, resolution fails.
- `dnsVerificationMode: "auto"` tries RPC proofs first and only then downgrades to REST/LCD.
- `dnsVerificationMode: "auto"` emits `security_downgrade` and returns downgrade metadata in `result.security`.
- `dnsVerificationMode: "rest"` is explicitly unsafe and skips proof verification.
- RPC proofs and REST/LCD reads are never mixed silently.

### What It Does

- races multiple trustless gateways in parallel and keeps the first valid block
- caches `domain -> target`, `gateway list`, `IPNS -> CID`, and file bytes
- uses `IndexedDB` in browsers or the filesystem in Node/Electron by default
- hardens IPNS with a timeout plus cached-CID fallback
- can compare multiple LCD/REST endpoints and reject inconsistent domain state
- can verify Lumen DNS records with CometBFT RPC proofs in `proof` mode
- scores gateways dynamically from latency and success history
- exposes observability events and gateway score snapshots

### Install

```bash
npm install @lumen-chain/domain-resolver
```

### Quick Start

```ts
import { createDomainResolver } from "@lumen-chain/domain-resolver";

const resolver = createDomainResolver({
  transport: "p2p",
  httpFallback: true,
  p2pAttemptTimeoutMs: 2500,
  restEndpoint: "https://rest.lumen.example",
  rpcEndpoint: "https://rpc.lumen.example",
  dnsVerificationMode: "proof",
  trustOptions: {
    checkpoints: [{
      height: 123456,
      blockHash: "abcdef0123456789...",
      chainId: "lumen-1",
      trustedAt: Date.now(),
    }],
    maxDriftBlocks: 100000,
    requireChainIdMatch: true,
  },
});

const domain = await resolver.resolveDomain("lumen.cosmos.directory");
console.log(domain.target);
console.log(domain.security);

const files = await resolver.ls("lumen.cosmos.directory");
console.log(files);

const chainJson = await resolver.readJson("lumen.cosmos.directory/cosmoshub/chain.json");
console.log(chainJson);

for await (const chunk of resolver.readStream("lumen.cosmos.directory/cosmoshub/chain.json")) {
  console.log(chunk.byteLength);
}

console.log(await resolver.getGatewayScores());
console.log(resolver.getResolverStatus());
console.log(resolver.getRecentEvents(10));
```

### API

```ts
const resolver = createDomainResolver(options?)

await resolver.resolveDomain("lumen.cosmos.directory")
await resolver.resolveResource("lumen.cosmos.directory/cosmoshub/chain.json")
await resolver.stat("lumen.cosmos.directory")
await resolver.ls("lumen.cosmos.directory")
await resolver.readBytes("lumen.cosmos.directory/cosmoshub/chain.json")
for await (const chunk of resolver.readStream("lumen.cosmos.directory/cosmoshub/chain.json")) {}
await resolver.readText("lumen.cosmos.directory/cosmoshub/chain.json")
await resolver.readJson("lumen.cosmos.directory/cosmoshub/chain.json")
await resolver.prefetch("lumen.cosmos.directory/cosmoshub", { strategy: "shallow" })
await resolver.getGatewayScores()
resolver.getResolverStatus()
resolver.getRecentEvents(25)
await resolver.getFullContent("lumen.cosmos.directory", { recursive: true })
await resolver.close()
```

### Options

```ts
createDomainResolver({
  transport: "p2p",
  httpFallback: true,
  p2pUseDelegatedRouting: true,
  p2pAttemptTimeoutMs: 2500,
  restEndpoint: "https://rest.lumen.example",
  restEndpoints: [
    "https://rest-1.lumen.example",
    "https://rest-2.lumen.example"
  ],
  rpcEndpoint: "https://rpc.lumen.example",
  rpcEndpoints: [
    "https://rpc-1.lumen.example",
    "https://rpc-2.lumen.example"
  ],
  rpcTimeoutMs: 8000,
  rpcGlobalTimeoutMs: 12000,
  rpcMaxAttempts: 3,
  rpcRetryBaseDelayMs: 150,
  rpcRetryMaxDelayMs: 1500,
  rpcCircuitBreakerThreshold: 3,
  rpcCircuitBreakerCooldownMs: 15000,
  rpcCircuitBreakerDecayMs: 60000,
  chainConsistencyMode: "majority",
  dnsVerificationMode: "auto",
  trustOptions: {
    checkpoints: [{
      height: 123456,
      blockHash: "abcdef0123456789...",
      chainId: "lumen-1",
      trustedAt: Date.now(),
    }],
    maxDriftBlocks: 100000,
    requireChainIdMatch: true,
  },
  dnsStatusCacheTtlMs: 1500,
  dnsVerifiedHeaderCacheSize: 64,
  customGateways: ["https://gateway-1.example"],
  publicGateways: ["https://trustless-gateway.link", "https://ipfs.io"],
  delegatedRoutingEndpoints: ["https://delegated-ipfs.dev"],
  cacheMode: "auto",
  cacheDirectory: "./.cache/domain-resolver",
  contentCacheMaxEntries: 256,
  contentCacheMaxBytes: 64 * 1024 * 1024,
  enableGatewayScoring: true,
  gatewayScoreTtlMs: 30 * 24 * 60 * 60 * 1000,
  maxRecentEvents: 200,
  prefetchConcurrency: 4,
  prefetchMaxEntries: 64,
  prefetchMaxBytes: 16 * 1024 * 1024,
  ipnsResolveTimeoutMs: 1500,
  ipnsFallbackTtlMs: 24 * 60 * 60 * 1000,
  onEvent(event) {
    console.log(event.type, event.data)
  },
})
```

### Trust State And Status

- verified headers, validator set metadata, checkpoint state, and RPC health are persisted across sessions
- the resolver persists its trust state in IndexedDB in browsers and the filesystem in Node/Electron
- `getResolverStatus()` returns:
  - `mode`
  - `lastVerifiedHeight`
  - `checkpointAge`
  - `proofSuccessRate`
  - `fallbackRate`
  - `cacheHitRate`

### Key Events

- `dns_verified`
- `dns_verify_failed`
- `dns_verify_fallback`
- `security_downgrade`
- `dns_checkpoint_verified`
- `dns_checkpoint_stale`
- `dns_header_cache_hit`
- `dns_status_cache_hit`
- `dns_rpc_error`
- `dns_timeout`

### Notes

- `transport: "http"` uses trustless HTTP gateways via Helia HTTP.
- `transport: "p2p"` uses Helia + libp2p in the browser or desktop runtime.
- `httpFallback: true` keeps HTTP as an explicit secondary backend when P2P retrieval fails.
- `p2pAttemptTimeoutMs` limits how long a single P2P content attempt can block before the resolver falls back to HTTP.
- Domain inputs can include subdomain records such as `lumen.cosmos.directory`.
- Direct `ipfs://`, `ipns://`, `/ipfs/...`, `/ipns/...`, and raw CID inputs are also supported.
- `getFullContent` defaults to a shallow directory snapshot; pass `{ recursive: true }` to walk nested directories.
- Gateway responses are validated against the requested CID before the data is returned.
- `dnsVerificationMode: "proof"` verifies DNS state with RPC commit signatures plus ICS23 proofs.
- Proof mode resolves DNS against `latest - 1` and anchors that proof on the signed header at `latest`.
- `trustOptions.checkpoints` let you pin one or more recent trusted headers before accepting proof-mode results from an RPC endpoint.
- Verified DNS anchor headers are cached in memory and reused across repeated proof-mode lookups.
- `dnsVerificationMode: "auto"` tries proof verification first and only then falls back to REST with explicit downgrade metadata.
- REST/LCD reads are still available, but they are a fallback path rather than a trustless proof path.
- `readStream` supports `offset` and `length` for range-friendly reads.
- `prefetch` supports `file`, `shallow`, `recursive`, and `adjacent` strategies.
