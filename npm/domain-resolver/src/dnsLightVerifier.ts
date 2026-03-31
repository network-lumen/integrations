import { ics23, iavlSpec, tendermintSpec, verifyMembership, verifyNonMembership } from "@confio/ics23";
import { Ed25519 } from "@cosmjs/crypto";
import { Tendermint37Client, pubkeyToRawAddress, type AbciQueryResponse, type CommitResponse, type Validator } from "@cosmjs/tendermint-rpc";
import { Timestamp as ProtoTimestamp } from "cosmjs-types/google/protobuf/timestamp.js";
import { PublicKey as TendermintPublicKey } from "cosmjs-types/tendermint/crypto/keys.js";
import { SimpleValidator as TendermintSimpleValidator } from "cosmjs-types/tendermint/types/validator.js";
import { BlockID as ProtoBlockId } from "cosmjs-types/tendermint/types/types.js";
import { Consensus as ProtoConsensusVersion } from "cosmjs-types/tendermint/version/types.js";
import protobuf from "protobufjs";

import type {
  ChainConsistencyMode,
  DnsTrustedCheckpoint,
  DomainInfoLike,
  PersistedResolverTrustState,
  ResolverEvent,
  ResolverMetricsSnapshot,
  RpcEndpointHealth,
  TrustOptions,
  TrustedCheckpoint,
  VerifiedHeaderSnapshot,
  VerifiedValidatorSetSnapshot,
} from "./types.js";
import { RpcRequestError, RpcResilienceLayer } from "./rpcResilience.js";
import { trimTrailingSlash } from "./utils.js";

const DNS_STORE_NAME = "dns";
const DNS_DOMAIN_PREFIX = "domain/value/";
const PRECOMMIT_TYPE = 2;
const BLOCK_ID_FLAG_ABSENT = 1;
const BLOCK_ID_FLAG_COMMIT = 2;
const BLOCK_ID_FLAG_NIL = 3;
const DEFAULT_STATUS_CACHE_TTL_MS = 1_500;
const DEFAULT_VERIFIED_HEADER_CACHE_SIZE = 64;

type DnsVerifierEventType = Extract<
  ResolverEvent["type"],
  | "rpc_query"
  | "dns_verified"
  | "dns_verify_failed"
  | "dns_checkpoint_verified"
  | "dns_checkpoint_stale"
  | "dns_header_cache_hit"
  | "dns_status_cache_hit"
  | "dns_rpc_error"
  | "dns_timeout"
>;
type DnsVerifierObserver = (type: DnsVerifierEventType, data: Record<string, unknown>) => void;

export type VerifiedDomainResult = {
  endpoint: string;
  chainId: string;
  height: number;
  anchorHeight: number;
  latestHeight: number;
  domain: DomainInfoLike | null;
  appHashHex: string;
  headerHashHex: string;
  commitBlockHashHex: string;
  storeRootHex: string;
  validatorsHashHex: string;
  nextValidatorsHashHex: string;
  totalVotingPower: string;
  signedVotingPower: string;
};

type QueryResult = {
  endpoint: string;
  value: VerifiedDomainResult;
  normalized: string;
};

type TimestampLike = Date & {
  nanoseconds?: number;
};

type BlockIdLike = {
  hash: Uint8Array;
  parts: {
    total: number;
    hash: Uint8Array;
  };
};

type DecodedRecord = {
  key: string;
  value: string;
  ttl: string;
};

type DecodedDomain = {
  index?: string;
  name?: string;
  owner?: string;
  creator?: string;
  expire_at?: string;
  records?: DecodedRecord[];
};

type NormalizedTrustedCheckpoint = {
  height: number;
  blockHashHex: string;
  chainId: string;
  trustedAt: number;
};

type StatusCacheEntry = {
  chainId: string;
  latestHeight: number;
  latestBlockHash: Uint8Array;
  latestAppHash: Uint8Array;
  expiresAt: number;
};

type VerifiedAnchorState = {
  endpoint: string;
  chainId: string;
  height: number;
  latestHeight: number;
  validatorCount: number;
  appHash: Uint8Array;
  headerHash: Uint8Array;
  commitBlockHash: Uint8Array;
  validatorsHash: Uint8Array;
  nextValidatorsHash: Uint8Array;
  totalVotingPower: bigint;
  signedVotingPower: bigint;
};

type VerifierRuntimeStatus = {
  lastVerifiedHeight: number;
  checkpointAge: number;
};

const canonicalProtoRoot = protobuf.Root.fromJSON({
  nested: {
    google: {
      nested: {
        protobuf: {
          nested: {
            Timestamp: {
              fields: {
                seconds: { type: "int64", id: 1 },
                nanos: { type: "int32", id: 2 },
              },
            },
          },
        },
      },
    },
    tendermint: {
      nested: {
        types: {
          nested: {
            CanonicalPartSetHeader: {
              fields: {
                total: { type: "uint32", id: 1 },
                hash: { type: "bytes", id: 2 },
              },
            },
            CanonicalBlockID: {
              fields: {
                hash: { type: "bytes", id: 1 },
                part_set_header: { type: "CanonicalPartSetHeader", id: 2 },
              },
            },
            CanonicalVote: {
              fields: {
                type: { type: "int32", id: 1 },
                height: { type: "sfixed64", id: 2 },
                round: { type: "sfixed64", id: 3 },
                block_id: { type: "CanonicalBlockID", id: 4 },
                timestamp: { type: "google.protobuf.Timestamp", id: 5 },
                chain_id: { type: "string", id: 6 },
              },
            },
          },
        },
      },
    },
  },
});

const CanonicalVoteType = canonicalProtoRoot.lookupType("tendermint.types.CanonicalVote");

function now(): number {
  return Date.now();
}

function normalizeRpcEndpoints(inputs: Array<string | URL>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const input of inputs) {
    const value = trimTrailingSlash(String(input || "").trim());
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }

  return out;
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableNormalize(entry));

  if (
    value != null &&
    typeof value === "object" &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer)
  ) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableNormalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }

  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

function normalizeDomainForConsensus(info: DomainInfoLike | null): unknown {
  if (!info) return null;
  const records = Array.isArray(info.records)
    ? [...info.records]
        .map((entry) => stableNormalize(entry) as Record<string, unknown>)
        .sort((left, right) => {
          const leftKey = `${String(left.key ?? "")}\u0000${String(left.value ?? "")}`;
          const rightKey = `${String(right.key ?? "")}\u0000${String(right.value ?? "")}`;
          return leftKey.localeCompare(rightKey);
        })
    : undefined;

  return stableNormalize({
    ...info,
    ...(records ? { records } : {}),
  });
}

function encodeUtf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function decodeUtf8(input: Uint8Array): string {
  return new TextDecoder().decode(input);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function toOwnedBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(input) as Uint8Array<ArrayBuffer>;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function bytesToHex(input: Uint8Array): string {
  return Array.from(input, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(input: string): Uint8Array {
  const normalized = input.trim().replace(/^0x/i, "").toLowerCase();
  if (!normalized || normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) {
    throw new Error("Expected a hex string");
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    out[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return out;
}

function normalizeCheckpointHash(input: string | Uint8Array): string {
  if (typeof input !== "string") return bytesToHex(input).toLowerCase();
  const normalized = input.trim().replace(/^0x/i, "").toLowerCase();
  if (!normalized || normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) {
    throw new Error("dnsTrustedCheckpoint.blockHash must be a hex string or Uint8Array");
  }
  return normalized;
}

function normalizeTrustedCheckpoint(checkpoint: TrustedCheckpoint): NormalizedTrustedCheckpoint {
  const height = Math.trunc(Number(checkpoint.height));
  if (!(height > 0)) {
    throw new Error("trustOptions.checkpoints[].height must be a positive integer");
  }
  const chainId = String(checkpoint.chainId || "").trim();
  if (!chainId) {
    throw new Error("trustOptions.checkpoints[].chainId is required");
  }
  const trustedAt = Math.trunc(Number(checkpoint.trustedAt));
  if (!(trustedAt > 0)) {
    throw new Error("trustOptions.checkpoints[].trustedAt must be a unix timestamp in milliseconds");
  }

  return {
    height,
    blockHashHex: normalizeCheckpointHash(checkpoint.blockHash),
    chainId,
    trustedAt,
  };
}

function normalizeTrustOptions(
  trustOptions?: TrustOptions,
  legacyCheckpoint?: DnsTrustedCheckpoint,
): {
  checkpoints: NormalizedTrustedCheckpoint[];
  maxDriftBlocks: number;
  requireChainIdMatch: boolean;
  trustingPeriodMs?: number;
  expectedChainId?: string;
} {
  const checkpoints = [
    ...(trustOptions?.checkpoints ?? []),
    ...(legacyCheckpoint ? [legacyCheckpoint] : []),
  ].map((checkpoint) => normalizeTrustedCheckpoint(checkpoint));

  return {
    checkpoints,
    maxDriftBlocks: Math.max(0, Math.trunc(Number(trustOptions?.maxDriftBlocks ?? 100_000))),
    requireChainIdMatch: trustOptions?.requireChainIdMatch ?? true,
    ...(trustOptions?.trustingPeriodMs != null
      ? { trustingPeriodMs: Math.max(1, Math.trunc(Number(trustOptions.trustingPeriodMs))) }
      : {}),
    ...(trustOptions?.expectedChainId
      ? { expectedChainId: String(trustOptions.expectedChainId).trim() }
      : {}),
  };
}

function encodeUvarint(value: number | bigint): Uint8Array {
  let current = typeof value === "bigint" ? value : BigInt(value);
  if (current < 0n) throw new Error("uvarint cannot encode negative values");

  const out: number[] = [];
  while (current >= 0x80n) {
    out.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }
  out.push(Number(current));
  return Uint8Array.from(out);
}

function encodeTag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeUvarint((fieldNumber << 3) | wireType);
}

function encodeVarintField(fieldNumber: number, value: number | bigint): Uint8Array {
  return concatBytes(encodeTag(fieldNumber, 0), encodeUvarint(value));
}

function encodeSfixed64Field(fieldNumber: number, value: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setBigInt64(0, typeof value === "bigint" ? value : BigInt(value), true);
  return concatBytes(encodeTag(fieldNumber, 1), out);
}

function encodeBytesField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return concatBytes(encodeTag(fieldNumber, 2), encodeUvarint(value.byteLength), value);
}

function encodeStringField(fieldNumber: number, value: string): Uint8Array {
  return encodeBytesField(fieldNumber, encodeUtf8(value));
}

function encodeMessageField(fieldNumber: number, value: Uint8Array | null): Uint8Array {
  if (!value || value.byteLength === 0) return new Uint8Array();
  return concatBytes(encodeTag(fieldNumber, 2), encodeUvarint(value.byteLength), value);
}

function encodeVersionMessage(version: { block: number; app: number }): Uint8Array {
  return concatBytes(
    version.block ? encodeVarintField(1, version.block) : new Uint8Array(),
    version.app ? encodeVarintField(2, version.app) : new Uint8Array(),
  );
}

function encodePartSetHeaderMessage(parts: { total: number; hash: Uint8Array }): Uint8Array {
  return concatBytes(
    parts.total ? encodeVarintField(1, parts.total) : new Uint8Array(),
    parts.hash.byteLength ? encodeBytesField(2, parts.hash) : new Uint8Array(),
  );
}

function encodeBlockIdMessage(blockId: BlockIdLike | null): Uint8Array {
  if (!blockId || (blockId.hash.byteLength === 0 && blockId.parts.total === 0 && blockId.parts.hash.byteLength === 0)) {
    return new Uint8Array();
  }

  return concatBytes(
    blockId.hash.byteLength ? encodeBytesField(1, blockId.hash) : new Uint8Array(),
    encodeMessageField(2, encodePartSetHeaderMessage(blockId.parts)),
  );
}

function encodeTimestampMessage(timestamp: TimestampLike): Uint8Array {
  const milliseconds = timestamp.getTime();
  const seconds = BigInt(Math.floor(milliseconds / 1000));
  const nanos = Number(timestamp.nanoseconds ?? ((milliseconds % 1000) * 1_000_000));

  return concatBytes(
    seconds !== 0n ? encodeVarintField(1, seconds) : new Uint8Array(),
    nanos !== 0 ? encodeVarintField(2, nanos) : new Uint8Array(),
  );
}

function encodeCanonicalVote(chainId: string, vote: {
  type: number;
  height: number;
  round: number;
  blockId: BlockIdLike | null;
  timestamp: TimestampLike;
}): Uint8Array {
  return concatBytes(
    encodeVarintField(1, vote.type),
    encodeSfixed64Field(2, vote.height),
    encodeSfixed64Field(3, vote.round),
    encodeMessageField(4, encodeBlockIdMessage(vote.blockId)),
    encodeMessageField(5, encodeTimestampMessage(vote.timestamp)),
    encodeStringField(6, chainId),
  );
}

function encodeDelimited(message: Uint8Array): Uint8Array {
  return concatBytes(encodeUvarint(message.byteLength), message);
}

function encodeAminoString(value: string): Uint8Array {
  const utf8 = encodeUtf8(value);
  return Uint8Array.from([utf8.length, ...utf8]);
}

function encodeAminoBytes(value: Uint8Array): Uint8Array {
  if (!value.byteLength) return new Uint8Array();
  if (value.byteLength >= 0x80) {
    throw new Error("Amino byte encoding for values >= 128 bytes is not supported");
  }
  return Uint8Array.from([value.byteLength, ...value]);
}

function encodeAminoTime(timestamp: TimestampLike): Uint8Array {
  const milliseconds = timestamp.getTime();
  const seconds = Math.floor(milliseconds / 1000);
  const secondsArray = seconds ? Uint8Array.from([0x08, ...encodeUvarint(seconds)]) : new Uint8Array();
  const nanoseconds = (timestamp.nanoseconds ?? 0) + (milliseconds % 1000) * 1_000_000;
  const nanosecondsArray = nanoseconds ? Uint8Array.from([0x10, ...encodeUvarint(nanoseconds)]) : new Uint8Array();
  return concatBytes(secondsArray, nanosecondsArray);
}

function encodeAminoVersion(version: { block: number; app: number }): Uint8Array {
  const blockArray = version.block ? Uint8Array.from([0x08, ...encodeUvarint(version.block)]) : new Uint8Array();
  const appArray = version.app ? Uint8Array.from([0x10, ...encodeUvarint(version.app)]) : new Uint8Array();
  return concatBytes(blockArray, appArray);
}

function encodeAminoBlockId(blockId: BlockIdLike): Uint8Array {
  return Uint8Array.from([
    0x0a,
    blockId.hash.length,
    ...blockId.hash,
    0x12,
    blockId.parts.hash.length + 4,
    0x08,
    blockId.parts.total,
    0x12,
    blockId.parts.hash.length,
    ...blockId.parts.hash,
  ]);
}

function encodeProtoStringValue(value: string): Uint8Array {
  return value ? encodeStringField(1, value) : new Uint8Array();
}

function encodeProtoInt64Value(value: number | bigint): Uint8Array {
  const bigintValue = typeof value === "bigint" ? value : BigInt(value);
  return bigintValue !== 0n ? encodeVarintField(1, bigintValue) : new Uint8Array();
}

function encodeProtoBytesValue(value: Uint8Array): Uint8Array {
  return value.byteLength ? encodeBytesField(1, value) : new Uint8Array();
}

function toProtoTimestamp(timestamp: TimestampLike): { seconds: bigint; nanos: number } {
  const milliseconds = timestamp.getTime();
  return {
    seconds: BigInt(Math.floor(milliseconds / 1000)),
    nanos: (timestamp.nanoseconds ?? 0) + (milliseconds % 1000) * 1_000_000,
  };
}

function toCanonicalVoteTimestamp(timestamp: TimestampLike): Record<string, string | number> {
  const proto = toProtoTimestamp(timestamp);
  return {
    ...(proto.seconds !== 0n ? { seconds: proto.seconds.toString() } : {}),
    ...(proto.nanos !== 0 ? { nanos: proto.nanos } : {}),
  };
}

function getSplitPoint(length: number): number {
  if (length < 1) throw new Error("Cannot split an empty tree");
  const largestPowerOfTwo = 2 ** Math.floor(Math.log2(length));
  return largestPowerOfTwo < length ? largestPowerOfTwo : (largestPowerOfTwo / 2);
}

async function sha256Bytes(...parts: Uint8Array[]): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto is required for DNS light verification");
  }
  const payload = toOwnedBytes(concatBytes(...parts));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", payload);
  return new Uint8Array(digest);
}

async function hashLeaf(leaf: Uint8Array): Promise<Uint8Array> {
  return await sha256Bytes(Uint8Array.from([0]), leaf);
}

async function hashInner(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return await sha256Bytes(Uint8Array.from([1]), left, right);
}

async function hashTree(chunks: Uint8Array[]): Promise<Uint8Array> {
  if (chunks.length === 0) throw new Error("Cannot hash an empty tree");
  if (chunks.length === 1) return await hashLeaf(chunks[0]!);

  const split = getSplitPoint(chunks.length);
  const left = await hashTree(chunks.slice(0, split));
  const right = await hashTree(chunks.slice(split));
  return await hashInner(left, right);
}

async function hashHeader(header: CommitResponse["header"]): Promise<Uint8Array> {
  if (!header.lastBlockId) {
    throw new Error("Hashing a height-1 header is not supported by the DNS light verifier");
  }

  return await hashTree([
    ProtoConsensusVersion.encode({
      block: BigInt(header.version.block),
      app: BigInt(header.version.app),
    }).finish(),
    encodeProtoStringValue(header.chainId),
    encodeProtoInt64Value(header.height),
    ProtoTimestamp.encode(toProtoTimestamp(header.time as TimestampLike)).finish(),
    ProtoBlockId.encode({
      hash: header.lastBlockId.hash,
      partSetHeader: {
        total: header.lastBlockId.parts.total,
        hash: header.lastBlockId.parts.hash,
      },
    }).finish(),
    encodeProtoBytesValue(header.lastCommitHash),
    encodeProtoBytesValue(header.dataHash),
    encodeProtoBytesValue(header.validatorsHash),
    encodeProtoBytesValue(header.nextValidatorsHash),
    encodeProtoBytesValue(header.consensusHash),
    encodeProtoBytesValue(header.appHash),
    encodeProtoBytesValue(header.lastResultsHash),
    encodeProtoBytesValue(header.evidenceHash),
    encodeProtoBytesValue(header.proposerAddress),
  ]);
}

export async function computeHeaderHash(header: CommitResponse["header"]): Promise<Uint8Array> {
  return await hashHeader(header);
}

function compareValidators(left: Validator, right: Validator): number {
  if (left.votingPower === right.votingPower) {
    const length = Math.min(left.address.byteLength, right.address.byteLength);
    for (let index = 0; index < length; index += 1) {
      const delta = left.address[index]! - right.address[index]!;
      if (delta !== 0) return delta;
    }
    return left.address.byteLength - right.address.byteLength;
  }
  return left.votingPower > right.votingPower ? -1 : 1;
}

function toProtoPublicKey(validator: Validator): { ed25519?: Uint8Array; secp256k1?: Uint8Array } {
  if (!validator.pubkey) {
    throw new Error("Validator is missing a public key");
  }
  if (validator.pubkey.algorithm === "ed25519") {
    return TendermintPublicKey.fromPartial({
      ed25519: validator.pubkey.data,
    });
  }
  if (validator.pubkey.algorithm === "secp256k1") {
    return TendermintPublicKey.fromPartial({
      secp256k1: validator.pubkey.data,
    });
  }
  throw new Error(`Unsupported validator key algorithm: ${String((validator.pubkey as any).algorithm ?? "unknown")}`);
}

export async function computeValidatorSetHash(validators: readonly Validator[]): Promise<Uint8Array> {
  const ordered = [...validators].sort(compareValidators);
  const leaves = ordered.map((validator) =>
    TendermintSimpleValidator.encode(TendermintSimpleValidator.fromPartial({
      pubKey: toProtoPublicKey(validator),
      votingPower: validator.votingPower,
    })).finish()
  );
  return await hashTree(leaves);
}

function encodeDnsStoreKey(domain: string): Uint8Array {
  return encodeUtf8(`${DNS_DOMAIN_PREFIX}${domain}`);
}

function readVarint(bytes: Uint8Array, offset: number): { value: bigint; offset: number } {
  let out = 0n;
  let shift = 0n;
  let cursor = offset;

  while (cursor < bytes.byteLength) {
    const current = BigInt(bytes[cursor]!);
    cursor += 1;
    out |= (current & 0x7fn) << shift;
    if ((current & 0x80n) === 0n) {
      return { value: out, offset: cursor };
    }
    shift += 7n;
    if (shift > 63n) throw new Error("protobuf_varint_overflow");
  }

  throw new Error("protobuf_unexpected_eof");
}

function skipField(bytes: Uint8Array, offset: number, wireType: number): number {
  if (wireType === 0) return readVarint(bytes, offset).offset;
  if (wireType === 1) return offset + 8;
  if (wireType === 2) {
    const length = readVarint(bytes, offset);
    return length.offset + Number(length.value);
  }
  if (wireType === 5) return offset + 4;
  throw new Error(`Unsupported protobuf wire type ${wireType}`);
}

function decodeStringField(bytes: Uint8Array, offset: number): { value: string; offset: number } {
  const length = readVarint(bytes, offset);
  const size = Number(length.value);
  const start = length.offset;
  const end = start + size;
  return {
    value: decodeUtf8(bytes.subarray(start, end)),
    offset: end,
  };
}

function decodeBytesField(bytes: Uint8Array, offset: number): { value: Uint8Array; offset: number } {
  const length = readVarint(bytes, offset);
  const size = Number(length.value);
  const start = length.offset;
  const end = start + size;
  return {
    value: bytes.subarray(start, end),
    offset: end,
  };
}

function decodeRecordMessage(bytes: Uint8Array): DecodedRecord {
  const out: DecodedRecord = {
    key: "",
    value: "",
    ttl: "0",
  };

  let offset = 0;
  while (offset < bytes.byteLength) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x7n);

    if (fieldNumber === 1 && wireType === 2) {
      const decoded = decodeStringField(bytes, offset);
      out.key = decoded.value;
      offset = decoded.offset;
      continue;
    }

    if (fieldNumber === 2 && wireType === 2) {
      const decoded = decodeStringField(bytes, offset);
      out.value = decoded.value;
      offset = decoded.offset;
      continue;
    }

    if (fieldNumber === 3 && wireType === 0) {
      const decoded = readVarint(bytes, offset);
      out.ttl = decoded.value.toString();
      offset = decoded.offset;
      continue;
    }

    offset = skipField(bytes, offset, wireType);
  }

  return out;
}

function decodeDomainMessage(bytes: Uint8Array): DomainInfoLike {
  const out: DecodedDomain = {
    records: [],
  };

  let offset = 0;
  while (offset < bytes.byteLength) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x7n);

    if (fieldNumber === 1 && wireType === 2) {
      const decoded = decodeStringField(bytes, offset);
      out.index = decoded.value;
      offset = decoded.offset;
      continue;
    }

    if (fieldNumber === 2 && wireType === 2) {
      const decoded = decodeStringField(bytes, offset);
      out.name = decoded.value;
      offset = decoded.offset;
      continue;
    }

    if (fieldNumber === 3 && wireType === 2) {
      const decoded = decodeStringField(bytes, offset);
      out.owner = decoded.value;
      offset = decoded.offset;
      continue;
    }

    if (fieldNumber === 6 && wireType === 2) {
      const decoded = decodeBytesField(bytes, offset);
      out.records?.push(decodeRecordMessage(decoded.value));
      offset = decoded.offset;
      continue;
    }

    if (fieldNumber === 7 && wireType === 0) {
      const decoded = readVarint(bytes, offset);
      out.expire_at = decoded.value.toString();
      offset = decoded.offset;
      continue;
    }

    if (fieldNumber === 8 && wireType === 2) {
      const decoded = decodeStringField(bytes, offset);
      out.creator = decoded.value;
      offset = decoded.offset;
      continue;
    }

    offset = skipField(bytes, offset, wireType);
  }

  return out;
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!(timeoutMs > 0)) return promise;

  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new Error(`${label}_timeout_after_${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error) => {
        clearTimeout(handle);
        reject(error);
      },
    );
  });
}

async function verifyEd25519Signature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  return await Ed25519.verifySignature(signature, message, publicKey);
}

function buildVoteSignBytes(
  chainId: string,
  commit: CommitResponse["commit"],
  validatorIndex: number,
): Uint8Array {
  const signature = commit.signatures[validatorIndex];
  if (!signature) {
    throw new Error(`Missing commit signature at validator index ${validatorIndex}`);
  }

  const payload = CanonicalVoteType.create({
    type: PRECOMMIT_TYPE,
    height: commit.height.toString(),
    ...(commit.round !== 0 ? { round: commit.round.toString() } : {}),
    ...(signature.blockIdFlag === BLOCK_ID_FLAG_COMMIT
      ? {
          block_id: {
            hash: commit.blockId.hash,
            part_set_header: {
              total: commit.blockId.parts.total,
              hash: commit.blockId.parts.hash,
            },
          },
        }
      : {}),
    timestamp: toCanonicalVoteTimestamp(signature.timestamp as TimestampLike),
    ...(chainId ? { chain_id: chainId } : {}),
  });

  return Uint8Array.from(CanonicalVoteType.encodeDelimited(payload).finish());
}

export async function verifyCommitQuorum(
  commitResponse: CommitResponse,
  validators: readonly Validator[],
): Promise<{
  headerHash: Uint8Array;
  commitBlockHash: Uint8Array;
  totalVotingPower: bigint;
  signedVotingPower: bigint;
}> {
  if (validators.length !== commitResponse.commit.signatures.length) {
    throw new Error(
      `Validator set size (${validators.length}) does not match commit signatures (${commitResponse.commit.signatures.length})`,
    );
  }

  if (commitResponse.commit.height !== commitResponse.header.height) {
    throw new Error("Commit height does not match header height");
  }

  const headerHash = await hashHeader(commitResponse.header);
  const commitBlockHash = commitResponse.commit.blockId.hash;
  if (!bytesEqual(headerHash, commitBlockHash)) {
    throw new Error("Header hash does not match commit block hash");
  }

  let totalVotingPower = 0n;
  let signedVotingPower = 0n;

  for (let index = 0; index < validators.length; index += 1) {
    const validator = validators[index]!;
    const signature = commitResponse.commit.signatures[index]!;
    totalVotingPower += validator.votingPower;

    if (signature.blockIdFlag === BLOCK_ID_FLAG_ABSENT) continue;
    if (!signature.signature || !signature.validatorAddress || !validator.pubkey) {
      throw new Error(`Commit signature ${index} is missing signature material`);
    }

    if (validator.pubkey.algorithm !== "ed25519") {
      throw new Error(`Unsupported validator key algorithm: ${validator.pubkey.algorithm}`);
    }

    const derivedAddress = pubkeyToRawAddress(validator.pubkey.algorithm, validator.pubkey.data);
    if (!bytesEqual(derivedAddress, validator.address)) {
      throw new Error(`Validator ${index} address does not match its public key`);
    }

    if (!bytesEqual(signature.validatorAddress, validator.address)) {
      throw new Error(`Commit signature ${index} address does not match validator set`);
    }

    const signBytes = buildVoteSignBytes(commitResponse.header.chainId, commitResponse.commit, index);
    const ok = await verifyEd25519Signature(
      validator.pubkey.data,
      signBytes,
      signature.signature,
    );

    if (!ok) {
      throw new Error(`Commit signature ${index} failed Ed25519 verification`);
    }

    if (signature.blockIdFlag === BLOCK_ID_FLAG_COMMIT) {
      signedVotingPower += validator.votingPower;
    }
  }

  if (signedVotingPower * 3n <= totalVotingPower * 2n) {
    throw new Error(
      `Insufficient signed voting power: ${signedVotingPower.toString()} / ${totalVotingPower.toString()}`,
    );
  }

  return {
    headerHash,
    commitBlockHash,
    totalVotingPower,
    signedVotingPower,
  };
}

export function verifyDomainProofChain(
  query: AbciQueryResponse,
  expectedStoreKey: Uint8Array,
  appHash: Uint8Array,
): { value: Uint8Array | null; storeRoot: Uint8Array } {
  if (!query.proof?.ops?.length || query.proof.ops.length < 2) {
    throw new Error("ABCI query did not include the expected DNS proof chain");
  }

  if (!bytesEqual(query.key, expectedStoreKey)) {
    throw new Error("ABCI query returned a different DNS store key than requested");
  }

  const [domainOp, storeOp] = query.proof.ops;
  if (!bytesEqual(domainOp!.key, expectedStoreKey)) {
    throw new Error("IAVL proof key does not match requested DNS store key");
  }

  const storeKeyBytes = encodeUtf8(DNS_STORE_NAME);
  if (!bytesEqual(storeOp!.key, storeKeyBytes)) {
    throw new Error("Multistore proof key does not match dns store");
  }

  const domainProof = ics23.CommitmentProof.decode(domainOp!.data);
  const storeProof = ics23.CommitmentProof.decode(storeOp!.data);
  const storeRoot = storeProof.exist?.value;
  if (!storeRoot || storeRoot.byteLength === 0) {
    throw new Error("Missing dns store root in multistore proof");
  }

  if (!verifyMembership(storeProof, tendermintSpec, appHash, storeKeyBytes, storeRoot)) {
    throw new Error("Failed to verify dns multistore proof against header appHash");
  }

  if (query.value.byteLength > 0) {
    if (!verifyMembership(domainProof, iavlSpec, storeRoot, expectedStoreKey, query.value)) {
      throw new Error("Failed to verify DNS IAVL membership proof");
    }
    return {
      value: query.value,
      storeRoot,
    };
  }

  if (!verifyNonMembership(domainProof, iavlSpec, storeRoot, expectedStoreKey)) {
    throw new Error("Failed to verify DNS IAVL non-membership proof");
  }

  return {
    value: null,
    storeRoot,
  };
}

export class LumenDnsLightVerifier {
  private readonly rpcEndpoints: string[];
  private readonly timeoutMs: number;
  private readonly trustOptions: ReturnType<typeof normalizeTrustOptions>;
  private readonly statusCacheTtlMs: number;
  private readonly verifiedHeaderCacheSize: number;
  private readonly observer?: DnsVerifierObserver;
  private readonly rpcResilience: RpcResilienceLayer;
  private readonly clients = new Map<string, Promise<Tendermint37Client>>();
  private readonly statusCache = new Map<string, StatusCacheEntry>();
  private readonly pendingStatus = new Map<string, Promise<StatusCacheEntry>>();
  private readonly verifiedAnchors = new Map<string, VerifiedAnchorState>();
  private readonly pendingVerifiedAnchors = new Map<string, Promise<VerifiedAnchorState>>();
  private readonly verifiedCheckpointKeys = new Set<string>();
  private readonly pendingCheckpointVerifications = new Map<string, Promise<void>>();
  private metrics: ResolverMetricsSnapshot = {
    proofAttempts: 0,
    proofSuccesses: 0,
    fallbackCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  private runtimeStatus: VerifierRuntimeStatus = {
    lastVerifiedHeight: 0,
    checkpointAge: 0,
  };
  private lastVerifiedHeader?: VerifiedHeaderSnapshot;
  private lastValidatorSet?: VerifiedValidatorSetSnapshot;
  private lastGoodCheckpoint?: TrustedCheckpoint;
  private expectedChainId?: string;

  constructor(init: {
    rpcEndpoints: Array<string | URL>;
    timeoutMs: number;
    globalTimeoutMs?: number;
    maxAttempts?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
    circuitBreakerThreshold?: number;
    circuitBreakerCooldownMs?: number;
    circuitBreakerDecayMs?: number;
    trustOptions?: TrustOptions;
    trustedCheckpoint?: DnsTrustedCheckpoint;
    statusCacheTtlMs?: number;
    verifiedHeaderCacheSize?: number;
    observer?: DnsVerifierObserver;
  }) {
    this.rpcEndpoints = normalizeRpcEndpoints(init.rpcEndpoints);
    this.timeoutMs = init.timeoutMs;
    this.trustOptions = normalizeTrustOptions(init.trustOptions, init.trustedCheckpoint);
    this.statusCacheTtlMs = Math.max(0, init.statusCacheTtlMs ?? DEFAULT_STATUS_CACHE_TTL_MS);
    this.verifiedHeaderCacheSize = Math.max(1, init.verifiedHeaderCacheSize ?? DEFAULT_VERIFIED_HEADER_CACHE_SIZE);
    this.observer = init.observer;
    this.expectedChainId = this.trustOptions.expectedChainId ?? this.trustOptions.checkpoints[0]?.chainId;
    this.rpcResilience = new RpcResilienceLayer({
      timeoutMs: init.timeoutMs,
      globalTimeoutMs: init.globalTimeoutMs,
      maxAttempts: init.maxAttempts,
      retryBaseDelayMs: init.retryBaseDelayMs,
      retryMaxDelayMs: init.retryMaxDelayMs,
      circuitBreakerThreshold: init.circuitBreakerThreshold,
      circuitBreakerCooldownMs: init.circuitBreakerCooldownMs,
      circuitBreakerDecayMs: init.circuitBreakerDecayMs,
      observer: (type, data) => this.emit(type as DnsVerifierEventType, data),
    });
  }

  importTrustState(state?: PersistedResolverTrustState | null): void {
    if (!state) return;
    if (state.metrics) {
      this.metrics = {
        ...this.metrics,
        ...state.metrics,
      };
    }
    if (state.lastVerifiedHeader) {
      this.lastVerifiedHeader = { ...state.lastVerifiedHeader };
      this.runtimeStatus.lastVerifiedHeight = Math.max(
        this.runtimeStatus.lastVerifiedHeight,
        state.lastVerifiedHeader.height,
      );
      this.expectedChainId = this.expectedChainId ?? state.lastVerifiedHeader.chainId;
      const anchor: VerifiedAnchorState = {
        endpoint: state.lastVerifiedHeader.endpoint,
        chainId: state.lastVerifiedHeader.chainId,
        height: state.lastVerifiedHeader.height,
        latestHeight: state.lastVerifiedHeader.latestHeight,
        validatorCount: state.lastValidatorSet?.validatorCount ?? 0,
        appHash: bytesFromHex(state.lastVerifiedHeader.appHash),
        headerHash: bytesFromHex(state.lastVerifiedHeader.headerHash),
        commitBlockHash: bytesFromHex(state.lastVerifiedHeader.commitBlockHash),
        validatorsHash: bytesFromHex(state.lastVerifiedHeader.validatorsHash),
        nextValidatorsHash: bytesFromHex(state.lastVerifiedHeader.nextValidatorsHash),
        totalVotingPower: BigInt(state.lastVerifiedHeader.totalVotingPower),
        signedVotingPower: BigInt(state.lastVerifiedHeader.signedVotingPower),
      };
      this.verifiedAnchors.set(`${anchor.endpoint}::${anchor.height}`, anchor);
    }
    if (state.lastValidatorSet) {
      this.lastValidatorSet = { ...state.lastValidatorSet };
    }
    if (state.lastGoodCheckpoint) {
      this.lastGoodCheckpoint = {
        ...state.lastGoodCheckpoint,
        blockHash: typeof state.lastGoodCheckpoint.blockHash === "string"
          ? state.lastGoodCheckpoint.blockHash
          : bytesToHex(state.lastGoodCheckpoint.blockHash),
      };
    }
    this.rpcResilience.importHealth(state.rpcHealth);
  }

  exportTrustState(): PersistedResolverTrustState {
    return {
      version: 2,
      updatedAt: now(),
      ...(this.lastVerifiedHeader ? { lastVerifiedHeader: { ...this.lastVerifiedHeader } } : {}),
      ...(this.lastValidatorSet ? { lastValidatorSet: { ...this.lastValidatorSet } } : {}),
      ...(this.lastGoodCheckpoint ? { lastGoodCheckpoint: { ...this.lastGoodCheckpoint } } : {}),
      rpcHealth: this.rpcResilience.exportHealth(),
      metrics: this.getMetrics(),
    };
  }

  getMetrics(): ResolverMetricsSnapshot {
    return { ...this.metrics };
  }

  getRuntimeStatus(): VerifierRuntimeStatus {
    return { ...this.runtimeStatus };
  }

  getRpcHealth(): RpcEndpointHealth[] {
    return this.rpcResilience.exportHealth();
  }

  markFallback(): void {
    this.metrics.fallbackCount += 1;
  }

  async close(): Promise<void> {
    const clients = await Promise.all(
      [...this.clients.values()].map((pending) => pending.catch(() => null)),
    );

    for (const client of clients) {
      client?.disconnect();
    }
    this.clients.clear();
    this.statusCache.clear();
    this.pendingStatus.clear();
    this.verifiedAnchors.clear();
    this.pendingVerifiedAnchors.clear();
    this.verifiedCheckpointKeys.clear();
    this.pendingCheckpointVerifications.clear();
  }

  async queryDomain(
    baseDomain: string,
    consistencyMode: ChainConsistencyMode,
  ): Promise<VerifiedDomainResult> {
    if (!this.rpcEndpoints.length) {
      throw new Error("No Tendermint RPC endpoints configured for DNS proof verification");
    }
    this.metrics.proofAttempts += 1;

    const results = await Promise.allSettled(
      this.rpcEndpoints.map((endpoint) => this.queryDomainFromEndpoint(endpoint, baseDomain)),
    );

    const successes: QueryResult[] = [];
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        successes.push(result.value);
      } else {
        failures.push(result.reason);
      }
    }

    if (!successes.length) {
      this.emit("dns_verify_failed", {
        domain: baseDomain,
        error: `Failed to verify DNS proof for "${baseDomain}" on every RPC endpoint`,
        failures: failures.map((error) => error instanceof Error ? error.message : String(error)),
      });
      throw new AggregateError(failures, `Failed to verify DNS proof for "${baseDomain}" on every RPC endpoint`);
    }

    if (consistencyMode === "single" || successes.length === 1) {
      this.metrics.proofSuccesses += 1;
      return successes[0]!.value;
    }

    const buckets = new Map<string, { count: number; winner: QueryResult }>();
    for (const success of successes) {
      const existing = buckets.get(success.normalized);
      if (existing) {
        existing.count += 1;
      } else {
        buckets.set(success.normalized, {
          count: 1,
          winner: success,
        });
      }
    }

    const ranked = [...buckets.values()].sort((left, right) => right.count - left.count);
    const winner = ranked[0];
    const runnerUp = ranked[1];

    if (!winner) {
      throw new Error(`Failed to establish RPC consensus for "${baseDomain}"`);
    }

    if ((runnerUp && runnerUp.count === winner.count) || winner.count <= successes.length / 2) {
      for (const success of successes) {
        this.rpcResilience.recordVerificationFailure(
          success.endpoint,
          "consensus_mismatch",
          `RPC consensus mismatch for "${baseDomain}"`,
          { domain: baseDomain },
        );
      }
      const message = `Inconsistent DNS proof state across RPC endpoints: ${successes.map((entry) => entry.endpoint).join(", ")}`;
      this.emit("dns_verify_failed", {
        domain: baseDomain,
        kind: "consensus_mismatch",
        error: message,
      });
      throw new Error(
        message,
      );
    }

    for (const success of successes) {
      if (success.normalized !== winner.winner.normalized) {
        this.rpcResilience.recordVerificationFailure(
          success.endpoint,
          "consensus_mismatch",
          `RPC response diverged from proof majority for "${baseDomain}"`,
          { domain: baseDomain },
        );
      }
    }

    this.metrics.proofSuccesses += 1;
    return winner.winner.value;
  }

  private async queryDomainFromEndpoint(endpoint: string, baseDomain: string): Promise<QueryResult> {
    const deadlineAt = this.rpcResilience.getGlobalTimeoutMs() != null
      ? now() + this.rpcResilience.getGlobalTimeoutMs()!
      : undefined;
    const client = await this.getClient(endpoint);

    try {
      const status = await this.getStatus(endpoint, client, deadlineAt);
      this.validateExpectedChainId(status.chainId, endpoint, status.latestHeight);
      await this.ensureTrustedCheckpoint(endpoint, client, status, deadlineAt);

      const expectedStoreKey = encodeDnsStoreKey(baseDomain);
      const proofHeight = Math.max(1, status.latestHeight - 1);
      const anchorHeight = proofHeight + 1;
      const query = await this.callRpc(endpoint, "abci_query", () =>
        client.abciQuery({
          path: "/store/dns/key",
          data: expectedStoreKey,
          height: proofHeight,
          prove: true,
        }), deadlineAt
      );

      if ((query.code ?? 0) !== 0) {
        throw new Error(`ABCI query failed for "${baseDomain}" with code ${query.code} (${query.codespace})`);
      }

      if (!query.height) {
        throw new Error(`ABCI query for "${baseDomain}" returned no height`);
      }

      if (query.height !== proofHeight) {
        throw new Error(`ABCI query height mismatch for "${baseDomain}": expected ${proofHeight}, got ${query.height}`);
      }

      const anchor = await this.getVerifiedAnchor(endpoint, client, anchorHeight, status, deadlineAt);
      const proof = verifyDomainProofChain(query, expectedStoreKey, anchor.appHash);
      const domain = proof.value ? decodeDomainMessage(proof.value) : null;
      const domainIndex = typeof domain?.index === "string" ? domain.index : "";

      if (domainIndex && domainIndex.toLowerCase() !== baseDomain.toLowerCase()) {
        throw new Error(`Verified domain payload mismatch: expected "${baseDomain}", got "${domainIndex}"`);
      }

      const value: VerifiedDomainResult = {
        endpoint,
        chainId: anchor.chainId,
        height: proofHeight,
        anchorHeight,
        latestHeight: status.latestHeight,
        domain,
        appHashHex: bytesToHex(anchor.appHash),
        headerHashHex: bytesToHex(anchor.headerHash),
        commitBlockHashHex: bytesToHex(anchor.commitBlockHash),
        storeRootHex: bytesToHex(proof.storeRoot),
        validatorsHashHex: bytesToHex(anchor.validatorsHash),
        nextValidatorsHashHex: bytesToHex(anchor.nextValidatorsHash),
        totalVotingPower: anchor.totalVotingPower.toString(),
        signedVotingPower: anchor.signedVotingPower.toString(),
      };

      this.emit("dns_verified", {
        endpoint,
        domain: baseDomain,
        chainId: value.chainId,
        height: proofHeight,
        anchorHeight,
        latestHeight: status.latestHeight,
        headerHash: value.headerHashHex,
        commitBlockHash: value.commitBlockHashHex,
        appHash: value.appHashHex,
        storeRoot: value.storeRootHex,
        validatorsHash: value.validatorsHashHex,
        nextValidatorsHash: value.nextValidatorsHashHex,
        totalVotingPower: value.totalVotingPower,
        signedVotingPower: value.signedVotingPower,
        exists: domain != null,
      });

      return {
        endpoint,
        value,
        normalized: stableStringify({
          domain: normalizeDomainForConsensus(domain),
          chainId: value.chainId,
          anchorHeight: value.anchorHeight,
          headerHash: value.headerHashHex,
          appHash: value.appHashHex,
          storeRoot: value.storeRootHex,
          validatorsHash: value.validatorsHashHex,
          nextValidatorsHash: value.nextValidatorsHashHex,
        }),
      };
    } catch (error) {
      const kind = this.classifyVerificationFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof RpcRequestError)) {
        this.rpcResilience.recordVerificationFailure(endpoint, kind, message, {
          domain: baseDomain,
        });
      }
      this.emit("dns_verify_failed", {
        endpoint,
        domain: baseDomain,
        kind,
        error: message,
      });
      throw error;
    }
  }

  private async getStatus(
    endpoint: string,
    client: Tendermint37Client,
    deadlineAt?: number,
  ): Promise<StatusCacheEntry> {
    const cached = this.statusCache.get(endpoint);
    if (cached && cached.expiresAt > now()) {
      this.metrics.cacheHits += 1;
      this.emit("dns_status_cache_hit", {
        endpoint,
        latestHeight: cached.latestHeight,
        chainId: cached.chainId,
      });
      return cached;
    }

    this.metrics.cacheMisses += 1;
    const pending = this.pendingStatus.get(endpoint);
    if (pending) return await pending;

    const request = (async () => {
      const status = await this.callRpc(endpoint, "status", () => client.status(), deadlineAt);
      const entry: StatusCacheEntry = {
        chainId: String(status.nodeInfo.network || "").trim(),
        latestHeight: status.syncInfo.latestBlockHeight,
        latestBlockHash: status.syncInfo.latestBlockHash,
        latestAppHash: status.syncInfo.latestAppHash,
        expiresAt: now() + this.statusCacheTtlMs,
      };
      if (!entry.chainId) {
        throw new Error(`RPC status for ${endpoint} did not include a chain ID`);
      }
      this.statusCache.set(endpoint, entry);
      return entry;
    })();

    this.pendingStatus.set(endpoint, request);
    try {
      return await request;
    } finally {
      this.pendingStatus.delete(endpoint);
    }
  }

  private async ensureTrustedCheckpoint(
    endpoint: string,
    client: Tendermint37Client,
    status: StatusCacheEntry,
    deadlineAt?: number,
  ): Promise<void> {
    if (!this.trustOptions.checkpoints.length) {
      this.runtimeStatus.checkpointAge = 0;
      return;
    }

    const usable = this.pickUsableCheckpoints(status);
    if (!usable.length) {
      throw new Error(`No usable trusted checkpoint remains for chain ${status.chainId}`);
    }

    const checkpoint = usable[0]!;
    const cacheKey = `${endpoint}::${checkpoint.height}::${checkpoint.blockHashHex}`;
    this.runtimeStatus.checkpointAge = Math.max(0, status.latestHeight - checkpoint.height);
    this.lastGoodCheckpoint = {
      height: checkpoint.height,
      blockHash: checkpoint.blockHashHex,
      chainId: checkpoint.chainId,
      trustedAt: checkpoint.trustedAt,
    };

    if (this.verifiedCheckpointKeys.has(cacheKey)) return;

    const existing = this.pendingCheckpointVerifications.get(cacheKey);
    if (existing) {
      await existing;
      return;
    }

    const request = (async () => {
      const commitResponse = await this.callRpc(
        endpoint,
        "commit",
        () => client.commit(checkpoint.height),
        deadlineAt,
      );
      if (commitResponse.header.height !== checkpoint.height || commitResponse.commit.height !== checkpoint.height) {
        throw new Error(`Trusted checkpoint ${checkpoint.height} returned an inconsistent commit height`);
      }
      if (this.trustOptions.requireChainIdMatch && commitResponse.header.chainId !== checkpoint.chainId) {
        throw new Error(
          `Trusted checkpoint chain ID mismatch: expected ${checkpoint.chainId}, got ${commitResponse.header.chainId}`,
        );
      }
      const blockHashHex = bytesToHex(commitResponse.commit.blockId.hash).toLowerCase();
      if (blockHashHex !== checkpoint.blockHashHex) {
        throw new Error(
          `Trusted checkpoint mismatch at height ${checkpoint.height}: expected ${checkpoint.blockHashHex}, got ${blockHashHex}`,
        );
      }

      this.verifiedCheckpointKeys.add(cacheKey);
      this.emit("dns_checkpoint_verified", {
        endpoint,
        chainId: checkpoint.chainId,
        height: checkpoint.height,
        blockHash: blockHashHex,
        driftBlocks: this.runtimeStatus.checkpointAge,
      });
    })();

    this.pendingCheckpointVerifications.set(cacheKey, request);
    try {
      await request;
    } finally {
      this.pendingCheckpointVerifications.delete(cacheKey);
    }
  }

  private async getVerifiedAnchor(
    endpoint: string,
    client: Tendermint37Client,
    height: number,
    status: StatusCacheEntry,
    deadlineAt?: number,
  ): Promise<VerifiedAnchorState> {
    const key = `${endpoint}::${height}`;
    const cached = this.verifiedAnchors.get(key);
    if (cached) {
      this.verifiedAnchors.delete(key);
      this.verifiedAnchors.set(key, cached);
      this.metrics.cacheHits += 1;
      this.emit("dns_header_cache_hit", {
        endpoint,
        height,
        chainId: cached.chainId,
        headerHash: bytesToHex(cached.headerHash),
        commitBlockHash: bytesToHex(cached.commitBlockHash),
      });
      return cached;
    }

    const persisted = this.tryReusePersistedAnchor(endpoint, height, status);
    if (persisted) {
      this.metrics.cacheHits += 1;
      this.rememberAnchor(key, persisted);
      this.emit("dns_header_cache_hit", {
        endpoint,
        height,
        chainId: persisted.chainId,
        headerHash: bytesToHex(persisted.headerHash),
        commitBlockHash: bytesToHex(persisted.commitBlockHash),
        reused: "persistent",
      });
      return persisted;
    }

    this.metrics.cacheMisses += 1;
    const pending = this.pendingVerifiedAnchors.get(key);
    if (pending) return await pending;

    const request = (async () => {
      const [commitResponse, validatorsResponse] = await Promise.all([
        this.callRpc(endpoint, "commit", () => client.commit(height), deadlineAt),
        this.callRpc(endpoint, "validators", () => client.validatorsAll(height), deadlineAt),
      ]);

      if (commitResponse.header.height !== height || commitResponse.commit.height !== height) {
        throw new Error(`Commit/header height mismatch at ${height}`);
      }
      if (this.trustOptions.requireChainIdMatch && commitResponse.header.chainId !== status.chainId) {
        throw new Error(
          `Header chain ID mismatch at height ${height}: expected ${status.chainId}, got ${commitResponse.header.chainId}`,
        );
      }
      const quorum = await verifyCommitQuorum(commitResponse, validatorsResponse.validators);
      const validatorsHash = await computeValidatorSetHash(validatorsResponse.validators);
      if (!bytesEqual(validatorsHash, commitResponse.header.validatorsHash)) {
        throw new Error(`Header validators hash mismatch at height ${height}`);
      }
      if (height === status.latestHeight && !bytesEqual(commitResponse.header.appHash, status.latestAppHash)) {
        throw new Error(`Header appHash mismatch at latest height ${height}`);
      }
      if (height === status.latestHeight && !bytesEqual(commitResponse.commit.blockId.hash, status.latestBlockHash)) {
        throw new Error(`Latest block hash mismatch between status and commit at height ${height}`);
      }
      this.validateHeaderTransition(commitResponse, validatorsHash);
      const anchor: VerifiedAnchorState = {
        endpoint,
        chainId: commitResponse.header.chainId,
        height,
        latestHeight: status.latestHeight,
        validatorCount: validatorsResponse.validators.length,
        appHash: commitResponse.header.appHash,
        headerHash: quorum.headerHash,
        commitBlockHash: quorum.commitBlockHash,
        validatorsHash,
        nextValidatorsHash: commitResponse.header.nextValidatorsHash,
        totalVotingPower: quorum.totalVotingPower,
        signedVotingPower: quorum.signedVotingPower,
      };

      this.rememberAnchor(key, anchor);
      this.updateLastVerifiedState(anchor);
      return anchor;
    })();

    this.pendingVerifiedAnchors.set(key, request);
    try {
      return await request;
    } finally {
      this.pendingVerifiedAnchors.delete(key);
    }
  }

  private async getClient(endpoint: string): Promise<Tendermint37Client> {
    const key = trimTrailingSlash(endpoint);
    const existing = this.clients.get(key);
    if (existing) return await existing;

    const pending = Tendermint37Client.connect(key);
    this.clients.set(key, pending);

    try {
      return await pending;
    } catch (error) {
      this.clients.delete(key);
      throw error;
    }
  }

  private async callRpc<T>(
    endpoint: string,
    method: string,
    fn: () => Promise<T>,
    deadlineAt?: number,
  ): Promise<T> {
    return await this.rpcResilience.execute({
      endpoint,
      method,
      fn,
      deadlineAt,
    });
  }

  private pickUsableCheckpoints(status: StatusCacheEntry): NormalizedTrustedCheckpoint[] {
    const usable: NormalizedTrustedCheckpoint[] = [];
    for (const checkpoint of this.trustOptions.checkpoints) {
      if (this.trustOptions.requireChainIdMatch && checkpoint.chainId !== status.chainId) {
        this.emit("dns_checkpoint_stale", {
          chainId: status.chainId,
          height: checkpoint.height,
          checkpointChainId: checkpoint.chainId,
          reason: "chain_id_mismatch",
        });
        continue;
      }
      if (status.latestHeight < checkpoint.height) {
        this.emit("dns_checkpoint_stale", {
          chainId: checkpoint.chainId,
          height: checkpoint.height,
          latestHeight: status.latestHeight,
          reason: "future_checkpoint",
        });
        continue;
      }
      const driftBlocks = Math.max(0, status.latestHeight - checkpoint.height);
      if (this.trustOptions.maxDriftBlocks > 0 && driftBlocks > this.trustOptions.maxDriftBlocks) {
        this.emit("dns_checkpoint_stale", {
          chainId: checkpoint.chainId,
          height: checkpoint.height,
          latestHeight: status.latestHeight,
          driftBlocks,
          reason: "drift_exceeded",
        });
        continue;
      }
      if (
        this.trustOptions.trustingPeriodMs != null &&
        now() - checkpoint.trustedAt > this.trustOptions.trustingPeriodMs
      ) {
        this.emit("dns_checkpoint_stale", {
          chainId: checkpoint.chainId,
          height: checkpoint.height,
          trustedAt: checkpoint.trustedAt,
          trustingPeriodMs: this.trustOptions.trustingPeriodMs,
          reason: "trust_period_expired",
        });
        continue;
      }
      usable.push(checkpoint);
    }

    return usable.sort((left, right) => right.height - left.height);
  }

  private validateExpectedChainId(chainId: string, endpoint: string, height: number): void {
    const expected = this.expectedChainId ?? this.trustOptions.expectedChainId ?? this.trustOptions.checkpoints[0]?.chainId;
    if (!this.trustOptions.requireChainIdMatch) {
      this.expectedChainId = expected ?? chainId;
      return;
    }
    if (expected && expected !== chainId) {
      const message = `Chain ID mismatch: expected ${expected}, got ${chainId}`;
      this.rpcResilience.recordVerificationFailure(endpoint, "consensus_mismatch", message, {
        height,
      });
      throw new Error(message);
    }
    this.expectedChainId = expected ?? chainId;
  }

  private tryReusePersistedAnchor(
    endpoint: string,
    height: number,
    status: StatusCacheEntry,
  ): VerifiedAnchorState | null {
    if (!this.lastVerifiedHeader) return null;
    const snapshot = this.lastVerifiedHeader;
    if (snapshot.endpoint !== endpoint) return null;
    if (snapshot.height !== height) return null;
    if (snapshot.latestHeight !== status.latestHeight) return null;
    if (snapshot.chainId !== status.chainId) return null;
    if (!bytesEqual(bytesFromHex(snapshot.commitBlockHash), status.latestBlockHash)) return null;

    return {
      endpoint: snapshot.endpoint,
      chainId: snapshot.chainId,
      height: snapshot.height,
      latestHeight: snapshot.latestHeight,
      validatorCount: this.lastValidatorSet?.validatorCount ?? 0,
      appHash: bytesFromHex(snapshot.appHash),
      headerHash: bytesFromHex(snapshot.headerHash),
      commitBlockHash: bytesFromHex(snapshot.commitBlockHash),
      validatorsHash: bytesFromHex(snapshot.validatorsHash),
      nextValidatorsHash: bytesFromHex(snapshot.nextValidatorsHash),
      totalVotingPower: BigInt(snapshot.totalVotingPower),
      signedVotingPower: BigInt(snapshot.signedVotingPower),
    };
  }

  private validateHeaderTransition(
    commitResponse: CommitResponse,
    validatorsHash: Uint8Array,
  ): void {
    const previous = this.lastVerifiedHeader;
    if (!previous) return;

    const currentHeight = commitResponse.header.height;
    const currentHeaderHash = bytesToHex(commitResponse.commit.blockId.hash);
    const currentValidatorsHash = bytesToHex(validatorsHash);

    if (commitResponse.header.chainId !== previous.chainId) {
      throw new Error(
        `Invalid header transition: expected chain ${previous.chainId}, got ${commitResponse.header.chainId}`,
      );
    }
    if (currentHeight < previous.height) {
      throw new Error(`Replay attack detected: verified height regressed from ${previous.height} to ${currentHeight}`);
    }
    if (currentHeight === previous.height && currentHeaderHash !== previous.headerHash) {
      throw new Error(`Conflicting header detected at height ${currentHeight}`);
    }
    if (currentHeight === previous.height + 1 && previous.nextValidatorsHash !== currentValidatorsHash) {
      throw new Error(
        `Invalid validator transition at height ${currentHeight}: expected ${previous.nextValidatorsHash}, got ${currentValidatorsHash}`,
      );
    }
  }

  private updateLastVerifiedState(anchor: VerifiedAnchorState): void {
    this.runtimeStatus.lastVerifiedHeight = Math.max(this.runtimeStatus.lastVerifiedHeight, anchor.height);
    this.expectedChainId = this.expectedChainId ?? anchor.chainId;
    this.lastVerifiedHeader = {
      endpoint: anchor.endpoint,
      chainId: anchor.chainId,
      height: anchor.height,
      latestHeight: anchor.latestHeight,
      headerHash: bytesToHex(anchor.headerHash),
      commitBlockHash: bytesToHex(anchor.commitBlockHash),
      appHash: bytesToHex(anchor.appHash),
      validatorsHash: bytesToHex(anchor.validatorsHash),
      nextValidatorsHash: bytesToHex(anchor.nextValidatorsHash),
      totalVotingPower: anchor.totalVotingPower.toString(),
      signedVotingPower: anchor.signedVotingPower.toString(),
      verifiedAt: now(),
    };
    this.lastValidatorSet = {
      endpoint: anchor.endpoint,
      chainId: anchor.chainId,
      height: anchor.height,
      validatorsHash: bytesToHex(anchor.validatorsHash),
      validatorCount: anchor.validatorCount,
      totalVotingPower: anchor.totalVotingPower.toString(),
      capturedAt: now(),
    };
  }

  private rememberAnchor(key: string, anchor: VerifiedAnchorState): void {
    this.verifiedAnchors.set(key, anchor);
    while (this.verifiedAnchors.size > this.verifiedHeaderCacheSize) {
      const oldestKey = this.verifiedAnchors.keys().next().value;
      if (!oldestKey) break;
      this.verifiedAnchors.delete(oldestKey);
    }
  }

  private classifyVerificationFailure(
    error: unknown,
  ): Extract<RpcRequestError["kind"], "proof_verification" | "consensus_mismatch" | "invalid_response"> {
    if (error instanceof RpcRequestError) {
      if (error.kind === "consensus_mismatch") return "consensus_mismatch";
      if (error.kind === "proof_verification") return "proof_verification";
      return "invalid_response";
    }

    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes("consensus") || message.includes("chain id mismatch")) {
      return "consensus_mismatch";
    }
    return "proof_verification";
  }

  private emit(type: DnsVerifierEventType, data: Record<string, unknown>): void {
    try {
      this.observer?.(type, data);
    } catch {
      // Ignore observer failures.
    }
  }
}
