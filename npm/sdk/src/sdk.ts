import type { OfflineSigner } from "@cosmjs/proto-signing";
import type { DeliverTxResponse } from "@cosmjs/stargate";

import type { LumenEndpoints } from "./constants.js";
import type { LumenSigningClientOptions } from "./client/signing.js";
import { LumenSigningClient } from "./client/signing.js";
import { DnsModule, GatewaysModule, GovModule, ReleasesModule, TokenomicsModule } from "./modules/index.js";
import type { EncodeObject } from "@cosmjs/proto-signing";

export class LumenSDK {
  constructor(public readonly client: LumenSigningClient) {}

  static async connectWithSigner(
    signer: OfflineSigner,
    endpoints?: LumenEndpoints,
    options?: LumenSigningClientOptions,
  ) {
    const client = await LumenSigningClient.connectWithSigner(signer, endpoints, undefined, options);
    return new LumenSDK(client);
  }

  dns(): DnsModule {
    return this.client.dns();
  }

  gateways(): GatewaysModule {
    return this.client.gateways();
  }

  releases(): ReleasesModule {
    return this.client.releases();
  }

  tokenomics(): TokenomicsModule {
    return this.client.tokenomics();
  }

  gov(): GovModule {
    return this.client.gov();
  }

  async getAccountSnapshot(address: string) {
    const [height, balance, domains] = await Promise.all([
      this.client.getHeight(),
      this.client.getBalance(address),
      this.client.dns().domainsByOwner(address).catch(() => ({ domains: [] })),
    ]);
    return { height, balance, domains };
  }

  async registerDomain(sender: string, payload: Parameters<DnsModule["msgRegister"]>[1]) {
    return this.broadcast(sender, [this.client.dns().msgRegister(sender, payload)]);
  }

  async updateDomain(sender: string, payload: Parameters<DnsModule["msgUpdate"]>[1]) {
    return this.broadcast(sender, [this.client.dns().msgUpdate(sender, payload)]);
  }

  async renewDomain(sender: string, payload: Parameters<DnsModule["msgRenew"]>[1]) {
    return this.broadcast(sender, [this.client.dns().msgRenew(sender, payload)]);
  }

  async transferDomain(sender: string, payload: Parameters<DnsModule["msgTransfer"]>[1]) {
    return this.broadcast(sender, [this.client.dns().msgTransfer(sender, payload)]);
  }

  async bidOnDomain(sender: string, payload: Parameters<DnsModule["msgBid"]>[1]) {
    return this.broadcast(sender, [this.client.dns().msgBid(sender, payload)]);
  }

  async settleDomain(sender: string, payload: Parameters<DnsModule["msgSettle"]>[1]) {
    return this.broadcast(sender, [this.client.dns().msgSettle(sender, payload)]);
  }

  async registerGateway(operator: string, payload: Parameters<GatewaysModule["msgRegisterGateway"]>[1]) {
    return this.broadcast(operator, [this.client.gateways().msgRegisterGateway(operator, payload)]);
  }

  async updateGateway(operator: string, payload: Parameters<GatewaysModule["msgUpdateGateway"]>[1]) {
    return this.broadcast(operator, [this.client.gateways().msgUpdateGateway(operator, payload)]);
  }

  async createContract(clientAddr: string, payload: Parameters<GatewaysModule["msgCreateContract"]>[1]) {
    return this.broadcast(clientAddr, [this.client.gateways().msgCreateContract(clientAddr, payload)]);
  }

  async claimGatewayPayment(operator: string, contractId: string | number) {
    return this.broadcast(operator, [this.client.gateways().msgClaimPayment(operator, contractId)]);
  }

  async cancelContract(clientAddr: string, contractId: string | number) {
    return this.broadcast(clientAddr, [this.client.gateways().msgCancelContract(clientAddr, contractId)]);
  }

  async finalizeContract(caller: string, contractId: string | number) {
    return this.broadcast(caller, [this.client.gateways().msgFinalizeContract(caller, contractId)]);
  }

  async publishRelease(creator: string, payload: Parameters<ReleasesModule["msgPublishRelease"]>[1]) {
    return this.broadcast(creator, [this.client.releases().msgPublishRelease(creator, payload)]);
  }

  async mirrorRelease(creator: string, payload: Parameters<ReleasesModule["msgMirrorRelease"]>[1]) {
    return this.broadcast(creator, [this.client.releases().msgMirrorRelease(creator, payload)]);
  }

  async yankRelease(creator: string, id: number) {
    return this.broadcast(creator, [this.client.releases().msgYankRelease(creator, id)]);
  }

  async validateRelease(authority: string, id: number) {
    return this.broadcast(authority, [this.client.releases().msgValidateRelease(authority, id)]);
  }

  async rejectRelease(authority: string, id: number) {
    return this.broadcast(authority, [this.client.releases().msgRejectRelease(authority, id)]);
  }

  async updateTokenomics(authority: string, params: Parameters<TokenomicsModule["msgUpdateParams"]>[1]) {
    return this.broadcast(authority, [this.client.tokenomics().msgUpdateParams(authority, params)]);
  }

  async submitProposal(proposer: string, payload: Parameters<GovModule["msgSubmitProposal"]>[1]) {
    return this.broadcast(proposer, [this.client.gov().msgSubmitProposal(proposer, payload)]);
  }

  async depositToProposal(depositor: string, payload: Parameters<GovModule["msgDeposit"]>[1]) {
    return this.broadcast(depositor, [this.client.gov().msgDeposit(depositor, payload)]);
  }

  async voteOnProposal(voter: string, payload: Parameters<GovModule["msgVote"]>[1]) {
    return this.broadcast(voter, [this.client.gov().msgVote(voter, payload)]);
  }

  async voteWeightedOnProposal(voter: string, payload: Parameters<GovModule["msgVoteWeighted"]>[1]) {
    return this.broadcast(voter, [this.client.gov().msgVoteWeighted(voter, payload)]);
  }

  private broadcast(sender: string, msgs: EncodeObject[]): Promise<DeliverTxResponse> {
    return this.client.signAndBroadcast(sender, msgs);
  }
}
