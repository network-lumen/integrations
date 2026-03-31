import { afterEach, describe, expect, it, vi } from "vitest";
import { CID } from "multiformats/cid";

import { createParallelGatewayBroker } from "../src/parallelGatewayBroker.js";

const TEST_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

describe("createParallelGatewayBroker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns the fastest successful gateway even when it is listed second", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const gatewayEvents: Array<{ gateway: string; ok: boolean; winner?: boolean; aborted?: boolean }> = [];

    vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const isSlow = url.includes("slow.example");
      const payload = isSlow ? Uint8Array.from([1, 1, 1]) : Uint8Array.from([9, 9, 9]);

      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(new Response(payload, {
            status: 200,
            headers: {
              "content-length": String(payload.byteLength),
            },
          }));
        }, isSlow ? 40 : 5);

        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("gateway_fetch_aborted"));
        });
      });
    }));

    const brokerFactory = createParallelGatewayBroker({
      gateways: ["https://slow.example", "https://fast.example"],
      onGatewayResult: (event) => {
        gatewayEvents.push({
          gateway: event.gateway,
          ok: event.ok,
          winner: event.winner,
          aborted: event.aborted,
        });
      },
    });
    const broker = brokerFactory({
      logger: {
        forComponent: () => ({
          trace: () => undefined,
        }),
      } as any,
    });

    const bytes = await broker.retrieve!(CID.parse(TEST_CID), {
      validateFn: async () => undefined,
    });

    expect(bytes).toEqual(Uint8Array.from([9, 9, 9]));
    expect(gatewayEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        gateway: "https://fast.example",
        ok: true,
        winner: true,
      }),
      expect.objectContaining({
        gateway: "https://slow.example",
        ok: false,
        aborted: true,
      }),
    ]));
  });
});
