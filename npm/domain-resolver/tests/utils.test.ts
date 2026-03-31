import { describe, expect, it } from "vitest";

import {
  extractGatewayCandidates,
  mergePaths,
  parseRecordTarget,
  pickTargetFromDomainInfo,
} from "../src/utils.js";

const FILE_CID = "bafyreidykglsfhoixmivffc5uwhcgshx4j465xwqntbmu43nb2dzqwfvae";
const OTHER_CID = "bafybeigdyrzt3x4m6sl7pgnx2lz6w4vl6z6is3cl4ohq4rj5sp7q5c6d5e";

describe("parseRecordTarget", () => {
  it("parses lumen ipfs targets with a base path", () => {
    expect(parseRecordTarget(`lumen://ipfs/${FILE_CID}/registry/v1/`)).toEqual({
      proto: "ipfs",
      id: FILE_CID,
      basePath: "/registry/v1",
    });
  });
});

describe("pickTargetFromDomainInfo", () => {
  it("prefers the requested subdomain record when present", () => {
    const info = {
      records: [
        { key: "website", value: `ipfs://${OTHER_CID}` },
        { key: "lumen", value: `ipfs://${FILE_CID}/chain-registry` },
      ],
    };

    expect(pickTargetFromDomainInfo(info, "lumen")).toEqual({
      target: {
        proto: "ipfs",
        id: FILE_CID,
        basePath: "/chain-registry",
      },
      source: "record:lumen",
    });
  });
});

describe("mergePaths", () => {
  it("joins base path and request path once", () => {
    expect(mergePaths("/registry", "/cosmoshub", "chain.json")).toBe("/registry/cosmoshub/chain.json");
  });
});

describe("extractGatewayCandidates", () => {
  it("extracts urls from gateway metadata", () => {
    const gateways = extractGatewayCandidates({
      gateways: [
        {
          id: 7,
          metadata: JSON.stringify({ endpoint: "gw-1.example.com" }),
        },
      ],
    }, "onchain");

    expect(gateways).toEqual([
      {
        url: "https://gw-1.example.com",
        source: "onchain",
        gatewayId: "7",
        endpoint: "gw-1.example.com",
        active: undefined,
        metadata: { endpoint: "gw-1.example.com" },
      },
    ]);
  });
});
