import type { EncodeObject } from "@cosmjs/proto-signing";
import { fromBase64, fromHex } from "@cosmjs/encoding";

import { BaseModule } from "./base.js";
import { joinRest } from "../rest.js";
import { MsgLinkAccountPQC } from "../types/lumen/pqc/v1/tx.js";

export class PqcModule extends BaseModule {
  constructor(restEndpoint?: string) {
    const base = restEndpoint ? joinRest(restEndpoint, "/lumen/pqc/v1") : undefined;
    super(base);
  }

  account(addr: string) {
    return this.get(`/accounts/${encodeURIComponent(addr)}`);
  }

  params() {
    return this.get("/params");
  }

  msgLinkAccountPqc(creator: string, payload: { scheme: string; pubKey: Uint8Array | string }): EncodeObject {
    return {
      typeUrl: "/lumen.pqc.v1.MsgLinkAccountPQC",
      value: MsgLinkAccountPQC.fromPartial({
        creator,
        scheme: payload.scheme,
        pubKey: normalizePubKey(payload.pubKey),
      }),
    };
  }
}

function normalizePubKey(value: Uint8Array | string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  const trimmed = value.trim();
  if (/^[0-9a-f]+$/i.test(trimmed)) return fromHex(trimmed);
  return fromBase64(trimmed);
}
