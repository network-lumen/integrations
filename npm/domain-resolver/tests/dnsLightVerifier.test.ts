import { describe, expect, it } from "vitest";

import {
  LumenDnsLightVerifier,
  computeHeaderHash,
  verifyCommitQuorum,
  verifyDomainProofChain,
} from "../src/dnsLightVerifier.js";

function dnsStatus(overrides: Partial<{
  chainId: string;
  latestHeight: number;
}> = {}) {
  return {
    chainId: overrides.chainId ?? "lumen-1",
    latestHeight: overrides.latestHeight ?? 50,
    latestBlockHash: new Uint8Array(32),
    latestAppHash: new Uint8Array(32),
    expiresAt: Date.now() + 1_000,
  };
}

describe("LumenDnsLightVerifier hardening", () => {
  it("rejects invalid IAVL proof paths before decoding", () => {
    const expectedStoreKey = new TextEncoder().encode("domain/value/cosmos.directory");

    expect(() => verifyDomainProofChain({
      key: expectedStoreKey,
      value: new Uint8Array([1]),
      proof: {
        ops: [
          { key: new TextEncoder().encode("domain/value/other"), data: new Uint8Array(), type: "iavl" },
          { key: new TextEncoder().encode("dns"), data: new Uint8Array(), type: "store" },
        ],
      },
      codespace: "",
      info: "",
    } as any, expectedStoreKey, new Uint8Array(32))).toThrow("IAVL proof key");
  });

  it("rejects corrupted ICS23 proof payloads", () => {
    const expectedStoreKey = new TextEncoder().encode("domain/value/cosmos.directory");

    expect(() => verifyDomainProofChain({
      key: expectedStoreKey,
      value: new Uint8Array([1]),
      proof: {
        ops: [
          { key: expectedStoreKey, data: Uint8Array.from([0xff]), type: "iavl" },
          { key: new TextEncoder().encode("dns"), data: Uint8Array.from([0xff]), type: "store" },
        ],
      },
      codespace: "",
      info: "",
    } as any, expectedStoreKey, new Uint8Array(32))).toThrow();
  });

  it("rejects insufficient commit quorum", async () => {
    const header = {
      version: { block: 11, app: 1 },
      chainId: "lumen-1",
      height: 9,
      time: new Date("2026-01-01T00:00:00Z"),
      lastBlockId: {
        hash: new Uint8Array(32),
        parts: { total: 1, hash: new Uint8Array(32) },
      },
      lastCommitHash: new Uint8Array(32),
      dataHash: new Uint8Array(32),
      validatorsHash: new Uint8Array(32),
      nextValidatorsHash: new Uint8Array(32),
      consensusHash: new Uint8Array(32),
      appHash: new Uint8Array(32),
      lastResultsHash: new Uint8Array(32),
      evidenceHash: new Uint8Array(32),
      proposerAddress: new Uint8Array(20),
    } as any;

    await expect(verifyCommitQuorum({
      header,
      commit: {
        height: 9,
        round: 0,
        blockId: {
          hash: await computeHeaderHash(header),
          parts: { total: 1, hash: new Uint8Array(32) },
        },
        signatures: [{
          blockIdFlag: 1,
          validatorAddress: undefined,
          timestamp: undefined,
          signature: undefined,
        }],
      },
    } as any, [{
      address: new Uint8Array(20),
      votingPower: 10n,
    }] as any)).rejects.toThrow("Insufficient signed voting power");
  });

  it("marks stale checkpoints and filters them out", () => {
    const events: string[] = [];
    const verifier = new LumenDnsLightVerifier({
      rpcEndpoints: ["https://rpc.example"],
      timeoutMs: 100,
      trustOptions: {
        checkpoints: [{
          height: 1,
          blockHash: "aa".repeat(32),
          chainId: "lumen-1",
          trustedAt: Date.now() - 10_000,
        }],
        maxDriftBlocks: 5,
        trustingPeriodMs: 1_000,
      },
      observer: (type) => events.push(type),
    });

    const usable = (verifier as any).pickUsableCheckpoints(dnsStatus({ latestHeight: 100 }));
    expect(usable).toEqual([]);
    expect(events).toContain("dns_checkpoint_stale");
  });

  it("rejects chain ID mismatches", () => {
    const verifier = new LumenDnsLightVerifier({
      rpcEndpoints: ["https://rpc.example"],
      timeoutMs: 100,
      trustOptions: {
        expectedChainId: "lumen-1",
      },
    });

    expect(() => (verifier as any).validateExpectedChainId("evil-1", "https://rpc.example", 99)).toThrow("Chain ID mismatch");
  });

  it("rejects replayed headers and invalid validator transitions", () => {
    const verifier = new LumenDnsLightVerifier({
      rpcEndpoints: ["https://rpc.example"],
      timeoutMs: 100,
    });

    (verifier as any).lastVerifiedHeader = {
      endpoint: "https://rpc.example",
      chainId: "lumen-1",
      height: 10,
      latestHeight: 10,
      headerHash: "11".repeat(32),
      commitBlockHash: "11".repeat(32),
      appHash: "22".repeat(32),
      validatorsHash: "33".repeat(32),
      nextValidatorsHash: "44".repeat(32),
      totalVotingPower: "100",
      signedVotingPower: "100",
      verifiedAt: Date.now(),
    };

    expect(() => (verifier as any).validateHeaderTransition({
      header: { chainId: "lumen-1", height: 9 },
      commit: { blockId: { hash: new Uint8Array(32) } },
    }, new Uint8Array(32))).toThrow("Replay attack");

    expect(() => (verifier as any).validateHeaderTransition({
      header: { chainId: "lumen-1", height: 11 },
      commit: { blockId: { hash: new Uint8Array(32) } },
    }, Uint8Array.from({ length: 32 }, () => 0x99))).toThrow("Invalid validator transition");
  });

  it("detects conflicting RPC proof responses in majority mode", async () => {
    const verifier = new LumenDnsLightVerifier({
      rpcEndpoints: ["https://rpc-1.example", "https://rpc-2.example"],
      timeoutMs: 100,
    });

    (verifier as any).queryDomainFromEndpoint = async (endpoint: string) => ({
      endpoint,
      normalized: endpoint.includes("1") ? "a" : "b",
      value: {
        endpoint,
        chainId: "lumen-1",
        height: 1,
        anchorHeight: 2,
        latestHeight: 2,
        domain: { index: "cosmos.directory" },
        appHashHex: "aa",
        headerHashHex: "bb",
        commitBlockHashHex: "bb",
        storeRootHex: "cc",
        validatorsHashHex: "dd",
        nextValidatorsHashHex: "ee",
        totalVotingPower: "100",
        signedVotingPower: "100",
      },
    });

    await expect(verifier.queryDomain("cosmos.directory", "majority")).rejects.toThrow("Inconsistent DNS proof state");
  });
});
