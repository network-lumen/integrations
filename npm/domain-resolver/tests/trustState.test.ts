import { describe, expect, it } from "vitest";

import { createMemoryCacheStore } from "../src/cache.js";
import { PersistentTrustStateStore } from "../src/trustState.js";

describe("PersistentTrustStateStore", () => {
  it("persists and reloads trust state with checksum validation", async () => {
    const cache = createMemoryCacheStore();
    const store = new PersistentTrustStateStore(cache, "resolver");

    await store.save({
      version: 2,
      updatedAt: Date.now(),
      lastVerifiedHeader: {
        endpoint: "https://rpc.example",
        chainId: "lumen-1",
        height: 123,
        latestHeight: 123,
        headerHash: "aa".repeat(32),
        commitBlockHash: "bb".repeat(32),
        appHash: "cc".repeat(32),
        validatorsHash: "dd".repeat(32),
        nextValidatorsHash: "ee".repeat(32),
        totalVotingPower: "100",
        signedVotingPower: "100",
        verifiedAt: Date.now(),
      },
      rpcHealth: [{
        endpoint: "https://rpc.example",
        successes: 1,
        failures: 0,
        timeoutCount: 0,
        proofFailureCount: 0,
        consensusMismatchCount: 0,
        failureScore: 0,
      }],
    });

    await expect(store.load()).resolves.toMatchObject({
      version: 2,
      lastVerifiedHeader: {
        chainId: "lumen-1",
        height: 123,
      },
      rpcHealth: [{
        endpoint: "https://rpc.example",
        successes: 1,
      }],
    });
  });

  it("rejects corrupted cached trust state", async () => {
    const cache = createMemoryCacheStore();
    const store = new PersistentTrustStateStore(cache, "resolver");

    await cache.set("resolver:trust_state", "state", {
      key: "state",
      value: {
        version: 1,
        checksum: "deadbeef",
        payload: {
          version: 2,
          updatedAt: Date.now(),
        },
      },
      lastAccessedAt: Date.now(),
      sizeBytes: 128,
    });

    await expect(store.load()).rejects.toThrow("checksum");
  });
});
