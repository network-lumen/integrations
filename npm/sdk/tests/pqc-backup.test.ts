import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { exportDualSigner, importDualSigner } from "../src/pqc/backup.js";
import { createKeyPair } from "../src/pqc/signer.js";
import { DEFAULT_SCHEME } from "../src/pqc/constants.js";
import type { KeyRecord } from "../src/pqc/keystore.js";

const SAMPLE_MNEMONIC = "mirror orient ghost viable wrap oppose maximum crater imitate group raw bean";
const SAMPLE_ADDRESS = "lmn1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqw4y6hw";

describe("dual signer backup helpers", () => {
  it("exports and re-imports a dual signer bundle", async () => {
    const pqcKey = await createKeyRecord("backup-key");
    const backup = exportDualSigner({
      mnemonic: SAMPLE_MNEMONIC,
      pqcKey,
      address: SAMPLE_ADDRESS,
    });

    const homeDir = await mkdtemp(path.join(os.tmpdir(), "lumen-backup-"));
    try {
      const { mnemonic, keyStore, key, linkedAddress } = await importDualSigner(backup, { homeDir });
      expect(mnemonic).toBe(SAMPLE_MNEMONIC);
      expect(key.name).toBe(pqcKey.name);
      const stored = keyStore.getKey(pqcKey.name);
      expect(stored?.publicKey).toEqual(pqcKey.publicKey);
      expect(stored?.privateKey).toEqual(pqcKey.privateKey);
      expect(linkedAddress).toBe(SAMPLE_ADDRESS);
      expect(keyStore.getLink(SAMPLE_ADDRESS)).toBe(pqcKey.name);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("requires overwrite flag when key already exists", async () => {
    const pqcKey = await createKeyRecord("backup-key");
    const backup = exportDualSigner({ mnemonic: SAMPLE_MNEMONIC, pqcKey });
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "lumen-backup-"));
    try {
      await importDualSigner(backup, { homeDir });
      await expect(importDualSigner(backup, { homeDir })).rejects.toThrow(/already exists/i);
      const renamed = await importDualSigner(backup, { homeDir, overwrite: true, keyName: "backup-key-2" });
      expect(renamed.key.name).toBe("backup-key-2");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

async function createKeyRecord(name: string): Promise<KeyRecord> {
  const pair = await createKeyPair();
  return {
    name,
    scheme: DEFAULT_SCHEME,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    createdAt: new Date("2025-01-01T00:00:00Z"),
  };
}
