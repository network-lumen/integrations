import { describe, expect, it } from "vitest";

import { RpcResilienceLayer } from "../src/rpcResilience.js";

describe("RpcResilienceLayer", () => {
  it("retries transient RPC failures and eventually succeeds", async () => {
    const rpc = new RpcResilienceLayer({
      timeoutMs: 100,
      maxAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2,
    });

    let attempts = 0;
    const result = await rpc.execute({
      endpoint: "https://rpc.example",
      method: "status",
      fn: async () => {
        attempts += 1;
        if (attempts < 2) {
          throw new Error("fetch failed");
        }
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(rpc.getHealth("https://rpc.example")).toMatchObject({
      successes: 1,
      failures: 1,
    });
  });

  it("opens the circuit breaker after repeated timeouts", async () => {
    const rpc = new RpcResilienceLayer({
      timeoutMs: 5,
      maxAttempts: 1,
      circuitBreakerThreshold: 2,
      circuitBreakerCooldownMs: 60_000,
    });

    const slowCall = () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 25));

    await expect(rpc.execute({
      endpoint: "https://rpc.example",
      method: "status",
      fn: slowCall,
    })).rejects.toThrow("timeout");

    await expect(rpc.execute({
      endpoint: "https://rpc.example",
      method: "status",
      fn: slowCall,
    })).rejects.toThrow("timeout");

    await expect(rpc.execute({
      endpoint: "https://rpc.example",
      method: "status",
      fn: async () => "never",
    })).rejects.toThrow("circuit");

    expect(rpc.getHealth("https://rpc.example")).toMatchObject({
      failures: 2,
      timeoutCount: 2,
      lastErrorKind: "timeout",
    });
  });
});
