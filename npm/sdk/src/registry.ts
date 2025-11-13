import { Registry, GeneratedType } from "@cosmjs/proto-signing";
import { defaultRegistryTypes } from "@cosmjs/stargate";

import {
  MsgBid,
  MsgCreateAuction,
  MsgCreateDomain,
  MsgDeleteAuction,
  MsgDeleteDomain,
  MsgRegister as MsgDnsRegister,
  MsgRenew,
  MsgSettle,
  MsgTransfer,
  MsgUpdate as MsgDnsUpdate,
  MsgUpdateAuction,
  MsgUpdateDomain,
  MsgUpdateParams as MsgDnsUpdateParams,
} from "./types/lumen/dns/v1/tx.js";
import {
  MsgCancelContract,
  MsgClaimPayment,
  MsgCreateContract,
  MsgFinalizeContract,
  MsgRegisterGateway,
  MsgUpdateGateway,
  MsgUpdateParams as MsgGatewayUpdateParams,
} from "./types/lumen/gateway/v1/tx.js";
import {
  MsgMirrorRelease,
  MsgPublishRelease,
  MsgRejectRelease,
  MsgSetEmergency,
  MsgUpdateParams as MsgReleaseUpdateParams,
  MsgValidateRelease,
  MsgYankRelease,
} from "./types/lumen/release/v1/tx.js";
import { MsgUpdateParams as MsgTokenomicsUpdateParams } from "./types/lumen/tokenomics/v1/tx.js";
import { MsgLinkAccountPQC } from "./types/lumen/pqc/v1/tx.js";
import {
  MsgSubmitProposal,
  MsgVote,
  MsgVoteWeighted,
  MsgDeposit,
  MsgExecLegacyContent,
  MsgUpdateParams as MsgGovUpdateParams,
} from "cosmjs-types/cosmos/gov/v1/tx.js";

const customTypes: Array<[string, GeneratedType]> = [
  ["/lumen.dns.v1.MsgUpdateParams", MsgDnsUpdateParams as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgRegister", MsgDnsRegister as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgUpdate", MsgDnsUpdate as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgRenew", MsgRenew as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgTransfer", MsgTransfer as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgBid", MsgBid as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgSettle", MsgSettle as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgCreateDomain", MsgCreateDomain as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgUpdateDomain", MsgUpdateDomain as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgDeleteDomain", MsgDeleteDomain as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgCreateAuction", MsgCreateAuction as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgUpdateAuction", MsgUpdateAuction as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgDeleteAuction", MsgDeleteAuction as unknown as GeneratedType],
  ["/lumen.gateway.v1.MsgUpdateParams", MsgGatewayUpdateParams as unknown as GeneratedType],
  ["/lumen.gateway.v1.MsgRegisterGateway", MsgRegisterGateway as unknown as GeneratedType],
  ["/lumen.gateway.v1.MsgUpdateGateway", MsgUpdateGateway as unknown as GeneratedType],
  ["/lumen.gateway.v1.MsgCreateContract", MsgCreateContract as unknown as GeneratedType],
  ["/lumen.gateway.v1.MsgClaimPayment", MsgClaimPayment as unknown as GeneratedType],
  ["/lumen.gateway.v1.MsgCancelContract", MsgCancelContract as unknown as GeneratedType],
  ["/lumen.gateway.v1.MsgFinalizeContract", MsgFinalizeContract as unknown as GeneratedType],
  ["/lumen.release.v1.MsgPublishRelease", MsgPublishRelease as unknown as GeneratedType],
  ["/lumen.release.v1.MsgMirrorRelease", MsgMirrorRelease as unknown as GeneratedType],
  ["/lumen.release.v1.MsgYankRelease", MsgYankRelease as unknown as GeneratedType],
  ["/lumen.release.v1.MsgSetEmergency", MsgSetEmergency as unknown as GeneratedType],
  ["/lumen.release.v1.MsgValidateRelease", MsgValidateRelease as unknown as GeneratedType],
  ["/lumen.release.v1.MsgRejectRelease", MsgRejectRelease as unknown as GeneratedType],
  ["/lumen.release.v1.MsgUpdateParams", MsgReleaseUpdateParams as unknown as GeneratedType],
  ["/lumen.tokenomics.v1.MsgUpdateParams", MsgTokenomicsUpdateParams as unknown as GeneratedType],
  ["/lumen.pqc.v1.MsgLinkAccountPQC", MsgLinkAccountPQC as unknown as GeneratedType],
  ["/cosmos.gov.v1.MsgSubmitProposal", MsgSubmitProposal as unknown as GeneratedType],
  ["/cosmos.gov.v1.MsgDeposit", MsgDeposit as unknown as GeneratedType],
  ["/cosmos.gov.v1.MsgVote", MsgVote as unknown as GeneratedType],
  ["/cosmos.gov.v1.MsgVoteWeighted", MsgVoteWeighted as unknown as GeneratedType],
  ["/cosmos.gov.v1.MsgExecLegacyContent", MsgExecLegacyContent as unknown as GeneratedType],
  ["/cosmos.gov.v1.MsgUpdateParams", MsgGovUpdateParams as unknown as GeneratedType],
];

export function createRegistry(): Registry {
  const registry = new Registry(defaultRegistryTypes);
  for (const [typeUrl, mod] of customTypes) {
    registry.register(typeUrl, mod);
  }
  return registry;
}
