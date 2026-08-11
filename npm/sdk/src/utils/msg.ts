import type { Coin } from "@cosmjs/amino";
import type { EncodeObject } from "@cosmjs/proto-signing";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";

export function bankSend(from: string, to: string, amount: readonly Coin[]): EncodeObject {
  return {
    typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    value: MsgSend.fromPartial({
      fromAddress: from,
      toAddress: to,
      amount: amount.map((coin) => ({ ...coin })),
    }),
  };
}

export const msg = {
  bankSend,
};
