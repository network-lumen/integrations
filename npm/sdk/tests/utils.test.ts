import { describe, expect, it } from "vitest";
import type { EncodeObject } from "@cosmjs/proto-signing";

import { splitFqdn } from "../src/utils/domain.js";
import { isGaslessTx } from "../src/utils/gas.js";
import { LUMEN } from "../src/constants.js";

describe("domain helpers", () => {
  it("splits valid domains", () => {
    expect(splitFqdn("example.lumen")).toEqual({ domain: "example", ext: "lumen" });
  });

  it("rejects invalid domains", () => {
    expect(() => splitFqdn("not-a-domain")).toThrow();
  });
});

describe("gasless detection", () => {
  it("accepts whitelisted type URLs", () => {
    const msgs: EncodeObject[] = LUMEN.gaslessTypeUrls.map((typeUrl) => ({ typeUrl, value: {} }));
    expect(isGaslessTx(msgs)).toBe(true);
  });

  it("rejects mixed messages", () => {
    const msgs: EncodeObject[] = [
      { typeUrl: LUMEN.gaslessTypeUrls[0], value: {} },
      { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: {} },
    ];
    expect(isGaslessTx(msgs)).toBe(false);
  });
});
