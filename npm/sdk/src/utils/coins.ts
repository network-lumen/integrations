import { coin as sdkCoin, coins as sdkCoins } from "@cosmjs/stargate";

export const coin = {
  ulmn: (amount: number | string) => sdkCoin(String(amount), "ulmn"),
  toUlmn: (value: number) => Math.floor(value).toString(),
  fromUlmn: (value: string) => Number(value),
};

export const coins = {
  ulmn: (amount: number | string) => sdkCoins(String(amount), "ulmn"),
};
