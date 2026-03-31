import { afterEach, describe, expect, it, vi } from "vitest";

import { createDomainResolver } from "../src/resolver.js";

describe("LumenDomainResolver transport fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back from p2p to http when the p2p content attempt times out", async () => {
    const resolver = createDomainResolver({
      transport: "p2p",
      httpFallback: true,
      p2pAttemptTimeoutMs: 5,
      restEndpoint: "",
      restEndpoints: [],
      dnsModule: {
        async domain() {
          return null;
        },
      },
      gatewaysModule: {
        async gateways() {
          return [];
        },
      },
    });

    const runtime = resolver as any;
    const transports: string[] = [];
    runtime.getHelia = vi.fn(async (transport: string) => ({ transport }));

    const result = await runtime.withContentBackend(
      false,
      [],
      undefined,
      async (bundle: { transport: string }, signal?: AbortSignal) => {
        transports.push(bundle.transport);

        if (bundle.transport === "p2p") {
          await new Promise((resolve, reject) => {
            if (signal?.aborted) {
              reject(signal.reason ?? new Error("aborted"));
              return;
            }
            signal?.addEventListener("abort", () => {
              reject(signal.reason ?? new Error("aborted"));
            }, { once: true });
          });
        }

        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(transports).toEqual(["p2p", "http"]);

    await resolver.close();
  });
});
