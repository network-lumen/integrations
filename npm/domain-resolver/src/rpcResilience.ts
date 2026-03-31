import type { ResolverEvent, RpcEndpointHealth, RpcErrorKind } from "./types.js";

const DEFAULT_RPC_MAX_ATTEMPTS = 3;
const DEFAULT_RPC_RETRY_BASE_DELAY_MS = 150;
const DEFAULT_RPC_RETRY_MAX_DELAY_MS = 1_500;
const DEFAULT_RPC_CIRCUIT_BREAKER_THRESHOLD = 3;
const DEFAULT_RPC_CIRCUIT_BREAKER_COOLDOWN_MS = 15_000;
const DEFAULT_RPC_CIRCUIT_BREAKER_DECAY_MS = 60_000;

type RpcObserver = (type: ResolverEvent["type"], data: Record<string, unknown>) => void;

export class RpcRequestError extends Error {
  readonly kind: RpcErrorKind;
  readonly endpoint: string;
  readonly method: string;
  readonly attempt: number;
  readonly retryable: boolean;
  readonly durationMs?: number;
  override readonly cause?: unknown;

  constructor(input: {
    kind: RpcErrorKind;
    endpoint: string;
    method: string;
    attempt: number;
    retryable: boolean;
    message: string;
    durationMs?: number;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "RpcRequestError";
    this.kind = input.kind;
    this.endpoint = input.endpoint;
    this.method = input.method;
    this.attempt = input.attempt;
    this.retryable = input.retryable;
    this.durationMs = input.durationMs;
    this.cause = input.cause;
  }
}

export interface RpcResilienceOptions {
  timeoutMs: number;
  globalTimeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownMs?: number;
  circuitBreakerDecayMs?: number;
  observer?: RpcObserver;
}

type RpcHealthMap = Map<string, RpcEndpointHealth>;

function now(): number {
  return Date.now();
}

function sleep(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRpcRequestError(error: unknown): error is RpcRequestError {
  return error instanceof RpcRequestError;
}

function normalizeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyRpcError(error: unknown): {
  kind: RpcErrorKind;
  retryable: boolean;
  message: string;
} {
  if (isRpcRequestError(error)) {
    return {
      kind: error.kind,
      retryable: error.retryable,
      message: error.message,
    };
  }

  const message = normalizeMessage(error);
  const lower = message.toLowerCase();

  if (lower.includes("timeout")) {
    return {
      kind: "timeout",
      retryable: true,
      message,
    };
  }

  if (
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("socket") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("connection closed")
  ) {
    return {
      kind: "network",
      retryable: true,
      message,
    };
  }

  return {
    kind: "invalid_response",
    retryable: false,
    message,
  };
}

function cloneHealth(health: RpcEndpointHealth): RpcEndpointHealth {
  return {
    ...health,
  };
}

function createHealth(endpoint: string): RpcEndpointHealth {
  return {
    endpoint,
    successes: 0,
    failures: 0,
    timeoutCount: 0,
    proofFailureCount: 0,
    consensusMismatchCount: 0,
    failureScore: 0,
  };
}

function decayFailureScore(health: RpcEndpointHealth, decayMs: number): RpcEndpointHealth {
  if (!(decayMs > 0) || !(health.failureScore > 0) || !health.lastFailureAt) return health;
  const elapsed = Math.max(0, now() - health.lastFailureAt);
  const decayUnits = Math.floor(elapsed / decayMs);
  if (!(decayUnits > 0)) return health;
  return {
    ...health,
    failureScore: Math.max(0, health.failureScore - decayUnits),
  };
}

function remainingBudget(deadlineAt?: number): number | undefined {
  if (deadlineAt == null) return undefined;
  return Math.max(0, deadlineAt - now());
}

async function promiseWithTimeout<T>(
  promiseFactory: () => Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  if (!(timeoutMs != null && timeoutMs > 0)) {
    return await promiseFactory();
  }

  return await new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new Error(`${label}_timeout_after_${timeoutMs}ms`));
    }, timeoutMs);

    promiseFactory().then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error) => {
        clearTimeout(handle);
        reject(error);
      },
    );
  });
}

export class RpcResilienceLayer {
  private readonly timeoutMs: number;
  private readonly globalTimeoutMs: number | undefined;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly circuitBreakerThreshold: number;
  private readonly circuitBreakerCooldownMs: number;
  private readonly circuitBreakerDecayMs: number;
  private readonly observer?: RpcObserver;
  private readonly health: RpcHealthMap = new Map();

  constructor(options: RpcResilienceOptions) {
    this.timeoutMs = Math.max(1, options.timeoutMs);
    this.globalTimeoutMs = options.globalTimeoutMs != null ? Math.max(1, options.globalTimeoutMs) : undefined;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_RPC_MAX_ATTEMPTS);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RPC_RETRY_BASE_DELAY_MS);
    this.retryMaxDelayMs = Math.max(this.retryBaseDelayMs, options.retryMaxDelayMs ?? DEFAULT_RPC_RETRY_MAX_DELAY_MS);
    this.circuitBreakerThreshold = Math.max(1, options.circuitBreakerThreshold ?? DEFAULT_RPC_CIRCUIT_BREAKER_THRESHOLD);
    this.circuitBreakerCooldownMs = Math.max(1, options.circuitBreakerCooldownMs ?? DEFAULT_RPC_CIRCUIT_BREAKER_COOLDOWN_MS);
    this.circuitBreakerDecayMs = Math.max(1, options.circuitBreakerDecayMs ?? DEFAULT_RPC_CIRCUIT_BREAKER_DECAY_MS);
    this.observer = options.observer;
  }

  getGlobalTimeoutMs(): number | undefined {
    return this.globalTimeoutMs;
  }

  importHealth(healthEntries?: RpcEndpointHealth[]): void {
    this.health.clear();
    for (const entry of healthEntries ?? []) {
      this.health.set(entry.endpoint, cloneHealth(entry));
    }
  }

  exportHealth(): RpcEndpointHealth[] {
    return [...this.health.values()]
      .map((entry) => cloneHealth(entry))
      .sort((left, right) => left.endpoint.localeCompare(right.endpoint));
  }

  getHealth(endpoint: string): RpcEndpointHealth {
    const current = this.health.get(endpoint) ?? createHealth(endpoint);
    const decayed = decayFailureScore(current, this.circuitBreakerDecayMs);
    if (decayed !== current) {
      this.health.set(endpoint, decayed);
    } else if (!this.health.has(endpoint)) {
      this.health.set(endpoint, current);
    }
    return this.health.get(endpoint)!;
  }

  async execute<T>(input: {
    endpoint: string;
    method: string;
    fn: () => Promise<T>;
    deadlineAt?: number;
  }): Promise<T> {
    const deadlineAt =
      input.deadlineAt ??
      (this.globalTimeoutMs != null ? now() + this.globalTimeoutMs : undefined);

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const openedHealth = this.getHealth(input.endpoint);
      if (openedHealth.circuitOpenUntil && openedHealth.circuitOpenUntil > now()) {
        const error = new RpcRequestError({
          kind: "circuit_open",
          endpoint: input.endpoint,
          method: input.method,
          attempt,
          retryable: false,
          message: `RPC circuit breaker is open for ${input.endpoint}`,
        });
        this.emit("dns_rpc_error", {
          endpoint: input.endpoint,
          method: input.method,
          kind: error.kind,
          attempt,
          circuitOpenUntil: openedHealth.circuitOpenUntil,
          error: error.message,
        });
        throw error;
      }

      const remaining = remainingBudget(deadlineAt);
      if (remaining != null && remaining <= 0) {
        const error = new RpcRequestError({
          kind: "timeout",
          endpoint: input.endpoint,
          method: input.method,
          attempt,
          retryable: false,
          message: `RPC deadline exceeded before ${input.method} on ${input.endpoint}`,
        });
        this.recordError(input.endpoint, error.kind, error.message);
        this.emit("dns_timeout", {
          endpoint: input.endpoint,
          method: input.method,
          attempt,
          error: error.message,
        });
        throw error;
      }

      const timeoutMs = remaining != null ? Math.min(this.timeoutMs, remaining) : this.timeoutMs;
      const startedAt = now();
      try {
        const value = await promiseWithTimeout(input.fn, timeoutMs, input.method);
        this.recordSuccess(input.endpoint);
        this.emit("rpc_query", {
          endpoint: input.endpoint,
          method: input.method,
          ok: true,
          attempt,
          durationMs: now() - startedAt,
        });
        return value;
      } catch (error) {
        const classified = classifyRpcError(error);
        const wrapped = new RpcRequestError({
          kind: classified.kind,
          endpoint: input.endpoint,
          method: input.method,
          attempt,
          retryable: classified.retryable,
          message: classified.message,
          durationMs: now() - startedAt,
          cause: error,
        });
        lastError = wrapped;
        this.recordError(input.endpoint, wrapped.kind, wrapped.message);
        this.emit("rpc_query", {
          endpoint: input.endpoint,
          method: input.method,
          ok: false,
          attempt,
          durationMs: wrapped.durationMs,
          kind: wrapped.kind,
          error: wrapped.message,
        });
        if (wrapped.kind === "timeout") {
          this.emit("dns_timeout", {
            endpoint: input.endpoint,
            method: input.method,
            attempt,
            error: wrapped.message,
          });
        } else {
          this.emit("dns_rpc_error", {
            endpoint: input.endpoint,
            method: input.method,
            kind: wrapped.kind,
            attempt,
            error: wrapped.message,
          });
        }

        if (!wrapped.retryable || attempt >= this.maxAttempts) {
          throw wrapped;
        }

        const retryDelay = Math.min(
          this.retryMaxDelayMs,
          this.retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)),
        );
        const remainingAfterFailure = remainingBudget(deadlineAt);
        if (remainingAfterFailure != null && remainingAfterFailure <= retryDelay) {
          throw wrapped;
        }
        await sleep(retryDelay);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  recordVerificationFailure(
    endpoint: string,
    kind: Extract<RpcErrorKind, "proof_verification" | "consensus_mismatch" | "invalid_response">,
    message: string,
    data: Record<string, unknown> = {},
  ): void {
    this.recordError(endpoint, kind, message);
    this.emit("dns_rpc_error", {
      endpoint,
      kind,
      error: message,
      ...data,
    });
  }

  private recordSuccess(endpoint: string): void {
    const current = this.getHealth(endpoint);
    this.health.set(endpoint, {
      ...current,
      successes: current.successes + 1,
      failureScore: Math.max(0, current.failureScore - 1),
      lastSuccessAt: now(),
      ...(current.circuitOpenUntil && current.circuitOpenUntil <= now() ? { circuitOpenUntil: undefined } : {}),
    });
  }

  private recordError(endpoint: string, kind: RpcErrorKind, message: string): void {
    const current = this.getHealth(endpoint);
    const failureScore = current.failureScore + 1;
    const opened = failureScore >= this.circuitBreakerThreshold
      ? now() + this.circuitBreakerCooldownMs
      : current.circuitOpenUntil;

    this.health.set(endpoint, {
      ...current,
      failures: current.failures + 1,
      timeoutCount: current.timeoutCount + (kind === "timeout" ? 1 : 0),
      proofFailureCount: current.proofFailureCount + (kind === "proof_verification" ? 1 : 0),
      consensusMismatchCount: current.consensusMismatchCount + (kind === "consensus_mismatch" ? 1 : 0),
      failureScore,
      circuitOpenUntil: opened,
      lastFailureAt: now(),
      lastErrorKind: kind,
      lastErrorMessage: message,
    });
  }

  private emit(type: ResolverEvent["type"], data: Record<string, unknown>): void {
    try {
      this.observer?.(type, data);
    } catch {
      // Ignore observer failures.
    }
  }
}
