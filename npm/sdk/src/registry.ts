import { Registry, GeneratedType } from "@cosmjs/proto-signing";
import { defaultRegistryTypes } from "@cosmjs/stargate";

import {
  MsgBid,
  MsgRegister as MsgDnsRegister,
  MsgRenew,
  MsgSettle,
  MsgTransfer,
  MsgUpdate as MsgDnsUpdate,
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
  MsgPublishRelease,
  MsgRejectRelease,
  MsgSetEmergency,
  MsgUpdateParams as MsgReleaseUpdateParams,
  MsgValidateRelease,
} from "./types/lumen/release/v1/tx.js";
import {
  MsgCommunityPoolSpend,
  MsgUpdateGovMinDeposit,
  MsgUpdateParams as MsgTokenomicsUpdateParams,
  MsgUpdateSlashingDowntimeParams,
  MsgUpdateSlashingLivenessParams,
} from "./types/lumen/tokenomics/v1/tx.js";
import {
  MsgAddIBCRelayer,
  MsgLinkAccountPQC,
  MsgRemoveIBCRelayer,
  MsgUpdateParams as MsgPqcUpdateParams,
} from "./types/lumen/pqc/v1/tx.js";
import {
  MsgSubmitProposal,
  MsgVote,
  MsgVoteWeighted,
  MsgDeposit,
  MsgExecLegacyContent,
  MsgUpdateParams as MsgGovUpdateParams,
} from "cosmjs-types/cosmos/gov/v1/tx";
import { MsgSoftwareUpgrade } from "cosmjs-types/cosmos/upgrade/v1beta1/tx";

const customTypes: Array<[string, GeneratedType]> = [
  ["/lumen.dns.v1.MsgUpdateParams", MsgDnsUpdateParams as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgRegister", MsgDnsRegister as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgUpdate", MsgDnsUpdate as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgRenew", MsgRenew as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgTransfer", MsgTransfer as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgBid", MsgBid as unknown as GeneratedType],
  ["/lumen.dns.v1.MsgSettle", MsgSettle as unknown as GeneratedType],
  ["/lumen.gateway.v1.MsgUpdateParams", MsgGatewayUpdateParams as unknown as GeneratedType],
  ["/lumen.gateway.v1.MsgRegisterGateway", MsgRegisterGateway as unknown as GeneratedType],
  ["/lumen.gateway.v1.MsgUpdateGateway", MsgUpdateGateway as unknown as GeneratedType],
  ["/lumen.gateway.v1.MsgCreateContract", MsgCreateContract as unknown as GeneratedType],
  ["/lumen.gateway.v1.MsgClaimPayment", MsgClaimPayment as unknown as GeneratedType],
  ["/lumen.gateway.v1.MsgCancelContract", MsgCancelContract as unknown as GeneratedType],
  ["/lumen.gateway.v1.MsgFinalizeContract", MsgFinalizeContract as unknown as GeneratedType],
  ["/lumen.release.v1.MsgPublishRelease", MsgPublishRelease as unknown as GeneratedType],
  ["/lumen.release.v1.MsgSetEmergency", MsgSetEmergency as unknown as GeneratedType],
  ["/lumen.release.v1.MsgValidateRelease", MsgValidateRelease as unknown as GeneratedType],
  ["/lumen.release.v1.MsgRejectRelease", MsgRejectRelease as unknown as GeneratedType],
  ["/lumen.release.v1.MsgUpdateParams", MsgReleaseUpdateParams as unknown as GeneratedType],
  ["/lumen.tokenomics.v1.MsgUpdateParams", MsgTokenomicsUpdateParams as unknown as GeneratedType],
  ["/lumen.tokenomics.v1.MsgUpdateGovMinDeposit", MsgUpdateGovMinDeposit as unknown as GeneratedType],
  ["/lumen.tokenomics.v1.MsgCommunityPoolSpend", MsgCommunityPoolSpend as unknown as GeneratedType],
  [
    "/lumen.tokenomics.v1.MsgUpdateSlashingDowntimeParams",
    MsgUpdateSlashingDowntimeParams as unknown as GeneratedType,
  ],
  [
    "/lumen.tokenomics.v1.MsgUpdateSlashingLivenessParams",
    MsgUpdateSlashingLivenessParams as unknown as GeneratedType,
  ],
  ["/lumen.pqc.v1.MsgUpdateParams", MsgPqcUpdateParams as unknown as GeneratedType],
  ["/lumen.pqc.v1.MsgAddIBCRelayer", MsgAddIBCRelayer as unknown as GeneratedType],
  ["/lumen.pqc.v1.MsgRemoveIBCRelayer", MsgRemoveIBCRelayer as unknown as GeneratedType],
  ["/lumen.pqc.v1.MsgLinkAccountPQC", MsgLinkAccountPQC as unknown as GeneratedType],
  ["/cosmos.gov.v1.MsgSubmitProposal", MsgSubmitProposal as unknown as GeneratedType],
  ["/cosmos.gov.v1.MsgDeposit", MsgDeposit as unknown as GeneratedType],
  ["/cosmos.gov.v1.MsgVote", MsgVote as unknown as GeneratedType],
  ["/cosmos.gov.v1.MsgVoteWeighted", MsgVoteWeighted as unknown as GeneratedType],
  ["/cosmos.gov.v1.MsgExecLegacyContent", MsgExecLegacyContent as unknown as GeneratedType],
  ["/cosmos.gov.v1.MsgUpdateParams", MsgGovUpdateParams as unknown as GeneratedType],
  ["/cosmos.upgrade.v1beta1.MsgSoftwareUpgrade", MsgSoftwareUpgrade as unknown as GeneratedType],
];

export function createRegistry(): Registry {
  const registry = new Registry(defaultRegistryTypes);
  for (const [typeUrl, mod] of customTypes) {
    registry.register(typeUrl, mod);
  }
  return registry;
}
