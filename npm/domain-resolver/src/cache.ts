import type { ResolverCacheRecord, ResolverCacheRecordMeta, ResolverCacheStore } from "./types.js";

type StoredRecordPayload =
  | {
      key: string;
      valueKind: "json";
      value: unknown;
      expiresAt?: number;
      lastAccessedAt: number;
      sizeBytes: number;
    }
  | {
      key: string;
      valueKind: "bytes";
      value: string;
      expiresAt?: number;
      lastAccessedAt: number;
      sizeBytes: number;
    };

const DEFAULT_DB_NAME = "lumen-domain-resolver";
const DEFAULT_STORE_NAME = "resolver-cache";
const DEFAULT_NODE_CACHE_DIR_NAME = "domain_resolver_cache";

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function estimateSize(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

function encodeRecord<T>(record: ResolverCacheRecord<T>): StoredRecordPayload {
  if (record.value instanceof Uint8Array) {
    return {
      key: record.key,
      valueKind: "bytes",
      value: toBase64(record.value),
      expiresAt: record.expiresAt,
      lastAccessedAt: record.lastAccessedAt,
      sizeBytes: record.sizeBytes,
    };
  }

  return {
    key: record.key,
    valueKind: "json",
    value: record.value,
    expiresAt: record.expiresAt,
    lastAccessedAt: record.lastAccessedAt,
    sizeBytes: record.sizeBytes,
  };
}

function decodeRecord<T>(payload: StoredRecordPayload): ResolverCacheRecord<T> {
  return {
    key: payload.key,
    value: (payload.valueKind === "bytes" ? fromBase64(payload.value) : payload.value) as T,
    expiresAt: payload.expiresAt,
    lastAccessedAt: payload.lastAccessedAt,
    sizeBytes: payload.sizeBytes,
  };
}

function normalizeMeta(record: ResolverCacheRecord<any>): ResolverCacheRecordMeta {
  return {
    key: record.key,
    expiresAt: record.expiresAt,
    lastAccessedAt: record.lastAccessedAt,
    sizeBytes: record.sizeBytes,
  };
}

export class MemoryResolverCacheStore implements ResolverCacheStore {
  private readonly namespaces = new Map<string, Map<string, ResolverCacheRecord<any>>>();

  async get<T>(namespace: string, key: string): Promise<ResolverCacheRecord<T> | null> {
    return (this.namespaces.get(namespace)?.get(key) as ResolverCacheRecord<T> | undefined) ?? null;
  }

  async set<T>(namespace: string, key: string, record: ResolverCacheRecord<T>): Promise<void> {
    let bucket = this.namespaces.get(namespace);
    if (!bucket) {
      bucket = new Map();
      this.namespaces.set(namespace, bucket);
    }
    bucket.set(key, record);
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.namespaces.get(namespace)?.delete(key);
  }

  async list(namespace: string): Promise<ResolverCacheRecordMeta[]> {
    return [...(this.namespaces.get(namespace)?.values() ?? [])].map(normalizeMeta);
  }

  async clear(namespace?: string): Promise<void> {
    if (namespace) {
      this.namespaces.delete(namespace);
      return;
    }
    this.namespaces.clear();
  }
}

export function createMemoryCacheStore(): ResolverCacheStore {
  return new MemoryResolverCacheStore();
}

class IndexedDbResolverCacheStore implements ResolverCacheStore {
  private dbPromise: Promise<IDBDatabase>;

  constructor(private readonly dbName = DEFAULT_DB_NAME, private readonly storeName = DEFAULT_STORE_NAME) {
    this.dbPromise = this.open();
  }

  async get<T>(namespace: string, key: string): Promise<ResolverCacheRecord<T> | null> {
    const db = await this.dbPromise;
    const payload = await this.request<StoredRecordPayload | undefined>(
      db.transaction(this.storeName, "readwrite").objectStore(this.storeName).get(`${namespace}:${key}`),
    );
    if (!payload) return null;
    return decodeRecord<T>(payload);
  }

  async set<T>(namespace: string, key: string, record: ResolverCacheRecord<T>): Promise<void> {
    const db = await this.dbPromise;
    await this.request(
      db.transaction(this.storeName, "readwrite").objectStore(this.storeName).put({
        id: `${namespace}:${key}`,
        namespace,
        ...encodeRecord(record),
      }),
    );
  }

  async delete(namespace: string, key: string): Promise<void> {
    const db = await this.dbPromise;
    await this.request(
      db.transaction(this.storeName, "readwrite").objectStore(this.storeName).delete(`${namespace}:${key}`),
    );
  }

  async list(namespace: string): Promise<ResolverCacheRecordMeta[]> {
    const db = await this.dbPromise;
    const tx = db.transaction(this.storeName, "readonly");
    const store = tx.objectStore(this.storeName);
    const out: ResolverCacheRecordMeta[] = [];

    await new Promise<void>((resolve, reject) => {
      const cursor = store.openCursor();
      cursor.onerror = () => reject(cursor.error ?? new Error("indexeddb_cursor_failed"));
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) {
          resolve();
          return;
        }
        const value = entry.value as StoredRecordPayload & { namespace?: string };
        if (value.namespace === namespace) {
          out.push({
            key: value.key,
            expiresAt: value.expiresAt,
            lastAccessedAt: value.lastAccessedAt,
            sizeBytes: value.sizeBytes,
          });
        }
        entry.continue();
      };
    });

    return out;
  }

  async clear(namespace?: string): Promise<void> {
    const db = await this.dbPromise;
    if (!namespace) {
      await this.request(db.transaction(this.storeName, "readwrite").objectStore(this.storeName).clear());
      return;
    }

    const entries = await this.list(namespace);
    await Promise.all(entries.map((entry) => this.delete(namespace, entry.key)));
  }

  async close(): Promise<void> {
    const db = await this.dbPromise;
    db.close();
  }

  private async open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      throw new Error("indexeddb_unavailable");
    }

    return await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onerror = () => reject(request.error ?? new Error("indexeddb_open_failed"));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  private async request<T = unknown>(request: IDBRequest<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error("indexeddb_request_failed"));
      request.onsuccess = () => resolve(request.result);
    });
  }
}

export function createIndexedDbCacheStore(
  dbName = DEFAULT_DB_NAME,
  storeName = DEFAULT_STORE_NAME,
): ResolverCacheStore {
  return new IndexedDbResolverCacheStore(dbName, storeName);
}

class FileSystemResolverCacheStore implements ResolverCacheStore {
  constructor(private readonly baseDir: string) {}

  async get<T>(namespace: string, key: string): Promise<ResolverCacheRecord<T> | null> {
    const { readFile } = await importNode<typeof import("node:fs/promises")>("node:fs/promises");
    try {
      const file = this.recordPath(namespace, key);
      const payload = JSON.parse(await readFile(file, "utf8")) as StoredRecordPayload;
      return decodeRecord<T>(payload);
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async set<T>(namespace: string, key: string, record: ResolverCacheRecord<T>): Promise<void> {
    const { mkdir, writeFile } = await importNode<typeof import("node:fs/promises")>("node:fs/promises");
    const dir = await this.namespaceDir(namespace);
    await mkdir(dir, { recursive: true });
    await writeFile(this.recordPath(namespace, key), JSON.stringify(encodeRecord(record)), "utf8");
  }

  async delete(namespace: string, key: string): Promise<void> {
    const { rm } = await importNode<typeof import("node:fs/promises")>("node:fs/promises");
    await rm(this.recordPath(namespace, key), { force: true });
  }

  async list(namespace: string): Promise<ResolverCacheRecordMeta[]> {
    const { readdir, readFile } = await importNode<typeof import("node:fs/promises")>("node:fs/promises");
    try {
      const dir = await this.namespaceDir(namespace);
      const names = await readdir(dir);
      const out: ResolverCacheRecordMeta[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          const payload = JSON.parse(await readFile(`${dir}/${name}`, "utf8")) as StoredRecordPayload;
          out.push({
            key: payload.key,
            expiresAt: payload.expiresAt,
            lastAccessedAt: payload.lastAccessedAt,
            sizeBytes: payload.sizeBytes,
          });
        } catch {
          // ignore broken cache files
        }
      }
      return out;
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async clear(namespace?: string): Promise<void> {
    const { rm } = await importNode<typeof import("node:fs/promises")>("node:fs/promises");
    if (!namespace) {
      await rm(this.baseDir, { recursive: true, force: true });
      return;
    }
    await rm(await this.namespaceDir(namespace), { recursive: true, force: true });
  }

  private async namespaceDir(namespace: string): Promise<string> {
    return `${this.baseDir}/${namespace}`;
  }

  private recordPath(namespace: string, key: string): string {
    return `${this.baseDir}/${namespace}/${hashKey(key)}.json`;
  }
}

export function createFileSystemCacheStore(baseDir: string): ResolverCacheStore {
  return new FileSystemResolverCacheStore(baseDir);
}

export async function createDefaultCacheStore(input: {
  cacheMode?: "auto" | "memory" | "indexeddb" | "filesystem";
  cacheDirectory?: string;
  cacheNamespace?: string;
} = {}): Promise<ResolverCacheStore> {
  const mode = input.cacheMode ?? "auto";

  if (mode === "memory") {
    return createMemoryCacheStore();
  }

  if ((mode === "indexeddb" || mode === "auto") && typeof indexedDB !== "undefined") {
    return createIndexedDbCacheStore(input.cacheNamespace ?? DEFAULT_DB_NAME, DEFAULT_STORE_NAME);
  }

  if (mode === "indexeddb") {
    throw new Error("indexeddb_unavailable");
  }

  if (mode === "filesystem" || mode === "auto") {
    const cacheDir = input.cacheDirectory ?? await defaultNodeCacheDirectory();
    return createFileSystemCacheStore(cacheDir);
  }

  return createMemoryCacheStore();
}

export function makeCacheRecord<T>(
  key: string,
  value: T,
  opts: { expiresAt?: number; lastAccessedAt?: number; sizeBytes?: number } = {},
): ResolverCacheRecord<T> {
  return {
    key,
    value,
    expiresAt: opts.expiresAt,
    lastAccessedAt: opts.lastAccessedAt ?? Date.now(),
    sizeBytes: opts.sizeBytes ?? estimateSize(value),
  };
}

async function defaultNodeCacheDirectory(): Promise<string> {
  const os = await importNode<typeof import("node:os")>("node:os");
  const path = await importNode<typeof import("node:path")>("node:path");
  return path.join(os.homedir(), ".lumen", DEFAULT_NODE_CACHE_DIR_NAME);
}

function hashKey(input: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);

  let hash = 5381;
  for (const byte of bytes) {
    hash = ((hash << 5) + hash) + byte;
    hash |= 0;
  }
  return `k${Math.abs(hash).toString(16)}`;
}

async function importNode<T>(specifier: string): Promise<T> {
  const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<T>;
  return await dynamicImport(specifier);
}
