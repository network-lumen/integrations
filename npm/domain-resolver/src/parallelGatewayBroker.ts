import type { BlockBroker, BlockRetrievalOptions } from "@helia/interface";
import type { ComponentLogger } from "@libp2p/interface";
import type { CID } from "multiformats/cid";

import { shuffleArray } from "./utils.js";

const DEFAULT_MAX_SIZE = 2_097_152;

export interface ParallelGatewayBrokerInit {
  gateways: string[];
  requestCache?: RequestCache;
  rankGateways?: (gateways: string[]) => string[];
  onGatewayResult?: (event: GatewayResultEvent) => void;
}

export interface GatewayResultEvent {
  gateway: string;
  cid: string;
  durationMs: number;
  ok: boolean;
  aborted?: boolean;
  winner?: boolean;
  error?: string;
}

export function createParallelGatewayBroker(init: ParallelGatewayBrokerInit) {
  return (components: { logger: ComponentLogger }): BlockBroker => new ParallelGatewayBroker(components.logger, init);
}

class ParallelGatewayBroker implements BlockBroker {
  public readonly name = "parallel-trustless-gateway";
  private readonly gateways: string[];
  private readonly requestCache: RequestCache;
  private readonly rankGateways?: (gateways: string[]) => string[];
  private readonly onGatewayResult?: (event: GatewayResultEvent) => void;
  private readonly pending = new Map<string, Promise<Uint8Array>>();
  private readonly log: ReturnType<ComponentLogger["forComponent"]>;

  constructor(logger: ComponentLogger, init: ParallelGatewayBrokerInit) {
    this.gateways = init.gateways;
    this.requestCache = init.requestCache ?? "force-cache";
    this.rankGateways = init.rankGateways;
    this.onGatewayResult = init.onGatewayResult;
    this.log = logger.forComponent("helia:parallel-trustless-gateway");
  }

  async retrieve(cid: CID, options: BlockRetrievalOptions = {}): Promise<Uint8Array> {
    const key = cid.toString();
    const existing = this.pending.get(key);
    if (existing) return await existing;

    const job = this.retrieveInner(cid, options)
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, job);
    return await job;
  }

  private async retrieveInner(cid: CID, options: BlockRetrievalOptions): Promise<Uint8Array> {
    const gateways = this.rankGateways ? this.rankGateways([...this.gateways]) : shuffleArray(this.gateways);
    if (!gateways.length) {
      throw new Error(`Unable to fetch raw block for CID ${cid} because no gateways are configured`);
    }

    const parentAbort = new AbortController();
    const abortAll = () => parentAbort.abort();
    options.signal?.addEventListener("abort", abortAll);

    const requestControllers = gateways.map(() => new AbortController());
    const cleanups: Array<() => void> = [];

    const tasks = gateways.map((gateway, index) => {
      const signal = mergeAbortSignals(
        [options.signal, parentAbort.signal, requestControllers[index]?.signal],
        cleanups,
      );
      const startedAt = Date.now();

      return this.fetchAndValidate(gateway, cid, {
        signal,
        maxSize: options.maxSize ?? DEFAULT_MAX_SIZE,
        validateFn: options.validateFn,
      })
        .then((block) => ({
          gateway,
          block,
          durationMs: Date.now() - startedAt,
        }))
        .catch((error) => {
          this.onGatewayResult?.({
            gateway,
            cid: cid.toString(),
            durationMs: Date.now() - startedAt,
            ok: false,
            aborted: isAbortLikeError(error),
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        });
    });

    try {
      const winner = await Promise.any(tasks);
      parentAbort.abort();
      for (const controller of requestControllers) controller.abort();
      this.onGatewayResult?.({
        gateway: winner.gateway,
        cid: cid.toString(),
        durationMs: winner.durationMs,
        ok: true,
        winner: true,
      });
      return winner.block;
    } catch (error) {
      if (error instanceof AggregateError) {
        throw new AggregateError(error.errors, `Unable to fetch raw block for CID ${cid} from any gateway`);
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abortAll);
      for (const cleanup of cleanups) cleanup();
    }
  }

  private async fetchAndValidate(
    gateway: string,
    cid: CID,
    options: {
      signal: AbortSignal;
      maxSize: number;
      validateFn?: (block: Uint8Array) => Promise<void>;
    },
  ): Promise<Uint8Array> {
    const url = new URL(gateway);
    url.pathname = `/ipfs/${cid.toString()}`;
    url.search = "?format=raw";

    this.log.trace("fetching %c from %s", cid, gateway);

    const response = await fetch(url.toString(), {
      signal: options.signal,
      headers: {
        Accept: "application/vnd.ipld.raw",
      },
      cache: this.requestCache,
    });

    if (!response.ok) {
      throw new Error(`Gateway ${gateway} returned ${response.status} ${response.statusText}`);
    }

    const block = await limitedResponse(response, options.maxSize, options.signal);
    await options.validateFn?.(block);
    return block;
  }
}

async function limitedResponse(response: Response, byteLimit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength != null) {
    const size = parseInt(contentLength, 10);
    if (Number.isFinite(size) && size > byteLimit) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Content-Length header (${size}) exceeds maxSize ${byteLimit}`);
    }
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not readable");

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      if (signal?.aborted === true) throw new Error("gateway_fetch_aborted");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > byteLimit) throw new Error(`Gateway payload exceeds maxSize ${byteLimit}`);
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => undefined).finally(() => {
      reader.releaseLock();
    });
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function mergeAbortSignals(
  signals: Array<AbortSignal | undefined>,
  cleanups: Array<() => void>,
): AbortSignal {
  const available = signals.filter((signal): signal is AbortSignal => signal != null);
  const controller = new AbortController();

  if (available.some((signal) => signal.aborted)) {
    controller.abort();
    return controller.signal;
  }

  const listeners = available.map((signal) => {
    const listener = () => controller.abort();
    signal.addEventListener("abort", listener);
    return () => signal.removeEventListener("abort", listener);
  });

  cleanups.push(() => {
    for (const cleanup of listeners) cleanup();
  });

  return controller.signal;
}

function isAbortLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /abort/i.test(message);
}
