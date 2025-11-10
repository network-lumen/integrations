import { StargateClient } from "@cosmjs/stargate";
import type { Coin } from "@cosmjs/proto-signing";

import { LUMEN, type LumenEndpoints } from "../constants.js";
import { DnsModule, GatewaysModule, PqcModule, ReleasesModule, TokenomicsModule } from "../modules/index.js";

type ModuleCache = {
  dns?: DnsModule;
  gateways?: GatewaysModule;
  releases?: ReleasesModule;
  tokenomics?: TokenomicsModule;
  pqc?: PqcModule;
};

export class LumenClient {
  readonly chainId: string;
  readonly rpc: string;
  readonly rest?: string;
  readonly grpc?: string;

  protected stargate?: StargateClient;
  private modules: ModuleCache = {};

  protected constructor(chainId: string, endpoints: LumenEndpoints) {
    this.chainId = chainId;
    this.rpc = endpoints.rpc ?? LUMEN.defaultRpc;
    this.rest = endpoints.rest ?? LUMEN.defaultRest;
    this.grpc = endpoints.grpc ?? LUMEN.defaultGrpc;
  }

  static async connect(endpoints: LumenEndpoints = {}, chainId = LUMEN.chainId) {
    const client = new LumenClient(chainId, endpoints);
    client.stargate = await StargateClient.connect(client.rpc);
    const gotChain = await client.stargate.getChainId();
    if (gotChain !== chainId) console.warn(`Connected to chainId=${gotChain}, expected=${chainId}`);
    return client;
  }

  protected ensureStargate(): StargateClient {
    if (!this.stargate) throw new Error("Not connected. Call LumenClient.connect first.");
    return this.stargate;
  }

  async disconnect() {
    if (this.stargate) {
      await this.stargate.disconnect();
      this.stargate = undefined;
    }
  }

  async getHeight(): Promise<number> {
    return this.ensureStargate().getHeight();
  }

  async getBalance(address: string, denom = "ulmn"): Promise<Coin | null> {
    return this.ensureStargate().getBalance(address, denom);
  }

  onNewBlock(callback: (height: number) => void, intervalMs = 1_000): () => void {
    let lastHeight = -1;
    const timer = setInterval(async () => {
      try {
        const h = await this.getHeight();
        if (h !== lastHeight) {
          lastHeight = h;
          callback(h);
        }
      } catch {
        // ignore polling errors
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }

  dns(): DnsModule {
    if (!this.modules.dns) this.modules.dns = new DnsModule(this.rest);
    return this.modules.dns;
  }

  gateways(): GatewaysModule {
    if (!this.modules.gateways) this.modules.gateways = new GatewaysModule(this.rest);
    return this.modules.gateways;
  }

  releases(): ReleasesModule {
    if (!this.modules.releases) this.modules.releases = new ReleasesModule(this.rest);
    return this.modules.releases;
  }

  tokenomics(): TokenomicsModule {
    if (!this.modules.tokenomics) this.modules.tokenomics = new TokenomicsModule(this.rest);
    return this.modules.tokenomics;
  }

  pqc(): PqcModule {
    if (!this.modules.pqc) this.modules.pqc = new PqcModule(this.rest);
    return this.modules.pqc;
  }
}
