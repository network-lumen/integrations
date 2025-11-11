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
    rpc: process.env.LUMEN_RPC || "http://127.0.0.1:27657",
    rest: process.env.LUMEN_REST || "http://127.0.0.1:2327",
    grpc: process.env.LUMEN_GRPC || "http://127.0.0.1:9190",
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
  const originalSignAndBroadcast = client.signAndBroadcast.bind(client);
  client.signAndBroadcast = (...args) => runWithRpcRetry(() => originalSignAndBroadcast(...args), "sign_and_broadcast");

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
  const params = await client.pqc().params().catch(() => null);
  const normalized = normalizeParams(params);
  if (normalized.minBalanceForLink) {
    await assertMinBalance(client, address, normalized.minBalanceForLink);
  }
  console.log(`Mining PQC PoW nonce (bits=${normalized.powDifficultyBits})...`);
  const powNonce = pqc.computePowNonce(record.publicKey, normalized.powDifficultyBits);
  const msg = client.pqc().msgLinkAccountPqc(address, {
    scheme: record.scheme,
    pubKey: record.publicKey,
    powNonce,
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
    const hash = info?.pubKeyHash ?? info?.pub_key_hash;
    return !(hash && getLength(hash) > 0);
  } catch {
    return true;
  }
}

function normalizeParams(payload) {
  const params = payload?.params ?? payload ?? {};
  const rawPow = params.powDifficultyBits ?? params.pow_difficulty_bits ?? 0;
  const powDifficultyBits = Number(rawPow);
  return {
    powDifficultyBits: Number.isFinite(powDifficultyBits) ? powDifficultyBits : 0,
    minBalanceForLink: params.minBalanceForLink ?? params.min_balance_for_link,
  };
}

async function assertMinBalance(client, address, coin) {
  if (!coin?.denom || !coin?.amount) return;
  const balance = await client.getBalance(address, coin.denom);
  const available = BigInt(balance?.amount ?? "0");
  const required = BigInt(coin.amount);
  if (available < required) {
    throw new Error(
      `PQC link requires at least ${formatCoin(coin)} (available ${formatCoin({ denom: coin.denom, amount: balance?.amount ?? "0" })})`,
    );
  }
}

function formatCoin(coin) {
  if (!coin) return "0";
  return `${coin.amount ?? "0"}${coin.denom ?? ""}`;
}

function getLength(value) {
  if (typeof value === "string") return value.length;
  if (value instanceof Uint8Array) return value.length;
  return Array.isArray(value) ? value.length : 0;
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

function isSocketClosedError(err) {
  const code = err?.cause?.code ?? err?.code;
  if (code === "UND_ERR_SOCKET") return true;
  const msg = String(err?.message ?? "");
  return msg.includes("fetch failed") || msg.includes("UND_ERR_SOCKET");
}

export async function runWithRpcRetry(action, label, attempts = 3, delayMs = 1000) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await action();
    } catch (err) {
      lastError = err;
      if (!isSocketClosedError(err) || i === attempts - 1) {
        throw err;
      }
      console.warn(`${label}: RPC connection closed (attempt ${i + 1}/${attempts}); retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}
