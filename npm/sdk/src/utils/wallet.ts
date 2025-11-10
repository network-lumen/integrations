import { DirectSecp256k1HdWallet, type OfflineSigner } from "@cosmjs/proto-signing";
import { bech32 } from "bech32";
import { generateMnemonic } from "bip39";

import { LUMEN } from "../constants.js";

export type CreatedWallet = { mnemonic: string; address: string; signer: OfflineSigner };

export async function walletFromMnemonic(mnemonic: string, prefix = LUMEN.bech32Prefix): Promise<OfflineSigner> {
  return DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix });
}

export function parseAddressMaybe(value: string, prefix = LUMEN.bech32Prefix): string | null {
  try {
    const decoded = bech32.decode(value);
    return decoded.prefix === prefix ? value : null;
  } catch {
    return null;
  }
}

export function looksLikeMnemonic(input: string): boolean {
  const words = input.trim().split(/\s+/);
  return words.length >= 12 && words.length <= 24;
}

export async function addressFromMnemonic(mnemonic: string): Promise<string> {
  const signer = await walletFromMnemonic(mnemonic);
  const [account] = await signer.getAccounts();
  return account.address;
}

export async function getWalletFrom(input: string): Promise<string> {
  const addr = parseAddressMaybe(input);
  if (addr) return addr;
  if (looksLikeMnemonic(input)) return addressFromMnemonic(input);
  throw new Error("Input is neither a Lumen bech32 address nor a mnemonic");
}

export async function createWallet(strength: 128 | 256 = 256): Promise<CreatedWallet> {
  const mnemonic = generateMnemonic(strength);
  const signer = await walletFromMnemonic(mnemonic);
  const [account] = await signer.getAccounts();
  return { mnemonic, address: account.address, signer };
}
