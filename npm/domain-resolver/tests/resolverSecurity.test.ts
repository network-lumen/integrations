import { afterEach, describe, expect, it, vi } from "vitest";

import { createDomainResolver } from "../src/resolver.js";

const TEST_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

describe("LumenDomainResolver security modes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fails closed in proof mode when no RPC endpoint is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const resolver = createDomainResolver({
      dnsVerificationMode: "proof",
      restEndpoint: "https://rest.example",
    });

    await expect(resolver.resolveDomain("cosmos.directory")).rejects.toThrow("proof verification");
    expect(fetchSpy).not.toHaveBeenCalled();
    await resolver.close();
  });

  it("downgrades explicitly in auto mode and exposes metadata in the result", async () => {
    const events: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        domain: {
          index: "cosmos.directory",
          cid: TEST_CID,
          records: [],
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    ));

    const resolver = createDomainResolver({
      dnsVerificationMode: "auto",
      restEndpoint: "https://rest.example",
      onEvent(event) {
        events.push(event.type);
      },
    });

    const result = await resolver.resolveDomain("cosmos.directory");

    expect(result.security).toMatchObject({
      mode: "auto",
      source: "rest",
      verified: false,
      downgraded: true,
      unsafe: true,
    });
    expect(events).toContain("security_downgrade");
    expect(events).toContain("dns_verify_fallback");
    expect(resolver.getResolverStatus().fallbackRate).toBeGreaterThan(0);

    await resolver.close();
  });
});
