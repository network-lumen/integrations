import type { EncodeObject } from "@cosmjs/proto-signing";

import { LUMEN } from "../constants.js";

const GASLESS_SET = new Set(LUMEN.gaslessTypeUrls);

export function isGaslessTx(msgs: readonly EncodeObject[]): boolean {
  if (!Array.isArray(msgs) || msgs.length === 0) return false;
  for (const msg of msgs) {
    if (!msg?.typeUrl || !GASLESS_SET.has(msg.typeUrl)) return false;
  }
  return true;
}

export function zeroFee(gas = "250000") {
  return { amount: [], gas: String(gas) };
}
