import { wasmKeygen, wasmSign } from "./wasmClient.js";

export async function createKeyPair() {
  return wasmKeygen();
}

export async function sign(payload: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
  return wasmSign(privateKey, payload);
}
