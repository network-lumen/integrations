import { promises as fs } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

import { fromBase64, toBase64 } from "@cosmjs/encoding";

import { PQC_KEYS_FILE, PQC_LINKS_FILE, PQC_STORE_DIRNAME } from "./constants.js";

const FILE_MODE = 0o600;

type StoredKey = {
  name: string;
  scheme: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
};

type LinkMap = Record<string, string>;

export type KeyRecord = {
  name: string;
  scheme: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  createdAt: Date;
};

export class PqcKeyStore {
  constructor(
    private readonly keysPath: string,
    private readonly linksPath: string,
    private keys: Record<string, StoredKey>,
    private links: LinkMap,
  ) {}

  static async open(homeDir = defaultHomeDir()) {
    const dir = join(homeDir, PQC_STORE_DIRNAME);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const keysPath = join(dir, PQC_KEYS_FILE);
    const linksPath = join(dir, PQC_LINKS_FILE);
    const keys = await readJson<Record<string, StoredKey>>(keysPath, {});
    const links = await readJson<LinkMap>(linksPath, {});
    return new PqcKeyStore(keysPath, linksPath, keys, links);
  }

  listKeys(): KeyRecord[] {
    return Object.values(this.keys).map(deserializeKey);
  }

  getKey(name: string): KeyRecord | undefined {
    const found = this.keys[name];
    return found ? deserializeKey(found) : undefined;
  }

  async saveKey(record: KeyRecord) {
    const payload: StoredKey = {
      name: record.name,
      scheme: record.scheme,
      publicKey: toBase64(record.publicKey),
      privateKey: toBase64(record.privateKey),
      createdAt: record.createdAt.toISOString(),
    };
    this.keys[record.name] = payload;
    await writeJson(this.keysPath, this.keys);
  }

  listLinks(): LinkMap {
    return { ...this.links };
  }

  getLink(address: string): string | undefined {
    return this.links[address];
  }

  async linkAddress(address: string, keyName: string) {
    this.links[address] = keyName;
    await writeJson(this.linksPath, this.links);
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const data = await readFile(path, "utf8");
    return JSON.parse(data) as T;
  } catch (err: any) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJson(path: string, payload: any) {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload, null, 2), {
    mode: FILE_MODE,
  });
  await fs.rename(tmpPath, path);
}

function deserializeKey(entry: StoredKey): KeyRecord {
  return {
    name: entry.name,
    scheme: entry.scheme,
    publicKey: fromBase64(entry.publicKey),
    privateKey: fromBase64(entry.privateKey),
    createdAt: new Date(entry.createdAt),
  };
}

export function defaultHomeDir() {
  const base = os.homedir();
  if (!base) throw new Error("Unable to resolve user home directory for pqc key store");
  return join(base, ".lumen");
}
