import { Go } from "./wasm_exec.js";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const wasmUrl = new URL("./dilithium3.wasm", import.meta.url);

type GoGlobal = typeof globalThis & {
  lumen_dilithium_keygen?: () => { publicKey: Uint8Array; privateKey: Uint8Array };
  lumen_dilithium_pub_from_priv?: (priv: Uint8Array) => Uint8Array;
  lumen_dilithium_sign?: (priv: Uint8Array, msg: Uint8Array) => Uint8Array;
  __lumen_dilithium_ready__?: boolean;
};

const globalAny = globalThis as GoGlobal;
let initPromise: Promise<void> | null = null;

async function ensureWasm(): Promise<void> {
  if (globalAny.__lumen_dilithium_ready__) return;
  if (!initPromise) {
    initPromise = (async () => {
      const go = new Go();
      const wasmPath = fileURLToPath(wasmUrl);
      const wasmBytes = await fs.readFile(path.resolve(wasmPath));
      const { instance } = await WebAssembly.instantiate(wasmBytes, go.importObject);
      go.run(instance);
      await waitFor(() => typeof globalAny.lumen_dilithium_sign === "function");
      globalAny.__lumen_dilithium_ready__ = true;
    })();
  }
  await initPromise;
}

function waitFor(check: () => boolean, interval = 10): Promise<void> {
  return new Promise((resolve) => {
    const poll = () => {
      if (check()) {
        resolve();
        return;
      }
      setTimeout(poll, interval);
    };
    poll();
  });
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

export async function wasmKeygen() {
  await ensureWasm();
  const result = globalAny.lumen_dilithium_keygen!();
  return {
    publicKey: cloneBytes(result.publicKey),
    privateKey: cloneBytes(result.privateKey),
  };
}

export async function wasmPubFromPriv(priv: Uint8Array) {
  await ensureWasm();
  const result = globalAny.lumen_dilithium_pub_from_priv!(priv);
  return cloneBytes(result);
}

export async function wasmSign(priv: Uint8Array, msg: Uint8Array) {
  await ensureWasm();
  const result = globalAny.lumen_dilithium_sign!(priv, msg);
  return cloneBytes(result);
}
