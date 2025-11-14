import type { OfflineSigner, EncodeObject, OfflineDirectSigner, Registry } from "@cosmjs/proto-signing";
import { makeSignDoc } from "@cosmjs/proto-signing";
import { fromBase64 } from "@cosmjs/encoding";
import { calculateFee, GasPrice, type DeliverTxResponse, SigningStargateClient, type SigningStargateClientOptions } from "@cosmjs/stargate";
import type { StdFee } from "@cosmjs/amino";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";

import { LUMEN, type LumenEndpoints } from "../constants.js";
import { createRegistry } from "../registry.js";
import { isGaslessTx, zeroFee } from "../utils/gas.js";
import { computeSignBytes, withPqcExtension } from "../pqc/tx.js";
import type { PqcKeyStore, KeyRecord } from "../pqc/keystore.js";
import { sign as pqcSign } from "../pqc/signer.js";
import { DEFAULT_SCHEME, DILITHIUM3_PRIVATE_KEY_BYTES, DILITHIUM3_PUBLIC_KEY_BYTES } from "../pqc/constants.js";
import type { PQCSignatureEntry } from "../types/lumen/pqc/v1/pqc.js";
import { PqcPolicy, pqcPolicyFromJSON, type Params as PqcParams } from "../types/lumen/pqc/v1/params.js";
import { LumenClient } from "./base.js";

export type FeeLike = StdFee | number | "auto";

export type PqcSigningOptions = {
  enabled?: boolean;
  scheme?: string;
  store?: PqcKeyStore;
  homeDir?: string;
  overrides?: Record<string, string>;
};

export interface LumenSigningClientOptions extends SigningStargateClientOptions {
  gasMultiplier?: number;
  pqc?: PqcSigningOptions;
}

type NormalizedPqcOptions = {
  enabled: boolean;
  scheme: string;
  store?: PqcKeyStore;
  homeDir?: string;
  overrides: Record<string, string>;
};

export class LumenSigningClient extends LumenClient {
  protected signing?: SigningStargateClient;
  protected readonly signer: OfflineSigner;
  protected registry: Registry;

  private readonly gasPrice?: GasPrice;
  private readonly gasMultiplier: number;
  private readonly pqcConfig: NormalizedPqcOptions;
  private pqcStore?: PqcKeyStore;
  private pqcParams?: PqcParams;
  private pqcParamsFetched = false;

  protected constructor(
    chainId: string,
    endpoints: LumenEndpoints,
    signer: OfflineSigner,
    registry: Registry,
    options: LumenSigningClientOptions,
  ) {
    super(chainId, endpoints);
    this.signer = signer;
    this.registry = registry;
    this.gasPrice = options.gasPrice;
    this.gasMultiplier = options.gasMultiplier ?? 1.3;
    this.pqcConfig = {
      enabled: options.pqc?.enabled ?? true,
      scheme: options.pqc?.scheme ?? DEFAULT_SCHEME,
      store: options.pqc?.store,
      homeDir: options.pqc?.homeDir,
      overrides: options.pqc?.overrides ?? {},
    };
    if (this.pqcConfig.store) this.pqcStore = this.pqcConfig.store;
  }

  static async connectWithSigner(
    signer: OfflineSigner,
    endpoints: LumenEndpoints = {},
    chainId = LUMEN.chainId,
    options: LumenSigningClientOptions = {},
  ) {
    const { gasMultiplier, pqc, ...cosmjsOptions } = options;
    const registry = cosmjsOptions.registry ?? createRegistry();
    cosmjsOptions.registry = registry;
    const client = new LumenSigningClient(chainId, endpoints, signer, registry, {
      ...cosmjsOptions,
      gasMultiplier,
      pqc,
    });
    client.signing = await SigningStargateClient.connectWithSigner(client.rpc, signer, cosmjsOptions);
    client.stargate = client.signing;
    const gotChain = await client.signing.getChainId();
    if (gotChain !== chainId) console.warn(`Connected to chainId=${gotChain}, expected=${chainId}`);
    return client;
  }

  protected ensureSigning(): SigningStargateClient {
    if (!this.signing) throw new Error("Signing client not initialised. Use connectWithSigner.");
    return this.signing;
  }

  async signAndBroadcast(
    signerAddress: string,
    messages: readonly EncodeObject[],
    fee: FeeLike = "auto",
    memo = "",
    timeoutHeight?: bigint,
  ): Promise<DeliverTxResponse> {
    const signing = this.ensureSigning();
    const directFee = isStdFee(fee) ? fee : undefined;
    const usedFee = directFee ?? await this.normalizeFee(signerAddress, messages, fee, memo);
    const initialTx = await signing.sign(signerAddress, messages, usedFee, memo, undefined, timeoutHeight);
    const pqcEntries = await this.buildPqcEntries(initialTx, signerAddress);
    const finalTx = pqcEntries.length > 0
      ? await this.resignWithPqc(initialTx, pqcEntries, signerAddress)
      : initialTx;
    const txBytes = TxRaw.encode(finalTx).finish();
    return signing.broadcastTx(txBytes);
  }

  private async normalizeFee(
    signerAddress: string,
    messages: readonly EncodeObject[],
    fee: FeeLike,
    memo: string,
  ): Promise<StdFee> {
    if (isStdFee(fee)) return fee;
    if (isGaslessTx(messages)) return zeroFee();
    const signing = this.ensureSigning();
    if (fee === "auto" || typeof fee === "number") {
      if (!this.gasPrice) throw new Error("gasPrice must be set when using auto fee estimation");
      const gasEstimation = await signing.simulate(signerAddress, messages, memo);
      const multiplier = typeof fee === "number" ? fee : this.gasMultiplier;
      return calculateFee(Math.round(gasEstimation * multiplier), this.gasPrice);
    }
    return fee;
  }

  private async buildPqcEntries(txRaw: TxRaw, signerAddress: string): Promise<PQCSignatureEntry[]> {
    if (!this.pqcConfig.enabled) return [];
    const store = await this.ensurePqcStore();
    if (!store) return [];

    const overrides = this.pqcConfig.overrides ?? {};
    const keyName = overrides[signerAddress] ?? store.getLink(signerAddress);
    const params = await this.loadPqcParams();
    const required = params ? params.policy === PqcPolicy.PQC_POLICY_REQUIRED : true;
    if (!keyName) {
      if (required) throw new Error(`No PQC key linked to ${signerAddress}. Import and link a Dilithium key first.`);
      return [];
    }
    const key = store.getKey(keyName);
    if (!key) throw new Error(`PQC key "${keyName}" not found in local store`);

    const scheme = (this.pqcConfig.scheme ?? key.scheme).toLowerCase();
    if (key.scheme.toLowerCase() !== scheme) {
      throw new Error(`Local PQC key ${key.name} uses scheme ${key.scheme}, expected ${scheme}`);
    }
    validateKeyShape(key, scheme);

    const registry = await this.fetchPqcAccount(signerAddress);
    if (registry?.scheme && registry.scheme.toLowerCase() !== scheme) {
      throw new Error(`On-chain PQC registry expects scheme ${registry.scheme} for ${signerAddress}`);
    }
    if (params?.minScheme && params.minScheme.toLowerCase() !== scheme) {
      throw new Error(`Chain requires minimum scheme ${params.minScheme}, local config uses ${scheme}`);
    }

    const { accountNumber } = await this.ensureSigning().getSequence(signerAddress);
    const signBytes = computeSignBytes(this.chainId, accountNumber, txRaw);
    const signature = await pqcSign(signBytes, key.privateKey);
    return [{
      addr: signerAddress,
      scheme,
      signature,
      pubKey: key.publicKey,
    }];
  }

  private async resignWithPqc(txRaw: TxRaw, entries: PQCSignatureEntry[], signerAddress: string): Promise<TxRaw> {
    if (!("signDirect" in this.signer)) {
      throw new Error("PQC signing requires a Direct signer (OfflineDirectSigner)");
    }
    const direct = this.signer as OfflineDirectSigner;
    const nextBody = withPqcExtension(txRaw.bodyBytes, entries);
    const { accountNumber } = await this.ensureSigning().getSequence(signerAddress);
    const signDoc = makeSignDoc(nextBody, txRaw.authInfoBytes, this.chainId, accountNumber);
    const { signature, signed } = await direct.signDirect(signerAddress, signDoc);
    return TxRaw.fromPartial({
      bodyBytes: signed.bodyBytes,
      authInfoBytes: signed.authInfoBytes,
      signatures: [fromBase64(signature.signature)],
    });
  }

  private async ensurePqcStore(): Promise<PqcKeyStore | undefined> {
    if (!this.pqcConfig.enabled) return undefined;
    if (this.pqcStore) return this.pqcStore;
    if (this.pqcConfig.store) {
      this.pqcStore = this.pqcConfig.store;
      return this.pqcStore;
    }
    const mod = await import("../pqc/keystore.js");
    const home = this.pqcConfig.homeDir ?? mod.defaultHomeDir();
    this.pqcStore = await mod.PqcKeyStore.open(home);
    return this.pqcStore;
  }

  private async loadPqcParams(): Promise<PqcParams | undefined> {
    if (this.pqcParamsFetched) return this.pqcParams;
    this.pqcParamsFetched = true;
    try {
      const payload = await this.pqc().params();
      const params = parseParams(payload?.params ?? payload);
      this.pqcParams = params;
    } catch {
      this.pqcParams = undefined;
    }
    return this.pqcParams;
  }

  private async fetchPqcAccount(address: string): Promise<{ scheme?: string } | undefined> {
    try {
      const payload = await this.pqc().account(address);
      return payload?.account ?? payload;
    } catch {
      return undefined;
    }
  }
}

function validateKeyShape(key: KeyRecord, scheme: string) {
  if (scheme === DEFAULT_SCHEME) {
    const pubLen = key.publicKey.length;
    const privLen = key.privateKey.length;
    if (pubLen !== DILITHIUM3_PUBLIC_KEY_BYTES || privLen !== DILITHIUM3_PRIVATE_KEY_BYTES) {
      throw new Error(
        `PQC key "${key.name}" is incompatible with Dilithium3 (${pubLen}/${privLen} bytes, expected ${DILITHIUM3_PUBLIC_KEY_BYTES}/${DILITHIUM3_PRIVATE_KEY_BYTES}). ` +
          `Re-import or regenerate the key using @lumen-chain/sdk >= 0.9.0.`,
      );
    }
  }
}

function isStdFee(value: FeeLike): value is StdFee {
  return typeof value === "object" && value !== null && "gas" in value;
}

function parseParams(input: any): PqcParams | undefined {
  if (!input) return undefined;
  const policy = typeof input.policy === "string" ? pqcPolicyFromJSON(input.policy) : Number(input.policy ?? 0);
  return {
    policy,
    minScheme: input.minScheme ?? input.min_scheme ?? "",
    minBalanceForLink: input.minBalanceForLink ?? input.min_balance_for_link,
    powDifficultyBits: Number(input.powDifficultyBits ?? input.pow_difficulty_bits ?? 0),
  };
}
