import { describe, expect, it } from "vitest";

import { createMemoryCacheStore, makeCacheRecord } from "../src/cache.js";

describe("MemoryResolverCacheStore", () => {
  it("stores, loads, and lists cached records", async () => {
    const store = createMemoryCacheStore();
    const record = makeCacheRecord("domain:lumen.cosmos.directory", {
      cid: "bafybeigdyrzt3x4m6sl7pgnx2lz6w4vl6z6is3cl4ohq4rj5sp7q5c6d5e",
    }, {
      expiresAt: 123_456,
      lastAccessedAt: 111_222,
      sizeBytes: 48,
    });

    await store.set("resolver:domain", record.key, record);

    await expect(store.get("resolver:domain", record.key)).resolves.toEqual(record);
    await expect(store.list("resolver:domain")).resolves.toEqual([
      {
        key: record.key,
        expiresAt: 123_456,
        lastAccessedAt: 111_222,
        sizeBytes: 48,
      },
    ]);
  });
});
