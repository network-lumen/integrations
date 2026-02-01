import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { DnsModule } from "../src/modules/dns.js";
import { GatewaysModule } from "../src/modules/gateways.js";
import { ReleasesModule } from "../src/modules/releases.js";
import { TokenomicsModule } from "../src/modules/tokenomics.js";
import { GovModule } from "../src/modules/gov.js";
import { LumenSDK } from "../src/sdk.js";
import { joinRest, withQuery } from "../src/rest.js";
import type { Release } from "../src/types/lumen/release/v1/types.js";
import { Release_ReleaseStatus } from "../src/types/lumen/release/v1/types.js";
import { VoteOption } from "cosmjs-types/cosmos/gov/v1/gov.js";

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

  it("params exposes update_fee_ulmn", async () => {
    fetchMock = setupFetchMock({ params: { update_fee_ulmn: "42" } });
    const res = await module.params();
    expect(res.params.update_fee_ulmn).toBe("42");
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

  it("msgUpdateSlashingDowntimeParams", () => {
    const module = new TokenomicsModule();
    const msg = module.msgUpdateSlashingDowntimeParams("authority", "0.02", "600s");
    expect(msg.typeUrl).toBe("/lumen.tokenomics.v1.MsgUpdateSlashingDowntimeParams");
    expect(msg.value.authority).toBe("authority");
    expect(msg.value.slashFractionDowntime).toBe("0.02");
    expect(msg.value.downtimeJailDuration).toBe("600s");
  });

  it("msgUpdateSlashingLivenessParams", () => {
    const module = new TokenomicsModule();
    const msg = module.msgUpdateSlashingLivenessParams("authority", 123, "0.9");
    expect(msg.typeUrl).toBe("/lumen.tokenomics.v1.MsgUpdateSlashingLivenessParams");
    expect(msg.value.authority).toBe("authority");
    expect(msg.value.signedBlocksWindow).toBe(123);
    expect(msg.value.minSignedPerWindow).toBe("0.9");
  });
});

describe("GovModule", () => {
  it("params default set", async () => {
    const module = new GovModule(REST);
    const fetchMock = setupFetchMock({ params: { voting_period: "60s" } });
    await module.params();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:2327/cosmos/gov/v1/params",
      expect.any(Object),
    );
  });

  it("proposals builds query", async () => {
    const module = new GovModule(REST);
    const fetchMock = setupFetchMock({});
    await module.proposals({ status: "PROPOSAL_STATUS_VOTING_PERIOD", limit: 5 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:2327/cosmos/gov/v1/proposals?pagination.limit=5&proposal_status=PROPOSAL_STATUS_VOTING_PERIOD",
      expect.any(Object),
    );
  });

  it("msgSubmitProposal wraps fields", () => {
    const module = new GovModule();
    const msg = module.msgSubmitProposal("addr", {
      messages: [],
      title: "title",
      summary: "summary",
      initialDeposit: [{ denom: "ulmn", amount: "10" }],
    });
    expect(msg.typeUrl).toBe("/cosmos.gov.v1.MsgSubmitProposal");
    expect(msg.value.title).toBe("title");
    expect(msg.value.initialDeposit[0].amount).toBe("10");
  });

  it("msgVote composes numbers", () => {
    const module = new GovModule();
    const msg = module.msgVote("addr", { proposalId: 12, option: VoteOption.VOTE_OPTION_YES });
    expect(msg.value.proposalId).toBe(12n);
    expect(msg.value.option).toBe(VoteOption.VOTE_OPTION_YES);
  });
});

describe("LumenSDK tokenomics helpers", () => {
  it("updateSlashingDowntimeParams delegates to module + broadcast", async () => {
    const tokenomics = {
      msgUpdateSlashingDowntimeParams: vi.fn(() => ({ typeUrl: "t", value: {} })),
    };
    const signAndBroadcast = vi.fn(async () => ({ transactionHash: "hash" }));
    const client = {
      tokenomics: () => tokenomics,
      signAndBroadcast,
    } as any;

    const sdk = new LumenSDK(client);
    await sdk.updateSlashingDowntimeParams("auth", {
      slashFractionDowntime: "0.02",
      downtimeJailDuration: "600s",
    });

    expect(tokenomics.msgUpdateSlashingDowntimeParams).toHaveBeenCalledWith(
      "auth",
      "0.02",
      "600s",
    );
    expect(signAndBroadcast).toHaveBeenCalledWith("auth", [{ typeUrl: "t", value: {} }]);
  });
});
