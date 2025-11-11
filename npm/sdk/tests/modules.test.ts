import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { DnsModule } from "../src/modules/dns.js";
import { GatewaysModule } from "../src/modules/gateways.js";
import { ReleasesModule } from "../src/modules/releases.js";
import { TokenomicsModule } from "../src/modules/tokenomics.js";
import { joinRest, withQuery } from "../src/rest.js";
import type { Release } from "../src/types/lumen/release/v1/types.js";
import { Release_ReleaseStatus } from "../src/types/lumen/release/v1/types.js";

const REST = "http://localhost:2327";

function setupFetchMock(payload: any = {}) {
  const mock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
  globalThis.fetch = mock;
  return mock;
}

describe("rest helpers", () => {
  it("joinRest trims slashes", () => {
    expect(joinRest("http://host/api/", "/foo")).toBe("http://host/api/foo");
    expect(joinRest("http://host/api", "foo")).toBe("http://host/api/foo");
  });

  it("withQuery appends encoded params", () => {
    const url = withQuery("http://h/path", { a: 1, b: "ok", c: undefined });
    expect(url).toBe("http://h/path?a=1&b=ok");
  });
});

describe("DnsModule", () => {
  let module: DnsModule;
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    module = new DnsModule(REST);
    fetchMock = setupFetchMock({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolve builds encoded path", async () => {
    await module.resolve("foo", "bar");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:2327/lumen/dns/v1/resolve/foo/bar/-/0/-",
      expect.any(Object),
    );
  });

  it("domains adds query params", async () => {
    await module.domains({ pageKey: "abc", limit: 5 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:2327/lumen/dns/v1/domain?pagination.key=abc&pagination.limit=5",
      expect.any(Object),
    );
  });

  it("msgRegister encodes payload", () => {
    const msg = module.msgRegister("addr", { domain: "foo", ext: "bar", durationDays: 10 });
    expect(msg.typeUrl).toBe("/lumen.dns.v1.MsgRegister");
    expect(msg.value.domain).toBe("foo");
    expect(msg.value.durationDays).toBe(10);
  });

  it("msgCreateAuction sets defaults", () => {
    const msg = module.msgCreateAuction("addr", {
      index: "foo.lmn",
      name: "foo.lmn",
      start: 1,
      end: 2,
    });
    expect(msg.value.start).toBe(1);
    expect(msg.value.end).toBe(2);
    expect(msg.value.highestBid).toBe("");
  });
});

describe("GatewaysModule", () => {
  let module: GatewaysModule;
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    module = new GatewaysModule(REST);
    fetchMock = setupFetchMock({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gateways query", async () => {
    await module.gateways({ offset: 1, limit: 2 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:2327/lumen/gateway/v1/gateways?offset=1&limit=2",
      expect.any(Object),
    );
  });

  it("msgCreateContract coerces numbers", () => {
    const msg = module.msgCreateContract("addr", {
      gatewayId: "5",
      priceUlmn: "2000",
      storageGbPerMonth: "10",
      networkGbPerMonth: "2",
      monthsTotal: "3",
    });
    expect(msg.value.gatewayId).toBe(5);
    expect(msg.value.monthsTotal).toBe(3);
  });
});

describe("ReleasesModule", () => {
  let module: ReleasesModule;
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    module = new ReleasesModule(REST);
    fetchMock = setupFetchMock({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("latest endpoint", async () => {
    await module.latest();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:2327/lumen/release/latest",
      expect.any(Object),
    );
  });

  it("msgPublishRelease wires payload", () => {
    const release: Release = {
      id: 0,
      version: "1.0.0",
      channel: "stable",
      artifacts: [],
      publisher: "lmn1publisheraddressxxxxxxxxxxxxxxxxxxxxx",
      notes: "test",
      createdAt: 0,
      yanked: false,
      supersedes: [],
      status: Release_ReleaseStatus.PENDING,
      emergencyOk: false,
      emergencyUntil: 0,
    };
    const msg = module.msgPublishRelease("addr", release);
    expect(msg.value.release?.version).toBe("1.0.0");
  });
});

describe("TokenomicsModule", () => {
  it("params query", async () => {
    const module = new TokenomicsModule(REST);
    const fetchMock = setupFetchMock({ params: {} });
    await module.params();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:2327/lumen/tokenomics/v1/params",
      expect.any(Object),
    );
  });

  it("msgUpdateParams", () => {
    const module = new TokenomicsModule();
    const msg = module.msgUpdateParams("authority", { txTaxRate: "0.01" } as any);
    expect(msg.typeUrl).toBe("/lumen.tokenomics.v1.MsgUpdateParams");
    expect(msg.value.authority).toBe("authority");
  });
});
