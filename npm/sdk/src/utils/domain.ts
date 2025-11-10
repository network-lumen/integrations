import type { LumenClient } from "../client/base.js";
import { parseAddressMaybe } from "./wallet.js";

export async function resolveDomainOrAddress(input: string, client: LumenClient): Promise<string | null> {
  if (input.includes(".")) return input;
  const addr = parseAddressMaybe(input);
  if (!addr) return null;
  try {
    const payload = await client.dns().domainsByOwner(addr);
    const first = payload?.domains?.[0];
    if (typeof first === "string") return first;
    if (first?.name && first?.ext) return `${first.name}.${first.ext}`;
  } catch {
    // ignore REST failures
  }
  return null;
}

export function splitFqdn(value: string): { domain: string; ext: string } {
  const trimmed = value.trim();
  const match = trimmed.match(/^([^\.]+)\.([^\.]+)$/);
  if (!match) throw new Error(`Invalid domain: ${value}`);
  return { domain: match[1], ext: match[2] };
}
