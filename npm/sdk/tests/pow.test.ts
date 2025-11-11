import { describe, expect, it } from "vitest";

import { computePowDigest, computePowNonce, leadingZeroBits } from "../src/pqc/pow.js";

describe("pqc pow helpers", () => {
  it("returns sentinel nonce when difficulty is zero", () => {
    const nonce = computePowNonce(new Uint8Array([1, 2, 3]), 0);
    expect(Array.from(nonce)).toEqual([0]);
  });

  it("finds a nonce satisfying the requested difficulty", () => {
    const pubKey = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const nonce = computePowNonce(pubKey, 8, { maxIterations: 1_000_000 });
    const digest = computePowDigest(pubKey, nonce);
    expect(leadingZeroBits(digest)).toBeGreaterThanOrEqual(8);
  });
});
