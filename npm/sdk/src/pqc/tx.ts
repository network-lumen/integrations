import { SignDoc, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";
import { Any } from "cosmjs-types/google/protobuf/any.js";

import { PQC_PREFIX, PQC_TYPE_URL } from "./constants.js";
import { PQCSignatureEntry, PQCSignatures } from "../types/lumen/pqc/v1/pqc.js";

export function sanitizeBodyBytes(bodyBytes: Uint8Array): Uint8Array {
  if (!bodyBytes?.length) throw new Error("tx body bytes missing");
  const body = TxBody.decode(bodyBytes);
  body.extensionOptions = filterExtensions(body.extensionOptions ?? []);
  body.nonCriticalExtensionOptions = filterExtensions(body.nonCriticalExtensionOptions ?? []);
  return TxBody.encode(body).finish();
}

export function computeSignBytes(chainId: string, accountNumber: number, txRaw: TxRaw): Uint8Array {
  if (!txRaw.bodyBytes?.length || !txRaw.authInfoBytes?.length) {
    throw new Error("tx raw missing body or auth info bytes");
  }
  const sanitized = sanitizeBodyBytes(txRaw.bodyBytes);
  const doc = SignDoc.fromPartial({
    bodyBytes: sanitized,
    authInfoBytes: txRaw.authInfoBytes,
    chainId,
    accountNumber: BigInt(accountNumber),
  });
  const docBytes = SignDoc.encode(doc).finish();
  return concatPrefix(docBytes);
}

export function withPqcExtension(bodyBytes: Uint8Array, entries: PQCSignatureEntry[]): Uint8Array {
  const body = TxBody.decode(bodyBytes);
  body.extensionOptions = filterExtensions(body.extensionOptions ?? []);
  body.nonCriticalExtensionOptions = filterExtensions(body.nonCriticalExtensionOptions ?? []);
  if (entries.length > 0) {
    const payload = PQCSignatures.fromPartial({ signatures: entries });
    const packet = Any.fromPartial({
      typeUrl: PQC_TYPE_URL,
      value: PQCSignatures.encode(payload).finish(),
    });
    body.nonCriticalExtensionOptions.push(packet);
  }
  return TxBody.encode(body).finish();
}

function filterExtensions(options: Any[]): Any[] {
  return options.filter((entry) => entry?.typeUrl !== PQC_TYPE_URL);
}

function concatPrefix(docBytes: Uint8Array): Uint8Array {
  const prefixBytes = new TextEncoder().encode(PQC_PREFIX);
  const out = new Uint8Array(prefixBytes.length + docBytes.length);
  out.set(prefixBytes, 0);
  out.set(docBytes, prefixBytes.length);
  return out;
}
