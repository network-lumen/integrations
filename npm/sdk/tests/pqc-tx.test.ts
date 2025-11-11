import { describe, expect, it } from "vitest";
import { Any } from "cosmjs-types/google/protobuf/any.js";
import { TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";

import { PQC_TYPE_URL } from "../src/pqc/constants.js";
import { sanitizeBodyBytes, withPqcExtension } from "../src/pqc/tx.js";

const SAMPLE_EXTENSION = Any.fromPartial({ typeUrl: PQC_TYPE_URL, value: new Uint8Array([1, 2, 3]) });

describe("pqc tx helpers", () => {
  it("removes PQC extension when sanitizing", () => {
    const body = TxBody.fromPartial({
      memo: "hello",
      extensionOptions: [SAMPLE_EXTENSION],
      nonCriticalExtensionOptions: [SAMPLE_EXTENSION],
    });
    const sanitized = sanitizeBodyBytes(TxBody.encode(body).finish());
    const decoded = TxBody.decode(sanitized);
    expect(decoded.extensionOptions).toHaveLength(0);
    expect(decoded.nonCriticalExtensionOptions).toHaveLength(0);
  });

  it("adds PQC extension to non-critical options", () => {
    const body = TxBody.fromPartial({ memo: "world" });
    const next = withPqcExtension(TxBody.encode(body).finish(), [{
      addr: "lmn1deadbeef",
      scheme: "dilithium3",
      signature: new Uint8Array([4, 5, 6]),
      pubKey: new Uint8Array([7, 8, 9]),
    }]);
    const decoded = TxBody.decode(next);
    expect(decoded.nonCriticalExtensionOptions).toHaveLength(1);
    expect(decoded.nonCriticalExtensionOptions[0]?.typeUrl).toBe(PQC_TYPE_URL);
  });
});
