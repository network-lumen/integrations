#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { LumenSigningClient, utils, pqc } from "../../sdk/dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, "..", "..", "sdk");
const requireFromSdk = createRequire(path.join(pkgRoot, "package.json"));
const { GasPrice } = requireFromSdk("@cosmjs/stargate");
const repoRoot = path.resolve(pkgRoot, "..", "..", "..");
const artifactsDir = path.join(repoRoot, "artifacts", "docker-node");
const validatorFile = path.join(artifactsDir, "validator.json");

function resolveEndpoints() {
  return {
    rpc: process.env.LUMEN_RPC || "http://127.0.0.1:26657",
    rest: process.env.LUMEN_REST || "http://127.0.0.1:1317",
    grpc: process.env.LUMEN_GRPC || "http://127.0.0.1:9090",
  };
}

export async function setupTestEnv(options = {}) {
  if (!fs.existsSync(validatorFile)) {
    throw new Error(`validator.json not found (${validatorFile}). Run npm run node:docker first.`);
  }

  const validatorInfo = JSON.parse(fs.readFileSync(validatorFile, "utf8"));
  const mnemonic = validatorInfo.mnemonic;
  if (!mnemonic) throw new Error("validator mnemonic missing in validator.json");

  const signer = await utils.walletFromMnemonic(mnemonic);
  const [validator] = await signer.getAccounts();
  const endpoints = resolveEndpoints();
  const chainId = process.env.LUMEN_CHAIN_ID || "lumen-local-1";
  const pqcHome = process.env.LUMEN_PQC_HOME || path.join(process.env.HOME || pkgRoot, ".lumen");
  const pqcKeyName = options.pqcKeyName || "validator-local-pqc";
  const pqcEnabled = options.pqcEnabled !== false;

  const keyStore = await pqc.PqcKeyStore.open(pqcHome);
  let record = keyStore.getKey(pqcKeyName);
  if (record && !isValidDilithiumKey(record)) {
    console.log(`⚠ Legacy PQC key "${pqcKeyName}" detected; regenerating for Dilithium3 compatibility...`);
    record = undefined;
    await keyStore.saveKey(await createDilithiumKey(pqcKeyName));
    record = keyStore.getKey(pqcKeyName);
  }
  if (!record) {
    record = await createDilithiumKey(pqcKeyName);
    await keyStore.saveKey(record);
    console.log(`✓ Stored PQC key "${pqcKeyName}" in ${pqcHome}`);
  }
  if (keyStore.getLink(validator.address) !== pqcKeyName) {
    await keyStore.linkAddress(validator.address, pqcKeyName);
    console.log(`✓ Linked ${validator.address} -> ${pqcKeyName}`);
  }

  const client = await LumenSigningClient.connectWithSigner(
    signer,
    endpoints,
    chainId,
    { gasPrice: GasPrice.fromString("0ulmn"), pqc: { homeDir: pqcHome, enabled: pqcEnabled } },
  );

  if (pqcEnabled) {
    await ensureOnChainPqcLink(client, validator.address, record);
  }

  return {
    client,
    signer,
    validator,
    endpoints,
    chainId,
    keyStore,
    pqcKey: record,
    pqcHome,
    pqcKeyName,
    zeroFee: utils.gas.zeroFee(),
  };
}

async function createDilithiumKey(name) {
  const pair = await pqc.createKeyPair();
  return {
    name,
    scheme: pqc.DEFAULT_SCHEME,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    createdAt: new Date(),
  };
}

async function ensureOnChainPqcLink(client, address, record) {
  const needsLink = await needsPqcLink(client, address);
  if (!needsLink) return;
  const msg = client.pqc().msgLinkAccountPqc(address, {
    scheme: record.scheme,
    pubKey: record.publicKey,
  });
  try {
    await expectSuccess(client.signAndBroadcast(address, [msg], utils.gas.zeroFee()), "pqc link");
    console.log("✓ Linked PQC key on-chain");
  } catch (err) {
    if (isRotationDisabledError(err)) {
      console.log("ℹ PQC already linked on-chain; rotation disabled.");
    } else {
      throw err;
    }
  }
}

async function needsPqcLink(client, address) {
  try {
    const resp = await client.pqc().account(address);
    const info = resp?.account ?? resp;
    return !(info && info.pubKey && info.pubKey.length > 0);
  } catch {
    return true;
  }
}

function isValidDilithiumKey(record) {
  if (!record) return false;
  return (
    record.publicKey?.length === pqc.DILITHIUM3_PUBLIC_KEY_BYTES &&
    record.privateKey?.length === pqc.DILITHIUM3_PRIVATE_KEY_BYTES
  );
}

export async function expectSuccess(promise, label) {
  const res = await promise;
  if (!res || typeof res.code !== "number") {
    throw new Error(`${label} returned invalid response`);
  }
  if (res.code !== 0) {
    throw new Error(`${label} failed (code=${res.code}): ${res.rawLog}`);
  }
  return res;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueSuffix() {
  return Date.now().toString(36);
}

export function assertIncludes(haystack, needle, message) {
  assert.ok(haystack.includes(needle), message);
}

function isRotationDisabledError(err) {
  const msg = String(err?.message || err || "");
  return msg.toLowerCase().includes("rotation disabled");
}
