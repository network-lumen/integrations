import type { EncodeObject } from "@cosmjs/proto-signing";
import Long from "long";

import { BaseModule } from "./base.js";
import { joinRest } from "../rest.js";
import { MsgSubmitProposal, MsgDeposit, MsgVote, MsgVoteWeighted } from "cosmjs-types/cosmos/gov/v1/tx";
import type { Coin } from "cosmjs-types/cosmos/base/v1beta1/coin";
import type { Any } from "cosmjs-types/google/protobuf/any";
import type { WeightedVoteOption } from "cosmjs-types/cosmos/gov/v1/gov";
import { VoteOption } from "cosmjs-types/cosmos/gov/v1/gov";

type Pagination = { pageKey?: string; limit?: number };

export type ProposalFilters = Pagination & {
  status?: string;
  voter?: string;
  depositor?: string;
};

export type SubmitProposalParams = {
  messages: Any[];
  initialDeposit?: Coin[];
  metadata?: string;
  title?: string;
  summary?: string;
};

export type DepositParams = {
  proposalId: Long | string | number | bigint;
  amount: readonly Coin[];
};

export type VoteParams = {
  proposalId: Long | string | number | bigint;
  option: VoteOption;
};

export type WeightedVoteParams = {
  proposalId: Long | string | number | bigint;
  options: WeightedVoteOption[];
};

export class GovModule extends BaseModule {
  constructor(restEndpoint?: string) {
    const base = restEndpoint ? joinRest(restEndpoint, "/cosmos/gov/v1") : undefined;
    super(base);
  }

  params(kind?: "deposit" | "voting" | "tallying") {
    if (kind) return this.get(`/params/${kind}`);
    return this.get("/params");
  }

  proposal(id: string | number | Long) {
    return this.get(`/proposals/${encodeURIComponent(String(id))}`);
  }

  proposals(filters: ProposalFilters = {}) {
    const query = buildPagination(filters);
    if (filters.status) query.proposal_status = filters.status;
    if (filters.voter) query.voter = filters.voter;
    if (filters.depositor) query.depositor = filters.depositor;
    return this.get("/proposals", query);
  }

  deposits(proposalId: string | number | Long, pagination: Pagination = {}) {
    return this.get(`/proposals/${encodeURIComponent(String(proposalId))}/deposits`, buildPagination(pagination));
  }

  deposit(proposalId: string | number | Long, depositor: string) {
    return this.get(
      `/proposals/${encodeURIComponent(String(proposalId))}/deposits/${encodeURIComponent(depositor)}`,
    );
  }

  votes(proposalId: string | number | Long, pagination: Pagination = {}) {
    return this.get(`/proposals/${encodeURIComponent(String(proposalId))}/votes`, buildPagination(pagination));
  }

  vote(proposalId: string | number | Long, voter: string) {
    return this.get(`/proposals/${encodeURIComponent(String(proposalId))}/votes/${encodeURIComponent(voter)}`);
  }

  tallyResult(proposalId: string | number | Long) {
    return this.get(`/proposals/${encodeURIComponent(String(proposalId))}/tally`);
  }

  msgSubmitProposal(proposer: string, payload: SubmitProposalParams): EncodeObject {
    return {
      typeUrl: "/cosmos.gov.v1.MsgSubmitProposal",
      value: MsgSubmitProposal.fromPartial({
        proposer,
        messages: payload.messages ?? [],
        initialDeposit: payload.initialDeposit ?? [],
        metadata: payload.metadata ?? "",
        title: payload.title ?? "",
        summary: payload.summary ?? "",
      }),
    };
  }

  msgDeposit(depositor: string, payload: DepositParams): EncodeObject {
    return {
      typeUrl: "/cosmos.gov.v1.MsgDeposit",
      value: MsgDeposit.fromPartial({
        depositor,
        proposalId: toProposalId(payload.proposalId),
        amount: payload.amount.slice(),
      }),
    };
  }

  msgVote(voter: string, payload: VoteParams): EncodeObject {
    return {
      typeUrl: "/cosmos.gov.v1.MsgVote",
      value: MsgVote.fromPartial({
        voter,
        proposalId: toProposalId(payload.proposalId),
        option: payload.option,
      }),
    };
  }

  msgVoteWeighted(voter: string, payload: WeightedVoteParams): EncodeObject {
    return {
      typeUrl: "/cosmos.gov.v1.MsgVoteWeighted",
      value: MsgVoteWeighted.fromPartial({
        voter,
        proposalId: toProposalId(payload.proposalId),
        options: payload.options.slice(),
      }),
    };
  }
}

function buildPagination(params: Pagination) {
  const query: Record<string, string> = {};
  if (params.pageKey) query["pagination.key"] = params.pageKey;
  if (params.limit != null) query["pagination.limit"] = String(params.limit);
  return query;
}

function toProposalId(value: string | number | Long | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (Long.isLong(value)) return BigInt(value.toString());
  if (typeof value === "string") return BigInt(value);
  return BigInt(value);
}
