import type { PersistedResolverTrustState, ResolverCacheStore } from "./types.js";
import { makeCacheRecord } from "./cache.js";

const TRUST_STATE_NAMESPACE = "trust_state";
const TRUST_STATE_KEY = "state";
const TRUST_STATE_ENVELOPE_VERSION = 1;
const TRUST_STATE_SCHEMA_VERSION = 2;

type TrustStateEnvelope = {
  version: number;
  checksum: string;
  payload: PersistedResolverTrustState;
};

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

async function sha256Hex(input: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  const { createHash } = await importNode<typeof import("node:crypto")>("node:crypto");
  return createHash("sha256").update(input).digest("hex");
}

function cloneTrustState(state: PersistedResolverTrustState): PersistedResolverTrustState {
  return JSON.parse(JSON.stringify(state)) as PersistedResolverTrustState;
}

function normalizeTrustState(state: PersistedResolverTrustState): PersistedResolverTrustState {
  return {
    version: TRUST_STATE_SCHEMA_VERSION,
    updatedAt: state.updatedAt,
    ...(state.lastVerifiedHeader ? { lastVerifiedHeader: state.lastVerifiedHeader } : {}),
    ...(state.lastValidatorSet ? { lastValidatorSet: state.lastValidatorSet } : {}),
    ...(state.lastGoodCheckpoint ? { lastGoodCheckpoint: state.lastGoodCheckpoint } : {}),
    ...(state.gatewayScores ? { gatewayScores: state.gatewayScores } : {}),
    ...(state.rpcHealth ? { rpcHealth: state.rpcHealth } : {}),
    ...(state.metrics ? { metrics: state.metrics } : {}),
  };
}

export class PersistentTrustStateStore {
  constructor(
    private readonly cacheStore: ResolverCacheStore,
    private readonly cacheNamespace: string,
  ) {}

  async load(): Promise<PersistedResolverTrustState | null> {
    const record = await this.cacheStore.get<TrustStateEnvelope>(this.namespace(), TRUST_STATE_KEY);
    if (!record) return null;
    const envelope = record.value;
    if (!envelope || typeof envelope !== "object") {
      throw new Error("resolver_trust_state_invalid_envelope");
    }
    if (envelope.version !== TRUST_STATE_ENVELOPE_VERSION) {
      throw new Error(`resolver_trust_state_unsupported_envelope_v${String(envelope.version)}`);
    }
    const expectedChecksum = await sha256Hex(stableStringify(envelope.payload));
    if (expectedChecksum !== envelope.checksum) {
      throw new Error("resolver_trust_state_checksum_mismatch");
    }
    if (envelope.payload.version !== TRUST_STATE_SCHEMA_VERSION) {
      throw new Error(`resolver_trust_state_unsupported_schema_v${String(envelope.payload.version)}`);
    }
    return cloneTrustState(normalizeTrustState(envelope.payload));
  }

  async save(state: PersistedResolverTrustState): Promise<void> {
    const normalized = normalizeTrustState({
      ...cloneTrustState(state),
      version: TRUST_STATE_SCHEMA_VERSION,
      updatedAt: Date.now(),
    });
    const checksum = await sha256Hex(stableStringify(normalized));
    const envelope: TrustStateEnvelope = {
      version: TRUST_STATE_ENVELOPE_VERSION,
      checksum,
      payload: normalized,
    };
    await this.cacheStore.set(
      this.namespace(),
      TRUST_STATE_KEY,
      makeCacheRecord(TRUST_STATE_KEY, envelope),
    );
  }

  async clear(): Promise<void> {
    await this.cacheStore.delete(this.namespace(), TRUST_STATE_KEY);
  }

  private namespace(): string {
    return `${this.cacheNamespace}:${TRUST_STATE_NAMESPACE}`;
  }
}

async function importNode<T>(specifier: string): Promise<T> {
  const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<T>;
  return await dynamicImport(specifier);
}
