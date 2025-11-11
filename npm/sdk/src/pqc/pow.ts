import { sha256 } from "@noble/hashes/sha256";

export interface PowOptions {
  /** Override nonce byte length (default 8). */
  nonceLength?: number;
  /** Maximum iterations before aborting (default: unlimited). */
  maxIterations?: number;
  /** Abort controller signal for cancelling long runs. */
  signal?: AbortSignal;
}

/**
 * Returns the SHA-256 digest of `pubKey || nonce`.
 */
export function computePowDigest(pubKey: Uint8Array, nonce: Uint8Array): Uint8Array {
  const payload = new Uint8Array(pubKey.length + nonce.length);
  payload.set(pubKey, 0);
  payload.set(nonce, pubKey.length);
  return sha256(payload);
}

/**
 * Counts the number of most-significant zero bits in the provided digest.
 */
export function leadingZeroBits(digest: Uint8Array): number {
  let total = 0;
  for (const byte of digest) {
    if (byte === 0) {
      total += 8;
      continue;
    }
    for (let bit = 7; bit >= 0; bit--) {
      if (((byte >> bit) & 0x1) === 0) {
        total += 1;
      } else {
        return total;
      }
    }
    return total;
  }
  return total;
}

/**
 * Mines a nonce so that `sha256(pubKey || nonce)` has at least `bits`
 * leading zero bits. Throws if `maxIterations` is reached.
 */
export function computePowNonce(pubKey: Uint8Array, bits: number, options: PowOptions = {}): Uint8Array {
  if (bits <= 0) return new Uint8Array([0]);

  const nonceLength = options.nonceLength ?? 8;
  const nonce = new Uint8Array(nonceLength);
  const maxIterations = BigInt(options.maxIterations ?? Number.MAX_SAFE_INTEGER);

  for (let attempts = 0n; attempts < maxIterations; attempts++) {
    if (options.signal?.aborted) {
      throw new Error("pow cancelled");
    }

    writeCounterBigEndian(nonce, attempts);
    const digest = computePowDigest(pubKey, nonce);
    if (leadingZeroBits(digest) >= bits) {
      return nonce.slice();
    }
  }

  throw new Error(`failed to find pow nonce after ${maxIterations} attempts (difficulty=${bits})`);
}

function writeCounterBigEndian(buf: Uint8Array, counter: bigint) {
  let value = counter;
  for (let i = buf.length - 1; i >= 0; i--) {
    buf[i] = Number(value & 0xffn);
    value >>= 8n;
  }
}
