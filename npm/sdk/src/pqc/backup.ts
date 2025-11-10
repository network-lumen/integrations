import { fromBase64, toBase64 } from "@cosmjs/encoding";

import { DEFAULT_SCHEME, DILITHIUM3_PRIVATE_KEY_BYTES, DILITHIUM3_PUBLIC_KEY_BYTES } from "./constants.js";
import { PqcKeyStore, type KeyRecord } from "./keystore.js";

export const DUAL_SIGNER_BACKUP_TYPE = "lumen/dual-signer";
export const DUAL_SIGNER_BACKUP_VERSION = 1;

export type DualSignerBackup = {
  type: typeof DUAL_SIGNER_BACKUP_TYPE;
  version: typeof DUAL_SIGNER_BACKUP_VERSION;
  mnemonic: string;
  bech32Prefix?: string;
  address?: string;
  pqc: {
    name: string;
    scheme: string;
    publicKey: string;
    privateKey: string;
    createdAt: string;
  };
};

export type ExportDualSignerParams = {
  mnemonic: string;
  pqcKey: KeyRecord;
  address?: string;
  bech32Prefix?: string;
};

export type ImportDualSignerOptions = {
  keyStore?: PqcKeyStore;
  homeDir?: string;
  overwrite?: boolean;
  keyName?: string;
  linkAddress?: string | false;
};

export type ImportDualSignerResult = {
  mnemonic: string;
  key: KeyRecord;
  keyStore: PqcKeyStore;
  linkedAddress?: string;
};

export function exportDualSigner(params: ExportDualSignerParams): DualSignerBackup {
  const mnemonic = params.mnemonic?.trim();
  if (!mnemonic) throw new Error("mnemonic is required to export dual signer data");
  const pqcKey = params.pqcKey;
  if (!pqcKey) throw new Error("pqcKey is required to export dual signer data");
  assertKeyShape(pqcKey);
  return {
    type: DUAL_SIGNER_BACKUP_TYPE,
    version: DUAL_SIGNER_BACKUP_VERSION,
    mnemonic,
    bech32Prefix: params.bech32Prefix,
    address: params.address,
    pqc: {
      name: pqcKey.name,
      scheme: pqcKey.scheme,
      publicKey: toBase64(pqcKey.publicKey),
      privateKey: toBase64(pqcKey.privateKey),
      createdAt: pqcKey.createdAt.toISOString(),
    },
  };
}

export async function importDualSigner(
  bundle: DualSignerBackup | string,
  options: ImportDualSignerOptions = {},
): Promise<ImportDualSignerResult> {
  const parsed = normalizeBundle(bundle);
  const keyStore = options.keyStore ?? await PqcKeyStore.open(options.homeDir);
  const keyName = options.keyName ?? parsed.pqc.name;
  if (!options.overwrite && keyStore.getKey(keyName)) {
    throw new Error(`PQC key "${keyName}" already exists. Pass overwrite: true to replace it.`);
  }

  const record: KeyRecord = {
    name: keyName,
    scheme: parsed.pqc.scheme || DEFAULT_SCHEME,
    publicKey: fromBase64(parsed.pqc.publicKey),
    privateKey: fromBase64(parsed.pqc.privateKey),
    createdAt: parsed.pqc.createdAt ? new Date(parsed.pqc.createdAt) : new Date(),
  };
  assertKeyShape(record);

  await keyStore.saveKey(record);
  const saved = keyStore.getKey(keyName);
  if (!saved) throw new Error(`Failed to persist PQC key "${keyName}"`);

  const linkTarget = resolveLinkAddress(parsed, options.linkAddress);
  if (linkTarget) {
    await keyStore.linkAddress(linkTarget, keyName);
  }

  return {
    mnemonic: parsed.mnemonic,
    key: saved,
    keyStore,
    linkedAddress: linkTarget,
  };
}

function normalizeBundle(input: DualSignerBackup | string): DualSignerBackup {
  const parsed: DualSignerBackup = typeof input === "string" ? JSON.parse(input) : input;
  if (!parsed || typeof parsed !== "object") throw new Error("dual signer backup is invalid");
  if (parsed.type !== DUAL_SIGNER_BACKUP_TYPE) throw new Error(`unexpected backup type: ${parsed.type}`);
  if (parsed.version !== DUAL_SIGNER_BACKUP_VERSION) {
    throw new Error(`unsupported backup version: ${parsed.version}`);
  }
  if (!parsed.mnemonic?.trim()) throw new Error("backup is missing mnemonic");
  if (!parsed.pqc?.publicKey || !parsed.pqc?.privateKey) throw new Error("backup is missing PQC key material");
  return {
    ...parsed,
    mnemonic: parsed.mnemonic.trim(),
  };
}

function resolveLinkAddress(parsed: DualSignerBackup, linkOption?: string | false) {
  if (linkOption === false) return undefined;
  if (typeof linkOption === "string" && linkOption.length > 0) return linkOption;
  return parsed.address;
}

function assertKeyShape(key: KeyRecord) {
  const scheme = key.scheme?.toLowerCase() || DEFAULT_SCHEME;
  if (scheme === DEFAULT_SCHEME) {
    if (key.publicKey.length !== DILITHIUM3_PUBLIC_KEY_BYTES) {
      throw new Error(`Dilithium3 public key must be ${DILITHIUM3_PUBLIC_KEY_BYTES} bytes`);
    }
    if (key.privateKey.length !== DILITHIUM3_PRIVATE_KEY_BYTES) {
      throw new Error(`Dilithium3 private key must be ${DILITHIUM3_PRIVATE_KEY_BYTES} bytes`);
    }
  }
}
